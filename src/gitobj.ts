/**
 * gitobj.ts — the git object model: hashing, parsing and building of commit,
 * tree, blob and tag objects, byte-for-byte the way git itself computes them.
 *
 * An object id is the SHA-1 of `<type> <size>\0` followed by the raw content.
 * Trees store entries as `<mode> <name>\0<20 raw id bytes>`, sorted by name
 * with directories compared as if their name ended in '/'. Commits and tags
 * are header lines, a blank line, then the message.
 */

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return typeof value === 'string' && HEX40.test(value);
}

/** SHA-1 over the loose-object framing of `data`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: entry without mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: truncated entry');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: bytewise by name, a subtree compared as `name/`. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** The epoch seconds a commit header line (`Name <mail> 1700000000 +0000`) carries, or 0. */
export function headerTimestamp(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number(match[1]) : 0;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export function buildCommit(fields: CommitFields): Buffer {
  const who = `${fields.authorName} <${fields.authorEmail}> ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- tags

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    else if (key === 'tagger') view.tagger = value;
  }
  return view;
}

/** Follow tag objects until a non-tag object; returns that object's id and type. */
export function peelToCommit(
  lookup: (oid: string) => GitObject | undefined,
  oid: string,
): { oid: string; type: GitObjectType } | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return { oid: current, type: object.type };
    current = parseTag(object.data).object;
    if (!isObjectId(current)) return null;
  }
  return null;
}
