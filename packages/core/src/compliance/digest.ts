// Canonical JSON and SHA-256 for gate inputs (R-GATE-5 determinism, R-GATE-11 inputs + digest).
//
// Canonical form: object keys sorted, `undefined` members dropped, Sets become sorted arrays,
// Maps become sorted [key, value] pairs, non-finite numbers are rejected. Two inputs that are equal
// as data always give the same bytes and so the same digest, whatever the key or set order.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type Canonical = null | boolean | number | string | Canonical[] | { [k: string]: Canonical };

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalize(v: unknown): Canonical {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
    case 'string':
      return v;
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
      return v;
    case 'object': {
      if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonicalize(x)));
      if (v instanceof Set) {
        const items = [...v].map(canonicalize);
        return items.sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
      }
      if (v instanceof Map) {
        return [...v.entries()]
          .map(([k, x]) => [canonicalize(k), canonicalize(x)] as Canonical[])
          .sort((a, b) => compareStrings(JSON.stringify(a[0]), JSON.stringify(b[0])));
      }
      const out: { [k: string]: Canonical } = {};
      for (const k of Object.keys(v as object).sort(compareStrings)) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = canonicalize(x);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof v}`);
  }
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

/** First 32 bits of SHA-256 of `s` as an unsigned integer (deterministic bucketing). */
export function hash32(s: string): number {
  const h = sha256(utf8ToBytes(s));
  return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
}
