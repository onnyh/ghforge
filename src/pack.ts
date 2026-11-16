/**
 * pack.ts — packfile reading and writing.
 *
 * Reading resolves OFS_DELTA and REF_DELTA entries (including thin packs,
 * whose bases are looked up in the caller's store) and verifies every
 * object's size and the pack's SHA-1 trailer. Writing emits plain,
 * undeltified objects: any conforming reader accepts them, and correctness
 * never depends on a delta encoder.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType } from './gitobj.ts';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

// ---------------------------------------------------------------- writing

function objectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile holding the given objects, in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(objectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta stream to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, delta expects ${sourceSize}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length || written + literal > targetSize) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------- reading

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: GitObject;
  oid?: string;
}

function readEntryHeader(pack: Buffer, start: number): { size: number; typeCode: number; next: number; first: number } {
  if (start >= pack.length) throw new Error('pack entry header is truncated');
  let byte = pack[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= pack.length) throw new Error('pack entry size varint is truncated');
    byte = pack[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset, first };
}

function readOfsBase(pack: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= pack.length) throw new Error('ofs-delta base offset is truncated');
  let byte = pack[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= pack.length) throw new Error('ofs-delta base offset is truncated');
    byte = pack[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(pack: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error(`zlib stream at pack offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a packfile and resolve every object. `resolveBase` supplies objects a
 * thin pack assumes the receiver already holds (REF_DELTA bases).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (trailer !== packChecksum(pack)) throw new Error('pack checksum does not match its bytes');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(pack, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size does not match its inflated bytes');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved !== undefined && entry.oid !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = byOid.get(wanted);
      const base = baseEntry !== undefined ? resolve(baseEntry) : resolveBase?.(wanted);
      if (base === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    entry.resolved = object;
    entry.oid = hashObject(object.type, object.data);
    byOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return object;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    objects.set(entry.oid!, object);
  }
  return { objects, count: declared };
}
