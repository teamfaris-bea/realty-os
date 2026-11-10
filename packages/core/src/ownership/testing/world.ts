// The simulated world of the ownership property suite (used only by tests and local harnesses):
// memberships, the job queue, the rotation cursor and the non-guarded inactivity columns, applying
// decide()'s effects the way db/client does, and asserting every invariant after each decision.
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  type Actor,
  type ContactId,
  DAY_MS,
  HOUR_MS,
  type Instant,
  MINUTE_MS,
  SECOND_MS,
  type UserId,
  sequentialIds,
} from '../../foundation/index.js';
import { decide, effectPlacement } from '../decide.js';
import { applyEvent, fold, foldFrom } from '../fold.js';
import { checkShape } from '../invariants.js';
import { offeredInCurrentSequence } from '../routing.js';
import { CAL, C1, C2, DEFAULT_POND, FALLBACK_POND, OTHER_POND, ROLE_OF, SETTINGS, T0, U, nyContactable, ownedLead, pond, pondLead, rule } from './fixtures.js';
import { inactivityApplies } from '../timers.js';
import {
  type Candidate,
  type ContactStage,
  type Decision,
  type DecisionContext,
  type Effect,
  type MembershipStatus,
  type OwnershipCommand,
  type OwnershipEvent,
  type OwnershipProjection,
  REASON_CODE_RE,
  type RotationCursor,
  type RoutingSnapshot,
  type TimerJobFence,
} from '../types.js';

export const USERS: UserId[] = [U.a, U.b, U.c, U.tl, U.isa, U.admin, U.owner, U.tc];
const ROUTED: UserId[] = [U.a, U.b, U.c, U.tl, U.isa, U.tc];
export const DTS = [0, SECOND_MS, 30 * SECOND_MS, MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS, DAY_MS, 8 * DAY_MS, 27 * DAY_MS, 31 * DAY_MS];
const CROSS_USER_KINDS = new Set(['route', 'routingCursor', 'invalidateDrafts', 'pauseAgentEnrollments', 'rehomeHandbacks', 'addCollaborator']);

const PEER_POND = pondLead().p;
const PEER_OWNED_B = ownedLead(U.b).p;

export interface Step {
  op: number;
  who: number;
  flag: number;
  dt: number;
}
export const stepArb = fc.record({ op: fc.nat(40), who: fc.nat(15), flag: fc.nat(15), dt: fc.nat(DTS.length - 1) });

interface Job {
  dedupeKey: string;
  runAt: Instant;
  fence: TimerJobFence;
}
interface MemberState {
  status: MembershipStatus;
  acceptingLeads: boolean;
  missed: number;
  channel: boolean;
}

export class World {
  constructor(readonly contactId: ContactId = C1) {}
  /** Called after every decision has been checked and committed (local DB harnesses persist it). */
  onDecision?: (d: Decision, cmd: OwnershipCommand, ctx: DecisionContext, prev: OwnershipProjection | null) => void;

  ids = sequentialIds({ prefix: 0x5eed });
  now: Instant = T0;
  ledger: OwnershipEvent[] = [];
  state: OwnershipProjection | null = null;
  jobs: Job[] = [];
  cursor: RotationCursor = {};
  inactivity: { warnAt: Instant | null; releaseAt: Instant | null } = { warnAt: null, releaseAt: null };
  lastHumanTouchAt: Instant | null = null;
  stage: ContactStage = 'new';
  dealOpen = false;
  members = new Map<UserId, MemberState>(USERS.map((u) => [u, { status: 'active', acceptingLeads: ROLE_OF[u] !== 'tc', missed: 0, channel: true }]));
  lastAccepted: { cmd: OwnershipCommand; ctx: DecisionContext } | null = null;
  decisions = 0;

