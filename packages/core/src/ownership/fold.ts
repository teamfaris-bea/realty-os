// fold(ledger) == projection (R-OWN-4). The reducer is shared with decide(), which builds `next` by
// applying its own events to the current projection, and the drift job re-folds the stored ledger.
//
// Every guarded column of `contacts` is a function of the events alone:
//   state / owner / pond / offeree: the event's AFTER values (the DB guard compares exactly these)
//   offer id + expiry:              set by `offered` (deadline_at), cleared outside `offered`
//   offer round:                    +1 per `offered` event; -1 per offer_rescinded into unassigned (only
//                                   expiries and declines count, R-OWN-9); kept while offered/unassigned; 0 elsewhere
//   routing rule:                   set by `offered` / `sent_to_pond`; cleared by created/imported; else kept
//   ownership period:               starts when an event enters `owned`, changes the owner, or carries
//                                   payload.newPeriod; it sets owned_at, first-touch due (deadline_at)
//                                   and release due (payload.releaseDueAt); in-period events keep them
//   first touch / breach:           first_touch_recorded / first_touch_breached (occurred_at)
//   route due:                      payload.routeDueAt on events into `unassigned`
//   closed reason:                  payload.closedReason on events into `closed`
//   seq / command / actor user:     the last event's
// Rejections are not ledger events, so they can never cause drift.
import { type Instant, instant } from '../foundation/index.js';
import { checkShape } from './invariants.js';
import { CLOSE_REASONS, type CloseReason, type OwnershipEvent, type OwnershipProjection } from './types.js';

export class OwnershipFoldError extends Error {
  override readonly name = 'OwnershipFoldError';
  constructor(
    readonly code: 'SEQ_GAP' | 'FIRST_EVENT' | 'FROM_STATE' | 'SHAPE' | 'PAYLOAD',
    message: string,
  ) {
    super(message);
  }
}

function payloadInstant(v: unknown, what: string): Instant | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new OwnershipFoldError('PAYLOAD', `${what} must be epoch ms`);
  return instant(v);
}

function payloadCloseReason(v: unknown): CloseReason {
  if (typeof v === 'string' && (CLOSE_REASONS as readonly string[]).includes(v)) return v as CloseReason;
  throw new OwnershipFoldError('PAYLOAD', 'closed events need payload.closedReason');
}

/** Whether `e` starts a new ownership period on top of `prev`. */
export function startsPeriod(prev: OwnershipProjection | null, e: OwnershipEvent): boolean {
  if (e.toState !== 'owned') return false;
  if (!prev || prev.state !== 'owned') return true;
  return prev.ownerUserId !== e.ownerUserId || e.payload.newPeriod === true;
}

