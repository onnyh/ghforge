/**
 * records.ts — the issue and pull-request operations every surface shares,
 * so an object created over MCP is the same object REST reads back, with the
 * same id. Validation failures raise HttpError with the status GitHub would
 * answer (422 for bad input, 405 for a pull request that cannot merge).
 */

import { nowIso } from './clock.ts';
import { diffTrees, mergeTrees, type FileChange } from './trees.ts';
import { HttpError, VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';

/** Normalize the label list an issue create carries (names or {name} objects). */
export function labelNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const names: string[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

export function createIssue(
  forge: Forge,
  repo: RepoRec,
  input: { title?: unknown; body?: unknown; labels?: unknown },
): IssueRec {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const labels = labelNames(input.labels);
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist in this repository`);
  }
  const stamp = nowIso();
  const issue: IssueRec = {
    id: forge.issueId(),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
    seq: forge.nextSeq(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(forge: Forge, target: IssueRec | PullRec, body: string): { id: number; body: string; createdAt: string } {
  const stamp = nowIso();
  const comment = { id: forge.commentId(), body, createdAt: stamp, updatedAt: stamp };
  target.comments.push(comment);
  target.updatedAt = stamp;
  return comment;
}

/** The branch a pull-request head/base value names ('owner:branch' and refs/heads/ forms included). */
export function branchNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon > 0) name = name.slice(colon + 1);
  return name;
}

export function createPull(
  forge: Forge,
  repo: RepoRec,
  input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): PullRec {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const head = branchNameOf(input.head);
  const base = branchNameOf(input.base) || repo.defaultBranch;
  if (head === '') throw new HttpError(422, 'Validation Failed: head is required');
  if (repo.refs.get(`refs/heads/${head}`) === undefined) {
    throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  }
  if (repo.refs.get(`refs/heads/${base}`) === undefined) {
    throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, `Validation Failed: a pull request already exists for ${VIEWER.login}:${head} -> ${base}`);
    }
  }
  const stamp = nowIso();
  const pull: PullRec = {
    id: forge.issueId(),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    headRef: head,
    baseRef: base,
    state: 'open',
    merged: false,
    comments: [],
    mergeCommitSha: null,
    mergedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    seq: forge.nextSeq(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The tips a pull request currently points at (resolved live, like GitHub). */
export function pullTips(forge: Forge, repo: RepoRec, pull: PullRec): { headTip?: string; baseTip?: string } {
  return {
    headTip: repo.refs.get(`refs/heads/${pull.headRef}`),
    baseTip: repo.refs.get(`refs/heads/${pull.baseRef}`),
  };
}

/** The changed files of a pull request: merge-base tree against head tree. */
export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): FileChange[] {
  const { headTip, baseTip } = pullTips(forge, repo, pull);
  if (headTip === undefined) return [];
  const headTree = forge.commitView(repo, headTip)?.tree;
  let baseTree: string | undefined;
  if (baseTip !== undefined) {
    const base = forge.mergeBase(repo, headTip, baseTip);
    baseTree = base === undefined ? undefined : forge.commitView(repo, base)?.tree;
  }
  return diffTrees(forge, repo, baseTree, headTree);
}

/** MERGEABLE when a trial merge is clean, CONFLICTING when it is not. */
export function pullMergeable(forge: Forge, repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'UNKNOWN';
  const { headTip, baseTip } = pullTips(forge, repo, pull);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = forge.mergeBase(repo, headTip, baseTip);
  if (base === undefined) return 'UNKNOWN';
  if (base === headTip) return 'UNKNOWN';
  const outcome = mergeTrees(
    forge,
    repo,
    forge.commitView(repo, base)?.tree,
    forge.commitView(repo, baseTip)?.tree,
    forge.commitView(repo, headTip)?.tree,
  );
  return outcome.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * Merge a pull request for real: a three-way tree merge of head into base,
 * landed as a commit on the base branch. Conflicts and repeat merges are
 * HttpError(405), an unknown method a 422 — the statuses the API promises.
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: MergeMethod): { sha: string } {
  if (pull.merged) throw new HttpError(405, 'Pull Request is already merged');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const { headTip, baseTip } = pullTips(forge, repo, pull);
  if (headTip === undefined || baseTip === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
  const base = forge.mergeBase(repo, headTip, baseTip);
  if (base === undefined || base === headTip) throw new HttpError(405, 'Pull Request is not mergeable');
  const baseTree = forge.commitView(repo, base)?.tree;
  const baseTipTree = forge.commitView(repo, baseTip)?.tree;
  const headTipTree = forge.commitView(repo, headTip)?.tree;

  let newTip: string;
  if (method === 'rebase') {
    // Replay the head-only commits, oldest first, each as a three-way merge
    // of its own change onto the growing tip.
    const unique = forge
      .listCommits(repo, headTip)
      .filter((entry) => !forge.isAncestor(repo, entry.sha, baseTip))
      .reverse();
    let tip = baseTip;
    let tipTree = baseTipTree;
    for (const entry of unique) {
      const parentTree = entry.view.parents.length > 0 ? forge.commitView(repo, entry.view.parents[0])?.tree : undefined;
      const outcome = mergeTrees(forge, repo, parentTree, tipTree, entry.view.tree);
      if (outcome.conflicts.length > 0) throw new HttpError(405, 'Pull Request is not mergeable');
      tip = forge.createCommit(repo, outcome.tree, [tip], entry.view.message);
      tipTree = outcome.tree;
    }
    newTip = tip;
  } else {
    const outcome = mergeTrees(forge, repo, baseTree, baseTipTree, headTipTree);
    if (outcome.conflicts.length > 0) throw new HttpError(405, 'Pull Request is not mergeable');
    if (method === 'squash') {
      const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
      newTip = forge.createCommit(repo, outcome.tree, [baseTip], message);
    } else {
      const message = `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
      newTip = forge.createCommit(repo, outcome.tree, [baseTip, headTip], message);
    }
  }

  repo.refs.set(`refs/heads/${pull.baseRef}`, newTip);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = newTip;
  pull.mergedAt = nowIso();
  pull.updatedAt = pull.mergedAt;
  return { sha: newTip };
}
