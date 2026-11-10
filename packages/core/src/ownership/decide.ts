// decide(): the deterministic ownership engine (ARCHITECTURE §5; R-OWN-1…26, R-AST-7, R-AST-15,
// R-PERM-15). db/client's applyOwnershipCommand calls it under the contact lock with the DB clock
// (R-OWN-6) and writes exactly what it returns:
//   accepted → the ledger events (seq = head + 1 …), then the projection `next`, then the effects
//              (inline, or in ownership.followup per effectPlacement)
//   rejected → one ownership_command_rejections row (`rejection`); no ledger row, no projection change
//
// Guarantees (property-tested in decide.property.test.ts):
//   - next == fold(previous ledger ++ events); next.seq is the last event's seq; seq is gapless
//   - every projection satisfies the shape invariants (one owner, only when owned, …)
//   - a rejection has no events and leaves the projection unchanged
//   - replaying the command that produced the projection is a no-op
//   - a stale or duplicate timer is a no-op; an early one reschedules; a breach never stales the
//     auto-release fence (E70)
//   - routing (offers, the rotation cursor) only ever happens under the system actor
import {
  type Actor,
  type AuditAction,
  type ContactId,
  DAY_MS,
  type Instant,
  type PondId,
  type UserId,
  addLocalDays,
  canOwnLeads,
  plusMs,
} from '../foundation/index.js';
import { sha256Hex } from '../compliance/index.js';
import { canReceiveLead, claimBlock, pondAllows } from './eligibility.js';
import { applyEvent } from './fold.js';
import { mergeOwnership } from './merge.js';
import { selectCandidate } from './routing.js';
import {
  breachTimerKey,
  firstTouchDeadlines,
  inactivityApplies,
  inactivityDeadlines,
  inactivityTimerKey,
  inactivityTimers,
  offerExpiresAt,
  offerTimer,
  offerTimerKey,
  periodTimerKeys,
  releaseTimerKey,
  rescheduleTimer,
  slaTimers,
} from './timers.js';
import {
  type Candidate,
  type ConsideredCandidate,
  DECLINE_REASONS,
  type Decision,
  type DecisionContext,
  type Effect,
  type FeedItemType,
  type LedgerActorKind,
  MANUAL_CLOSE_REASONS,
  type NotificationKind,
  type NotificationSpec,
  type OwnershipCommand,
  type OwnershipErrorCode,
  type OwnershipEvent,
  type OwnershipEventPayload,
  type OwnershipEventType,
  type OwnershipProjection,
  type OwnershipState,
  type PeriodFence,
  REASON_CODE_RE,
  RELEASE_REASONS,
  type RuleFacts,
  type RejectionSpec,
  type TimerFence,
} from './types.js';

/** Thrown when the caller omitted context a command needs (a programming error, never a user outcome). */
export class OwnershipContextError extends Error {
  override readonly name = 'OwnershipContextError';
}

const NOTE_MAX = 500;

// ---- actor mapping -----------------------------------------------------------------------------

/** lead_ownership_events.actor_kind / actor_user_id for an actor. */
export function ledgerActor(actor: Actor): { actorKind: LedgerActorKind; actorUserId: UserId | null } {
  switch (actor.kind) {
    case 'user':
      return { actorKind: 'user', actorUserId: actor.userId };
    case 'support':
      return { actorKind: 'user', actorUserId: actor.userId };
    case 'system':
      return {
        actorKind: actor.via === 'timer' ? 'timer' : actor.via === 'import' ? 'import' : actor.via === 'provider' ? 'provider' : 'system',
        actorUserId: null,
      };
  }
}

function isSystem(actor: Actor, ...vias: Extract<Actor, { kind: 'system' }>['via'][]): boolean {
  return actor.kind === 'system' && vias.includes(actor.via);
}

function userOf(actor: Actor): Extract<Actor, { kind: 'user' }> | null {
  return actor.kind === 'user' ? actor : null;
}

// ---- builder ---------------------------------------------------------------------------------------

interface EmitFields {
  reasonCode: string;
  ownerUserId?: UserId;
  pondId?: OwnershipProjection['pondId'];
  offerId?: string | null;
  offeredToUserId?: UserId;
  routingRuleId?: OwnershipProjection['routingRuleId'];
  deadlineAt?: Instant | null;
  note?: string | null;
  payload?: OwnershipEventPayload;
}

class Builder {
  readonly initial: OwnershipProjection | null;
  cur: OwnershipProjection | null;
  readonly events: OwnershipEvent[] = [];
  readonly effects: Effect[] = [];
  /** Inline routing happened in this decision (no `route` effect needed). */
  routed = false;

  constructor(
    state: OwnershipProjection | null,
    readonly contactId: ContactId,
    readonly ctx: DecisionContext,
  ) {
    this.initial = state;
    this.cur = state;
  }

  /** The projection after the events so far (every caller emits before reading it). */
  get state(): OwnershipProjection {
    return this.cur as OwnershipProjection;
  }

  emit(type: OwnershipEventType, to: OwnershipState, f: EmitFields): OwnershipEvent {
    const cur = this.cur;
    const { actorKind, actorUserId } = ledgerActor(this.ctx.actor);
    const e: OwnershipEvent = {
      eventId: this.ctx.ids.next<'OwnershipEventId'>(),
      contactId: this.contactId,
      seq: (cur?.seq ?? 0) + 1,
      type,
      fromState: cur?.state ?? null,
      toState: to,
      ownerUserId: to === 'owned' ? (f.ownerUserId ?? (cur as OwnershipProjection).ownerUserId) : null,
      prevOwnerUserId: cur?.state === 'owned' ? cur.ownerUserId : null,
      pondId: to === 'in_pond' ? (f.pondId as PondId) : null,
      offerId: f.offerId ?? null,
      offeredToUserId: to === 'offered' ? (f.offeredToUserId as UserId) : null,
      routingRuleId: f.routingRuleId !== undefined ? f.routingRuleId : (cur?.routingRuleId ?? null),
      deadlineAt: f.deadlineAt ?? null,
      actorKind,
      actorUserId,
      reasonCode: f.reasonCode,
      note: f.note ?? null,
      commandId: this.ctx.commandId,
      payload: f.payload ?? {},
      occurredAt: this.ctx.now,
    };
    this.cur = applyEvent(cur, e);
    this.events.push(e);
    return e;
  }

  effect(e: Effect): void {
    this.effects.push(e);
  }

  notify(userId: UserId, kind: NotificationKind, priority: NotificationSpec['priority'], dedupeKey: string, reasonCode: string): void {
    this.effects.push({ kind: 'notify', userId, notification: { kind, priority, subjectType: 'contact', subjectId: this.contactId, dedupeKey, reasonCode } });
  }

  feed(userId: UserId, itemType: FeedItemType, dedupeKey: string, dueAt: Instant | null, reasons: string[]): void {
    this.effects.push({
      kind: 'upsertFeed',
      item: { userId, itemType, band: 'pinned', contactId: this.contactId, subjectType: 'contact', subjectId: this.contactId, dueAt, dedupeKey, reasons },
    });
  }

  teamLeadsOf(userId: UserId): UserId[] {
    return [...(this.ctx.people?.teamLeadsOf[userId] ?? [])].filter((u) => u !== userId);
  }
}

// ---- feed keys --------------------------------------------------------------------------------------

export function offerFeedKey(contactId: ContactId, offerId: string): string {
  return `lead_offer:${contactId}:${offerId}`;
}
export function firstTouchFeedKey(contactId: ContactId, periodSeq: number): string {
  return `first_touch:${contactId}:${periodSeq}`;
}

