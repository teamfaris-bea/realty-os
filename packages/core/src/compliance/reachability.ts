// Reachability: who can be texted, emailed or called right now, and why not, BEFORE anyone taps
// (lane optout-visibility; ARCHITECTURE §9 "the opt-out state is said wherever a send or call button
// appears").
//
// This is the content-independent half of canContact: the person-level and address-level blocks that
// hold for every message on a channel, whatever it says and whoever sends it. It never decides a send
// (the send-time canContact does, with the real text, sender and policy); it predicts exactly the
// reasons canContact would give for these facts, and a property test proves the two agree:
//
//   CONSENT_REVOKED         an opt-out (check 5): the same predicate canContact uses (`optedOut`), over
//                           the same rows (this address, plus the contact's other phones for texts and
//                           calls, removed ones that still count included, R-PAR-12). STOP, unsubscribe,
//                           an agent-recorded do-not-contact, an import.
//   SUPPRESSED              an active suppression on this address for the channel or `all` (check 6)
//   WRONG_NUMBER            the point is marked a wrong number (check 2)
//   CONTACT_POINT_INVALID   the point is not active (invalid, bouncing, removed) (check 2)
//   LANDLINE_NO_SMS         a text to a landline (check 2)
//
// Pure and deterministic, like the gate.
import { optedOut } from './gate.js';
import type { ReasonCode } from './reasons.js';
import type { PointKind, Channel, ConsentStateRow, LineType, PointStatus, Purpose, SuppressionRow } from './types.js';
import { CHANNELS, PHONE_EMAIL_CHANNELS, PURPOSES, pointKindOf } from './types.js';

/** The canContact reasons reachability predicts. Every other reason depends on the message or the sender. */
export const REACHABILITY_REASONS = ['CONSENT_REVOKED', 'SUPPRESSED', 'WRONG_NUMBER', 'CONTACT_POINT_INVALID', 'LANDLINE_NO_SMS'] as const satisfies readonly ReasonCode[];
export type ReachabilityReason = (typeof REACHABILITY_REASONS)[number];

export interface ReachPoint {
  id: string;
  kind: PointKind;
  addressHmac: string;
  status: PointStatus;
  lineType: LineType;
}

/** A suppressions row with the key it was found under. */
export interface ReachSuppression extends SuppressionRow {
  id: string;
  addressHmac: string;
}

export interface ReachabilityInput {
  /** the contact's points (removed ones excluded: the ones a send goes to or a call dials), primary first */
  points: readonly ReachPoint[];
  /**
   * R-PAR-12: HMACs of the contact's REMOVED phones whose opt-out still counts (removed for any reason but
   * a confirmed wrong number). Never listed and never sent to: their opt-outs only join the any-phone
   * fan-out of texts and calls, as the send-time gate and the dispatch guards read it. Absent = none.
   */
  removedPhoneHmacs?: readonly string[];
  /** consent_state rows for every one of the contact's addresses (removed phones above included), any channel */
  consent: readonly ConsentStateRow[];
  /** suppressions for every one of the contact's addresses (lifted ones are ignored) */
  suppressions: readonly ReachSuppression[];
}

export interface ReachBlock {
  reason: ReachabilityReason;
  /** CONSENT_REVOKED: every revoked row that blocks (the opt-out evidence); else empty */
  revokedRows: ConsentStateRow[];
  /** SUPPRESSED: every active suppression that blocks; else empty */
  suppressions: ReachSuppression[];
}

export function pointKindFor(channel: Channel): PointKind {
  return pointKindOf(channel);
}

/**
 * The consent rows canContact sees for a send to `point` on `channel` (api/comms gateInput): this
 * address, plus every other phone of the contact for texts and calls (R-CONSENT-7, outbound-3), the
 * removed phones that still count included (R-PAR-12).
 */
export function gateConsentRows(input: ReachabilityInput, point: ReachPoint, channel: Channel): ConsentStateRow[] {
  const hmacs = new Set([point.addressHmac]);
  // texts and calls: every phone, removed ones that still count too; DMs: every identity of the kind
  // (R-CHAN-4); email: the address
  if (channel !== 'email') {
    const kind = pointKindOf(channel);
    for (const p of input.points) if (p.kind === kind) hmacs.add(p.addressHmac);
    if (kind === 'phone') for (const h of input.removedPhoneHmacs ?? []) hmacs.add(h);
  }
  return input.consent.filter((r) => r.channel === channel && hmacs.has(r.addressHmac));
}

/** Why a send to `point` on `channel` for `purpose` would be blocked whatever it says; [] = reachable. */
export function pointBlocks(input: ReachabilityInput, point: ReachPoint, channel: Channel, purpose: Purpose): ReachBlock[] {
  if (point.kind !== pointKindFor(channel)) throw new Error('pointBlocks: point kind does not match the channel');
  const out: ReachBlock[] = [];
  const block = (reason: ReachabilityReason, revokedRows: ConsentStateRow[] = [], suppressions: ReachSuppression[] = []) => out.push({ reason, revokedRows, suppressions });
  // check 2 (contact point), in canContact's order
  if (point.status === 'wrong_number') block('WRONG_NUMBER');
  else if (point.status !== 'active') block('CONTACT_POINT_INVALID');
  if (channel === 'sms' && point.lineType === 'landline') block('LANDLINE_NO_SMS');
  // check 5 (opt-out): exactly canContact's predicate, row by row so the evidence can be named
  const rows = gateConsentRows(input, point, channel);
  if (optedOut(rows, channel, purpose, point.addressHmac)) {
    block('CONSENT_REVOKED', rows.filter((r) => optedOut([r], channel, purpose, point.addressHmac)));
  }
  // check 6 (suppressions on this address)
  const sup = input.suppressions.filter((s) => s.addressHmac === point.addressHmac && s.liftedAt === null && (s.channel === 'all' || s.channel === channel));
  if (sup.length > 0) block('SUPPRESSED', [], sup);
  return out;
}

export interface PointReach {
  pointId: string;
  /** per purpose: [] when nothing content-independent blocks a send to this point */
  blocks: Record<Purpose, ReachBlock[]>;
}

export interface ChannelReach {
  channel: Channel;
  points: PointReach[];
}

/**
 * Every Phase 1 channel, plus each DM/chat channel the contact has an identity on, × the contact's points
 * of that kind × both purposes. (A contact with no Messenger identity gets no Messenger row.)
 */
export function reachability(input: ReachabilityInput): ChannelReach[] {
  const channels = CHANNELS.filter((c) => (PHONE_EMAIL_CHANNELS as readonly Channel[]).includes(c) || input.points.some((p) => p.kind === pointKindOf(c)));
  return channels.map((channel) => ({
    channel,
    points: input.points
      .filter((p) => p.kind === pointKindFor(channel))
      .map((p) => ({
        pointId: p.id,
        blocks: Object.fromEntries(PURPOSES.map((purpose) => [purpose, pointBlocks(input, p, channel, purpose)])) as Record<Purpose, ReachBlock[]>,
      })),
  }));
}