  user(i: number): UserId {
    return USERS[i % USERS.length] as UserId;
  }
  actorFor(u: UserId): Actor {
    return { kind: 'user', userId: u, tenantId: 'tenant' as never, role: ROLE_OF[u] ?? 'agent', sessionId: 's' };
  }
  system(via: Extract<Actor, { kind: 'system' }>['via']): Actor {
    return { kind: 'system', tenantId: 'tenant' as never, via };
  }
  memberFacts(u: UserId) {
    const m = this.members.get(u) as MemberState;
    return { userId: u, role: ROLE_OF[u] ?? 'agent', status: m.status, acceptingLeads: m.acceptingLeads, inActorTeam: u !== U.owner && u !== U.admin };
  }
  routing(flag: number): RoutingSnapshot {
    const strategies = ['round_robin', 'weighted', 'direct', 'pond', 'none'] as const;
    const s = strategies[flag % strategies.length] as (typeof strategies)[number];
    if (s === 'none') return { rule: null, candidates: [], cursor: {}, alreadyOffered: [] };
    const r = rule({
      strategy: s,
      directUserId: s === 'direct' ? U.a : null,
      targetPondId: s === 'pond' ? OTHER_POND : null,
      fallbackPondId: flag % 2 === 0 ? FALLBACK_POND : null,
      maxOffers: flag % 3 === 0 ? 2 : null,
    });
    const candidates: Candidate[] = ROUTED.map((u, i) => {
      const m = this.members.get(u) as MemberState;
      return {
        userId: u,
        weight: 1 + ((i * 7 + flag) % 5),
        role: ROLE_OF[u] ?? 'agent',
        status: m.status,
        acceptingLeads: m.acceptingLeads,
        hasCriticalChannel: m.channel,
        inReleaseCooldown: (flag + i) % 9 === 0,
        uncontactedOwned: (flag * (i + 1)) % 7,
      };
    });
    return { rule: r, candidates, cursor: this.cursor, alreadyOffered: offeredInCurrentSequence(this.ledger) };
  }
  ctx(actor: Actor, over: Partial<DecisionContext> = {}): DecisionContext {
    const offeree = this.state?.offeredToUserId ?? null;
    return {
      now: this.now,
      ids: this.ids,
      actor,
      commandId: this.ids.next<'CommandId'>(),
      contactId: this.contactId,
      settings: SETTINGS,
      calendar: CAL,
      nextContactableAt: nyContactable,
      people: { admins: [U.admin], teamLeadsOf: { [U.a]: [U.tl], [U.b]: [U.tl], [U.c]: [U.tl], [U.isa]: [U.tl] } },
      contactStage: this.stage,
      dealOpen: this.dealOpen,
      lastHumanTouchAt: this.lastHumanTouchAt,
      inactivity: this.inactivity,
      offereeMissedOffers: offeree ? (this.members.get(offeree)?.missed ?? 0) : 0,
      ...over,
    };
  }