// ---- shared pieces ---------------------------------------------------------------------------------

/** Deadlines of an ownership period with first-touch SLA (R-OWN-13: accept, claim; re-inquiry without release). */
function periodStart(ctx: DecisionContext, opts: { allowRelease?: boolean } = {}): Pick<EmitFields, 'deadlineAt'> & { releaseDueAt: number | null } {
  const d = firstTouchDeadlines({ ownedAt: ctx.now, settings: ctx.settings, calendar: ctx.calendar, nextContactableAt: ctx.nextContactableAt });
  return { deadlineAt: d.firstTouchDueAt, releaseDueAt: opts.allowRelease === false ? null : d.releaseDueAt };
}

/** R-OWN-12: count a missed or declined offer; auto-pause at the threshold. */
function missedOffer(b: Builder, offereeId: UserId): void {
  const ctx = b.ctx;
  if (ctx.offereeMissedOffers === undefined) throw new OwnershipContextError('offereeMissedOffers is required for decline / offer expiry');
  b.effect({ kind: 'missedOfferCounter', userId: offereeId, op: 'increment' });
  if (ctx.offereeMissedOffers + 1 >= ctx.settings.autoPauseAfterMisses) {
    b.effect({ kind: 'membershipAutoPause', userId: offereeId });
    b.effect({ kind: 'audit', action: 'member.auto_paused', reason: 'AUTO_PAUSED' });
    const key = `auto_paused:${offereeId}:${ctx.commandId}`;
    b.notify(offereeId, 'system', 'high', key, 'AUTO_PAUSED');
    for (const tl of b.teamLeadsOf(offereeId)) b.notify(tl, 'system', 'high', key, 'AUTO_PAUSED');
  }
}

function sendToPond(b: Builder, pondId: NonNullable<OwnershipProjection['pondId']>, reasonCode: string, rule: RuleFacts | null, candidates: ConsideredCandidate[]): void {
  b.emit('sent_to_pond', 'in_pond', { pondId, reasonCode, routingRuleId: rule?.id ?? null, payload: { candidates } });
}

/**
 * System routing from `unassigned` (or `owned`, for a deactivation re-route): R-OWN-9 / -10 / -11.
 * No rule ⇒ default pond (NO_RULE_MATCH); pond strategy ⇒ its pond; max offers reached ⇒ fallback
 * pond else default; no eligible candidate ⇒ fallback/default pond (NO_ELIGIBLE_AGENT) + a critical
 * notification to the TLs and Admins; otherwise one offer for the rule's window in business time.
 */
function route(b: Builder): void {
  const ctx = b.ctx; // callers guarantee the system actor (decideRoute, routeIfPossible, decideDeactivate)
  const snap = ctx.routing;
  if (!snap) throw new OwnershipContextError('routing snapshot is required to route');
  b.routed = true;
  const s = ctx.settings;
  const rule = snap.rule;
  if (rule === null) return sendToPond(b, s.defaultPondId, 'NO_RULE_MATCH', null, []);
  if (rule.strategy === 'pond') return sendToPond(b, rule.targetPondId ?? s.defaultPondId, 'RULE_POND', rule, []);
  const fallback = rule.fallbackPondId ?? s.defaultPondId;
  const maxOffers = rule.maxOffers ?? s.maxOffers;
  const round = b.state.state === 'unassigned' ? b.state.offerRound : 0;
  if (round >= maxOffers) return sendToPond(b, fallback, 'MAX_OFFERS_REACHED', rule, []);

  const offered = new Set<string>(snap.alreadyOffered);
  const candidates: Candidate[] = snap.candidates.map((c) => ({ ...c, alreadyOffered: c.alreadyOffered === true || offered.has(c.userId) }));
  const sel = selectCandidate(rule, candidates, snap.cursor, { capacityCap: s.uncontactedCapacityCap });
  if (sel.pick === null) {
    sendToPond(b, fallback, 'NO_ELIGIBLE_AGENT', rule, sel.considered);
    const key = `no_eligible_agent:${b.contactId}:${b.state.seq}`;
    const leads = new Set<UserId>();
    for (const c of snap.candidates) for (const tl of b.teamLeadsOf(c.userId)) leads.add(tl);
    for (const a of ctx.people?.admins ?? []) leads.add(a);
    for (const u of [...leads].sort()) b.notify(u, 'system', 'critical', key, 'NO_ELIGIBLE_AGENT');
    return;
  }
  const offerId = ctx.ids.next<'OfferId'>();
  const expiresAt = offerExpiresAt(ctx.now, rule.offerWindowSeconds ?? s.offerWindowSeconds, ctx.calendar);
  b.emit('offered', 'offered', {
    reasonCode: rule.strategy === 'direct' ? 'DIRECT' : rule.strategy === 'weighted' ? 'WEIGHTED' : 'ROUND_ROBIN',
    offerId,
    offeredToUserId: sel.pick,
    routingRuleId: rule.id,
    deadlineAt: expiresAt,
    payload: { round: round + 1, candidates: sel.considered, ruleVersion: rule.version },
  });
  if (rule.strategy === 'round_robin' || rule.strategy === 'weighted') b.effect({ kind: 'routingCursor', ruleId: rule.id, cursor: sel.cursorAfter });
  b.effect(offerTimer(b.contactId, offerId, expiresAt));
  b.notify(sel.pick, 'lead_offer', 'critical', `lead_offer:${offerId}`, 'LEAD_OFFER');
  b.feed(sel.pick, 'lead_offer', offerFeedKey(b.contactId, offerId), expiresAt, ['LEAD_OFFER']);
}

/** Routes inline when the system actor has a snapshot; otherwise `finalize` adds a `route` effect. */
function routeIfPossible(b: Builder): void {
  if (b.ctx.actor.kind === 'system' && b.ctx.routing) route(b);
}

/**
 * Effects implied by the transition initial → final: offer clean-up, ownership-period end/start
 * (timers, drafts R-AST-7, enrollments R-AST-8, handbacks, feed, stored inactivity deadlines R-OWN-23),
 * pending routing, and the audit mirror of human commands (R-AUDIT-5).
 */
