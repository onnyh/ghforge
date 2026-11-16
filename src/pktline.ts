/**
 * pktline.ts — the pkt-line framing git's smart HTTP protocol speaks:
 * a 4-hex-digit length (including itself) before each payload, with 0000,
 * 0001 and 0002 as the flush, delimiter and response-end packets. No packet
 * may exceed 65520 bytes in total (git's LARGE_PACKET_MAX).
 */

export const PKT_LINE_MAX = 65520;
const PKT_PAYLOAD_MAX = PKT_LINE_MAX - 4;

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function encodePacket(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_PAYLOAD_MAX) throw new Error(`pkt-line payload of ${data.length} bytes is too large`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePackets(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else if (item === 'response-end') parts.push(RESPONSE_END);
    else parts.push(encodePacket(item));
  }
  return Buffer.concat(parts);
}

/** Decode a complete buffer; throws on anything malformed. */
export function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/**
 * Frame a byte stream as side-band-64k packets: each packet carries one band
 * byte (1 = data, 2 = progress, 3 = error) plus up to 65515 payload bytes.
 */
export function encodeSideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const bandByte = Buffer.from([band]);
  let offset = 0;
  if (data.length === 0) return Buffer.alloc(0);
  while (offset < data.length) {
    const take = Math.min(PKT_PAYLOAD_MAX - 1, data.length - offset);
    parts.push(encodePacket(Buffer.concat([bandByte, data.subarray(offset, offset + take)])));
    offset += take;
  }
  return Buffer.concat(parts);
}