/** Applies one ledger event. Throws OwnershipFoldError on a malformed ledger (drift, corruption). */
export function applyEvent(prev: OwnershipProjection | null, e: OwnershipEvent): OwnershipProjection {
  const expectedSeq = (prev?.seq ?? 0) + 1;
  if (e.seq !== expectedSeq) throw new OwnershipFoldError('SEQ_GAP', `expected seq ${expectedSeq}, got ${e.seq}`);
  if (!prev && e.fromState !== null) throw new OwnershipFoldError('FIRST_EVENT', 'the first event must have from_state NULL');
  if (prev && e.fromState !== prev.state) {
    throw new OwnershipFoldError('FROM_STATE', `seq ${e.seq}: from_state ${String(e.fromState)} but projection is ${prev.state}`);
  }
  const to = e.toState;
  const period = startsPeriod(prev, e);
  const owned = to === 'owned';

  let offerRound: number;
  if (e.type === 'offered') offerRound = (prev?.state === 'offered' || prev?.state === 'unassigned' ? prev.offerRound : 0) + 1;
  // R-OWN-9 counts only expiries and declines: a rescinded offer (deactivation, R-OWN-22) gives its round back
  else if (e.type === 'offer_rescinded' && to === 'unassigned') offerRound = Math.max(0, (prev as OwnershipProjection).offerRound - 1);
  else if (to === 'offered' || to === 'unassigned') offerRound = prev?.offerRound ?? 0; // e.g. merged_in keeps the offer
  else offerRound = 0;

  let routingRuleId = prev?.routingRuleId ?? null;
  if (e.type === 'offered' || e.type === 'sent_to_pond') routingRuleId = e.routingRuleId;
  else if (e.type === 'created' || e.type === 'imported') routingRuleId = null;

  const next: OwnershipProjection = {
    state: to,
    ownerUserId: e.ownerUserId,
    pondId: e.pondId,
    offerId: to === 'offered' ? e.offerId : null,
    offeredToUserId: e.offeredToUserId,
    offerExpiresAt: to === 'offered' ? e.deadlineAt : null,
    offerRound,
    routingRuleId,
    ownedAt: owned ? (period ? e.occurredAt : (prev as OwnershipProjection).ownedAt) : null,
    firstTouchDueAt: owned ? (period ? e.deadlineAt : (prev?.firstTouchDueAt ?? null)) : null,
    firstTouchAt: owned ? (period ? null : e.type === 'first_touch_recorded' ? e.occurredAt : (prev?.firstTouchAt ?? null)) : null,
    firstTouchBreachedAt: owned
      ? period
        ? null
        : e.type === 'first_touch_breached'
          ? e.occurredAt
          : (prev?.firstTouchBreachedAt ?? null)
      : null,
    releaseDueAt: owned ? (period ? payloadInstant(e.payload.releaseDueAt, 'releaseDueAt') : (prev?.releaseDueAt ?? null)) : null,
    periodSeq: owned ? (period ? e.seq : (prev as OwnershipProjection).periodSeq) : null,
    routeDueAt: to === 'unassigned' ? payloadInstant(e.payload.routeDueAt, 'routeDueAt') : null,
    closedReason: to === 'closed' ? payloadCloseReason(e.payload.closedReason) : null,
    seq: e.seq,
    commandId: e.commandId,
    actorUserId: e.actorKind === 'user' ? e.actorUserId : null,
  };
  const issues = checkShape(next);
  if (issues.length > 0) throw new OwnershipFoldError('SHAPE', `seq ${e.seq} (${e.type}): ${issues.join('; ')}`);
  return next;
}

/** Folds a whole ledger (ascending seq, starting at 1). Throws on an empty or malformed ledger. */
export function fold(events: readonly OwnershipEvent[]): OwnershipProjection {
  if (events.length === 0) throw new OwnershipFoldError('FIRST_EVENT', 'an empty ledger has no projection');
  let p: OwnershipProjection | null = null;
  for (const e of events) p = applyEvent(p, e);
  return p as OwnershipProjection;
}

/** Folds `events` on top of an existing projection (decide's `next`). */
export function foldFrom(prev: OwnershipProjection | null, events: readonly OwnershipEvent[]): OwnershipProjection | null {
  let p = prev;
  for (const e of events) p = applyEvent(p, e);
  return p;
}

export type ProjectionDiff = { field: keyof OwnershipProjection; ledger: unknown; stored: unknown };

/**
 * The nightly drift check (R-OWN-4): re-folds the ledger and lists every field where the stored
 * projection differs. An unfoldable ledger is reported as a single `seq` diff with the error. Nothing
 * is auto-corrected; the caller raises a P1 alert and an `ownership.drift_detected` audit entry.
 */
export function diffProjection(events: readonly OwnershipEvent[], stored: OwnershipProjection): ProjectionDiff[] {
  let folded: OwnershipProjection;
  try {
    folded = fold(events);
  } catch (err) {
    return [{ field: 'seq', ledger: (err as Error).message, stored: stored.seq }];
  }
  const diffs: ProjectionDiff[] = [];
  for (const k of Object.keys(folded) as (keyof OwnershipProjection)[]) {
    if (folded[k] !== stored[k]) diffs.push({ field: k, ledger: folded[k], stored: stored[k] });
  }
  return diffs;
}