  /** Builds the next command from a random step (or null for "time passes"). */
  command(s: Step): { cmd: OwnershipCommand; ctx: DecisionContext } | null {
    const st = this.state;
    const who = this.user(s.who);
    const me = this.actorFor(who);
    const offerId = s.flag % 4 === 0 ? 'stale-offer' : (st?.offerId ?? 'none');
    if (st === null) {
      const k = s.op % 4;
      if (k === 0) return { cmd: { kind: 'create', via: 'self' }, ctx: this.ctx(me) };
      if (k === 1) return { cmd: { kind: 'import_assign', target: s.flag % 3 === 0 ? 'unassigned' : s.flag % 3 === 1 ? { pondId: DEFAULT_POND } : { userId: who } }, ctx: this.ctx(this.system('import'), { targetMember: this.memberFacts(who) }) };
      return { cmd: { kind: 'create', via: s.flag % 2 ? 'intake' : 'inbound' }, ctx: this.ctx(this.system('provider'), s.flag % 3 ? { routing: this.routing(s.flag) } : {}) };
    }
    switch (s.op % 20) {
      case 0:
        return { cmd: { kind: 'route' }, ctx: s.flag % 5 === 0 ? this.ctx(me) : this.ctx(this.system('worker'), { routing: this.routing(s.flag) }) };
      case 1:
      case 2: {
        const offeree = st.offeredToUserId ?? who;
        const actor = s.flag % 3 === 0 ? me : this.actorFor(offeree);
        return { cmd: { kind: 'accept', offerId }, ctx: this.ctx(actor, { actorMember: this.memberFacts(actor.kind === 'user' ? actor.userId : who) }) };
      }
      case 3: {
        const actor = s.flag % 3 === 0 ? me : this.actorFor(st.offeredToUserId ?? who);
        return { cmd: { kind: 'decline', offerId, reason: 'busy' }, ctx: this.ctx(actor) };
      }
      case 4:
        return {
          cmd: { kind: 'claim', pondId: s.flag % 5 === 0 ? OTHER_POND : (st.pondId ?? DEFAULT_POND) },
          ctx: this.ctx(me, {
            expectedSeq: s.flag % 7 === 0 ? st.seq - 1 : undefined,
            actorMember: this.memberFacts(who),
            pond: pond({ pondId: s.flag % 5 === 0 ? OTHER_POND : (st.pondId ?? DEFAULT_POND), eligibleRoles: s.flag % 6 === 0 ? ['agent'] : ['agent', 'team_lead', 'isa'] }),
            claimStats: { claimsToday: s.flag % 8 === 0 ? 5 : 1, inCooldown: s.flag % 11 === 0, uncontactedOwned: s.flag % 13 === 0 ? 5 : 0 },
          }),
        };
      case 5: {
        const owner = st.ownerUserId ?? who;
        return { cmd: { kind: 'release', reason: s.flag % 4 === 0 ? 'other' : 'not_a_fit', note: s.flag % 8 === 0 ? undefined : 'n' }, ctx: this.ctx(s.flag % 5 === 0 ? me : this.actorFor(owner)) };
      }
      case 6:
      case 7: {
        const target = this.user(s.flag);
        const actor = s.flag % 4 === 0 ? this.system('worker') : me;
        return { cmd: { kind: s.op % 2 ? 'assign' : 'reassign', toUserId: target, reason: s.flag % 9 === 0 ? 'bad reason' : 'MANUAL' }, ctx: this.ctx(actor, { targetMember: this.memberFacts(target), ownerInActorTeam: s.flag % 2 === 0 }) };
      }
      case 8: {
        const target = this.user(s.flag);
        return { cmd: { kind: 'isa_handoff', toUserId: target, note: s.flag % 6 === 0 ? '' : 'context' }, ctx: this.ctx(this.actorFor(s.flag % 3 ? (st.ownerUserId ?? U.isa) : U.isa), { targetMember: this.memberFacts(target) }) };
      }
      case 9:
      case 10:
      case 11:
      case 12:
        return this.timerCommand(s);
      case 13:
      case 14: {
        const owner = st.ownerUserId ?? who;
        const actor = s.flag % 6 === 0 ? this.system('assistant') : this.actorFor(s.flag % 4 === 0 ? who : owner);
        return { cmd: { kind: 'touch', via: (['call', 'sms', 'email'] as const)[s.flag % 3] as 'sms', refId: `ref-${s.flag}`, at: this.now }, ctx: this.ctx(actor, { actorIsCollaborator: s.flag % 5 === 0 }) };
      }
      case 15:
        return {
          cmd: { kind: 'reinquiry', inquiryId: `inq-${this.ledger.length}` },
          ctx: this.ctx(this.system('provider'), { routing: s.flag % 2 ? this.routing(s.flag) : undefined, pond: st.pondId ? pond({ pondId: st.pondId, reinquiry: s.flag % 3 ? 'reroute' : 'stay' }) : undefined }),
        };
      case 16:
        if (s.flag % 5 === 4) {
          // this contact survives a merge with a pond lead or another agent's lead (R-OWN-24)
          const peer = s.who % 2 ? PEER_POND : PEER_OWNED_B;
          const choice = s.who % 3 === 0 ? null : s.who % 3 === 1 ? U.b : (st.ownerUserId ?? null);
          return { cmd: { kind: 'merge', survivorId: this.contactId, loserId: C2, ownerChoice: choice }, ctx: this.ctx(s.flag % 2 ? this.actorFor(U.admin) : me, { mergePeer: peer }) };
        }
        return { cmd: { kind: 'close', reason: (['spam', 'do_not_contact', 'not_a_lead', 'merged'] as const)[s.flag % 4] as 'spam' }, ctx: this.ctx(me, { ownerInActorTeam: s.flag % 2 === 0 }) };
      case 17:
        return s.flag % 2
          ? { cmd: { kind: 'reopen' }, ctx: this.ctx(s.flag % 3 ? this.actorFor(U.admin) : this.system('worker'), { routing: this.routing(s.flag) }) }
          : { cmd: { kind: 'soft_delete' }, ctx: this.ctx(me) };
      case 18: {
        const d = (['team_lead', 'default_pond', 'reroute'] as const)[s.flag % 3] as 'reroute';
        const target = st.ownerUserId ?? st.offeredToUserId ?? who;
        this.members.set(target, { ...(this.members.get(target) as MemberState), status: 'deactivating' });
        return { cmd: { kind: 'deactivate_owner', destination: d, deactivationId: 'dx' }, ctx: this.ctx(this.system('worker'), { routing: this.routing(s.flag), deactivation: { userId: target, teamLeadUserId: target === U.tl ? null : U.tl, fallbackUserId: U.admin } }) };
      }
      case 19: {
        // world facts change (stage, deal, membership) between commands
        if (s.flag % 4 === 0) this.stage = (['new', 'attempting', 'connected', 'active'] as const)[s.who % 4] as ContactStage;
        else if (s.flag % 4 === 1) this.dealOpen = !this.dealOpen;
        else if (s.flag % 4 === 2) {
          const m = this.members.get(who) as MemberState;
          this.members.set(who, { ...m, status: m.status === 'active' ? 'suspended' : 'active', channel: !m.channel });
        } else if (this.lastAccepted) return this.lastAccepted; // replay of the last accepted command
        return null;
      }
    }
    return null;
  }

