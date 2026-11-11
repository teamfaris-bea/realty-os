// Keyset cursors for list pages (R-PAR-29: 50 per page). A cursor is the last row's sort key and id,
// as opaque base64url JSON. Decoding validates the shape strictly; the values are bound parameters.
import type { ListSort } from './definition.js';

export const LIST_PAGE_SIZE = 50;
/** Counts are exact to 10,000, then "10,000+". */
export const LIST_COUNT_CAP = 10_000;

export interface ListCursor {
  sort: ListSort;
  /** The sort key of the last row: an ISO instant, a lower-cased name, or null (nulls sort last). */
  key: string | null;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9_-]{1,3000}$/;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

function fromB64url(s: string): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('bad cursor');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

function asciiBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

export function encodeCursor(c: ListCursor): string {
  return toB64url(asciiBytes(encodeURIComponent(JSON.stringify([c.sort, c.key, c.id]))));
}

/** The cursor, or null when it is malformed or was made for another sort. */
export function decodeCursor(s: string, sort: ListSort): ListCursor | null {
  if (!B64_RE.test(s)) return null;
  try {
    const v: unknown = JSON.parse(decodeURIComponent(String.fromCharCode(...fromB64url(s))));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [srt, key, id] = v as unknown[];
    if (srt !== sort || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    if (key !== null && (typeof key !== 'string' || key.length > 400)) return null;
    if (key !== null && sort !== 'name_asc' && Number.isNaN(Date.parse(key))) return null;
    return { sort, key, id: id.toLowerCase() };
  } catch {
    return null;
  }
}
