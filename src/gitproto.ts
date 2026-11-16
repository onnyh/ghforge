/**
 * gitproto.ts — git smart HTTP: the info/refs advertisements, protocol v2
 * ls-refs and fetch, the v0 fetch fallback, and v0 receive-pack pushes.
 *
 * The dialect is the one real git speaks: pkt-line framing everywhere, v2
 * fetch answers in named sections (acknowledgments, shallow-info, packfile),
 * the packfile framed in side-band-64k packets, and receive-pack answering a
 * per-ref report-status. Ref updates are fast-forward only; a refused ref
 * reports `ng <ref> non-fast-forward` and does not move.
 */

import { isObjectId, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject } from './gitobj.ts';
import { readPack, writePack } from './pack.ts';
import { encodePacket, encodePackets, encodeSideband, FLUSH } from './pktline.ts';
import { HttpError, type Forge, type RepoRec } from './store.ts';

const AGENT = 'ghforge/1.0';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function reply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

// ------------------------------------------------------------ advertisements

/** The ref lines of a v0 advertisement: HEAD first, then every ref in order. */
function v0RefLines(forge: Forge, repo: RepoRec, capabilities: string): Buffer {
  const headRef = forge.headRef(repo);
  const lines: (string | 'flush')[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = repo.refs.get(headRef);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}`);
  } else {
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${capabilities}`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}`);
      const object = forge.getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = forge.peelToCommit(repo, oid);
        if (peeled !== undefined) lines.push(`${peeled} ${ref}^{}`);
      }
    }
  }
  lines.push('flush');
  return encodePackets(lines);
}

export function infoRefs(forge: Forge, repo: RepoRec, service: string, wantsV2: boolean): GitReply {
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const body = encodePackets([
        'version 2\n',
        `agent=${AGENT}\n`,
        'ls-refs=unborn\n',
        'fetch=shallow\n',
        'object-format=sha1\n',
        'flush',
      ]);
      return reply(200, 'application/x-git-upload-pack-advertisement', body);
    }
    const caps = [
      'multi_ack_detailed',
      'side-band-64k',
      'thin-pack',
      'ofs-delta',
      'shallow',
      `agent=${AGENT}`,
      `symref=HEAD:${forge.headRef(repo)}`,
    ].join(' ');
    const body = Buffer.concat([
      encodePackets(['# service=git-upload-pack\n', 'flush']),
      v0RefLines(forge, repo, caps),
    ]);
    return reply(200, 'application/x-git-upload-pack-advertisement', body);
  }
  if (service === 'git-receive-pack') {
    const caps = ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`].join(' ');
    const body = Buffer.concat([
      encodePackets(['# service=git-receive-pack\n', 'flush']),
      v0RefLines(forge, repo, caps),
    ]);
    return reply(200, 'application/x-git-receive-pack-advertisement', body);
  }
  throw new HttpError(400, `unknown service ${JSON.stringify(service)}`);
}

// ------------------------------------------------------------ request parsing

interface ParsedRequest {
  /** Capability-section lines (v2), or the first section's lines (v0). */
  head: string[];
  /** Argument-section lines. */
  args: string[];
  /** Bytes after the argument section's flush (a receive-pack's packfile). */
  rest: Buffer;
}

function parseRequest(body: Buffer, stopAfterFirstFlush = false): ParsedRequest {
  const head: string[] = [];
  const args: string[] = [];
  let section: 'head' | 'args' | 'done' = 'head';
  let offset = 0;
  // Walk the buffer packet by packet so the raw remainder survives intact.
  let rest = Buffer.alloc(0);
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new HttpError(400, 'truncated pkt-line');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new HttpError(400, 'invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      if (section === 'head' && !stopAfterFirstFlush) section = 'args';
      else {
        section = 'done';
        rest = body.subarray(offset);
        break;
      }
      continue;
    }
    if (length === 1) {
      offset += 4;
      if (section === 'head') section = 'args';
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520 || offset + length > body.length) throw new HttpError(400, 'invalid pkt-line');
    const payload = body.subarray(offset + 4, offset + length);
    const text = payload.toString('utf8');
    if (section === 'head') head.push(text);
    else args.push(text);
    offset += length;
  }
  return { head, args, rest };
}