  timerCommand(s: Step): { cmd: OwnershipCommand; ctx: DecisionContext } | null {
    const st = this.state as OwnershipProjection;
    let fence: TimerJobFence | undefined;
    if (this.jobs.length > 0 && s.flag % 5 !== 0) {
      const job = this.jobs[s.who % this.jobs.length] as Job;
      fence = job.fence;
      if (s.flag % 3 !== 0 && this.now < job.runAt) this.now = job.runAt; // due (else possibly an early wake)
    } else {
      // a stale / forged fence
      fence = s.flag % 2 ? { contactId: this.contactId, deadline: 'offer_expiry', offerId: 'forged' } : { contactId: this.contactId, deadline: 'auto_release', periodSeq: (st.periodSeq ?? 1) + 7, dueAt: this.now };
    }
    const f = fence;
    const cmd: OwnershipCommand = { kind: 'timer', deadline: f.deadline, fence: f.deadline === 'offer_expiry' ? { offerId: f.offerId } : { periodSeq: f.periodSeq, dueAt: f.dueAt } };
    return { cmd, ctx: this.ctx(this.system(s.flag % 2 ? 'timer' : 'worker'), s.flag % 4 ? { routing: this.routing(s.flag) } : {}) };
  }

  /** Whether a timer fence is current (matches the stored state) — computed independently of decide(). */
  fenceCurrent(cmd: Extract<OwnershipCommand, { kind: 'timer' }>, ctx: DecisionContext): { current: boolean; due: Instant | null } {
    const st = this.state as OwnershipProjection;
    const f = cmd.fence;
    if (cmd.deadline === 'offer_expiry') {
      if (!('offerId' in f)) return { current: false, due: null };
      return { current: st.state === 'offered' && st.offerId === f.offerId, due: st.offerExpiresAt };
    }
    if (!('periodSeq' in f)) return { current: false, due: null };
    const inPeriod = st.state === 'owned' && st.periodSeq === f.periodSeq;
    switch (cmd.deadline) {
      case 'first_touch_breach':
        return { current: inPeriod && st.firstTouchDueAt === f.dueAt && st.firstTouchAt === null && st.firstTouchBreachedAt === null, due: f.dueAt };
      case 'auto_release':
        return { current: inPeriod && st.releaseDueAt === f.dueAt && st.firstTouchAt === null, due: f.dueAt };
      default: {
        const stored = cmd.deadline === 'inactivity_warn' ? this.inactivity.warnAt : this.inactivity.releaseAt;
        return { current: inPeriod && stored === f.dueAt && inactivityApplies(ctx.settings, ctx.contactStage, ctx.dealOpen), due: f.dueAt };
      }
    }
  }

