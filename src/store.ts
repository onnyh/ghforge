/**
 * store.ts — the forge's state and domain logic, in one in-memory store.
 *
 * One Forge holds every repository the token's owner owns. Each repository
 * carries its own git object store (objects never leak between repositories),
 * its refs, labels, issues and pull requests. Issue and pull-request numbers
 * share one per-repository counter, the way GitHub numbers them. Everything
 * is a pure function of the requests received, in order, plus the
 * deterministic clock: a replayed run rebuilds identical state.
 */

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type CommitView,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { nowEpochSec, nowIso } from './clock.ts';

/** The login the trial's token names. The suite's scenario fixes this user. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

/** An error that maps straight onto an HTTP status and a JSON message. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  comments: CommentRec[];
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The next global issue/pull-request object id. */
  issueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  /** The next global comment id. */
  commentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  // -------------------------------------------------------------- repos

  createRepo(input: { name: string; description?: string; private?: boolean; defaultBranch?: string }): RepoRec {
    const name = input.name;
    if (typeof name !== 'string' || !REPO_NAME.test(name) || name.endsWith('.git')) {
      throw new HttpError(422, `Validation Failed: name ${JSON.stringify(name)} is not a valid repository name`);
    }
    if (this.repos.has(name)) {
      throw new HttpError(422, 'Validation Failed: name already exists on this account');
    }
    const stamp = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      private: input.private === true,
      description: typeof input.description === 'string' ? input.description : '',
      defaultBranch: typeof input.defaultBranch === 'string' && input.defaultBranch !== '' ? input.defaultBranch : 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository by owner and name; another owner's name space is invisible. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(name);
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) throw new HttpError(404, 'Not Found');
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(name);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------- objects

  putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: RepoRec, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store an already-hashed object (from a received pack); verifies the hash. */
  putRawObject(repo: RepoRec, oid: string, object: GitObject): void {
    if (hashObject(object.type, object.data) !== oid) throw new HttpError(400, 'object hash mismatch');
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }

  commitView(repo: RepoRec, oid: string): CommitView | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** Create a commit over `tree` with the forge identity and the trial clock. */
  createCommit(repo: RepoRec, tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      timestamp: nowEpochSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  emptyTree(repo: RepoRec): string {
    return this.putObject(repo, 'tree', Buffer.alloc(0));
  }

  // -------------------------------------------------------------- refs

  headRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  refTip(repo: RepoRec, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Branch tips as [name, oid] pairs, in ref order. */
  branches(repo: RepoRec): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const ref of [...repo.refs.keys()].sort()) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: repo.refs.get(ref)! });
    }
    return out;
  }

  /**
   * Resolve a revision the way the API surfaces name one: a full ref, HEAD, a
   * branch or tag short name, or a full object id (dereferencing tags).
   */
  resolveRevision(repo: RepoRec, rev: string): string | undefined {
    if (rev === 'HEAD') return repo.refs.get(this.headRef(repo));
    if (rev.startsWith('refs/')) {
      const direct = repo.refs.get(rev);
      if (direct !== undefined) return direct;
    }
    const asBranch = repo.refs.get(`refs/heads/${rev}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = repo.refs.get(`refs/tags/${rev}`);
    if (asTag !== undefined) return asTag;
    if (isObjectId(rev) && repo.objects.has(rev)) return rev;
    return undefined;
  }

  /** Peel a tag chain to the commit it names, or undefined. */
  peelToCommit(repo: RepoRec, oid: string): string | undefined {
    let current = oid;
    for (let hops = 0; hops < 32; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return undefined;
      current = parseTag(object.data).object;
    }
    return undefined;
  }

  // -------------------------------------------------------------- reachability

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  closure(repo: RepoRec, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root) && repo.objects.has(root)) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        queue.push(view.tree);
        for (const parent of view.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` through parents. */
  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(repo, oid);
      if (view !== undefined) for (const parent of view.parents) queue.push(parent);
    }
    return false;
  }

  /** Ancestor distances from a commit (BFS over parents), including itself at 0. */
  ancestorDistances(repo: RepoRec, tip: string): Map<string, number> {
    const dist = new Map<string, number>([[tip, 0]]);
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const view = this.commitView(repo, oid);
      if (view === undefined) continue;
      for (const parent of view.parents) {
        if (!dist.has(parent)) {
          dist.set(parent, dist.get(oid)! + 1);
          queue.push(parent);
        }
      }
    }
    return dist;
  }

  /** The best common ancestor of two commits (lowest summed distance), or undefined. */
  mergeBase(repo: RepoRec, a: string, b: string): string | undefined {
    if (a === b) return a;
    const fromA = this.ancestorDistances(repo, a);
    const fromB = this.ancestorDistances(repo, b);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const [oid, da] of fromA) {
      const db = fromB.get(oid);
      if (db === undefined) continue;
      if (da + db < bestScore) {
        bestScore = da + db;
        best = oid;
      }
    }
    return best;
  }

  /** Commits reachable from `tip`, newest first (timestamp, then BFS depth). */
  listCommits(repo: RepoRec, tip: string): Array<{ sha: string; view: CommitView }> {
    const depth = this.ancestorDistances(repo, tip);
    const out: Array<{ sha: string; view: CommitView }> = [];
    for (const sha of depth.keys()) {
      const view = this.commitView(repo, sha);
      if (view !== undefined) out.push({ sha, view });
    }
    const stamp = (view: CommitView): number => {
      const match = / (\d+) [+-]\d{4}$/.exec(view.committer);
      return match ? Number(match[1]) : 0;
    };
    out.sort((x, y) => stamp(y.view) - stamp(x.view) || depth.get(x.sha)! - depth.get(y.sha)! || (x.sha < y.sha ? -1 : 1));
    return out;
  }
}
