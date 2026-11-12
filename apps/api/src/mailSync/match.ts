// Pure helpers of module 68 (PHASE2_3_PLAN §5.4 #68; no core module: this module is the only caller and they hold
// no policy core needs). Property-tested in match.test.ts.
//
//   parseAddressList       RFC 5322 address lists (display names, quoted strings with commas, groups, comments)
//                          to normalized addresses; anything unparsable is dropped (never guessed)
//   matchMailParticipants  per matched CONFIRMED contact point: the contact's role, who sent it, and the COUNT of
//                          other recipients; never another address (R-GMAIL-5, E204, E205)
//   stripQuoted            the message's own plain text: quoted history and the signature removed (best effort),
//                          at most 20,000 characters with a truncation flag; HTML is never an input (R-GMAIL-5)
//   rfcMessageIdSha256     module 22's exact normalization (channels/rfcMessageId.ts), so dedupe matches (R-GMAIL-12)
//   gmailMessageRef        the consent-ledger citation when no copy is stored (S-D2-3, E229)
import { normalizeEmail } from '@realty/core/foundation';
import { createHash } from 'node:crypto';
export { emailHandbackKey, normalizeMessageId, rfcMessageIdSha256 } from '../channels/rfcMessageId.js';

export type Bytes32 = Buffer;
export type Role = 'from' | 'to' | 'cc' | 'bcc';

export interface RelatedEmailPoint {
  contactId: string;
  pointId: string;
  /** hex HMAC of the normalized address (contact_points.address_hmac) */
  hmac: string;
}

export interface ParticipantMatch {
  contactId: string;
  pointId: string;
  hmac: string;
  role: Role;
  sender: 'contact' | 'mailbox' | 'other';
  /** recipients (To/Cc/Bcc) other than this contact's own addresses and the mailbox: a count, never addresses */
  otherRecipientCount: number;
}

/** Splits a header value at top-level commas (outside quotes, angle brackets and comments). */
function splitTopLevel(v: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < v.length) cur += v[++i];
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (paren === 0 && ch === '<') angle++;
    else if (paren === 0 && ch === '>' && angle > 0) angle--;
    else if (ch === ',' && angle === 0 && paren === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const stripComments = (s: string): string => {
  let out = '';
  let depth = 0;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) out += s[++i];
      else if (ch === '"') quote = false;
    } else if (ch === '"' && depth === 0) {
      quote = true;
      out += ch;
    } else if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
};

/** One mailbox spec ("Name <a@b>", "a@b", "<a@b>") to its normalized address, or null. */
function addressOf(spec: string): string | null {
  const s = stripComments(spec).trim();
  if (!s) return null;
  // an addr-spec in angle brackets wins (outside a quoted display name)
  let inQuote = false;
  let lt = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && inQuote) {
      i++;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (ch === '<' && !inQuote) lt = i;
  }
  const raw = lt >= 0 ? s.slice(lt + 1, s.indexOf('>', lt) >= 0 ? s.indexOf('>', lt) : undefined) : s;
  if (/\s/.test(raw.trim()) || raw.includes('"')) return null;
  const n = normalizeEmail(raw.trim());
  return n.ok ? n.email : null;
}

/** Every address of an RFC 5322 address-list header (groups flattened); unparsable entries are dropped. */
export function parseAddressList(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const v = value.replace(/\r?\n[ \t]+/g, ' ').slice(0, 20_000);
  const out: string[] = [];
  for (let part of splitTopLevel(v).map(stripComments)) {
    // groups: "Friends: a@x, b@y;" — splitTopLevel already split at commas; strip "name:" and ";"
    const colon = topLevelColon(part);
    if (colon >= 0) part = part.slice(colon + 1);
    part = part.replace(/;\s*$/, '');
    const a = addressOf(part);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

function topLevelColon(s: string): number {
  let quote = false;
  let angle = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '<') angle++;
    else if (!quote && ch === '>') angle--;
    else if (!quote && angle === 0 && ch === ':') return i;
  }
  return -1;
}

const ROLE_RANK: Record<Role, number> = { from: 0, to: 1, cc: 2, bcc: 3 };