function finalize(b: Builder, auditAction: AuditAction | null, auditAlways = false): Effect[] {
  const ctx = b.ctx;
  const initial = b.initial;
  const final = b.state;
  const out: Effect[] = [];
  const pre: Effect[] = [];

  if (initial?.state === 'offered' && (final.state !== 'offered' || final.offerId !== initial.offerId)) {
    pre.push({ kind: 'cancelTimers', dedupeKeys: [offerTimerKey(b.contactId, initial.offerId as string)] });
    pre.push({ kind: 'resolveFeed', dedupeKey: offerFeedKey(b.contactId, initial.offerId as string), userId: initial.offeredToUserId as UserId });
  }

  const periodEnded = initial?.state === 'owned' && (final.state !== 'owned' || final.periodSeq !== initial.periodSeq);
  const periodStarted = final.state === 'owned' && final.periodSeq !== (initial?.state === 'owned' ? initial.periodSeq : null);
  if (periodEnded && initial) {
    pre.push({ kind: 'cancelTimers', dedupeKeys: periodTimerKeys(b.contactId, initial.periodSeq, ctx.inactivity) });
    if (initial.firstTouchDueAt !== null && initial.firstTouchAt === null) {
      pre.push({ kind: 'resolveFeed', dedupeKey: firstTouchFeedKey(b.contactId, initial.periodSeq as number), userId: initial.ownerUserId as UserId });
    }
    pre.push({ kind: 'invalidateDrafts' });
    const newOwner = final.state === 'owned' ? final.ownerUserId : null;
    if (newOwner !== initial.ownerUserId) {
      pre.push({ kind: 'pauseAgentEnrollments', reason: 'owner_change' });
      pre.push({ kind: 'rehomeHandbacks', toUserId: newOwner });
    }
  }
  if (periodStarted) {
    out.push(...slaTimers(b.contactId, final));
    if (final.firstTouchDueAt !== null) {
      out.push({
        kind: 'upsertFeed',
        item: {
          userId: final.ownerUserId as UserId,
          itemType: 'first_touch_due',
          band: 'pinned',
          contactId: b.contactId,
          subjectType: 'contact',
          subjectId: b.contactId,
          dueAt: final.firstTouchDueAt,
          dedupeKey: firstTouchFeedKey(b.contactId, final.periodSeq as number),
          reasons: ['FIRST_TOUCH_DUE'],
        },
      });
    }
    const d = inactivityDeadlines({ from: ctx.now, settings: ctx.settings, zone: ctx.settings.tenantZone, stage: ctx.contactStage, dealOpen: ctx.dealOpen });
    out.push({ kind: 'setInactivityDeadlines', warnAt: d.warnAt, releaseAt: d.releaseAt });
    out.push(...inactivityTimers(b.contactId, final.periodSeq as number, d));
  } else if (final.state !== 'owned' && (initial?.state === 'owned' || ctx.inactivity?.warnAt || ctx.inactivity?.releaseAt)) {
    out.push({ kind: 'setInactivityDeadlines', warnAt: null, releaseAt: null });
  }

  if (final.state === 'unassigned' && final.routeDueAt !== null && !b.routed) out.push({ kind: 'route' });
  // R-AUDIT-5: every human command is mirrored; contact delete / restore / merge are audited for any actor.
  if (auditAction && (ctx.actor.kind === 'user' || auditAlways) && b.events.length > 0) out.push({ kind: 'audit', action: auditAction });
  return [...pre, ...b.effects, ...out];
}

// ---- results ---------------------------------------------------------------------------------------

function accepted(b: Builder, auditAction: AuditAction | null, auditAlways = false): Decision {
  const effects = finalize(b, auditAction, auditAlways);
  return { ok: true, events: b.events, next: b.state, effects };
}

function noop(state: OwnershipProjection, effects: Effect[] = []): Decision {
  return { ok: true, events: [], next: state, effects };
}

export function rejection(state: OwnershipProjection | null, cmd: OwnershipCommand, ctx: DecisionContext, code: OwnershipErrorCode, payload: Record<string, unknown> = {}): Decision {
  const { actorKind, actorUserId } = ledgerActor(ctx.actor);
  const r: RejectionSpec = {
    id: ctx.ids.next<'OwnershipRejectionId'>(),
    contactId: ctx.contactId,
    commandId: ctx.commandId,
    commandKind: cmd.kind,
    code,
    observedSeq: state?.seq ?? null,
    actorKind,
    actorUserId,
    payload,
    occurredAt: ctx.now,
  };
  return { ok: false, code, rejection: r, next: state, effects: [] };
}

function staleUi(state: OwnershipProjection, ctx: DecisionContext): boolean {
  return ctx.expectedSeq !== undefined && ctx.expectedSeq !== state.seq;
}

function validNote(note: string | undefined, required: boolean): boolean {
  if (note === undefined) return !required;
  if (note.length > NOTE_MAX) return false;
  return !required || note.trim().length > 0;
}