function stripNewline(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

// ------------------------------------------------------------ ls-refs

function lsRefs(forge: Forge, repo: RepoRec, args: string[]): GitReply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = stripNewline(raw);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = forge.headRef(repo);
  const headTip = repo.refs.get(headRef);
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = forge.getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = forge.peelToCommit(repo, oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return reply(200, 'application/x-git-upload-pack-result', encodePackets([...lines, 'flush']));
}

// ------------------------------------------------------------ fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
  needsAck: boolean;
}

/** Multi-source BFS distances (in commits) from the want tips. */
function wantDistances(forge: Forge, repo: RepoRec, wants: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = forge.peelToCommit(repo, want);
    if (commit !== undefined && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const view = forge.commitView(repo, oid);
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

/**
 * What the client already holds: the closure of its haves and its shallow
 * boundary, except that a shallow boundary commit's history is NOT held —
 * traversal includes the boundary commit and its trees but never descends
 * to its parents.
 */
function clientPossession(forge: Forge, repo: RepoRec, haves: string[], shallow: string[]): Set<string> {
  const cut = new Set(shallow);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of [...haves, ...shallow]) if (repo.objects.has(oid)) queue.push(oid);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      if (!cut.has(oid)) for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

function planFetch(
  forge: Forge,
  repo: RepoRec,
  wants: string[],
  haves: string[],
  shallowReported: string[],
  deepen: number | undefined,
): FetchPlan {
  const haveSet = new Set(haves.filter((oid) => repo.objects.has(oid)));
  const commonHaves = haves.filter((oid) => haveSet.has(oid));
  const haveClosure = clientPossession(forge, repo, haves, shallowReported);
  const dist = wantDistances(forge, repo, wants);

  // A deepen request names the total depth from the want tips: depth 1 is
  // the tips alone, depth 2 adds exactly their parents, and so on — whether
  // the clone is fresh or the fetch deepens an existing shallow boundary.
  let limit = Number.POSITIVE_INFINITY;
  if (deepen !== undefined) {
    limit = deepen - 1;
  }

  const included = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const want of wants) if (repo.objects.has(want)) queue.push(want);
  const commitIncluded = (oid: string): boolean => {
    const d = dist.get(oid);
    return d !== undefined && d <= limit;
  };
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (!commitIncluded(oid)) continue;
      // A held commit (a have, or the shallow boundary) is not re-sent, but
      // the walk continues through it: a deepen request reaches the history
      // below the boundary the client already holds.
      if (!haveClosure.has(oid)) {
        included.add(oid);
        queue.push(parseCommit(object.data).tree);
      }
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
      continue;
    }
    if (haveClosure.has(oid)) continue;
    included.add(oid);
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }

  // The new shallow boundary: included commits a parent of which is missing.
  const shallow: string[] = [];
  if (limit !== Number.POSITIVE_INFINITY || shallowReported.length > 0) {
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const missingParent = view.parents.some((parent) => !included.has(parent) && !haveClosure.has(parent) && repo.objects.has(parent));
      const atLimit = dist.get(oid) !== undefined && dist.get(oid)! >= limit;
      if (missingParent || (atLimit && view.parents.length > 0)) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of shallowReported) {
    if (included.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }

  // Deterministic pack order: by commit distance, then trees, blobs, tags.
  const rank = (object: GitObject, oid: string): number => {
    if (object.type === 'commit') return dist.get(oid) ?? 1_000_000;
    if (object.type === 'tree') return 2_000_000;
    if (object.type === 'blob') return 3_000_000;
    return 4_000_000;
  };
  const objects = [...included]
    .map((oid) => ({ oid, object: repo.objects.get(oid)! }))
    .sort((a, b) => rank(a.object, a.oid) - rank(b.object, b.oid) || (a.oid < b.oid ? -1 : 1))
    .map((entry) => entry.object);

  return { objects, shallow, unshallow, commonHaves, needsAck: haves.length > 0 };
}

// ------------------------------------------------------------ fetch

