// GET /contacts/:id/reachability and the "why wasn't this sent" facts of the thread (lane
// optout-visibility). Read-only: nothing here sends, stores or decides anything.
//
// The blocks come from core.pointBlocks, the content-independent half of canContact (the property test
// in core proves they agree exactly; reachability.test.ts here proves the assembled facts agree with the
// real send-time gate on real rows). This module only names the evidence: which ledger event, inbound
// message, call or suppression each block rests on, who recorded it and when. The web turns that into
// one plain sentence ("Texted STOP on Nov 10"); no raw code is shown.
import {
  type Channel,
  type ConsentStateRow,
  type Purpose,
  type ReachBlock,
  type ReachPoint,
  type ReachSuppression,
  type ReachabilityReason,
  type SuppressionRow,
  classifyHumanPurpose,
  optedOut,
  pointBlocks,
} from '@realty/core/compliance';
import { type Instant, instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { hint } from './dispatch.js';
import * as rr from './repos/reachability.js';

/** Where an opt-out came from, in the words the web needs to say it. */
export type ReasonSource =
  | 'keyword' // texted STOP (or another opt-out keyword)
  | 'opt_out_language' // wrote "stop texting me" in words
  | 'unsubscribe' // clicked unsubscribe / list-unsubscribe
  | 'agent_recorded' // a team member recorded "do not contact me"
  | 'call_outcome' // "asked not to be called" logged after a call
  | 'wrong_number' // marked a wrong number
  | 'provider_report' // the carrier / email provider reported an opt-out
  | 'imported' // came over from the old system
  | 'suppression' // a bounce, complaint, do-not-contact list, admin block
  | 'contact_point' // the number or address itself (wrong, invalid, landline)
  | 'other';

export interface ReasonView {
  code: ReachabilityReason;
  source: ReasonSource;
  /** the purposes this reason blocks on this point */
  purposes: Purpose[];
  /** when the person acted (or the suppression started) */
  at: string | null;
  keyword: string | null;
  recordedBy: { userId: string; displayName: string | null } | null;
  importBatchId: string | null;
  suppressionReason: string | null;
  /** the masked address the opt-out was recorded on */
  addressHint: string | null;
  /** recorded on another phone of the contact (a STOP from their work phone blocks every phone) */
  otherAddress: boolean;
  /**
   * that other phone has since been removed from the person (R-PAR-12: its opt-out still blocks them), so the
   * words can say "(removed number)" instead of naming a number the page no longer lists. Only the live
   * summary knows it; a blocked message's reason (the facts at the moment of the decision) never claims it.
   */
  addressRemoved: boolean;
  evidence: { consentEventId: string | null; inboundMessageId: string | null; callId: string | null; suppressionId: string | null };
}

export interface PointReachView {
  pointId: string;
  addressHint: string;
  /** blocked for the purpose a send would have now */
  blocked: boolean;
  reasons: ReasonView[];
}

export interface ChannelReachView {
  /** there is a phone (texts, calls) or an email address on file */
  hasAddress: boolean;
  /** the point Text / Call / Email uses when the agent picks none (the compose and dial defaults) */
  defaultPointId: string | null;
  /** a send or call from the default point would be blocked now, whatever it says */
  blocked: boolean;
  /** the reasons for the default point, most specific first, for the purpose a send would have now */
  reasons: ReasonView[];
  points: PointReachView[];
}

export interface ReachabilityView {
  contactId: string;
  /** what a human one-to-one message would be classified as right now (R-CONSENT-5 rules) */
  purposeNow: Purpose;
  channels: Record<'sms' | 'voice' | 'email', ChannelReachView>;
}

const ORDER: ReachabilityReason[] = ['CONSENT_REVOKED', 'SUPPRESSED', 'WRONG_NUMBER', 'CONTACT_POINT_INVALID', 'LANDLINE_NO_SMS'];

function sourceOf(e: rr.RevokeEventFacts): ReasonSource {
  if (e.imported) return 'imported';
  switch (e.source) {
    case 'inbound_keyword':
      return 'keyword';
    case 'inbound_language':
      return 'opt_out_language';
    case 'web_form':
      return e.channel === 'email' ? 'unsubscribe' : 'other';
    case 'agent_revoke':
      return e.callOutcome ? 'call_outcome' : 'agent_recorded';
    case 'wrong_number':
      return 'wrong_number';
    case 'provider_report':
      return 'provider_report';
    default:
      return 'other';
  }
}

function emptyReason(code: ReachabilityReason, purposes: Purpose[]): ReasonView {
  return { code, source: 'contact_point', purposes, at: null, keyword: null, recordedBy: null, importBatchId: null, suppressionReason: null, addressHint: null, otherAddress: false, addressRemoved: false, evidence: { consentEventId: null, inboundMessageId: null, callId: null, suppressionId: null } };
}

/** `removed`: the HMACs of the person's removed phones that are not live on it (the live summary only). */
export function revokeReason(e: rr.RevokeEventFacts | undefined, row: ConsentStateRow, pointHmac: string, purposes: Purpose[], removed: ReadonlySet<string> = new Set()): ReasonView {
  const otherAddress = row.addressHmac !== pointHmac;
  const base = { ...emptyReason('CONSENT_REVOKED', purposes), otherAddress, addressRemoved: otherAddress && removed.has(row.addressHmac), evidence: { consentEventId: row.basisEventId, inboundMessageId: null, callId: null, suppressionId: null } };
  if (!e) return { ...base, source: 'other' }; // the ledger row is not visible to this caller: say only that they opted out
  return {
    ...base,
    source: sourceOf(e),
    at: e.occurredAt.toISOString(),
    keyword: e.source === 'inbound_keyword' ? e.keyword : null,
    recordedBy: e.actorUserId && !e.imported ? { userId: e.actorUserId, displayName: e.actorName } : null,
    importBatchId: e.importBatchId,
    addressHint: e.addressHint,
    evidence: { consentEventId: e.id, inboundMessageId: e.evidenceMessageId, callId: e.evidenceCallId, suppressionId: null },
  };
}

export function suppressionReason(s: rr.SuppressionFacts | undefined, fallback: SuppressionRow, purposes: Purpose[]): ReasonView {
  const base = { ...emptyReason('SUPPRESSED', purposes), source: (fallback.reason === 'import_dnc' ? 'imported' : 'suppression') as ReasonSource, suppressionReason: fallback.reason };
  if (!s) return base;
  return { ...base, at: s.createdAt.toISOString(), recordedBy: s.createdByUserId ? { userId: s.createdByUserId, displayName: s.createdByName } : null, importBatchId: s.importBatchId, addressHint: s.addressHint, evidence: { ...base.evidence, suppressionId: s.id } };
}

/** The most telling revoked row: on this very address first, then the most recent event. */
function bestRow(rows: readonly ConsentStateRow[], pointHmac: string, events: ReadonlyMap<string, rr.RevokeEventFacts>): ConsentStateRow {
  const t = (r: ConsentStateRow) => (r.basisEventId ? (events.get(r.basisEventId)?.occurredAt.getTime() ?? 0) : 0);
  return [...rows].sort((a, b) => Number(b.addressHmac === pointHmac) - Number(a.addressHmac === pointHmac) || t(b) - t(a))[0]!;
}

function reasonsFor(blocks: Record<Purpose, ReachBlock[]>, point: ReachPoint, events: ReadonlyMap<string, rr.RevokeEventFacts>, sups: ReadonlyMap<string, rr.SuppressionFacts>, removed: ReadonlySet<string>): ReasonView[] {
  const byKey = new Map<string, ReasonView>();
  for (const purpose of ['informational', 'marketing'] as const) {
    for (const b of blocks[purpose]) {
      let v: ReasonView;
      if (b.reason === 'CONSENT_REVOKED') {
        const row = bestRow(b.revokedRows, point.addressHmac, events);
        v = revokeReason(row.basisEventId ? events.get(row.basisEventId) : undefined, row, point.addressHmac, [purpose], removed);
      } else if (b.reason === 'SUPPRESSED') {
        const s = [...b.suppressions].sort((x, y) => (sups.get(y.id)?.createdAt.getTime() ?? 0) - (sups.get(x.id)?.createdAt.getTime() ?? 0))[0]!;
        v = suppressionReason(sups.get(s.id), s, [purpose]);
      } else v = emptyReason(b.reason, [purpose]);
      const key = `${v.code}:${v.evidence.consentEventId ?? ''}:${v.evidence.suppressionId ?? ''}`;
      const prior = byKey.get(key);
      if (prior) prior.purposes.push(purpose);
      else byKey.set(key, v);
    }
  }
  return [...byKey.values()].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
}

/** The default point of a channel: compose picks the first active one of the kind (else the first); a call dials the first phone. */
export function defaultPoint<P extends { kind: 'phone' | 'email'; status: string }>(points: readonly P[], channel: Channel): P | null {
  const kind = channel === 'email' ? 'email' : 'phone';
  if (channel === 'voice') return points.find((p) => p.kind === 'phone') ?? null;
  return points.find((p) => p.kind === kind && p.status === 'active') ?? points.find((p) => p.kind === kind) ?? null;
}

/** The reachability summary of one contact, read in the caller's transaction (RLS-scoped); null when its detail is not visible. */
export async function reachabilityOf(tx: Tx, contactId: string, now: Instant): Promise<ReachabilityView | null> {
  return (await reachabilityFor(tx, [contactId], now)).get(contactId) ?? null;
}

/**
 * The summaries of many contacts (the feed's cards) in a fixed number of queries, whatever the count.
 * Contacts whose detail the caller does not see are left out (never a hint that they exist).
 */
export async function reachabilityFor(tx: Tx, contactIds: readonly string[], now: Instant): Promise<Map<string, ReachabilityView>> {
  const facts = await rr.purposeFacts(tx, [...new Set(contactIds)]);
  const ids = [...facts.keys()];
  const byContact = await rr.pointsForContacts(tx, ids);
  // R-PAR-12: removed phones whose opt-out still blocks the person (never listed, never a default point)
  const removed = await rr.removedFanoutPhones(tx, ids);
  const hmacs = [...new Set([...byContact.values()].flat().map((p) => p.hmac))];
  const consent = await rr.consentStateFor(tx, [...new Set([...hmacs, ...[...removed.values()].flat()])]);
  const sups = await rr.suppressionsFor(tx, hmacs);
  const events = await rr.revokeEvents(tx, consent.filter((r) => r.status === 'revoked' && r.basisEventId !== null).map((r) => r.basisEventId!));
  const supById = new Map(sups.map((s) => [s.id, s]));
  const out = new Map<string, ReachabilityView>();
  for (const contactId of ids) {
    const pts = byContact.get(contactId) ?? [];
    const f = facts.get(contactId)!;
    const purposeNow = classifyHumanPurpose({ lastInboundAt: f.lastInboundAt ? instantFromDate(f.lastInboundAt) : null, dealOrAppointmentContext: f.dealOrAppointmentContext, now });
    const own = new Set(pts.map((p) => p.hmac));
    const removedPhoneHmacs = removed.get(contactId) ?? [];
    const keys = new Set([...own, ...removedPhoneHmacs]);
    // a removed phone whose number is not also live on the person: its opt-out is said as a removed number's
    const removedOnly = new Set(removedPhoneHmacs.filter((x) => !own.has(x)));
    const input = {
      points: pts.map((p): ReachPoint => ({ id: p.id, kind: p.kind, addressHmac: p.hmac, status: p.status, lineType: p.lineType })),
      removedPhoneHmacs,
      consent: consent.filter((r) => keys.has(r.addressHmac)),
      suppressions: sups.filter((s) => own.has(s.addressHmac)).map((s): ReachSuppression => ({ id: s.id, addressHmac: s.addressHmac, channel: s.channel, reason: s.reason, liftedAt: s.liftedAt ? instantFromDate(s.liftedAt) : null })),
    };
    const channel = (ch: 'sms' | 'voice' | 'email'): ChannelReachView => {
      const kind = ch === 'email' ? 'email' : 'phone';
      const points = input.points.filter((p) => p.kind === kind).map((p): PointReachView => {
        const blocks = { informational: pointBlocks(input, p, ch, 'informational'), marketing: pointBlocks(input, p, ch, 'marketing') };
        const address = pts.find((x) => x.id === p.id)!.address;
        return { pointId: p.id, addressHint: hint(address), blocked: blocks[purposeNow].length > 0, reasons: reasonsFor(blocks, p, events, supById, removedOnly) };
      });
      const def = defaultPoint(pts, ch);
      const dp = def ? (points.find((p) => p.pointId === def.id) ?? null) : null;
      return { hasAddress: points.length > 0, defaultPointId: def?.id ?? null, blocked: dp?.blocked ?? false, reasons: dp ? dp.reasons.filter((r) => r.purposes.includes(purposeNow)) : [], points };
    };
    out.set(contactId, { contactId, purposeNow, channels: { sms: channel('sms'), voice: channel('voice'), email: channel('email') } });
  }
  return out;
}

// ---- why a message was not sent ----------------------------------------------------------------

const SUPPRESSION_CHANNELS = new Set(['sms', 'voice', 'email', 'all']);

interface StoredInputs {
  recipient?: { addressHmac?: string; channel?: Channel };
  purpose?: Purpose;
  consent?: ConsentStateRow[];
  suppressions?: SuppressionRow[];
}

/**
 * For blocked messages: the opt-out or suppression the send-time decision rested on, from the stored
 * gate_decisions inputs (the facts as they were at that moment, not as they are now). Two queries for
 * the whole page of messages.
 */
export async function blockedReasonsFor(tx: Tx, messageIds: readonly string[]): Promise<Map<string, ReasonView>> {
  const decisions = await rr.blockedDecisionInputs(tx, messageIds);
  const want: { messageId: string; row?: ConsentStateRow; sup?: SuppressionRow & { hmac: string; at: Date }; pointHmac: string; purpose: Purpose }[] = [];
  for (const [messageId, d] of decisions) {
    const inp = (d.inputs ?? {}) as StoredInputs;
    const hmac = inp.recipient?.addressHmac;
    const ch = inp.recipient?.channel;
    const purpose = inp.purpose;
    if (!hmac || !ch || !purpose) continue;
    const rows = (inp.consent ?? []).filter((r) => optedOut([r], ch, purpose, hmac));
    const row = rows.find((r) => r.addressHmac === hmac) ?? rows[0];
    if (row) {
      want.push({ messageId, row, pointHmac: hmac, purpose });
      continue;
    }
    const sup = (inp.suppressions ?? []).find((s) => s.liftedAt === null && SUPPRESSION_CHANNELS.has(s.channel) && (s.channel === 'all' || s.channel === ch));
    if (sup) want.push({ messageId, sup: { ...sup, hmac, at: d.evaluatedAt }, pointHmac: hmac, purpose });
  }
  const events = await rr.revokeEvents(tx, want.flatMap((w) => (w.row?.basisEventId ? [w.row.basisEventId] : [])));
  const supHmacs = [...new Set(want.flatMap((w) => (w.sup ? [w.sup.hmac] : [])))];
  const sups = supHmacs.length > 0 ? await rr.suppressionsFor(tx, supHmacs) : [];
  const out = new Map<string, ReasonView>();
  for (const w of want) {
    if (w.row) out.set(w.messageId, revokeReason(w.row.basisEventId ? events.get(w.row.basisEventId) : undefined, w.row, w.pointHmac, [w.purpose]));
    else if (w.sup) {
      const s = w.sup;
      const match = sups.filter((x) => x.addressHmac === s.hmac && x.channel === s.channel && x.reason === s.reason && x.createdAt <= s.at).pop();
      out.set(w.messageId, suppressionReason(match, s, [w.purpose]));
    }
  }
  return out;
}

/** What the thread shows under an outbound message that did not simply go out (lane item 3/4). */
export interface MessageStatusExtras {
  statusReason: string | null;
  providerErrorCode: string | null;
  blockedBy: ReasonView | null;
}

/** For a page of timeline items: the message ids' status reasons and, for blocked ones, the opt-out evidence. */
export async function messageStatusExtras(tx: Tx, messageIds: readonly string[]): Promise<Map<string, MessageStatusExtras>> {
  const facts = await rr.messageStatusFacts(tx, messageIds);
  const blocked = [...facts.values()].filter((m) => m.status === 'blocked').map((m) => m.id);
  const why = await blockedReasonsFor(tx, blocked);
  return new Map([...facts.values()].map((m) => [m.id, { statusReason: m.statusReason, providerErrorCode: m.providerErrorCode, blockedBy: why.get(m.id) ?? null }]));
}