function upper(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// ---- decide ---------------------------------------------------------------------------------------

/**
 * Decides one ownership command for one contact. `state` is the locked projection (null when the
 * contact does not exist yet: create / import_assign). Never throws for expected outcomes; throws
 * OwnershipContextError when required context is missing and OwnershipFoldError if it would ever
 * build an invalid projection.
 */
export function decide(state: OwnershipProjection | null, cmd: OwnershipCommand, ctx: DecisionContext): Decision {
  // R-OWN-7: the command that produced the projection, replayed, is a no-op (db/client returns the
  // stored outcome for older replays before calling decide).
  if (state && state.commandId === ctx.commandId) return noop(state);
  const actor = ctx.actor;
  // Support actors are read-only (R-PERM-11). The assistant never changes ownership (R-OWN-21);
  // its messages never count as touches (R-AST-15).
  if (actor.kind === 'support') return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (isSystem(actor, 'assistant')) return state && cmd.kind === 'touch' ? noop(state) : rejection(state, cmd, ctx, 'NOT_FOUND');

  switch (cmd.kind) {
    case 'create':
      return decideCreate(state, cmd, ctx);
    case 'import_assign':
      return decideImport(state, cmd, ctx);
    case 'merge':
      return decideMergeSide(state, cmd, ctx);
    default:
      break;
  }
  if (!state) return rejection(state, cmd, ctx, 'NOT_FOUND');

  switch (cmd.kind) {
    case 'route':
      return decideRoute(state, cmd, ctx);
    case 'accept':
      return decideAccept(state, cmd, ctx);
    case 'decline':
      return decideDecline(state, cmd, ctx);
    case 'claim':
      return decideClaim(state, cmd, ctx);
    case 'release':
      return decideRelease(state, cmd, ctx);
    case 'assign':
    case 'reassign':
      return decideAssign(state, cmd, ctx);
    case 'isa_handoff':
      return decideHandoff(state, cmd, ctx);
    case 'timer':
      return decideTimer(state, cmd, ctx);
    case 'touch':
      return decideTouch(state, cmd, ctx);
    case 'reinquiry':
      return decideReinquiry(state, cmd, ctx);
    case 'close':
      return decideClose(state, cmd, ctx);
    case 'reopen':
      return decideReopen(state, cmd, ctx);
    case 'soft_delete':
      return decideSoftDelete(state, cmd, ctx);
    case 'deactivate_owner':
      return decideDeactivate(state, cmd, ctx);
  }
}

type Cmd<K extends OwnershipCommand['kind']> = Extract<OwnershipCommand, { kind: K }>;

function decideCreate(state: OwnershipProjection | null, cmd: Cmd<'create'>, ctx: DecisionContext): Decision {
  if (state) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  const b = new Builder(null, ctx.contactId, ctx);
  if (cmd.via === 'self') {
    // R-OWN-19: owned by its creator, no SLA. R-PERM-15: never a TC.
    const u = userOf(ctx.actor);
    if (!u || !canOwnLeads(u.role)) return rejection(state, cmd, ctx, 'NOT_FOUND');
    b.emit('created', 'owned', { reasonCode: 'SELF_CREATED', ownerUserId: u.userId, routingRuleId: null, deadlineAt: null, payload: { via: 'self', releaseDueAt: null } });
    return accepted(b, 'ownership.create');
  }
  if (!isSystem(ctx.actor, 'provider', 'worker')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  b.emit('created', 'unassigned', { reasonCode: cmd.via === 'intake' ? 'INTAKE' : 'INBOUND', routingRuleId: null, payload: { via: cmd.via, routeDueAt: ctx.now } });
  routeIfPossible(b);
  return accepted(b, null);
}

function decideImport(state: OwnershipProjection | null, cmd: Cmd<'import_assign'>, ctx: DecisionContext): Decision {
  if (!isSystem(ctx.actor, 'import')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  // R-OWN-21 / E41: an import re-run never changes ownership of an already-linked record.
  if (state) return noop(state);
  const b = new Builder(null, ctx.contactId, ctx);
  const t = cmd.target;
  if (t === 'unassigned') {
    b.emit('imported', 'unassigned', { reasonCode: 'IMPORTED', routingRuleId: null, payload: { routeDueAt: null } });
  } else if ('pondId' in t) {
    b.emit('imported', 'in_pond', { reasonCode: 'IMPORTED', routingRuleId: null, pondId: t.pondId });
  } else {
    if (ctx.targetMember?.userId !== t.userId || !canReceiveLead(ctx.targetMember)) return rejection(state, cmd, ctx, 'TARGET_NOT_ELIGIBLE', { toUserId: t.userId });
    // R-OWN-13: import starts no SLA.
    b.emit('imported', 'owned', { reasonCode: 'IMPORTED', routingRuleId: null, ownerUserId: t.userId, deadlineAt: null, payload: { releaseDueAt: null } });
  }
  return accepted(b, null);
}

function decideRoute(state: OwnershipProjection, cmd: Cmd<'route'>, ctx: DecisionContext): Decision {
  // R-OWN-10 / F1: routing never runs under a user actor.
  if (!isSystem(ctx.actor, 'worker', 'timer', 'provider')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.state !== 'unassigned') return noop(state); // a stale follow-up / sweeper route
  const b = new Builder(state, ctx.contactId, ctx);
  route(b);
  return accepted(b, null);
}

function decideAccept(state: OwnershipProjection, cmd: Cmd<'accept'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  if (!u) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.state === 'owned' && state.ownerUserId === u.userId) return rejection(state, cmd, ctx, 'ALREADY_OWNER');
  if (state.state === 'offered' && state.offerId === cmd.offerId) {
    // R-OWN-8, in order: offeree, expiry (no grace; E2/E3), membership.
    if (state.offeredToUserId !== u.userId) return rejection(state, cmd, ctx, 'LEAD_OFFER_NOT_YOURS');
    if (ctx.now >= (state.offerExpiresAt as Instant)) return rejection(state, cmd, ctx, 'LEAD_OFFER_EXPIRED', { offerId: cmd.offerId });
    if (!ctx.actorMember) throw new OwnershipContextError('actorMember is required for accept');
    if (ctx.actorMember.status !== 'active' || !canOwnLeads(ctx.actorMember.role)) return rejection(state, cmd, ctx, 'MEMBERSHIP_INACTIVE');
    const b = new Builder(state, ctx.contactId, ctx);
    const p = periodStart(ctx);
    b.emit('offer_accepted', 'owned', { reasonCode: 'OFFER_ACCEPTED', ownerUserId: u.userId, offerId: cmd.offerId, deadlineAt: p.deadlineAt, payload: { releaseDueAt: p.releaseDueAt } });
    b.effect({ kind: 'missedOfferCounter', userId: u.userId, op: 'reset' });
    return accepted(b, 'ownership.accept');
  }
  // The offer no longer stands: re-offered ⇒ superseded; anything else ⇒ the UI is stale (E4).
  return rejection(state, cmd, ctx, state.state === 'offered' ? 'LEAD_OFFER_SUPERSEDED' : 'LEAD_STATE_CHANGED', { offerId: cmd.offerId });
}

function decideDecline(state: OwnershipProjection, cmd: Cmd<'decline'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  if (!u) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (cmd.reason !== undefined && !(DECLINE_REASONS as readonly string[]).includes(cmd.reason)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  if (state.state === 'offered' && state.offerId === cmd.offerId) {
    if (state.offeredToUserId !== u.userId) return rejection(state, cmd, ctx, 'LEAD_OFFER_NOT_YOURS');
    if (ctx.now >= (state.offerExpiresAt as Instant)) return rejection(state, cmd, ctx, 'LEAD_OFFER_EXPIRED', { offerId: cmd.offerId });
    // E5 / F1: the decline only ends the offer; ownership.followup routes as the system actor.
    const b = new Builder(state, ctx.contactId, ctx);
    b.emit('offer_declined', 'unassigned', {
      reasonCode: 'OFFER_DECLINED',
      offerId: cmd.offerId,
      payload: { routeDueAt: ctx.now, ...(cmd.reason ? { declineReason: cmd.reason } : {}) },
    });
    missedOffer(b, u.userId);
    return accepted(b, 'ownership.decline');
  }
  return rejection(state, cmd, ctx, state.state === 'offered' ? 'LEAD_OFFER_SUPERSEDED' : 'LEAD_STATE_CHANGED', { offerId: cmd.offerId });
}

function decideClaim(state: OwnershipProjection, cmd: Cmd<'claim'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  if (!u) return rejection(state, cmd, ctx, 'NOT_FOUND');
  // E1: the losing claimer sees `owned`.
  if (state.state === 'owned') return rejection(state, cmd, ctx, state.ownerUserId === u.userId ? 'ALREADY_OWNER' : 'LEAD_ALREADY_CLAIMED');
  if (staleUi(state, ctx) || state.state !== 'in_pond' || state.pondId !== cmd.pondId) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  if (!ctx.pond || ctx.pond.pondId !== cmd.pondId) throw new OwnershipContextError('pond facts of the claimed pond are required');
  if (!ctx.actorMember) throw new OwnershipContextError('actorMember is required for claim');
  if (!ctx.claimStats) throw new OwnershipContextError('claimStats (app.claim_stats) are required for claim');
  // R-OWN-16 (TCs: POND_NOT_ELIGIBLE, R-PERM-15)
  const block = claimBlock({ pond: ctx.pond, member: { ...ctx.actorMember, role: u.role }, stats: ctx.claimStats, capacityCap: ctx.settings.uncontactedCapacityCap });
  if (block) return rejection(state, cmd, ctx, block, { pondId: cmd.pondId });
  const b = new Builder(state, ctx.contactId, ctx);
  const p = periodStart(ctx);
  b.emit('claimed', 'owned', { reasonCode: 'CLAIMED', ownerUserId: u.userId, deadlineAt: p.deadlineAt, payload: { fromPondId: cmd.pondId, releaseDueAt: p.releaseDueAt } });
  return accepted(b, 'ownership.claim');
}

function decideRelease(state: OwnershipProjection, cmd: Cmd<'release'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  if (!u) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (staleUi(state, ctx) || state.state !== 'owned' || state.ownerUserId !== u.userId) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  // R-OWN-17: a reason is required, and `other` needs a note.
  if (!(RELEASE_REASONS as readonly string[]).includes(cmd.reason) || !validNote(cmd.note, cmd.reason === 'other')) {
    return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  }
  const pondId = cmd.toPondId ?? ctx.settings.defaultPondId;
  if (pondId !== ctx.settings.defaultPondId) {
    if (!ctx.pond || ctx.pond.pondId !== pondId || !pondAllows(ctx.pond, u.role)) return rejection(state, cmd, ctx, 'POND_NOT_ELIGIBLE', { pondId });
  }
  const b = new Builder(state, ctx.contactId, ctx);
  b.emit('released', 'in_pond', { reasonCode: `RELEASED_${upper(cmd.reason)}`, pondId, note: cmd.note ?? null, payload: { releaseReason: cmd.reason } });
  return accepted(b, 'ownership.release');
}

function decideAssign(state: OwnershipProjection, cmd: Cmd<'assign' | 'reassign'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  // R-OWN-21: imports assign only new contacts (import_assign); the system worker reassigns for deactivation.
  const allowed = u ? u.role === 'owner' || u.role === 'admin' || u.role === 'team_lead' : isSystem(ctx.actor, 'worker');
  if (!allowed) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.state === 'closed') return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  if (u && staleUi(state, ctx)) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  if (!REASON_CODE_RE.test(cmd.reason) || !validNote(cmd.note, false)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  if (u?.role === 'team_lead' && !tlReaches(state, u.userId, ctx)) {
    return rejection(state, cmd, ctx, 'NOT_FOUND'); // R-OWN-18: the current owner (or offeree) must be in a team they lead
  }
  const target = ctx.targetMember;
  if (target?.userId !== cmd.toUserId || !canReceiveLead(target)) return rejection(state, cmd, ctx, 'TARGET_NOT_ELIGIBLE', { toUserId: cmd.toUserId });
  if (u?.role === 'team_lead' && target.userId !== u.userId && target.inActorTeam !== true) return rejection(state, cmd, ctx, 'TARGET_NOT_ELIGIBLE', { toUserId: cmd.toUserId });
  if (state.state === 'owned' && state.ownerUserId === cmd.toUserId) return rejection(state, cmd, ctx, 'ALREADY_OWNER');

  const b = new Builder(state, ctx.contactId, ctx);
  const oldOwner = state.state === 'owned' ? state.ownerUserId : null;
  if (state.state === 'offered') {
    // R-OWN-18: reassigning an offered lead writes offer_rescinded then assigned.
    b.emit('offer_rescinded', 'unassigned', { reasonCode: 'OFFER_RESCINDED', offerId: state.offerId, payload: { routeDueAt: null } });
  }
  b.emit(oldOwner ? 'reassigned' : 'assigned', 'owned', { reasonCode: cmd.reason, ownerUserId: cmd.toUserId, note: cmd.note ?? null, deadlineAt: null, payload: { releaseDueAt: null } });
  notifyOwnerChange(b, oldOwner, cmd.toUserId);
  return accepted(b, cmd.kind === 'assign' ? 'ownership.assign' : 'ownership.reassign');
}

/**
 * DATA_MODEL §3 "Reassign: within team" (scopes own + team): a Team Lead reaches a lead they own, or
 * one owned by / offered to a member of a team they lead (`ctx.ownerInActorTeam`). A pond, unassigned
 * or closed lead has no such person, so a TL cannot assign it (they claim pond leads instead).
 */
function tlReaches(state: OwnershipProjection, tlUserId: UserId, ctx: DecisionContext): boolean {
  if (state.state === 'owned') return state.ownerUserId === tlUserId || ctx.ownerInActorTeam === true;
  if (state.state === 'offered') return state.offeredToUserId === tlUserId || ctx.ownerInActorTeam === true;
  return false;
}

/** R-OWN-18: both the old and new owners are notified (not the actor themself). */
function notifyOwnerChange(b: Builder, oldOwner: UserId | null, newOwner: UserId): void {
  const actorId = b.ctx.actor.kind === 'user' ? b.ctx.actor.userId : null;
  const key = `owner_change:${b.contactId}:${b.state.seq}`;
  if (newOwner !== actorId) b.notify(newOwner, 'reassigned_to_you', 'high', key, 'REASSIGNED_TO_YOU');
  if (oldOwner && oldOwner !== actorId && oldOwner !== newOwner) b.notify(oldOwner, 'reassigned_away', 'normal', key, 'REASSIGNED_AWAY');
}

function decideHandoff(state: OwnershipProjection, cmd: Cmd<'isa_handoff'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  if (!u || u.role !== 'isa') return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (staleUi(state, ctx) || state.state !== 'owned' || state.ownerUserId !== u.userId) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  if (!validNote(cmd.note, true)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  const t = ctx.targetMember;
  // R-OWN-18: only to an agent or TL.
  if (t?.userId !== cmd.toUserId || !canReceiveLead(t) || (t.role !== 'agent' && t.role !== 'team_lead')) {
    return rejection(state, cmd, ctx, 'TARGET_NOT_ELIGIBLE', { toUserId: cmd.toUserId });
  }
  const b = new Builder(state, ctx.contactId, ctx);
  b.emit('reassigned', 'owned', { reasonCode: 'ISA_HANDOFF', ownerUserId: cmd.toUserId, note: cmd.note, deadlineAt: null, payload: { releaseDueAt: null } });
  const days = ctx.settings.isaAccessAfterHandoffDays;
  if (days > 0) b.effect({ kind: 'addCollaborator', userId: u.userId, role: 'isa', expiresAt: addLocalDays(ctx.now, days, ctx.settings.tenantZone) });
  notifyOwnerChange(b, u.userId, cmd.toUserId);
  return accepted(b, 'ownership.isa_handoff');
}

function isPeriodFence(f: TimerFence): f is PeriodFence {
  return 'periodSeq' in f;
}

function decideTimer(state: OwnershipProjection, cmd: Cmd<'timer'>, ctx: DecisionContext): Decision {
  if (!isSystem(ctx.actor, 'timer', 'worker')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  const now = ctx.now;
  const s = ctx.settings;
  if (cmd.deadline === 'offer_expiry') {
    if (isPeriodFence(cmd.fence)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
    if (state.state !== 'offered' || state.offerId !== cmd.fence.offerId) return noop(state); // stale / duplicate (E6)
    const due = state.offerExpiresAt as Instant;
    if (now < due) return noop(state, [rescheduleTimer(ctx.contactId, 'offer_expiry', cmd.fence, due, now)]);
    const b = new Builder(state, ctx.contactId, ctx);
    const offeree = state.offeredToUserId as UserId;
    b.emit('offer_expired', 'unassigned', { reasonCode: 'OFFER_EXPIRED', offerId: state.offerId, payload: { routeDueAt: now } });
    missedOffer(b, offeree);
    routeIfPossible(b);
    return accepted(b, null);
  }
  if (!isPeriodFence(cmd.fence)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  const fence = cmd.fence;
  const inPeriod = state.state === 'owned' && state.periodSeq === fence.periodSeq;
  const owner = state.ownerUserId as UserId; // only read when inPeriod (owned)
  switch (cmd.deadline) {
    case 'first_touch_breach': {
      // once per ownership period; never after the first touch
      if (!inPeriod || state.firstTouchDueAt !== fence.dueAt || state.firstTouchAt !== null || state.firstTouchBreachedAt !== null) return noop(state);
      if (now < fence.dueAt) return noop(state, [rescheduleTimer(ctx.contactId, cmd.deadline, fence, fence.dueAt, now)]);
      const b = new Builder(state, ctx.contactId, ctx);
      b.emit('first_touch_breached', 'owned', { reasonCode: 'FIRST_TOUCH_BREACHED' });
      const key = `first_touch_breach:${ctx.contactId}:${fence.periodSeq}`;
      b.notify(owner, 'first_touch_due', 'critical', key, 'FIRST_TOUCH_BREACHED');
      for (const tl of b.teamLeadsOf(owner)) b.notify(tl, 'first_touch_escalation', 'high', key, 'FIRST_TOUCH_BREACHED');
      return accepted(b, null);
    }
    case 'auto_release': {
      // E70: the breach advanced the seq but not the period, so this fence still matches.
      if (!inPeriod || state.releaseDueAt !== fence.dueAt || state.firstTouchAt !== null) return noop(state);
      if (now < fence.dueAt) return noop(state, [rescheduleTimer(ctx.contactId, cmd.deadline, fence, fence.dueAt, now)]);
      const b = new Builder(state, ctx.contactId, ctx);
      b.emit('auto_released', 'in_pond', { reasonCode: 'FIRST_TOUCH_MISSED', pondId: s.defaultPondId });
      const key = `auto_released:${ctx.contactId}:${fence.periodSeq}`;
      b.notify(owner, 'reassigned_away', 'high', key, 'FIRST_TOUCH_MISSED');
      for (const tl of b.teamLeadsOf(owner)) b.notify(tl, 'first_touch_escalation', 'high', key, 'FIRST_TOUCH_MISSED');
      return accepted(b, null);
    }
    case 'inactivity_warn':
    case 'inactivity_release': {
      if (!ctx.inactivity) throw new OwnershipContextError('stored inactivity deadlines are required for inactivity timers');
      const stored = cmd.deadline === 'inactivity_warn' ? ctx.inactivity.warnAt : ctx.inactivity.releaseAt;
      if (!inPeriod || stored !== fence.dueAt) return noop(state);
      // R-OWN-23 / E58: never release on unknown facts (an omitted stage or deal flag must not read as "applies").
      if (ctx.contactStage === undefined || ctx.dealOpen === undefined) {
        throw new OwnershipContextError('contactStage and dealOpen are required for inactivity timers');
      }
      // Disabled, past new/attempting, or an open deal: honoured at fire time; it only lets the agent keep the lead.
      if (!inactivityApplies(s, ctx.contactStage, ctx.dealOpen)) {
        return noop(state, [
          { kind: 'cancelTimers', dedupeKeys: periodTimerKeys(ctx.contactId, fence.periodSeq, ctx.inactivity).filter((k) => k.startsWith('ownership.inactivity:')) },
          { kind: 'setInactivityDeadlines', warnAt: null, releaseAt: null },
        ]);
      }
      if (now < fence.dueAt) return noop(state, [rescheduleTimer(ctx.contactId, cmd.deadline, fence, fence.dueAt, now)]);
      const b = new Builder(state, ctx.contactId, ctx);
      if (cmd.deadline === 'inactivity_warn') {
        b.emit('inactivity_warned', 'owned', { reasonCode: 'INACTIVITY_WARNING' });
        b.effect({ kind: 'setInactivityDeadlines', warnAt: null, releaseAt: ctx.inactivity.releaseAt });
        const key = `inactivity:${ctx.contactId}:${fence.periodSeq}:${fence.dueAt}`;
        b.notify(owner, 'inactivity_warning', 'high', key, 'INACTIVITY_WARNING');
        b.feed(owner, 'inactivity_warning', key, ctx.inactivity.releaseAt, ['INACTIVITY_WARNING']);
        return accepted(b, null);
      }
      b.emit('inactivity_released', 'in_pond', { reasonCode: 'INACTIVITY', pondId: s.defaultPondId });
      b.notify(owner, 'reassigned_away', 'normal', `inactivity_released:${ctx.contactId}:${fence.periodSeq}`, 'INACTIVITY');
      return accepted(b, null);
    }
  }
}

function decideTouch(state: OwnershipProjection, cmd: Cmd<'touch'>, ctx: DecisionContext): Decision {
  // R-OWN-14 / R-AST-15: only a human outbound by the owner or a collaborator, after owned_at.
  const u = userOf(ctx.actor);
  if (!u) return noop(state);
  if (state.state !== 'owned' || (state.ownerUserId !== u.userId && ctx.actorIsCollaborator !== true)) return noop(state);
  if (cmd.at < (state.ownedAt as Instant) || cmd.at > ctx.now) return noop(state);
  const b = new Builder(state, ctx.contactId, ctx);
  const period = state.periodSeq as number;
  if (state.firstTouchAt === null) {
    // also after a breach, so metrics show the true response time
    b.emit('first_touch_recorded', 'owned', {
      reasonCode: `FIRST_TOUCH_${upper(cmd.via)}`,
      payload: { via: cmd.via, refId: cmd.refId, touchAt: cmd.at, afterBreach: state.firstTouchBreachedAt !== null },
    });
    b.effect({ kind: 'cancelTimers', dedupeKeys: [breachTimerKey(ctx.contactId, period), releaseTimerKey(ctx.contactId, period)] });
    if (state.firstTouchDueAt !== null) b.effect({ kind: 'resolveFeed', dedupeKey: firstTouchFeedKey(ctx.contactId, period), userId: state.ownerUserId as UserId });
  }
  b.effect({ kind: 'recordHumanTouch', at: ctx.now });
  // R-OWN-23: any touch resets the stored inactivity deadlines, computed with the settings in force now.
  const old = ctx.inactivity;
  const oldKeys = [
    ...(old?.warnAt ? [inactivityTimerKey(ctx.contactId, 'warn', period, old.warnAt)] : []),
    ...(old?.releaseAt ? [inactivityTimerKey(ctx.contactId, 'release', period, old.releaseAt)] : []),
  ];
  if (oldKeys.length > 0) b.effect({ kind: 'cancelTimers', dedupeKeys: oldKeys });
  const d = inactivityDeadlines({ from: ctx.now, settings: ctx.settings, zone: ctx.settings.tenantZone, stage: ctx.contactStage, dealOpen: ctx.dealOpen });
  b.effect({ kind: 'setInactivityDeadlines', warnAt: d.warnAt, releaseAt: d.releaseAt });
  for (const t of inactivityTimers(ctx.contactId, period, d)) b.effect(t);
  // No audit row per touch: the touch is the send itself (audited/recorded by comms); the ledger keeps the first one.
  if (b.events.length === 0) return { ok: true, events: [], next: state, effects: b.effects };
  return accepted(b, null);
}

function decideReinquiry(state: OwnershipProjection, cmd: Cmd<'reinquiry'>, ctx: DecisionContext): Decision {
  if (!isSystem(ctx.actor, 'provider', 'worker')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  const b = new Builder(state, ctx.contactId, ctx);
  switch (state.state) {
    case 'owned': {
      // R-OWN-20 / E18: never changes the owner. A re-inquiry SLA (a new ownership period, E68) starts
      // when the last human touch was more than `reinquirySlaAfterDays` ago; it never auto-releases.
      // A never-touched lead is measured from owned_at: otherwise a duplicate inquiry minutes after an
      // accept would end the open first-touch period and cancel its breach and auto-release timers.
      const last = ctx.lastHumanTouchAt ?? (state.ownedAt as Instant);
      const owner = state.ownerUserId as UserId;
      const sla = ctx.now - last > ctx.settings.reinquirySlaAfterDays * DAY_MS;
      if (sla) {
        const p = periodStart(ctx, { allowRelease: false });
        b.emit('reinquiry', 'owned', { reasonCode: 'REINQUIRY_SLA', deadlineAt: p.deadlineAt, payload: { inquiryId: cmd.inquiryId, newPeriod: true, releaseDueAt: null } });
      } else {
        b.emit('reinquiry', 'owned', { reasonCode: 'REINQUIRY', payload: { inquiryId: cmd.inquiryId } });
      }
      b.notify(owner, 'inbound_message', 'high', `reinquiry:${cmd.inquiryId}`, 'REINQUIRY');
      b.feed(owner, 'reinquiry', `reinquiry:${ctx.contactId}:${cmd.inquiryId}`, b.state.firstTouchDueAt, ['REINQUIRY']);
      return accepted(b, null);
    }
    case 'in_pond': {
      const setting = ctx.pond && ctx.pond.pondId === state.pondId ? ctx.pond.reinquiry : 'reroute';
      if (setting === 'stay') {
        b.emit('reinquiry', 'in_pond', { reasonCode: 'REINQUIRY_STAY', pondId: state.pondId, payload: { inquiryId: cmd.inquiryId } });
        return accepted(b, null);
      }
      b.emit('reinquiry', 'unassigned', { reasonCode: 'REINQUIRY_REROUTE', payload: { inquiryId: cmd.inquiryId, routeDueAt: ctx.now } });
      routeIfPossible(b);
      return accepted(b, null);
    }
    case 'offered':
    case 'unassigned':
      return noop(state); // the inquiry is attached only
    case 'closed': {
      if (state.closedReason === 'merged') return rejection(state, cmd, ctx, 'CONTACT_MERGED'); // redirect along merged_into first
      for (const a of [...(ctx.people?.admins ?? [])].sort()) b.notify(a, 'system', 'normal', `reinquiry:${cmd.inquiryId}`, 'REINQUIRY_CLOSED');
      return noop(state, b.effects); // stays closed
    }
  }
}

/** close / soft_delete permission: Owner/Admin anywhere; TL for own, team-owned/-offered or pond/unassigned; others own only. */
function mayCloseOrDelete(state: OwnershipProjection, ctx: DecisionContext): boolean {
  const u = userOf(ctx.actor);
  if (!u) return isSystem(ctx.actor, 'worker');
  if (u.role === 'owner' || u.role === 'admin') return true;
  const own = state.state === 'owned' && state.ownerUserId === u.userId;
  // A TL sees every pond (DATA_MODEL §2) but only own/team owned and offered leads.
  if (u.role === 'team_lead') return state.state === 'owned' || state.state === 'offered' ? tlReaches(state, u.userId, ctx) : true;
  return own;
}

function decideClose(state: OwnershipProjection, cmd: Cmd<'close'>, ctx: DecisionContext): Decision {
  if (!(MANUAL_CLOSE_REASONS as readonly string[]).includes(cmd.reason)) return rejection(state, cmd, ctx, 'VALIDATION_FAILED');
  if (!mayCloseOrDelete(state, ctx)) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.state === 'closed' || staleUi(state, ctx)) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  const b = new Builder(state, ctx.contactId, ctx);
  b.emit('closed', 'closed', { reasonCode: `CLOSED_${upper(cmd.reason)}`, payload: { closedReason: cmd.reason } });
  return accepted(b, 'ownership.close');
}

function decideReopen(state: OwnershipProjection, cmd: Cmd<'reopen'>, ctx: DecisionContext): Decision {
  const u = userOf(ctx.actor);
  const allowed = u ? u.role === 'owner' || u.role === 'admin' || u.role === 'team_lead' : isSystem(ctx.actor, 'worker');
  if (!allowed) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.closedReason === 'merged') return rejection(state, cmd, ctx, 'CONTACT_MERGED');
  if (state.state !== 'closed' || (u && staleUi(state, ctx))) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  const b = new Builder(state, ctx.contactId, ctx);
  b.emit('reopened', 'unassigned', { reasonCode: 'REOPENED', payload: { routeDueAt: ctx.now, reopenedFrom: state.closedReason } });
  if (state.closedReason === 'deleted') b.effect({ kind: 'clearDeleted' });
  routeIfPossible(b);
  return accepted(b, 'ownership.reopen', state.closedReason === 'deleted');
}

function decideSoftDelete(state: OwnershipProjection, cmd: Cmd<'soft_delete'>, ctx: DecisionContext): Decision {
  if (!mayCloseOrDelete(state, ctx)) return rejection(state, cmd, ctx, 'NOT_FOUND');
  if (state.closedReason === 'merged') return rejection(state, cmd, ctx, 'CONTACT_MERGED');
  if (state.closedReason === 'deleted' || staleUi(state, ctx)) return rejection(state, cmd, ctx, 'LEAD_STATE_CHANGED');
  // R-OWN-26 / E62: an ownership command; an open offer is cancelled with it.
  const b = new Builder(state, ctx.contactId, ctx);
  b.emit('closed', 'closed', { reasonCode: 'SOFT_DELETED', payload: { closedReason: 'deleted' } });
  b.effect({ kind: 'markDeleted', purgeAfter: plusMs(ctx.now, ctx.settings.softDeletePurgeDays * DAY_MS) });
  return accepted(b, 'ownership.soft_delete', true);
}

function decideDeactivate(state: OwnershipProjection, cmd: Cmd<'deactivate_owner'>, ctx: DecisionContext): Decision {
  if (!isSystem(ctx.actor, 'worker')) return rejection(state, cmd, ctx, 'NOT_FOUND');
  const d = ctx.deactivation;
  if (!d) throw new OwnershipContextError('deactivation facts are required for deactivate_owner');
  const b = new Builder(state, ctx.contactId, ctx);
  const payload = { deactivationId: cmd.deactivationId, destination: cmd.destination };
  if (state.state === 'offered' && state.offeredToUserId === d.userId) {
    // R-OWN-22 stage 2: pending offers are rescinded and re-routed (the member is no longer eligible).
    b.emit('offer_rescinded', 'unassigned', { reasonCode: 'OWNER_DEACTIVATED', offerId: state.offerId, payload: { ...payload, routeDueAt: ctx.now } });
    routeIfPossible(b);
    return accepted(b, null);
  }
  if (state.state !== 'owned' || state.ownerUserId !== d.userId) return noop(state); // resumable: already moved
  // R-OWN-22 stage 3; E58: contacts with open deals always go to a user.
  const toUser = (): UserId => (d.teamLeadUserId && d.teamLeadUserId !== d.userId ? d.teamLeadUserId : d.fallbackUserId);
  // An omitted deal flag must never send an open-deal contact to a pond.
  if (cmd.destination !== 'team_lead' && ctx.dealOpen === undefined) throw new OwnershipContextError('dealOpen is required to deactivate an owner to a pond or re-route');
  if (cmd.destination === 'default_pond' && ctx.dealOpen !== true) {
    b.emit('sent_to_pond', 'in_pond', { reasonCode: 'OWNER_DEACTIVATED', pondId: ctx.settings.defaultPondId, payload });
  } else if (cmd.destination === 'reroute' && ctx.dealOpen !== true) {
    route(b);
  } else {
    const to = toUser();
    b.emit('reassigned', 'owned', { reasonCode: 'OWNER_DEACTIVATED', ownerUserId: to, deadlineAt: null, payload: { ...payload, releaseDueAt: null } });
    b.notify(to, 'reassigned_to_you', 'high', `owner_change:${ctx.contactId}:${b.state.seq}`, 'OWNER_DEACTIVATED');
  }
  return accepted(b, null);
}

// ---- merge -----------------------------------------------------------------------------------------

export type MergeDecision =
  | { ok: true; survivor: { events: OwnershipEvent[]; next: OwnershipProjection; effects: Effect[] }; loser: { events: OwnershipEvent[]; next: OwnershipProjection; effects: Effect[] } }
  | Extract<Decision, { ok: false }>;

/**
 * R-OWN-24: one merge command, one ledger event set per contact (both under the same command_id;
 * the caller locks both contacts in ascending id order). Survivor: [offer_rescinded] + merged_in;
 * loser: merged_away → closed/merged. The rejection, if any, is recorded against the survivor.
 */
export function decideMerge(survivor: OwnershipProjection, loser: OwnershipProjection, cmd: Cmd<'merge'>, ctx: DecisionContext): MergeDecision {
  // ctx.inactivity belongs to ctx.contactId; ctx.mergePeerInactivity to the other side.
  const inactivityOf = (id: ContactId) => (ctx.contactId === id ? ctx.inactivity : ctx.mergePeerInactivity);
  const sctx: DecisionContext = { ...ctx, contactId: cmd.survivorId, inactivity: inactivityOf(cmd.survivorId) };
  const reject = (code: OwnershipErrorCode, payload: Record<string, unknown> = {}) => rejection(survivor, cmd, sctx, code, payload) as Extract<Decision, { ok: false }>;
  // R-OWN-7: the merge that produced both projections, replayed, is a no-op.
  if (survivor.commandId === ctx.commandId && loser.commandId === ctx.commandId) {
    return { ok: true, survivor: { events: [], next: survivor, effects: [] }, loser: { events: [], next: loser, effects: [] } };
  }
  const u = userOf(ctx.actor);
  if (!u && !isSystem(ctx.actor, 'worker')) return reject('NOT_FOUND');
  if (u && !canOwnLeads(u.role)) return reject('NOT_FOUND');
  // DATA_MODEL §3: an agent/ISA sees pond and offer contacts only as cards, never their detail. A merge
  // involving one would hand them that person's data and ownership without a claim (R-OWN-16: limits,
  // cooldown, capacity, SLA) or an accept (R-OWN-8), so it is refused. TLs see pond detail; Owner/Admin all.
  if (u && u.role !== 'owner' && u.role !== 'admin' && u.role !== 'team_lead') {
    const cardOnly = (p: OwnershipProjection) => p.state === 'in_pond' || p.state === 'offered';
    if (cardOnly(survivor) || cardOnly(loser)) return reject('NOT_FOUND');
  }
  if (cmd.survivorId === cmd.loserId) return reject('VALIDATION_FAILED');
  if (survivor.closedReason === 'merged' || loser.closedReason === 'merged') return reject('CONTACT_MERGED');
  if (survivor.closedReason === 'deleted' || loser.closedReason === 'deleted') return reject('LEAD_STATE_CHANGED');
  if (u && staleUi(survivor, ctx)) return reject('LEAD_STATE_CHANGED');
  const own = mergeOwnership(survivor, loser, cmd.ownerChoice);
  if (!own.ok) return reject(own.code, { preselected: own.preselected });
  if (own.rule === 'different_owners' && u && u.role !== 'owner' && u.role !== 'admin' && u.role !== 'team_lead') return reject('NOT_FOUND');

  // survivor
  const sb = new Builder(survivor, cmd.survivorId, sctx);
  const owner = own.ownerUserId;
  const survivorOwner = survivor.state === 'owned' ? survivor.ownerUserId : null;
  const mergedPayload = { loserId: cmd.loserId, ownerRule: own.rule };
  if (owner === null || owner === survivorOwner) {
    sb.emit('merged_in', survivor.state, {
      reasonCode: 'MERGED_IN',
      pondId: survivor.pondId,
      offerId: survivor.offerId,
      offeredToUserId: survivor.offeredToUserId ?? undefined,
      deadlineAt: survivor.state === 'offered' ? survivor.offerExpiresAt : null,
      payload: {
        ...mergedPayload,
        ...(survivor.state === 'unassigned' ? { routeDueAt: survivor.routeDueAt } : {}),
        ...(survivor.state === 'closed' ? { closedReason: survivor.closedReason as NonNullable<OwnershipProjection['closedReason']> } : {}),
      },
    });
  } else {
    if (survivor.state === 'offered') sb.emit('offer_rescinded', 'unassigned', { reasonCode: 'OFFER_RESCINDED', offerId: survivor.offerId, payload: { routeDueAt: null } });
    sb.emit('merged_in', 'owned', { reasonCode: 'MERGED_IN', ownerUserId: owner, deadlineAt: null, payload: { ...mergedPayload, releaseDueAt: null } });
  }
  if (own.losingOwnerUserId) sb.notify(own.losingOwnerUserId, 'reassigned_away', 'normal', `merge:${cmd.loserId}:${cmd.survivorId}`, 'MERGED');
  const survivorEffects = finalize(sb, 'ownership.merge', true);

  // loser
  const lctx: DecisionContext = { ...ctx, contactId: cmd.loserId, inactivity: inactivityOf(cmd.loserId) };
  const lb = new Builder(loser, cmd.loserId, lctx);
  lb.emit('merged_away', 'closed', { reasonCode: 'MERGED_AWAY', payload: { survivorId: cmd.survivorId, closedReason: 'merged' } });
  lb.effect({ kind: 'markMergedInto', survivorId: cmd.survivorId });
  // The loser's live enrollment is stopped ('merged') and its open handbacks move to the survivor and
  // the surviving owner in db/client's merge transaction (R-OWN-24), so no pause and no clearing here.
  const loserEffects = finalize(lb, null)
    .filter((e) => e.kind !== 'pauseAgentEnrollments')
    .map((e): Effect => (e.kind === 'rehomeHandbacks' ? { kind: 'rehomeHandbacks', toUserId: owner } : e));

  return {
    ok: true,
    survivor: { events: sb.events, next: sb.state, effects: survivorEffects },
    loser: { events: lb.events, next: lb.state, effects: loserEffects },
  };
}

/** decide() for one side of a merge: `ctx.contactId` names the side, `ctx.mergePeer` is the other contact. */
function decideMergeSide(state: OwnershipProjection | null, cmd: Cmd<'merge'>, ctx: DecisionContext): Decision {
  if (!state) return rejection(state, cmd, ctx, 'NOT_FOUND');
  const peer = ctx.mergePeer;
  if (!peer) throw new OwnershipContextError('mergePeer is required for merge');
  const isSurvivor = ctx.contactId === cmd.survivorId;
  if (!isSurvivor && ctx.contactId !== cmd.loserId) throw new OwnershipContextError('ctx.contactId must be the survivor or the loser');
  const d = isSurvivor ? decideMerge(state, peer, cmd, ctx) : decideMerge(peer, state, cmd, ctx);
  if (!d.ok) return isSurvivor ? d : rejection(state, cmd, ctx, d.code, d.rejection.payload);
  const side = isSurvivor ? d.survivor : d.loser;
  return { ok: true, events: side.events, next: side.next, effects: side.effects };
}

// ---- deactivation command ids ------------------------------------------------------------------------

/**
 * R-OWN-22: the resumable deactivation job issues one `deactivate_owner` command per contact with
 * `command_id = hash(deactivation_id, contact_id)`, so a re-run replays instead of acting twice.
 * The id is a name-based UUIDv8 (RFC 9562 §5.8) from SHA-256, distinct from every UUIDv7 command id.
 */
export function deactivationCommandId(deactivationId: string, contactId: ContactId): string {
  const h = sha256Hex(`ownership.deactivate_owner:${deactivationId.toLowerCase()}:${contactId.toLowerCase()}`);
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- effect placement ------------------------------------------------------------------------------

/**
 * ARCHITECTURE §5 step 7: under a user actor, effects that write OTHER users' rows (their feed items,
 * handbacks, drafts, enrollments, collaborator rows, membership counters) and any routing go to the
 * single ownership.followup job, applied as the system actor. Everything else, and everything under
 * the system actor, runs inline in the command transaction.
 */
export function effectPlacement(e: Effect, actor: Actor): 'inline' | 'followup' {
  if (actor.kind !== 'user') return 'inline';
  switch (e.kind) {
    case 'route':
    case 'routingCursor':
    case 'invalidateDrafts':
    case 'pauseAgentEnrollments':
    case 'rehomeHandbacks':
    case 'addCollaborator':
      return 'followup';
    case 'upsertFeed':
      return e.item.userId === actor.userId ? 'inline' : 'followup';
    case 'resolveFeed':
    case 'membershipAutoPause':
    case 'missedOfferCounter':
      return e.userId === actor.userId ? 'inline' : 'followup';
    case 'enqueueTimer':
    case 'cancelTimers':
    case 'notify':
    case 'setInactivityDeadlines':
    case 'recordHumanTouch':
    case 'markDeleted':
    case 'clearDeleted':
    case 'markMergedInto':
    case 'audit':
      return 'inline';
  }
}

/** Splits a decision's effects by placement (the followup list becomes one ownership.followup job). */
export function placeEffects(effects: readonly Effect[], actor: Actor): { inline: Effect[]; followup: Effect[] } {
  const inline: Effect[] = [];
  const followup: Effect[] = [];
  for (const e of effects) (effectPlacement(e, actor) === 'inline' ? inline : followup).push(e);
  return { inline, followup };
}
