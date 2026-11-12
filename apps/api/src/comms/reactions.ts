// Texting reactions in the inbound transaction and the timeline (owner decision D5b; R-REACT-2 … R-REACT-6;
// E300–E308). VERIFY WITH COUNSEL (R-CONSENT-8, R-CONSENT-11, R-CHAN-3, D5b).
//
// readReactionInTx runs inside ingestion step 5 for an SMS without media, after the inbound row is stored and before
// the consent side is planned. A body that is not a reaction form costs no query. Otherwise the candidate team texts
// are loaded with exactly the bounds of the DB guard app.message_reactions_guard (same contact, non-imported outbound
// sms/mms from the number the reaction came in on to the reaction's sender, at least dispatching and not failed,
// dispatched before the reaction, created in the 30 days before it), core decides the link, and the link and its
// audit are written inside a SAVEPOINT. A refused write is audited `consent.reaction_link_refused` and the text is
// classified exactly as before; a deadlock or serialization failure is rethrown so withTenantTx retries the whole
// ingestion. CommsDeps has no logger, which is why the refusal goes to audit.
import {
  type InboundClassification,
  type Keywords,
  type ParsedReaction,
  type ReactionAction,
  type ReactionName,
  REACTION_MAX_CANDIDATES,
  REACTION_WINDOW_DAYS,
  classifyWithReaction,
  foldReactions,
  parseReaction,
  reactionPhrase,
} from '@realty/core/compliance';
import type { IdGenerator, Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, isRetryable } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import type { ClaimSpec } from './repos/automation.js';

const QUOTE_CODE_POINTS = 120;
const RAW_CODE_POINTS = 1600;
const CLAIM_SNIPPET = 280;

/** The team text's first 120 code points, plus "…" when cut (the copy's quote). */
export function quoteForCopy(body: string): string {
  const cps = [...body];
  return cps.length > QUOTE_CODE_POINTS ? `${cps.slice(0, QUOTE_CODE_POINTS).join('')}…` : body;
}

export interface ReactionRead {
  /** What the inbound pipeline acts on: the reaction's own words. */
  classification: InboundClassification;
  /** The whole text's reading (stored as whole_text_reading). */
  wholeText: InboundClassification;
  reaction: ParsedReaction & { targetMessageId: string };
  /** The whole text would have read as STOP, START, HELP, a wrong number or opt-out language. */
  narrowed: boolean;
  /** The team text quoted, for the copy (quoteForCopy). */
  quote: string;
}

let savepoints = 0;

/**
 * R-REACT-2, R-REACT-3, R-REACT-5: the reaction a stored inbound SMS is, linked and audited, or null (classify the
 * text exactly as before). `occurredAt` is the reaction row's own occurred_at.
 */
