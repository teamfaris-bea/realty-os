// Derived, idempotent ids of bulk work (PARITY_PLAN §4.2; R-PAR-34, R-PAR-35, R-PAR-38).
//
// A bulk item is retried after a crash or a duplicate job delivery. Every side effect it causes is keyed
// by an id derived from (action, person) or (action, address), so a retry finds the effect it already
// caused instead of causing a second one:
//   - derivedCommandId(actionId, contactId): the ownership command id of a bulk assign (the engine
//     refuses a second command with the same id);
//   - bulkSendKey(actionId, addressHmac): the message idempotency key of a bulk send (one message per
//     address per action, so two people sharing an email get one email).
//
// RFC 9562 §5.5 name-based UUID version 5 (SHA-1) under a fixed namespace for bulk work.
import { sha1 } from '@noble/hashes/legacy.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Namespace of bulk-derived ids (random, fixed forever: changing it would re-run every replayed command). */
export const BULK_ID_NAMESPACE = '6f1d2c4e-8a3b-4f57-9c2d-5e8b7a1f3c90';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidBytes(u: string): Uint8Array {
  const hex = u.toLowerCase();
  if (!UUID_RE.test(hex)) throw new TypeError(`not a UUID: ${u}`);
  const h = hex.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** UUIDv5 of `name` in `namespace` (RFC 9562 §5.5). */
export function uuidV5(namespace: string, name: string): string {
  const ns = uuidBytes(namespace);
  const nb = utf8ToBytes(name);
  const buf = new Uint8Array(ns.length + nb.length);
  buf.set(ns, 0);
  buf.set(nb, ns.length);
  const h = sha1(buf);
  const b = h.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The ownership command id of one person's item in a bulk action (case-insensitive in its inputs). */
export function derivedCommandId(actionId: string, contactId: string): string {
  return uuidV5(BULK_ID_NAMESPACE, `bulk.command:${uuidBytesHex(actionId)}:${uuidBytesHex(contactId)}`);
}

/** The message idempotency key of one address in a bulk send action (≤ 100 characters). */
export function bulkSendKey(actionId: string, addressHmacHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(addressHmacHex)) throw new TypeError('bulkSendKey: address HMAC must be 32 bytes of hex');
  return `bulk:${uuidV5(BULK_ID_NAMESPACE, `bulk.send:${uuidBytesHex(actionId)}:${addressHmacHex.toLowerCase()}`)}`;
}

function uuidBytesHex(u: string): string {
  uuidBytes(u);
  return u.toLowerCase();
}