  apply(cmd: OwnershipCommand, ctx: DecisionContext): Decision {
    const prev = this.state;
    const timerCheck = cmd.kind === 'timer' && prev ? this.fenceCurrent(cmd, ctx) : null;
    const d = decide(prev, cmd, ctx);
    this.decisions += 1;
    const isReplay = this.lastAccepted !== null && this.lastAccepted.ctx === ctx;

    // --- a rejection has no events and leaves the projection unchanged
    if (!d.ok) {
      this.onDecision?.(d, cmd, ctx, prev);
      expect(d.next).toBe(prev);
      expect(d.effects).toEqual([]);
      expect(d.rejection).toMatchObject({ code: d.code, commandId: ctx.commandId, commandKind: cmd.kind, observedSeq: prev?.seq ?? null, occurredAt: ctx.now });
      expect(d.code).toMatch(REASON_CODE_RE);
      return d;
    }
    // --- seq gapless; next.seq is the ledger head; next == fold(prev ledger ++ events)
    const base = prev?.seq ?? 0;
    d.events.forEach((e, i) => {
      expect(e.seq).toBe(base + i + 1);
      expect(e.commandId).toBe(ctx.commandId);
      expect(e.occurredAt).toBe(ctx.now);
      expect(e.contactId).toBe(this.contactId);
      expect(e.toState === 'owned').toBe(e.ownerUserId !== null); // ledger CHECK owned ↔ owner
      expect(e.actorKind !== 'user' || e.actorUserId !== null).toBe(true);
      expect(e.reasonCode).toMatch(REASON_CODE_RE);
      expect(e.note === null || e.note.length <= 500).toBe(true);
    });
    if (d.events.length === 0) {
      expect(d.next).toEqual(prev);
    } else {
      const last = d.events.at(-1) as OwnershipEvent;
      expect(d.next.seq).toBe(last.seq);
      expect(foldFrom(prev, d.events)).toEqual(d.next);
      // the contacts_guard trigger: a ledger row at the head matching state/owner/pond/offeree/actor/command
      expect([last.toState, last.ownerUserId, last.pondId, last.offeredToUserId]).toEqual([d.next.state, d.next.ownerUserId, d.next.pondId, d.next.offeredToUserId]);
      expect(last.actorKind === 'user').toBe(d.next.actorUserId !== null);
      expect(d.next.commandId).toBe(ctx.commandId);
    }
    expect(checkShape(d.next)).toEqual([]);

    // --- routing and cross-user effects never run inline under a user actor
    if (ctx.actor.kind === 'user') {
      expect(d.events.some((e) => e.type === 'offered')).toBe(false);
      for (const e of d.effects) {
        if (CROSS_USER_KINDS.has(e.kind)) expect(effectPlacement(e, ctx.actor)).toBe('followup');
        if ((e.kind === 'upsertFeed' && e.item.userId !== ctx.actor.userId) || ((e.kind === 'resolveFeed' || e.kind === 'membershipAutoPause' || e.kind === 'missedOfferCounter') && e.userId !== ctx.actor.userId)) {
          expect(effectPlacement(e, ctx.actor)).toBe('followup');
        }
      }
    }
    if (ctx.actor.kind === 'system' && ctx.actor.via === 'assistant') expect(d.events).toEqual([]); // R-OWN-21 / R-AST-15
    // --- every offered event carries candidates[] with skip reasons
    for (const e of d.events.filter((x) => x.type === 'offered')) {
      expect(Array.isArray(e.payload.candidates)).toBe(true);
      expect((e.payload.candidates ?? []).length).toBeGreaterThan(0);
      for (const c of e.payload.candidates ?? []) expect(c.eligible).toBe(c.skipReason === undefined);
      expect(e.payload.candidates?.find((c) => c.userId === e.offeredToUserId)?.eligible).toBe(true);
    }
    // --- stale fences are no-ops; current due fences fire (E70: a breach never stales auto-release)
    if (timerCheck) {
      if (!timerCheck.current) expect(d.events).toEqual([]);
      else if (timerCheck.due !== null && ctx.now >= timerCheck.due) expect(d.events.length).toBeGreaterThan(0);
      else expect(d.events).toEqual([]);
    }
    // --- the command that produced the projection, replayed, is a no-op
    if (isReplay) expect(d).toEqual({ ok: true, events: [], next: prev, effects: [] });

    this.commit(d, cmd, ctx);
    this.onDecision?.(d, cmd, ctx, prev);
    return d;
  }