/**
 * Who on a message is one of the given CONFIRMED points (R-GMAIL-5). One match per contact: its strongest role
 * (from > to > cc > bcc), the point it matched under that role, who sent the message, and how many OTHER recipients
 * there were. `hmacOf` returns the hex HMAC of a normalized address; `mailboxHmac` is the mailbox's own.
 * Nothing about any other participant leaves this function but a count.
 */
export function matchMailParticipants(
  h: { from: string[]; to: string[]; cc: string[]; bcc: string[] },
  points: readonly RelatedEmailPoint[],
  hmacOf: (addr: string) => string,
  mailboxHmac: string | null = null,
): ParticipantMatch[] {
  const byHmac = new Map<string, RelatedEmailPoint[]>();
  for (const p of points) {
    const l = byHmac.get(p.hmac) ?? [];
    l.push(p);
    byHmac.set(p.hmac, l);
  }
  const roleList: [Role, string[]][] = [['from', h.from.slice(0, 1)], ['to', h.to], ['cc', h.cc], ['bcc', h.bcc]];
  const fromHmac = h.from[0] !== undefined ? hmacOf(h.from[0]) : null;
  const recipients = new Set<string>();
  for (const [role, list] of roleList) if (role !== 'from') for (const a of list) recipients.add(hmacOf(a));
  const best = new Map<string, { p: RelatedEmailPoint; role: Role }>();
  for (const [role, list] of roleList) {
    for (const a of list) {
      const hm = hmacOf(a);
      for (const p of byHmac.get(hm) ?? []) {
        const cur = best.get(p.contactId);
        if (!cur || ROLE_RANK[role] < ROLE_RANK[cur.role] || (ROLE_RANK[role] === ROLE_RANK[cur.role] && p.pointId < cur.p.pointId)) best.set(p.contactId, { p, role });
      }
    }
  }
  const out: ParticipantMatch[] = [];
  for (const [contactId, { p, role }] of best) {
    const own = new Set(points.filter((x) => x.contactId === contactId).map((x) => x.hmac));
    let others = 0;
    for (const r of recipients) if (!own.has(r) && r !== mailboxHmac) others++;
    const sender: ParticipantMatch['sender'] = role === 'from' ? 'contact' : fromHmac !== null && fromHmac === mailboxHmac ? 'mailbox' : 'other';
    out.push({ contactId, pointId: p.pointId, hmac: p.hmac, role, sender, otherRecipientCount: Math.min(others, 10_000) });
  }
  return out.sort((a, b) => (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
}

const QUOTE_INTRO = [
  /^On .{1,300}(wrote|écrit|schrieb|escribió):?\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^_{8,}\s*$/,
  /^From: .{1,300}$/,
];

/**
 * The message's own plain text (R-GMAIL-5): drops quoted lines ("> …"), everything from the first reply/forward
 * header ("On … wrote:", "-----Original Message-----", an Outlook "From:" block) and from the signature delimiter
 * ("-- "), best effort. Never adds text: the result is a prefix-subset of the input's lines. At most `max`
 * characters; `truncated` when cut.
 */
export function stripQuoted(text: string, max = 20_000): { text: string; truncated: boolean } {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '-- ' || line === '--') break;
    if (QUOTE_INTRO.some((r) => r.test(line.trim()))) {
      // an Outlook "From:" line only starts a quoted block when it is followed by a Sent:/Date: line; best effort: treat it as one
      break;
    }
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  while (kept.length > 0 && kept[0]!.trim() === '') kept.shift();
  const out = kept.join('\n');
  if (out.length <= max) return { text: out, truncated: false };
  // never cut a surrogate pair in half
  let cut = max;
  const code = out.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: out.slice(0, cut), truncated: true };
}

/** S-D2-3: the consent-ledger citation of a Gmail message when no copy is stored: sha256 hex of link id + message id. */
export function gmailMessageRef(linkId: string, gmailMessageId: string): string {
  return createHash('sha256').update(`${linkId}:${gmailMessageId}`, 'utf8').digest('hex');
}

/** Header value by name, case-insensitive (the first one). */
export function header(headers: readonly { name: string; value: string }[], name: string): string | null {
  const n = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === n) return h.value;
  return null;
}

/** Labels that are never stored (R-GMAIL-5). */
export const SKIPPED_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT'] as const;
export const isSkipped = (labelIds: readonly string[]): boolean => labelIds.some((l) => (SKIPPED_LABELS as readonly string[]).includes(l));