export async function readReactionInTx(
  tx: Tx,
  actor: SystemActor,
  i: { messageId: string; contactId: string; from: string; phoneNumberId: string; body: string; keywords: Keywords; occurredAt: Instant; ids: IdGenerator },
): Promise<ReactionRead | null> {
  if (parseReaction(i.body) === null) return null;
  const at = toIso(i.occurredAt);
  const sent = (
    await sql<{ id: string; body: string }>`
      SELECT id, body FROM messages
       WHERE tenant_id = app.tenant_id() AND contact_id = ${i.contactId} AND direction = 'outbound' AND NOT imported
         AND channel IN ('sms','mms') AND to_address = ${i.from} AND phone_number_id = ${i.phoneNumberId}
         AND status IN ('dispatching','sent','delivered','dispatch_unknown')
         AND occurred_at >= ${at}::timestamptz - make_interval(days => ${REACTION_WINDOW_DAYS}) AND dispatched_at <= ${at}::timestamptz
       ORDER BY occurred_at DESC, id DESC LIMIT ${REACTION_MAX_CANDIDATES}`.execute(tx)
  ).rows;
  const r = classifyWithReaction(i.body, i.keywords, 'sms', sent);
  if (r.reaction === null) return null;
  const reaction = r.reaction;
  savepoints = (savepoints + 1) % 1_000_000;
  const name = sql.raw(`sms_reaction_${savepoints}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    await sql`
      INSERT INTO message_reactions (tenant_id, id, message_id, target_message_id, action, reaction, emoji, whole_text_reading)
      VALUES (app.tenant_id(), ${i.ids.next<'MessageReactionId'>()}, ${i.messageId}, ${reaction.targetMessageId}, ${reaction.action},
              ${reaction.reaction}, ${reaction.emoji}, ${r.wholeText.kind})`.execute(tx);
    if (r.wholeText.kind !== 'none' && r.classification.kind === 'none') {
      await audit(tx, actor, { action: 'consent.reaction_quote_not_read', entity: { type: 'message', id: i.messageId }, reason: r.wholeText.kind.toUpperCase() });
    }
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    if (isRetryable(err)) throw err;
    const msg = (err as { message?: string }).message ?? '';
    const reason = /\b(REACTION_[A-Z_]+)\b/.exec(msg)?.[1] ?? (err as { code?: string }).code ?? 'UNKNOWN';
    await audit(tx, actor, { action: 'consent.reaction_link_refused', entity: { type: 'message', id: i.messageId }, reason });
    return null;
  }
  const target = sent.find((s) => s.id === reaction.targetMessageId)!;
  return { classification: r.classification, wholeText: r.wholeText, reaction, narrowed: r.wholeText.kind !== 'none', quote: quoteForCopy(target.body) };
}

// ---- copy (R-REACT-4: only the copy differs from a reply; never "your text") -------------------------------------

export interface ReactionCopy {
  claim: ClaimSpec;
  explanation: string;
  title: string;
}

/** The handback claim, the handback explanation and the notification title for a linked reaction. */
export function reactionCopy(rx: ReactionRead, o: { firstName: string | null; label: string | null; body: string; messageId: string; ids: IdGenerator }): ReactionCopy {
  const who = o.firstName ?? 'They';
  const removed = rx.reaction.action === 'remove';
  const snippet = o.body.slice(0, CLAIM_SNIPPET);
  const claim: ClaimSpec = {
    id: o.ids.next(),
    kind: 'fact',
    text: `${who} ${reactionPhrase(rx.reaction)} “${rx.quote}”.`,
    evidence: { id: o.ids.next(), sourceType: 'message', sourceId: o.messageId, locator: { kind: 'message' }, snippet },
  };
  let explanation = removed
    ? `${who} removed a reaction from a text, so the assistant paused and handed the conversation back to you.`
    : `${who} reacted to a text, so the assistant paused and handed the conversation back to you.`;
  if (rx.narrowed) explanation += ` The words in quotes come from a text sent to ${who === 'They' ? 'them' : who}, so they were not read as an opt-out or a wrong number.`;
  return { claim, explanation, title: reactionTitle(rx, o.label) };
}

/** Both notification titles (handback and unanswered inbound): kinds, priorities, bodies and dedupe keys unchanged. */
export function reactionTitle(rx: ReactionRead, label: string | null): string {
  const title = rx.reaction.action === 'remove' ? `${label ?? 'A client'} removed a reaction from a text` : `${label ?? 'A client'} reacted to a text`;
  return rx.narrowed ? `${title}. Not read as an opt-out or a wrong number: check it` : title;
}

// ---- timeline (R-REACT-5: under the caller's RLS; R-REACT-6) -----------------------------------------------------

export interface TimelineReaction {
  action: ReactionAction;
  reaction: ReactionName;
  emoji: string | null;
  targetMessageId: string;
  quote: string;
  raw: string;
  narrowed: boolean;
}

export interface TimelineReactedWith {
  reaction: ReactionName;
  emoji: string | null;
  at: string;
}

export interface ReactionExtras {
  reaction: Map<string, TimelineReaction>;
  reactedWith: Map<string, TimelineReactedWith>;
}

/** For one page of timeline message ids: the reactions they are, and the reaction in force on each. Two queries. */
export async function reactionExtras(tx: Tx, messageIds: readonly string[]): Promise<ReactionExtras> {
  const out: ReactionExtras = { reaction: new Map(), reactedWith: new Map() };
  if (messageIds.length === 0) return out;
  const ids = [...messageIds];
  const own = await sql<{ message_id: string; target_message_id: string; action: ReactionAction; reaction: ReactionName; emoji: string | null; whole_text_reading: string; target_body: string; raw: string }>`
    SELECT mr.message_id, mr.target_message_id, mr.action, mr.reaction, mr.emoji, mr.whole_text_reading, t.body AS target_body, m.body AS raw
      FROM message_reactions mr
      JOIN messages m ON m.tenant_id = mr.tenant_id AND m.id = mr.message_id
      JOIN messages t ON t.tenant_id = mr.tenant_id AND t.id = mr.target_message_id
     WHERE mr.tenant_id = app.tenant_id() AND mr.message_id = ANY(${ids}::uuid[])`.execute(tx);
  for (const r of own.rows) {
    out.reaction.set(r.message_id, {
      action: r.action,
      reaction: r.reaction,
      emoji: r.emoji,
      targetMessageId: r.target_message_id,
      quote: quoteForCopy(r.target_body),
      raw: [...r.raw].slice(0, RAW_CODE_POINTS).join(''),
      narrowed: r.whole_text_reading !== 'none',
    });
  }
  const on = await sql<{ target_message_id: string; action: ReactionAction; reaction: ReactionName; emoji: string | null; occurred_at: Date }>`
    SELECT mr.target_message_id, mr.action, mr.reaction, mr.emoji, m.occurred_at
      FROM message_reactions mr
      JOIN messages m ON m.tenant_id = mr.tenant_id AND m.id = mr.message_id
     WHERE mr.tenant_id = app.tenant_id() AND mr.target_message_id = ANY(${ids}::uuid[])
     ORDER BY m.occurred_at, m.id`.execute(tx);
  const byTarget = new Map<string, typeof on.rows>();
  for (const r of on.rows) byTarget.set(r.target_message_id, [...(byTarget.get(r.target_message_id) ?? []), r]);
  for (const [target, events] of byTarget) {
    const f = foldReactions(events);
    if (f) out.reactedWith.set(target, { reaction: f.reaction, emoji: f.emoji, at: f.occurred_at.toISOString() });
  }
  return out;
}