  commit(d: Extract<Decision, { ok: true }>, cmd: OwnershipCommand, ctx: DecisionContext): void {
    this.ledger.push(...d.events);
    if (d.events.length > 0) {
      this.state = d.next;
      this.lastAccepted = { cmd, ctx };
    }
    for (const e of d.effects) this.effect(e);
    // DB CHECK contacts_owned_period: stored inactivity deadlines only while owned
    if (this.state && this.state.state !== 'owned') expect(this.inactivity).toEqual({ warnAt: null, releaseAt: null });
  }

  effect(e: Effect): void {
    switch (e.kind) {
      case 'enqueueTimer':
        this.jobs = this.jobs.filter((j) => j.dedupeKey !== e.dedupeKey);
        this.jobs.push({ dedupeKey: e.dedupeKey, runAt: e.runAt, fence: e.fence });
        break;
      case 'cancelTimers':
        this.jobs = this.jobs.filter((j) => !e.dedupeKeys.includes(j.dedupeKey));
        break;
      case 'setInactivityDeadlines':
        this.inactivity = { warnAt: e.warnAt, releaseAt: e.releaseAt };
        break;
      case 'recordHumanTouch':
        this.lastHumanTouchAt = e.at;
        break;
      case 'routingCursor':
        this.cursor = e.cursor;
        break;
      case 'membershipAutoPause': {
        const m = this.members.get(e.userId) as MemberState;
        this.members.set(e.userId, { ...m, acceptingLeads: false });
        break;
      }
      case 'missedOfferCounter': {
        const m = this.members.get(e.userId) as MemberState;
        this.members.set(e.userId, { ...m, missed: e.op === 'increment' ? m.missed + 1 : 0 });
        break;
      }
      default:
        break;
    }
  }

  /** Per-period invariants over the whole ledger. */
  finalChecks(): void {
    if (this.ledger.length === 0) return;
    expect(fold(this.ledger)).toEqual(this.state);
    let p: OwnershipProjection | null = null;
    let touches = 0;
    let breaches = 0;
    for (const e of this.ledger) {
      const prevPeriod: number | null = p?.periodSeq ?? null;
      p = applyEvent(p, e);
      if (p.periodSeq !== prevPeriod) {
        touches = 0;
        breaches = 0;
      }
      if (e.type === 'first_touch_recorded') touches += 1;
      if (e.type === 'first_touch_breached') breaches += 1;
      expect(touches).toBeLessThanOrEqual(1); // once per ownership period
      expect(breaches).toBeLessThanOrEqual(1);
    }
  }
}

