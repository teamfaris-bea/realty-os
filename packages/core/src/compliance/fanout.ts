// Opt-out fan-out (core-compliance/3.0.0; R-CHAN-3, R-CONSENT-7, D-OPTOUT-LANG; E155). Messenger/Instagram
// DMs are out of scope (owner scope change D2), so R-CHAN-4's DM keyword rule and E74/E76 do not apply here.
//
// One function turns "this person opted out" into the consent events that make every dispatch path
// refuse, address-keyed exactly as Phase 1 (R-CONSENT-1, R-CHAN-1):
//
//   keyword    an exact STOP on a channel revokes that channel, all purposes, on every point of the
//              channel's kind on the contact (texts: every phone). Email keeps Phase 1 behaviour (the
//              address itself). A "keyword" on web chat is treated as language (no keyword protocol).
//   language   opt-out language on any channel ("please stop contacting me") revokes EVERY channel on
//              EVERY point of the contact, needs_review; the caller also records the person-level
//              do-not-contact (contacts.do_not_contact_at). From web chat the points are the session's
//              own contact's only: a chat session never attaches to an existing contact (R-INBOX-1).
//   agent_dnc  an agent-recorded "do not contact me": the same fan-out as language, written by that
//              user, no review (the agent heard it).
//
// The result only ever refuses more (it never writes a grant or a resubscribe), is deterministic in its
// inputs (ids from the injected generator), and is deduplicated per (address, channel). VERIFY WITH
// COUNSEL: keyword lists per channel, the scope of opt-out language.
import type { IdGenerator, Instant } from '../foundation/index.js';
import type { ConsentEventSpec } from './consent.js';
import { type PointKind, type Channel, type ConsentSource, channelsOfKind, pointKindOf } from './types.js';

/** One live contact point of the opted-out contact (removed points excluded). */
export interface PointFacts {
  kind: PointKind;
  hmac: string;
  /** masked display hint, as stored on the point */
  hint: string;
}

export type FanoutTrigger = 'keyword' | 'language' | 'agent_dnc';

export interface FanoutContext {
  occurredAt: Instant;
  contactId: string;
  /** the inbound message carrying the keyword or language (evidence), if any */
  messageId: string | null;
  /** agent_dnc: the user who recorded it; otherwise the system ingests the person's own words */
  actor: { kind: 'user'; userId: string } | { kind: 'system' };
  /** the matched keyword or phrase, kept as evidence */
  matched?: string;
  /** keyword on email: the address that sent it (email revokes stay address-scoped) */
  inboundHmac?: string;
  ids: IdGenerator;
}

const SOURCE: Record<FanoutTrigger, ConsentSource> = { keyword: 'inbound_keyword', language: 'inbound_language', agent_dnc: 'agent_revoke' };

export function optOutFanout(points: readonly PointFacts[], trigger: FanoutTrigger, channel: Channel, ctx: FanoutContext): ConsentEventSpec[] {
  // chat has no keyword protocol: a keyword there is the visitor's words, i.e. language (strictest)
  const t: FanoutTrigger = trigger === 'keyword' && channel === 'web_chat' ? 'language' : trigger;
  if (t === 'keyword' && channel === 'voice') throw new Error('optOutFanout: calls have no opt-out keyword');
  const targets: { p: PointFacts; ch: Channel }[] = [];
  if (t === 'keyword') {
    const kind = pointKindOf(channel);
    for (const p of points) {
      if (p.kind !== kind) continue;
      if (channel === 'email' && p.hmac !== ctx.inboundHmac) continue;
      targets.push({ p, ch: channel });
    }
  } else {
    for (const p of points) for (const ch of channelsOfKind(p.kind)) targets.push({ p, ch });
  }
  const seen = new Set<string>();
  const out: ConsentEventSpec[] = [];
  for (const { p, ch } of targets) {
    const key = `${ch}:${p.hmac}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: ctx.ids.next<'ConsentEventId'>(),
      addressKind: p.kind,
      addressHmac: p.hmac,
      addressHint: p.hint,
      channel: ch,
      purpose: 'all',
      eventType: 'revoke',
      level: 'none',
      source: SOURCE[t],
      occurredAt: ctx.occurredAt,
      contactId: ctx.contactId,
      actor: t === 'agent_dnc' ? ctx.actor : { kind: 'system' },
      disclosureId: null,
      evidenceObjectId: null,
      evidenceMessageId: ctx.messageId,
      evidenceCallId: null,
      evidenceCallOffsetMs: null,
      evidence: ctx.matched === undefined ? {} : { matched: ctx.matched },
      imported: false,
      importRecordId: null,
      originalProvenance: null,
      revertsEventId: null,
      expiresAt: null,
      needsReview: t === 'language',
    });
  }
  return out;
}
