// Mentions in a note body (R-PAR-2, R-PAR-3). A mention is the token `@[Label](<user uuid>)`. The
// label is display text only and is never trusted: the UI renders the member's current name from the
// id. parseMentions returns the mentioned member ids: deduped, self dropped, non-members dropped, at
// most 10 (more is MENTION_LIMIT). Who is actually notified is decided later, as each mentioned user
// under their own RLS; a mention never grants access.
import type { UserId } from '../../foundation/ids.js';

export const MAX_MENTIONS = 10;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TOKEN_SOURCE = `@\\[([^\\]\\n]{1,80})\\]\\((${UUID})\\)`;

export interface MentionToken {
  userId: UserId;
  label: string;
  start: number;
  end: number;
}

/** Every mention token in order (no filtering). */
export function mentionTokens(body: string): MentionToken[] {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const out: MentionToken[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out.push({ userId: m[2]!.toLowerCase() as UserId, label: m[1]!, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The token text for a member (labels lose characters that would break the token). */
export function mentionToken(userId: string, label: string): string {
  const safe = label.replace(/[[\]\n()]/g, '').trim().slice(0, 80) || 'member';
  return `@[${safe}](${userId.toLowerCase()})`;
}

export type MentionResult = { ok: true; userIds: UserId[] } | { ok: false; code: 'MENTION_LIMIT'; count: number };

/** Mentioned members (deduped, self dropped, unknown ids dropped), at most MAX_MENTIONS. */
export function parseMentions(body: string, ids: { members: Iterable<string>; self: string }): MentionResult {
  const members = new Set([...ids.members].map((x) => x.toLowerCase()));
  const self = ids.self.toLowerCase();
  const seen = new Set<string>();
  const out: UserId[] = [];
  for (const t of mentionTokens(body)) {
    if (t.userId === self || !members.has(t.userId) || seen.has(t.userId)) continue;
    seen.add(t.userId);
    out.push(t.userId);
  }
  if (out.length > MAX_MENTIONS) return { ok: false, code: 'MENTION_LIMIT', count: out.length };
  return { ok: true, userIds: out };
}

/** E164: on an edit, only people not mentioned before are checked and notified. */
export function addedMentions(before: readonly string[], after: readonly string[]): UserId[] {
  const b = new Set(before.map((x) => x.toLowerCase()));
  return after.filter((x) => !b.has(x.toLowerCase())) as UserId[];
}

/** The body with tokens shown as `@Name` (names from the directory; the token label otherwise). */
export function renderMentions(body: string, nameOf: (userId: UserId) => string | null = () => null): string {
  let out = '';
  let at = 0;
  for (const t of mentionTokens(body)) {
    out += body.slice(at, t.start) + '@' + (nameOf(t.userId) ?? t.label);
    at = t.end;
  }
  return out + body.slice(at);
}

/**
 * R-PAR-3: the mention notification's title. Never note text: at most the person's first name and last
 * initial (null when the tenant's notification_detail is 'none').
 */
export function mentionTitle(personLabel: string | null): string {
  return personLabel ? `You were mentioned in a note on ${personLabel}` : 'You were mentioned in a note';
}

/** R-PAR-3: one notification per note per user. */
export function mentionDedupeKey(noteId: string): string {
  return `mention:${noteId}`;
}
