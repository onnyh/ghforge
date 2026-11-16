/**
 * trees.ts — working with the trees of a repository: reading a path, listing
 * a directory, writing or deleting a file (rebuilding the tree chain and
 * committing), diffing two trees file by file, and the three-way tree merge
 * pull requests land through.
 */

import { buildTree, parseTree, type TreeEntry } from './gitobj.ts';
import { HttpError, type Forge, type RepoRec } from './store.ts';

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (and gitlink) under a tree, keyed by its slash path. */
export function flattenTree(forge: Forge, repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = forge.getObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(forge, repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The tree or blob entry at `path` under `treeOid`, or undefined. */
export function entryAtPath(forge: Forge, repo: RepoRec, treeOid: string, path: string): TreeEntry | undefined {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = forge.getObject(repo, current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return undefined;
    if (index === parts.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** The entries of the directory at `path` ('' is the root), or undefined. */
export function listDir(forge: Forge, repo: RepoRec, treeOid: string, path: string): TreeEntry[] | undefined {
  if (path === '') {
    const object = forge.getObject(repo, treeOid);
    if (object === undefined || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }
  const entry = entryAtPath(forge, repo, treeOid, path);
  if (entry === undefined || entry.mode !== '40000') return undefined;
  const object = forge.getObject(repo, entry.oid);
  if (object === undefined || object.type !== 'tree') return undefined;
  return parseTree(object.data);
}

/** A tree with `path` set to (mode, oid) — or removed when oid is null. */
function setPath(forge: Forge, repo: RepoRec, treeOid: string | undefined, parts: string[], leaf: { mode: string; oid: string } | null): string {
  const entries: TreeEntry[] = treeOid === undefined ? [] : parseTree(forge.getObject(repo, treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = parts;
  const existingIndex = entries.findIndex((entry) => entry.name === head);
  const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
  if (rest.length === 0) {
    if (leaf === null) {
      if (existingIndex >= 0) entries.splice(existingIndex, 1);
    } else if (existing !== undefined) {
      entries[existingIndex] = { mode: leaf.mode, name: head, oid: leaf.oid };
    } else {
      entries.push({ mode: leaf.mode, name: head, oid: leaf.oid });
    }
  } else {
    const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : undefined;
    const newChild = setPath(forge, repo, childTree, rest, leaf);
    const childObject = forge.getObject(repo, newChild);
    const childEmpty = childObject !== undefined && childObject.type === 'tree' && childObject.data.length === 0;
    if (childEmpty && leaf === null) {
      if (existingIndex >= 0) entries.splice(existingIndex, 1);
    } else if (existing !== undefined) {
      entries[existingIndex] = { mode: '40000', name: head, oid: newChild };
    } else {
      entries.push({ mode: '40000', name: head, oid: newChild });
    }
  }
  return forge.putObject(repo, 'tree', buildTree(entries));
}

/**
 * Commit a file write (or delete, when content is null) on a branch, creating
 * the branch from the default branch's tip when it does not exist yet.
 * Returns the new commit's id.
 */
export function commitFileChange(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    const fallback = repo.refs.get(forge.headRef(repo));
    if (fallback !== undefined && branch !== repo.defaultBranch) tip = fallback;
  }
  const tipTree = tip === undefined ? undefined : forge.commitView(repo, tip)?.tree;
  let blobSha: string | null = null;
  let leaf: { mode: string; oid: string } | null = null;
  if (content !== null) {
    blobSha = forge.putObject(repo, 'blob', content);
    const existing = tipTree === undefined ? undefined : entryAtPath(forge, repo, tipTree, path);
    leaf = { mode: existing !== undefined && existing.mode !== '40000' ? existing.mode : '100644', oid: blobSha };
  }
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) throw new HttpError(422, 'Validation Failed: path must name a file');
  const newTree = setPath(forge, repo, tipTree, parts, leaf);
  const commitSha = forge.createCommit(repo, newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- diffs

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a change: a longest-common-subsequence diff for small files. */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) {
    // Too large for a quadratic table: count it as a full rewrite.
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const common = table[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file-level diff between two trees (either may be undefined = empty). */
export function diffTrees(forge: Forge, repo: RepoRec, baseTree: string | undefined, headTree: string | undefined): FileChange[] {
  const baseFiles = baseTree === undefined ? new Map<string, FlatEntry>() : flattenTree(forge, repo, baseTree);
  const headFiles = headTree === undefined ? new Map<string, FlatEntry>() : flattenTree(forge, repo, headTree);
  const changes: FileChange[] = [];
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined) {
      if (before.oid === after.oid) continue;
      const oldData = forge.getObject(repo, before.oid)?.data ?? Buffer.alloc(0);
      const newData = forge.getObject(repo, after.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = lineDiff(oldData, newData);
      changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    } else if (after !== undefined) {
      const newData = forge.getObject(repo, after.oid)?.data ?? Buffer.alloc(0);
      const additions = splitLines(newData).length;
      changes.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined) {
      const oldData = forge.getObject(repo, before.oid)?.data ?? Buffer.alloc(0);
      const deletions = splitLines(oldData).length;
      changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  return changes;
}

// ---------------------------------------------------------------- merges

export interface MergeOutcome {
  tree: string;
  conflicts: string[];
}

/**
 * A three-way merge of two trees against their common ancestor's tree.
 * A path both sides changed differently (or one side deleted while the other
 * changed) is a conflict; every other path takes the side that changed it.
 */
export function mergeTrees(
  forge: Forge,
  repo: RepoRec,
  baseTree: string | undefined,
  oursTree: string | undefined,
  theirsTree: string | undefined,
  prefix = '',
): MergeOutcome {
  const read = (tree: string | undefined): Map<string, TreeEntry> => {
    const map = new Map<string, TreeEntry>();
    if (tree === undefined) return map;
    const object = forge.getObject(repo, tree);
    if (object === undefined || object.type !== 'tree') return map;
    for (const entry of parseTree(object.data)) map.set(entry.name, entry);
    return map;
  };
  const base = read(baseTree);
  const ours = read(oursTree);
  const theirs = read(theirsTree);
  const names = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])];
  const out: TreeEntry[] = [];
  const conflicts: string[] = [];
  const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
    a === b || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
  for (const name of names) {
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (same(o, t)) {
      if (o !== undefined) out.push(o);
      continue;
    }
    if (same(b, o)) {
      if (t !== undefined) out.push(t);
      continue;
    }
    if (same(b, t)) {
      if (o !== undefined) out.push(o);
      continue;
    }
    // Both sides changed the path in different ways.
    if (o !== undefined && t !== undefined && o.mode === '40000' && t.mode === '40000') {
      const sub = mergeTrees(forge, repo, b?.oid, o.oid, t.oid, path);
      conflicts.push(...sub.conflicts);
      out.push({ mode: '40000', name, oid: sub.tree });
      continue;
    }
    conflicts.push(path);
    if (o !== undefined) out.push(o);
  }
  return { tree: forge.putObject(repo, 'tree', buildTree(out)), conflicts };
}
