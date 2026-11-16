/**
 * rest.ts — the REST v3 API under /api/v3: repositories, contents, refs,
 * branches, commits, labels, issues, comments and pull requests.
 *
 * Every reply is a JSON value; errors are HttpError, rendered by the app as
 * {message}. Repository ids are sequential from 1 in creation order, issue
 * numbers share one counter with pull requests, and list endpoints paginate
 * with per_page/page plus a Link header naming the next page.
 */

import { addComment, branchNameOf, createIssue, createPull, labelNames, mergePull, pullFiles, pullTips, type MergeMethod } from './records.ts';
import { commitFileChange, entryAtPath, listDir } from './trees.ts';
import { HttpError, VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { nowIso } from './clock.ts';

export interface ApiRequest {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  path: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when there was no body). */
  body: Record<string, unknown> | undefined;
  /** The request's origin (scheme://host), for absolute Link headers. */
  origin: string;
}

export interface ApiReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function reply(status: number, body: unknown, headers?: Record<string, string>): ApiReply {
  return { status, body, headers };
}

// ------------------------------------------------------------ serializers

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    type: VIEWER.type,
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: '',
    url: '',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    url: '',
    clone_url: '',
    fork: false,
    archived: false,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: null, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: '',
    url: '',
  };
}

export function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: '',
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
    url: '',
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const { headTip, baseTip } = pullTips(forge, repo, pull);
  return {
    id: pull.id,
    node_id: '',
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: headTip ?? null,
      label: `${VIEWER.login}:${pull.headRef}`,
      user: { login: VIEWER.login },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip ?? null,
      label: `${VIEWER.login}:${pull.baseRef}`,
      user: { login: VIEWER.login },
      repo: repoJson(repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
    url: '',
  };
}

/** A pull request in the issue list's shape (GitHub serves PRs there too). */
function pullAsIssueJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: '',
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    comments: pull.comments.length,
    pull_request: { url: '', html_url: '' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
    url: '',
  };
}

function splitIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(repo: RepoRec, sha: string, forge: Forge): Record<string, unknown> {
  const view = forge.commitView(repo, sha);
  if (view === undefined) throw new HttpError(404, 'Not Found');
  return {
    sha,
    node_id: '',
    commit: {
      message: view.message,
      tree: { sha: view.tree },
      author: splitIdentity(view.author),
      committer: splitIdentity(view.committer),
      comment_count: 0,
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
    html_url: '',
    url: '',
  };
}

// ------------------------------------------------------------ pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(req: ApiRequest, items: readonly T[], path: string): ApiReply {
  const { perPage, page } = pageOf(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${req.origin}/api/v3${path}?per_page=${perPage}&page=${page + 1}`;
    const last = `${req.origin}/api/v3${path}?per_page=${perPage}&page=${Math.ceil(items.length / perPage)}`;
    headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return reply(200, slice, headers);
}

// ------------------------------------------------------------ routing

export function handleRest(forge: Forge, req: ApiRequest): ApiReply {
  const [head, ...tail] = req.path;
  if (head === undefined) {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return reply(200, { current_user_url: `${req.origin}/api/v3/user`, repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (head === 'meta') {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return reply(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (head === 'user') return userRoutes(forge, req, tail);
  if (head === 'repos') return repoRoutes(forge, req, tail);
  throw new HttpError(404, 'Not Found');
}

function userRoutes(forge: Forge, req: ApiRequest, path: string[]): ApiReply {
  if (path.length === 0) {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return reply(200, userJson());
  }
  if (path[0] === 'repos') {
    if (req.method === 'GET') {
      return paginate(req, forge.listRepos().map(repoJson), '/user/repos');
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const repo = forge.createRepo({
        name: typeof body.name === 'string' ? body.name : '',
        description: typeof body.description === 'string' ? body.description : undefined,
        private: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
      });
      return reply(201, repoJson(repo));
    }
  }
  throw new HttpError(404, 'Not Found');
}

function repoRoutes(forge: Forge, req: ApiRequest, path: string[]): ApiReply {
  const [owner, name, ...rest] = path;
  if (owner === undefined || name === undefined) throw new HttpError(404, 'Not Found');
  if (rest.length === 0) {
    if (req.method === 'GET') return reply(200, repoJson(forge.requireRepo(owner, name)));
    if (req.method === 'PATCH') {
      const repo = forge.requireRepo(owner, name);
      const body = req.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (forge.repos.has(body.name)) throw new HttpError(422, 'Validation Failed: name already exists on this account');
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      repo.updatedAt = nowIso();
      return reply(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      if (!forge.deleteRepo(owner, name)) throw new HttpError(404, 'Not Found');
      return { status: 204 };
    }
    throw new HttpError(404, 'Not Found');
  }
  const repo = forge.requireRepo(owner, name);
  const [section, ...sub] = rest;
  switch (section) {
    case 'contents':
      return contentsRoutes(forge, req, repo, sub);
    case 'labels':
      return labelRoutes(forge, req, repo, sub);
    case 'issues':
      return issueRoutes(forge, req, repo, sub);
    case 'pulls':
      return pullRoutes(forge, req, repo, sub);
    case 'branches':
      return branchRoutes(forge, req, repo, sub);
    case 'commits':
      return commitRoutes(forge, req, repo, sub);
    case 'git':
      return gitDataRoutes(forge, req, repo, sub);
    default:
      throw new HttpError(404, 'Not Found');
  }
}

// ------------------------------------------------------------ contents

function contentsRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  const filePath = path.join('/');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = forge.resolveRevision(repo, ref);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const commit = forge.peelToCommit(repo, tip);
    if (commit === undefined) throw new HttpError(404, 'Not Found');
    const tree = forge.commitView(repo, commit)?.tree;
    if (tree === undefined) throw new HttpError(404, 'Not Found');
    if (filePath === '') {
      const entries = listDir(forge, repo, tree, '');
      if (entries === undefined) throw new HttpError(404, 'Not Found');
      return reply(200, entries.map((entry) => dirEntryJson(forge, repo, entry, entry.name)));
    }
    const entry = entryAtPath(forge, repo, tree, filePath);
    if (entry === undefined) throw new HttpError(404, 'Not Found');
    if (entry.mode === '40000') {
      const entries = listDir(forge, repo, tree, filePath);
      if (entries === undefined) throw new HttpError(404, 'Not Found');
      return reply(200, entries.map((child) => dirEntryJson(forge, repo, child, `${filePath}/${child.name}`)));
    }
    const blob = forge.getObject(repo, entry.oid);
    if (blob === undefined) throw new HttpError(404, 'Not Found');
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      name: filePath.split('/').pop(),
      path: filePath,
      sha: entry.oid,
      size: blob.data.length,
      url: '',
      html_url: '',
      download_url: '',
    });
  }
  if (req.method === 'PUT') {
    const body = req.body ?? {};
    const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${filePath}`;
    // The sha rules are judged against the branch the write lands on (or the
    // default branch's tip when the write creates the branch).
    const branchRef = `refs/heads/${branch}`;
    const effectiveTip = repo.refs.get(branchRef) ?? repo.refs.get(forge.headRef(repo));
    const effectiveTree = effectiveTip === undefined ? undefined : forge.commitView(repo, effectiveTip)?.tree;
    const existing = effectiveTree === undefined ? undefined : entryAtPath(forge, repo, effectiveTree, filePath);
    const existingFile = existing !== undefined && existing.mode !== '40000' ? existing : undefined;
    if (existingFile !== undefined) {
      if (body.sha === undefined) throw new HttpError(422, 'Validation Failed: sha is required when updating a file');
      if (body.sha !== existingFile.oid) throw new HttpError(409, 'Conflict: the file sha does not match the current version');
    }
    const { commitSha, blobSha } = commitFileChange(forge, repo, branch, filePath, content, message);
    return reply(existingFile !== undefined ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobSha,
        size: content.length,
        url: '',
        html_url: '',
      },
      commit: { sha: commitSha, message },
    });
  }
  if (req.method === 'DELETE') {
    const body = req.body ?? {};
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${filePath}`;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const tree = forge.commitView(repo, tip)?.tree;
    const existing = tree === undefined ? undefined : entryAtPath(forge, repo, tree, filePath);
    if (existing === undefined || existing.mode === '40000') throw new HttpError(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      throw new HttpError(409, 'Conflict: the file sha does not match the current version');
    }
    const { commitSha } = commitFileChange(forge, repo, branch, filePath, null, message);
    return reply(200, { content: null, commit: { sha: commitSha, message } });
  }
  throw new HttpError(404, 'Not Found');
}

function dirEntryJson(forge: Forge, repo: RepoRec, entry: { mode: string; name: string; oid: string }, path: string): Record<string, unknown> {
  const object = forge.getObject(repo, entry.oid);
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (object?.data.length ?? 0),
    url: '',
    html_url: '',
  };
}

// ------------------------------------------------------------ labels

function labelRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (path.length === 0) {
    if (req.method === 'GET') {
      return reply(200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name, { name, color });
      return reply(201, labelJson(repo, name));
    }
  }
  const name = path.join('/');
  const label = repo.labels.get(name);
  if (req.method === 'GET') {
    if (label === undefined) throw new HttpError(404, 'Not Found');
    return reply(200, labelJson(repo, name));
  }
  if (req.method === 'DELETE') {
    if (!repo.labels.delete(name)) throw new HttpError(404, 'Not Found');
    return { status: 204 };
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------ issues

function issueRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (path.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const labelFilter = req.query.get('labels');
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return paginate(req, issues.map((issue) => issueJson(repo, issue)), `/repos/${VIEWER.login}/${repo.name}/issues`);
    }
    if (req.method === 'POST') {
      const issue = createIssue(forge, repo, req.body ?? {});
      return reply(201, issueJson(repo, issue));
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number.parseInt(path[0], 10);
  if (!Number.isInteger(number)) throw new HttpError(404, 'Not Found');
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (path.length === 2 && path[1] === 'comments') {
    const target = issue ?? pull;
    if (target === undefined) throw new HttpError(404, 'Not Found');
    if (req.method === 'GET') return reply(200, target.comments.map(commentJson));
    if (req.method === 'POST') {
      const body = req.body ?? {};
      if (typeof body.body !== 'string' || body.body === '') throw new HttpError(422, 'Validation Failed: body is required');
      const comment = addComment(forge, target, body.body);
      return reply(201, commentJson(comment));
    }
    throw new HttpError(404, 'Not Found');
  }
  if (path.length !== 1) throw new HttpError(404, 'Not Found');
  if (req.method === 'GET') {
    if (issue !== undefined) return reply(200, issueJson(repo, issue));
    if (pull !== undefined) return reply(200, pullAsIssueJson(forge, repo, pull));
    throw new HttpError(404, 'Not Found');
  }
  if (req.method === 'PATCH') {
    if (issue === undefined) throw new HttpError(404, 'Not Found');
    const body = req.body ?? {};
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
    if (body.labels !== undefined) {
      const names = labelNames(body.labels);
      for (const name of names) {
        if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist in this repository`);
      }
      issue.labels = names;
    }
    issue.updatedAt = nowIso();
    return reply(200, issueJson(repo, issue));
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------ pulls

function pullRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (path.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return paginate(req, pulls.map((pull) => pullJson(forge, repo, pull)), `/repos/${VIEWER.login}/${repo.name}/pulls`);
    }
    if (req.method === 'POST') {
      const pull = createPull(forge, repo, req.body ?? {});
      return reply(201, pullJson(forge, repo, pull));
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number.parseInt(path[0], 10);
  if (!Number.isInteger(number)) throw new HttpError(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  if (path.length === 1) {
    if (req.method === 'GET') return reply(200, pullJson(forge, repo, pull));
    if (req.method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.base !== undefined) pull.baseRef = branchNameOf(body.base) || pull.baseRef;
      if ((body.state === 'closed' || body.state === 'open') && !pull.merged) {
        pull.state = body.state;
      }
      pull.updatedAt = nowIso();
      return reply(200, pullJson(forge, repo, pull));
    }
    throw new HttpError(404, 'Not Found');
  }
  if (path.length === 2 && path[1] === 'files' && req.method === 'GET') {
    const files = pullFiles(forge, repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: '',
    }));
    return paginate(req, files, `/repos/${VIEWER.login}/${repo.name}/pulls/${number}/files`);
  }
  if (path.length === 2 && path[1] === 'merge' && req.method === 'PUT') {
    const body = req.body ?? {};
    const rawMethod = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
    if (rawMethod !== 'merge' && rawMethod !== 'squash' && rawMethod !== 'rebase') {
      throw new HttpError(405, `Validation Failed: merge method "${rawMethod}" is not supported`);
    }
    const { sha } = mergePull(forge, repo, pull, rawMethod as MergeMethod);
    return reply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------ branches, commits, git data

function branchRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
  if (path.length === 0) {
    return reply(200, forge.branches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })));
  }
  const name = path.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) throw new HttpError(404, 'Not Found');
  return reply(200, { name, commit: { sha }, protected: false });
}

function commitRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
  if (path.length === 1) {
    const sha = path[0];
    if (forge.commitView(repo, sha) === undefined) throw new HttpError(404, 'Not Found');
    return reply(200, commitJson(repo, sha, forge));
  }
  if (path.length !== 0) throw new HttpError(404, 'Not Found');
  const rev = req.query.get('sha') ?? repo.defaultBranch;
  const tip = forge.resolveRevision(repo, rev);
  if (tip === undefined) return reply(200, []);
  const commit = forge.peelToCommit(repo, tip);
  if (commit === undefined) return reply(200, []);
  const commits = forge.listCommits(repo, commit).map((entry) => commitJson(repo, entry.sha, forge));
  return paginate(req, commits, `/repos/${VIEWER.login}/${repo.name}/commits`);
}

function gitDataRoutes(forge: Forge, req: ApiRequest, repo: RepoRec, path: string[]): ApiReply {
  if (path[0] !== 'refs') throw new HttpError(404, 'Not Found');
  const refPath = path.slice(1).join('/');
  if (req.method === 'POST' && refPath === '') {
    const body = req.body ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
    const object = forge.getObject(repo, sha);
    if (object === undefined) throw new HttpError(422, 'Validation Failed: sha does not name an object in this repository');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Validation Failed: reference already exists');
    repo.refs.set(ref, sha);
    return reply(201, { ref, object: { sha, type: object.type } });
  }
  if (req.method === 'GET' && refPath === '') {
    const all = [...repo.refs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ref, sha]) => ({ ref, object: { sha, type: forge.getObject(repo, sha)?.type ?? 'commit' } }));
    return reply(200, all);
  }
  const sha = repo.refs.get(refPath);
  if (req.method === 'GET') {
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    return reply(200, { ref: refPath, object: { sha, type: forge.getObject(repo, sha)?.type ?? 'commit' } });
  }
  if (req.method === 'DELETE') {
    if (!repo.refs.delete(refPath)) throw new HttpError(404, 'Not Found');
    return { status: 204 };
  }
  throw new HttpError(404, 'Not Found');
}
