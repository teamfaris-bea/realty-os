// messages.rfc_message_id_sha256 (module 22; R-GMAIL-12, E201): the SHA-256 of a platform email's RFC 5322
// Message-ID, so module 68 can refuse a Gmail copy of the same message and both paths share one handback.
//
// Normalization (module 68 must hash exactly the same way, PHASE2_3_PLAN §5.4 #68 `rfcMessageIdSha256`): take the
// first `<…>` msg-id of the header value (folding whitespace and comments around it are ignored); without brackets
// the whole trimmed value; the id must be 3..995 printable ASCII characters with an `@`. The hash input is the id
// WITH its angle brackets, case preserved (RFC 5322: the left part is case-sensitive). Anything else is no hash: a
// row without a hash is simply not deduplicated (never a wrong match). VERIFY that Gmail returns the header verbatim.
import { createHash } from 'node:crypto';

const ID = /^[\x21-\x7e]{3,995}$/;

export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
  if (s === '' || s.length > 2000) return null;
  const bracketed = /<([^<>\s]+)>/.exec(s);
  const id = bracketed ? bracketed[1]! : s;
  if (!ID.test(id) || !id.includes('@') || /[<>]/.test(id)) return null;
  return `<${id}>`;
}

/** 32 bytes, or null when the value is not a usable Message-ID. */
export function rfcMessageIdSha256(raw: string | null | undefined): Buffer | null {
  const id = normalizeMessageId(raw);
  return id === null ? null : createHash('sha256').update(id, 'utf8').digest();
}

/** The Message-ID header of a parsed header map, whatever its case. */
export function messageIdHeader(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'message-id' && typeof v === 'string') return v;
  return null;
}

/** The handback dedupe key both platform inbound email and module 68's synced mail use (E201). */
export function emailHandbackKey(contactId: string, hash: Buffer): string {
  return `email:${contactId}:${hash.toString('hex')}`;
}