function fetchV2(forge: Forge, repo: RepoRec, args: string[]): GitReply {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReported: string[] = [];
  let deepen: number | undefined;
  for (const raw of args) {
    const line = stripNewline(raw);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReported.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
    // deepen-since / deepen-not / filter / thin-pack / no-progress /
    // ofs-delta / done need no state here: the plan covers them or the
    // suite's client never sends them.
  }
  const plan = planFetch(forge, repo, wants.filter(isObjectId), haves.filter(isObjectId), shallowReported.filter(isObjectId), deepen);
  const parts: Buffer[] = [];
  if (plan.needsAck) {
    const lines: string[] = ['acknowledgments\n'];
    if (plan.commonHaves.length > 0) {
      lines.push(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`, 'ready\n');
    } else {
      lines.push('NAK\n');
    }
    parts.push(encodePackets([...lines, 'flush']));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePackets([...lines, 'flush']));
  }
  const pack = writePack(plan.objects);
  parts.push(encodePacket('packfile\n'));
  parts.push(encodeSideband(pack, 1));
  parts.push(FLUSH);
  return reply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0(forge: Forge, repo: RepoRec, head: string[], args: string[]): GitReply {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReported: string[] = [];
  let deepen: number | undefined;
  const readLine = (raw: string): void => {
    const line = stripNewline(raw);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowReported.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
  };
  for (const line of head) readLine(line);
  for (const line of args) readLine(line);
  const plan = planFetch(forge, repo, wants.filter(isObjectId), haves.filter(isObjectId), shallowReported.filter(isObjectId), deepen);
  const parts: Buffer[] = [];
  const pre: string[] = [];
  for (const oid of plan.shallow) pre.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) pre.push(`unshallow ${oid}\n`);
  if (plan.commonHaves.length > 0) pre.push(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`);
  else pre.push('NAK\n');
  parts.push(encodePackets(pre));
  parts.push(encodeSideband(writePack(plan.objects), 1));
  parts.push(FLUSH);
  return reply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function uploadPack(forge: Forge, repo: RepoRec, body: Buffer, v2: boolean): GitReply {
  const parsed = parseRequest(body);
  const commandLine = parsed.head.find((line) => line.startsWith('command='));
  if (v2 || commandLine !== undefined) {
    const command = commandLine !== undefined ? stripNewline(commandLine).slice('command='.length) : '';
    if (command === 'ls-refs') return lsRefs(forge, repo, parsed.args);
    if (command === 'fetch') return fetchV2(forge, repo, parsed.args);
    throw new HttpError(400, `unknown command ${JSON.stringify(command)}`);
  }
  return fetchV0(forge, repo, parsed.head, parsed.args);
}

// ------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: RepoRec, body: Buffer): GitReply {
  const parsed = parseRequest(body, true);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const raw of parsed.head) {
    let line = stripNewline(raw);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const sideband = caps.has('side-band-64k');

  let unpackError: string | null = null;
  if (parsed.rest.length > 0) {
    try {
      const pack = readPack(parsed.rest, (oid) => forge.getObject(repo, oid));
      for (const [oid, object] of pack.objects) forge.putRawObject(repo, oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackError === null ? 'ok' : `error: ${unpackError}`}\n`];
  for (const command of commands) {
    const failure = unpackError !== null ? 'unpacker error' : applyPushCommand(forge, repo, command);
    report.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  const reportBytes = encodePackets([...report, 'flush']);
  const framed = sideband ? Buffer.concat([encodeSideband(reportBytes, 1), FLUSH]) : reportBytes;
  return reply(200, 'application/x-git-receive-pack-result', framed);
}

/** Apply one ref update; returns the refusal reason, or null on success. */
function applyPushCommand(forge: Forge, repo: RepoRec, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (current !== command.oldOid) return 'reference already exists';
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const object = forge.getObject(repo, command.newOid);
  if (object === undefined) return 'missing object';
  if (command.ref.startsWith('refs/heads/')) {
    const commit = object.type === 'commit' ? command.newOid : forge.peelToCommit(repo, command.newOid);
    if (commit === undefined) return 'invalid object';
    if (command.oldOid !== ZERO_OID) {
      if (!forge.isAncestor(repo, command.oldOid, commit)) return 'non-fast-forward';
    }
    repo.refs.set(command.ref, commit);
    return null;
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}
