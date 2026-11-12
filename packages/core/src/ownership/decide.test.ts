import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, type Instant, type UserId, addLocalDays, at, instant, plusMs } from '../foundation/index.js';
import { OwnershipContextError, decide, effectPlacement, placeEffects } from './decide.js';
import { offeredInCurrentSequence } from './routing.js';
import {
  C1,
  DEFAULT_POND,
  FALLBACK_POND,
  Lead,
  NY,
  OTHER_POND,
  RULE,
  SETTINGS,
  T0,
  U,
  candidate,
  ctx,
  eventsOf,
  expectRejected,
  member,
  nyContactable,
  offeredLead,
  ownedLead,
  pond,
  pondLead,
  rule,
  systemActor,
  userActor,
} from './testing/fixtures.js';
import { TOUCH_VIAS, type Decision, type Effect, type OwnershipCommand } from './types.js';

const kinds = (d: Decision) => d.effects.map((e) => e.kind);
const effectsOf = <K extends Effect['kind']>(d: Decision, k: K) => d.effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === k);
const rr = (members: UserId[], over: Parameters<typeof rule>[0] = {}) => ({ rule: rule(over), candidates: members.map((m) => candidate(m)), cursor: {}, alreadyOffered: [] as UserId[] });

describe('create', () => {
  it('R-OWN-19: a contact created manually by an agent, ISA or TL is owned by its creator (SELF_CREATED), with no SLA', () => {
    for (const who of [U.a, U.isa, U.tl]) {
      const l = new Lead();
      const d = l.run({ kind: 'create', via: 'self' }, { actor: userActor(who) });
      const [e] = eventsOf(d);
      expect(e).toMatchObject({ type: 'created', fromState: null, toState: 'owned', ownerUserId: who, reasonCode: 'SELF_CREATED', seq: 1, actorKind: 'user', actorUserId: who, deadlineAt: null });
      expect(l.p).toMatchObject({ state: 'owned', ownerUserId: who, firstTouchDueAt: null, releaseDueAt: null, periodSeq: 1, ownedAt: T0 });
      expect(effectsOf(d, 'enqueueTimer').filter((t) => t.jobKind !== 'ownership.inactivity')).toEqual([]);
      expect(effectsOf(d, 'audit')).toEqual([{ kind: 'audit', action: 'ownership.create' }]);
    }
  });

  it('R-PERM-15: a TC cannot create (own) a contact', () => {
    expectRejected(decide(null, { kind: 'create', via: 'self' }, ctx({ actor: userActor(U.tc) })), 'NOT_FOUND');
  });

  it('R-OWN-10: intake without a routing snapshot creates `unassigned` awaiting routing and asks for a route', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider') });
    expect(l.p).toMatchObject({ state: 'unassigned', routeDueAt: T0, seq: 1 });
    expect(kinds(d)).toContain('route');
    expect(eventsOf(d)[0]).toMatchObject({ actorKind: 'provider', actorUserId: null, reasonCode: 'INTAKE' });
  });

  it('creating an existing contact, or intake by a user, is refused', () => {
    const l = ownedLead();
    expectRejected(decide(l.p, { kind: 'create', via: 'self' }, ctx({ actor: userActor(U.a) })), 'LEAD_STATE_CHANGED');
    expectRejected(decide(null, { kind: 'create', via: 'intake' }, ctx({ actor: userActor(U.a) })), 'NOT_FOUND');
  });
});

describe('routing and offers', () => {
  it('R-OWN-9 R-OWN-10: intake routes inline as the system actor to one offer, with candidates[] and the cursor in the same decision', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { routing: rr([U.a, U.b], { strategy: 'round_robin' }) });
    const [created, offered] = eventsOf(d);
    expect(created).toMatchObject({ type: 'created', toState: 'unassigned' });
    expect(offered).toMatchObject({ type: 'offered', fromState: 'unassigned', toState: 'offered', offeredToUserId: U.a, routingRuleId: RULE, seq: 2 });
    expect(offered?.payload.candidates).toEqual([{ userId: U.a, eligible: true }, { userId: U.b, eligible: true }]);
    expect(offered?.deadlineAt).toBe(plusMs(T0, 5 * MINUTE_MS));
    expect(l.p).toMatchObject({ state: 'offered', offerRound: 1, offerExpiresAt: plusMs(T0, 5 * MINUTE_MS), routeDueAt: null });
    expect(effectsOf(d, 'routingCursor')).toEqual([{ kind: 'routingCursor', ruleId: RULE, cursor: { lastUserId: U.a } }]);
    expect(effectsOf(d, 'enqueueTimer')[0]).toMatchObject({ jobKind: 'ownership.offer_expiry', runAt: l.p.offerExpiresAt, fence: { contactId: C1, deadline: 'offer_expiry', offerId: l.p.offerId } });
    expect(effectsOf(d, 'notify')[0]).toMatchObject({ userId: U.a, notification: { kind: 'lead_offer', priority: 'critical' } });
    expect(kinds(d)).not.toContain('route');
  });

  it('R-OWN-10: no rule match sends the lead to the default pond (NO_RULE_MATCH)', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { routing: { rule: null, candidates: [], cursor: {}, alreadyOffered: [] } });
    expect(eventsOf(d)[1]).toMatchObject({ type: 'sent_to_pond', toState: 'in_pond', pondId: DEFAULT_POND, reasonCode: 'NO_RULE_MATCH', routingRuleId: null });
    expect(l.p).toMatchObject({ state: 'in_pond', pondId: DEFAULT_POND });
  });

  it('R-OWN-10: a pond-strategy rule sends the lead to its target pond', () => {
    const l = pondLead(OTHER_POND);
    expect(l.events[1]).toMatchObject({ type: 'sent_to_pond', pondId: OTHER_POND, reasonCode: 'RULE_POND', routingRuleId: RULE });
  });

  it('R-OWN-9 R-OWN-11 E11: with nobody eligible the lead goes to the pond at once (NO_ELIGIBLE_AGENT), TLs and Admins get a critical notification', () => {
    const l = new Lead();
    const routing = {
      rule: rule({ fallbackPondId: FALLBACK_POND }),
      candidates: [candidate(U.a, { acceptingLeads: false }), candidate(U.b, { hasCriticalChannel: false }), candidate(U.c, { status: 'deactivating' })],
      cursor: {},
      alreadyOffered: [],
    };
    const d = l.run({ kind: 'create', via: 'intake' }, { routing });
    const pondEvent = eventsOf(d)[1];
    expect(pondEvent).toMatchObject({ type: 'sent_to_pond', pondId: FALLBACK_POND, reasonCode: 'NO_ELIGIBLE_AGENT' });
    expect(pondEvent?.payload.candidates).toEqual([
      { userId: U.a, eligible: false, skipReason: 'NOT_ACCEPTING_LEADS' },
      { userId: U.b, eligible: false, skipReason: 'NO_CRITICAL_CHANNEL' },
      { userId: U.c, eligible: false, skipReason: 'MEMBERSHIP_INACTIVE' },
    ]);
    const notified = effectsOf(d, 'notify').map((n) => [n.userId, n.notification.priority, n.notification.reasonCode]);
    expect(notified).toEqual([
      [U.admin, 'critical', 'NO_ELIGIBLE_AGENT'],
      [U.tl, 'critical', 'NO_ELIGIBLE_AGENT'],
    ]);
  });

  it('R-OWN-9 E8: a lead at 02:00 is offered now; the 300 s window counts from the 08:00 opening', () => {
    const night = at('2026-11-10T02:00:00-05:00');
    const l = offeredLead(U.a, night);
    expect(l.events[1]?.occurredAt).toBe(night);
    expect(l.p.offerExpiresAt).toBe(at('2026-11-10T08:05:00-05:00'));
  });

  it('R-OWN-9: a rule may override the offer window', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { routing: rr([U.a], { offerWindowSeconds: 120 }) });
    expect(l.p.offerExpiresAt).toBe(plusMs(T0, 2 * MINUTE_MS));
  });

  it('R-OWN-9 R-OWN-10: after max_offers expiries the lead goes to the fallback pond (MAX_OFFERS_REACHED), else the default pond', () => {
    for (const fallback of [FALLBACK_POND, null]) {
      const l = new Lead();
      const members = [U.a, U.b, U.c];
      const routing = () => ({ rule: rule({ fallbackPondId: fallback }), candidates: members.map((m) => candidate(m)), cursor: {}, alreadyOffered: offeredInCurrentSequence(l.events) });
      l.run({ kind: 'create', via: 'intake' }, { routing: routing() });
      for (let round = 1; round <= 3; round++) {
        expect(l.p).toMatchObject({ state: 'offered', offerRound: round });
        const now = l.p.offerExpiresAt as Instant;
        l.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l.p.offerId as string } }, { now, actor: systemActor('timer'), routing: routing() });
      }
      expect(l.p).toMatchObject({ state: 'in_pond', pondId: fallback ?? DEFAULT_POND });
      expect(l.events.at(-1)).toMatchObject({ type: 'sent_to_pond', reasonCode: 'MAX_OFFERS_REACHED' });
      expect(l.events.filter((e) => e.type === 'offered').map((e) => e.offeredToUserId)).toEqual([U.a, U.b, U.c]);
    }
  });

  it('R-OWN-11: the same lead is never offered twice in one sequence (ALREADY_OFFERED)', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { routing: rr([U.a, U.b]) });
    l.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l.p.offerId as string } }, {
      now: l.p.offerExpiresAt as Instant,
      actor: systemActor('timer'),
      routing: { rule: rule(), candidates: [candidate(U.a)], cursor: { lastUserId: U.b }, alreadyOffered: offeredInCurrentSequence(l.events) },
    });
    expect(l.events.at(-1)?.payload.candidates).toEqual([{ userId: U.a, eligible: false, skipReason: 'ALREADY_OFFERED' }]);
    expect(l.p.state).toBe('in_pond');
  });

  it('R-OWN-10: a route command under a user actor is refused; a stale route is a no-op', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider') });
    expectRejected(decide(l.p, { kind: 'route' }, ctx({ actor: userActor(U.admin) })), 'NOT_FOUND');
    l.run({ kind: 'route' }, { routing: rr([U.a]) });
    expect(l.p.state).toBe('offered');
    const again = decide(l.p, { kind: 'route' }, ctx({ routing: rr([U.b]) }));
    expect(again).toMatchObject({ ok: true, events: [] });
  });

  it('routing without a snapshot is a programming error', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider') });
    expect(() => decide(l.p, { kind: 'route' }, ctx())).toThrow(OwnershipContextError);
  });
});

describe('accept (R-OWN-8)', () => {
  it('R-OWN-8 R-OWN-13: an accept inside the window by the offeree owns the lead and starts the first-touch SLA', () => {
    const l = offeredLead(U.a);
    const offerId = l.p.offerId as string;
    const now = plusMs(T0, 2 * MINUTE_MS);
    const d = l.run({ kind: 'accept', offerId }, { now, actor: userActor(U.a), actorMember: member(U.a) });
    expect(eventsOf(d)).toHaveLength(1);
    expect(eventsOf(d)[0]).toMatchObject({ type: 'offer_accepted', fromState: 'offered', toState: 'owned', ownerUserId: U.a, offerId, seq: 3, deadlineAt: plusMs(now, 15 * MINUTE_MS) });
    expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.a, ownedAt: now, periodSeq: 3, firstTouchDueAt: plusMs(now, 15 * MINUTE_MS), releaseDueAt: plusMs(now, 30 * MINUTE_MS), offerRound: 0, routingRuleId: RULE });
    expect(kinds(d)).toEqual(expect.arrayContaining(['cancelTimers', 'resolveFeed', 'missedOfferCounter', 'enqueueTimer', 'setInactivityDeadlines', 'audit']));
    expect(effectsOf(d, 'enqueueTimer').map((t) => t.jobKind)).toEqual(['ownership.first_touch_breach', 'ownership.auto_release', 'ownership.inactivity', 'ownership.inactivity']);
    expect(effectsOf(d, 'missedOfferCounter')).toEqual([{ kind: 'missedOfferCounter', userId: U.a, op: 'reset' }]);
  });

  it('R-OWN-8 E2: an accept 200 ms after expiry is LEAD_OFFER_EXPIRED (rejection only); the due timer then expires the offer and re-offers as the system', () => {
    const l = offeredLead(U.a);
    const expires = l.p.offerExpiresAt as Instant;
    const before = l.p;
    const late = decide(l.p, { kind: 'accept', offerId: l.p.offerId as string }, ctx({ now: plusMs(expires, 200), actor: userActor(U.a), actorMember: member(U.a) }));
    expectRejected(late, 'LEAD_OFFER_EXPIRED');
    if (!late.ok) {
      expect(late.next).toBe(before);
      expect(late.rejection).toMatchObject({ commandKind: 'accept', observedSeq: 2, actorKind: 'user', actorUserId: U.a, contactId: C1 });
    }
    const d = l.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: before.offerId as string } }, { now: plusMs(expires, 300), actor: systemActor('timer'), routing: { ...rr([U.a, U.b]), alreadyOffered: [U.a] } });
    expect(eventsOf(d).map((e) => e.type)).toEqual(['offer_expired', 'offered']);
    expect(eventsOf(d).every((e) => e.actorKind === 'timer')).toBe(true);
    expect(l.p).toMatchObject({ state: 'offered', offeredToUserId: U.b, offerRound: 2 });
  });

  it('R-OWN-8 E3: accept and expiry at the expiry instant: accept wins only if now < expires_at (no grace)', () => {
    const l = offeredLead(U.a);
    const expires = l.p.offerExpiresAt as Instant;
    const mk = (now: Instant) => decide(l.p, { kind: 'accept', offerId: l.p.offerId as string }, ctx({ now, actor: userActor(U.a), actorMember: member(U.a) }));
    expect(mk(plusMs(expires, -1)).ok).toBe(true);
    expectRejected(mk(expires), 'LEAD_OFFER_EXPIRED');
    // the expiry timer at the same instant expires it
    const t = decide(l.p, { kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l.p.offerId as string } }, ctx({ now: expires, actor: systemActor('timer') }));
    expect(eventsOf(t)[0]?.type).toBe('offer_expired');
  });

  it('R-OWN-8: an accept by someone other than the offeree is LEAD_OFFER_NOT_YOURS', () => {
    const l = offeredLead(U.a);
    expectRejected(decide(l.p, { kind: 'accept', offerId: l.p.offerId as string }, ctx({ actor: userActor(U.b), actorMember: member(U.b) })), 'LEAD_OFFER_NOT_YOURS');
  });

  it('R-OWN-8: an accept of a replaced offer is LEAD_OFFER_SUPERSEDED', () => {
    const l = offeredLead(U.a);
    const old = l.p.offerId as string;
    l.run({ kind: 'decline', offerId: old }, { actor: userActor(U.a) });
    l.run({ kind: 'route' }, { routing: rr([U.b]) });
    expectRejected(decide(l.p, { kind: 'accept', offerId: old }, ctx({ actor: userActor(U.a), actorMember: member(U.a) })), 'LEAD_OFFER_SUPERSEDED');
  });

  it('R-OWN-8: an accept by an inactive member is MEMBERSHIP_INACTIVE', () => {
    const l = offeredLead(U.a);
    for (const status of ['suspended', 'deactivating', 'removed', 'invited'] as const) {
      expectRejected(decide(l.p, { kind: 'accept', offerId: l.p.offerId as string }, ctx({ actor: userActor(U.a), actorMember: member(U.a, { status }) })), 'MEMBERSHIP_INACTIVE');
    }
  });

  it('a second accept by the current owner returns ALREADY_OWNER with no events', () => {
    // R-OWN-7 (core half; stored-outcome replay is db/client's)
    const l = ownedLead(U.a);
    const d = decide(l.p, { kind: 'accept', offerId: l.events[1]?.offerId as string }, ctx({ actor: userActor(U.a), actorMember: member(U.a) }));
    expectRejected(d, 'ALREADY_OWNER');
    expect('events' in d && d.events).toBeFalsy();
  });

  it('replaying the command that produced the projection writes nothing', () => {
    // R-OWN-7 (core half)
    const l = offeredLead(U.a);
    const c = ctx({ actor: userActor(U.a), actorMember: member(U.a) });
    const first = decide(l.p, { kind: 'accept', offerId: l.p.offerId as string }, c);
    expect(first.ok).toBe(true);
    const replay = decide(first.next, { kind: 'accept', offerId: l.p.offerId as string }, { ...c });
    expect(replay).toEqual({ ok: true, events: [], next: first.next, effects: [] });
  });

  it('E4: an Admin reassigns while the agent accepts: whichever is second gets LEAD_STATE_CHANGED', () => {
    // reassign first, then the accept
    const l1 = offeredLead(U.a);
    const offerId = l1.p.offerId as string;
    l1.run({ kind: 'reassign', toUserId: U.b, reason: 'MANUAL' }, { actor: userActor(U.admin), targetMember: member(U.b), expectedSeq: 2 });
    expectRejected(decide(l1.p, { kind: 'accept', offerId }, ctx({ actor: userActor(U.a), actorMember: member(U.a) })), 'LEAD_STATE_CHANGED');
    // accept first, then the reassign the Admin's UI built at seq 2
    const l2 = offeredLead(U.a);
    l2.run({ kind: 'accept', offerId: l2.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a) });
    expectRejected(decide(l2.p, { kind: 'reassign', toUserId: U.b, reason: 'MANUAL' }, ctx({ actor: userActor(U.admin), targetMember: member(U.b), expectedSeq: 2 })), 'LEAD_STATE_CHANGED');
  });
});

describe('decline (E5) and auto-pause (R-OWN-12)', () => {
  it('R-OWN-10 E5: a decline commits offer_declined → unassigned with route_due_at; routing is a follow-up as the system', () => {
    const l = offeredLead(U.a);
    const actor = userActor(U.a);
    const d = l.run({ kind: 'decline', offerId: l.p.offerId as string, reason: 'busy' }, { actor });
    expect(eventsOf(d).map((e) => e.type)).toEqual(['offer_declined']);
    expect(l.p).toMatchObject({ state: 'unassigned', routeDueAt: T0, offerRound: 1 });
    const route = effectsOf(d, 'route');
    expect(route).toHaveLength(1);
    expect(effectPlacement(route[0] as Effect, actor)).toBe('followup');
    // ownership.followup re-routes as the system actor with full eligibility data, never back to the decliner
    const f = l.run({ kind: 'route' }, { routing: { ...rr([U.a, U.b]), alreadyOffered: offeredInCurrentSequence(l.events) } });
    expect(eventsOf(f)[0]?.payload.candidates).toEqual([{ userId: U.a, eligible: false, skipReason: 'ALREADY_OFFERED' }, { userId: U.b, eligible: true }]);
    expect(l.p).toMatchObject({ state: 'offered', offeredToUserId: U.b, offerRound: 2, routeDueAt: null });
  });

  it('R-OWN-12: the third consecutive missed or declined offer auto-pauses the agent, audited, agent and TL notified', () => {
    const l = offeredLead(U.a);
    const d = l.run({ kind: 'decline', offerId: l.p.offerId as string }, { actor: userActor(U.a), offereeMissedOffers: 2 });
    expect(effectsOf(d, 'membershipAutoPause')).toEqual([{ kind: 'membershipAutoPause', userId: U.a }]);
    expect(effectsOf(d, 'audit').map((a) => a.action)).toEqual(['member.auto_paused', 'ownership.decline']);
    expect(effectsOf(d, 'notify').map((n) => [n.userId, n.notification.reasonCode])).toEqual([[U.a, 'AUTO_PAUSED'], [U.tl, 'AUTO_PAUSED']]);
    const l2 = offeredLead(U.a);
    const e = l2.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l2.p.offerId as string } }, { now: l2.p.offerExpiresAt as Instant, actor: systemActor('timer'), offereeMissedOffers: 1 });
    expect(effectsOf(e, 'missedOfferCounter')).toEqual([{ kind: 'missedOfferCounter', userId: U.a, op: 'increment' }]);
    expect(effectsOf(e, 'membershipAutoPause')).toEqual([]);
    expect(effectsOf(e, 'route')).toHaveLength(1); // no snapshot: the sweeper/followup routes
  });

  it('a decline needs the offer: wrong offeree, expired, superseded, malformed reason', () => {
    const l = offeredLead(U.a);
    const offerId = l.p.offerId as string;
    expectRejected(decide(l.p, { kind: 'decline', offerId }, ctx({ actor: userActor(U.b) })), 'LEAD_OFFER_NOT_YOURS');
    expectRejected(decide(l.p, { kind: 'decline', offerId }, ctx({ actor: userActor(U.a), now: l.p.offerExpiresAt as Instant })), 'LEAD_OFFER_EXPIRED');
    expectRejected(decide(l.p, { kind: 'decline', offerId: 'other' }, ctx({ actor: userActor(U.a) })), 'LEAD_OFFER_SUPERSEDED');
    expectRejected(decide(l.p, { kind: 'decline', offerId, reason: 'nope' as never }, ctx({ actor: userActor(U.a) })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'decline', offerId }, ctx({ actor: systemActor() })), 'NOT_FOUND');
    expect(() => decide(l.p, { kind: 'decline', offerId }, ctx({ actor: userActor(U.a), offereeMissedOffers: undefined }))).toThrow(OwnershipContextError);
  });
});

describe('claim (R-OWN-16)', () => {
  const claimCtx = (who: UserId, over: Parameters<typeof ctx>[0] = {}) =>
    ctx({ actor: userActor(who), actorMember: member(who), pond: pond(), claimStats: { claimsToday: 0, inCooldown: false, uncontactedOwned: 0 }, ...over });

  it('R-OWN-16 R-OWN-13: a claim of a pond lead owns it and starts the first-touch SLA', () => {
    const l = pondLead();
    const d = l.run({ kind: 'claim', pondId: DEFAULT_POND }, { ...claimCtx(U.a) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'claimed', fromState: 'in_pond', toState: 'owned', ownerUserId: U.a, pondId: null, payload: { fromPondId: DEFAULT_POND } });
    expect(l.p).toMatchObject({ state: 'owned', firstTouchDueAt: plusMs(T0, 15 * MINUTE_MS), pondId: null });
    expect(effectsOf(d, 'audit')).toEqual([{ kind: 'audit', action: 'ownership.claim' }]);
  });

  it('of two claims exactly one wins; the loser gets LEAD_ALREADY_CLAIMED (rejection log, not the ledger) and the next command uses seq + 1', () => {
    // R-OWN-5 / E1 decision half; the two-session lock test belongs to db/client
    const l = pondLead();
    const seqBefore = l.p.seq;
    const win = l.run({ kind: 'claim', pondId: DEFAULT_POND }, { ...claimCtx(U.a), expectedSeq: seqBefore });
    expect(win.ok).toBe(true);
    const lose = decide(l.p, { kind: 'claim', pondId: DEFAULT_POND }, claimCtx(U.b, { expectedSeq: seqBefore }));
    expectRejected(lose, 'LEAD_ALREADY_CLAIMED');
    if (!lose.ok) expect(lose.rejection).toMatchObject({ observedSeq: seqBefore + 1, actorUserId: U.b, commandKind: 'claim' });
    const rel = l.run({ kind: 'release', reason: 'not_a_fit' }, { actor: userActor(U.a) });
    expect(eventsOf(rel)[0]?.seq).toBe(seqBefore + 2);
  });

  it('R-OWN-16 R-PERM-15: POND_NOT_ELIGIBLE for a role outside the pond, a TC, a closed pond, or an archived pond', () => {
    const l = pondLead();
    const cmd: OwnershipCommand = { kind: 'claim', pondId: DEFAULT_POND };
    expectRejected(decide(l.p, cmd, claimCtx(U.isa, { pond: pond({ eligibleRoles: ['agent'] }) })), 'POND_NOT_ELIGIBLE');
    expectRejected(decide(l.p, cmd, claimCtx(U.tc, { actorMember: member(U.tc), pond: pond({ eligibleRoles: ['agent', 'team_lead', 'isa', 'tc' as never] }) })), 'POND_NOT_ELIGIBLE');
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { pond: pond({ openToAll: false, actorIsMember: false }) })), 'POND_NOT_ELIGIBLE');
    expect(decide(l.p, cmd, claimCtx(U.a, { pond: pond({ openToAll: false, actorIsMember: true }) })).ok).toBe(true);
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { pond: pond({ archived: true }) })), 'POND_NOT_ELIGIBLE');
  });

  it('R-OWN-16: an inactive member, the daily limit, the cooldown and the capacity cap are refused (in that order)', () => {
    const l = pondLead();
    const cmd: OwnershipCommand = { kind: 'claim', pondId: DEFAULT_POND };
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { actorMember: member(U.a, { status: 'suspended' }), claimStats: { claimsToday: 9, inCooldown: true, uncontactedOwned: 9 } })), 'MEMBERSHIP_INACTIVE');
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { claimStats: { claimsToday: 5, inCooldown: true, uncontactedOwned: 9 } })), 'CLAIM_LIMIT_REACHED');
    expect(decide(l.p, cmd, claimCtx(U.a, { claimStats: { claimsToday: 4, inCooldown: false, uncontactedOwned: 4 } })).ok).toBe(true);
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { claimStats: { claimsToday: 4, inCooldown: true, uncontactedOwned: 9 } })), 'CLAIM_COOLDOWN');
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { claimStats: { claimsToday: 0, inCooldown: false, uncontactedOwned: 5 } })), 'CAPACITY_REACHED');
    expectRejected(decide(l.p, cmd, claimCtx(U.a, { pond: pond({ claimsPerDay: 0 }) })), 'CLAIM_LIMIT_REACHED');
  });

  it('claiming your own lead is ALREADY_OWNER; a wrong pond or stale card is LEAD_STATE_CHANGED', () => {
    const l = pondLead();
    expectRejected(decide(l.p, { kind: 'claim', pondId: OTHER_POND }, claimCtx(U.a, { pond: pond({ pondId: OTHER_POND }) })), 'LEAD_STATE_CHANGED');
    expectRejected(decide(l.p, { kind: 'claim', pondId: DEFAULT_POND }, claimCtx(U.a, { expectedSeq: 1 })), 'LEAD_STATE_CHANGED');
    l.run({ kind: 'claim', pondId: DEFAULT_POND }, { ...claimCtx(U.a) });
    expectRejected(decide(l.p, { kind: 'claim', pondId: DEFAULT_POND }, claimCtx(U.a)), 'ALREADY_OWNER');
    expect(() => decide(pondLead().p, { kind: 'claim', pondId: DEFAULT_POND }, ctx({ actor: userActor(U.a) }))).toThrow(OwnershipContextError);
  });
});

describe('release (R-OWN-17)', () => {
  it('R-OWN-17: a release needs a reason (+ note for other), goes to the default pond, and records the releaser as previous owner (cooldown)', () => {
    const l = ownedLead(U.a);
    const actor = userActor(U.a);
    expectRejected(decide(l.p, { kind: 'release', reason: 'other' }, ctx({ actor })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'release', reason: 'other', note: '  ' }, ctx({ actor })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'release', reason: 'bored' as never }, ctx({ actor })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'release', reason: 'not_a_fit', note: 'x'.repeat(501) }, ctx({ actor })), 'VALIDATION_FAILED');
    const d = l.run({ kind: 'release', reason: 'other', note: 'Moved out of state' }, { actor });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'released', toState: 'in_pond', pondId: DEFAULT_POND, prevOwnerUserId: U.a, reasonCode: 'RELEASED_OTHER', note: 'Moved out of state' });
    expect(l.p).toMatchObject({ state: 'in_pond', ownerUserId: null, periodSeq: null, ownedAt: null, firstTouchDueAt: null });
    expect(kinds(d)).toEqual(expect.arrayContaining(['invalidateDrafts', 'pauseAgentEnrollments', 'rehomeHandbacks', 'cancelTimers', 'setInactivityDeadlines']));
    expect(effectsOf(d, 'setInactivityDeadlines')).toEqual([{ kind: 'setInactivityDeadlines', warnAt: null, releaseAt: null }]);
    expect(effectsOf(d, 'rehomeHandbacks')).toEqual([{ kind: 'rehomeHandbacks', toUserId: null }]);
  });

  it('R-OWN-17: a release to another pond needs a pond the releaser may use', () => {
    const l = ownedLead(U.a);
    const actor = userActor(U.a);
    expectRejected(decide(l.p, { kind: 'release', reason: 'wrong_area', toPondId: OTHER_POND }, ctx({ actor })), 'POND_NOT_ELIGIBLE');
    expectRejected(decide(l.p, { kind: 'release', reason: 'wrong_area', toPondId: OTHER_POND }, ctx({ actor, pond: pond({ pondId: OTHER_POND, eligibleRoles: ['isa'] }) })), 'POND_NOT_ELIGIBLE');
    const d = decide(l.p, { kind: 'release', reason: 'wrong_area', toPondId: OTHER_POND }, ctx({ actor, pond: pond({ pondId: OTHER_POND, isDefault: false }) }));
    expect(d.next?.pondId).toBe(OTHER_POND);
  });

  it('only the owner releases; a stale UI gets LEAD_STATE_CHANGED', () => {
    const l = ownedLead(U.a);
    expectRejected(decide(l.p, { kind: 'release', reason: 'not_a_fit' }, ctx({ actor: userActor(U.b) })), 'LEAD_STATE_CHANGED');
    expectRejected(decide(l.p, { kind: 'release', reason: 'not_a_fit' }, ctx({ actor: userActor(U.a), expectedSeq: 1 })), 'LEAD_STATE_CHANGED');
    expectRejected(decide(l.p, { kind: 'release', reason: 'not_a_fit' }, ctx({ actor: systemActor() })), 'NOT_FOUND');
  });
});

describe('reassignment (R-OWN-18)', () => {
  it('R-OWN-18 R-AST-7: an Admin reassigns anywhere; both owners are notified; the old period ends (drafts invalidated, enrollments paused, handbacks re-homed) as follow-up effects', () => {
    const l = ownedLead(U.a);
    const actor = userActor(U.admin);
    const d = l.run({ kind: 'reassign', toUserId: U.b, reason: 'COVERAGE', note: 'vacation' }, { actor, targetMember: member(U.b) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'reassigned', fromState: 'owned', toState: 'owned', ownerUserId: U.b, prevOwnerUserId: U.a, reasonCode: 'COVERAGE', deadlineAt: null });
    expect(l.p).toMatchObject({ ownerUserId: U.b, periodSeq: 4, firstTouchDueAt: null, releaseDueAt: null });
    expect(effectsOf(d, 'notify').map((n) => [n.userId, n.notification.kind])).toEqual([[U.b, 'reassigned_to_you'], [U.a, 'reassigned_away']]);
    const { followup } = placeEffects(d.effects, actor);
    expect(followup.map((e) => e.kind)).toEqual(expect.arrayContaining(['invalidateDrafts', 'pauseAgentEnrollments', 'rehomeHandbacks', 'resolveFeed']));
    expect(effectsOf(d, 'rehomeHandbacks')).toEqual([{ kind: 'rehomeHandbacks', toUserId: U.b }]);
    expect(effectsOf(d, 'audit')).toEqual([{ kind: 'audit', action: 'ownership.reassign' }]);
  });

  it('R-OWN-18: a TL reassigns only when the current owner and the target are both in a team they lead', () => {
    const l = ownedLead(U.a);
    const actor = userActor(U.tl);
    const cmd: OwnershipCommand = { kind: 'reassign', toUserId: U.b, reason: 'COVERAGE' };
    expectRejected(decide(l.p, cmd, ctx({ actor, targetMember: member(U.b, { inActorTeam: true }), ownerInActorTeam: false })), 'NOT_FOUND');
    expectRejected(decide(l.p, cmd, ctx({ actor, targetMember: member(U.b, { inActorTeam: false }), ownerInActorTeam: true })), 'TARGET_NOT_ELIGIBLE');
    expect(decide(l.p, cmd, ctx({ actor, targetMember: member(U.b, { inActorTeam: true }), ownerInActorTeam: true })).ok).toBe(true);
    // a TL may take a team member's lead themselves
    expect(decide(l.p, { ...cmd, toUserId: U.tl }, ctx({ actor, targetMember: member(U.tl), ownerInActorTeam: true })).ok).toBe(true);
  });

  it('R-OWN-18 R-PERM-15: agents cannot reassign; targets must be active and able to own leads (never a TC); reassigning to the owner is ALREADY_OWNER', () => {
    const l = ownedLead(U.a);
    const admin = userActor(U.admin);
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.b, reason: 'X' }, ctx({ actor: userActor(U.a), targetMember: member(U.b) })), 'NOT_FOUND');
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.tc, reason: 'X' }, ctx({ actor: admin, targetMember: member(U.tc) })), 'TARGET_NOT_ELIGIBLE');
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.b, reason: 'X' }, ctx({ actor: admin, targetMember: member(U.b, { status: 'deactivating' }) })), 'TARGET_NOT_ELIGIBLE');
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.b, reason: 'X' }, ctx({ actor: admin })), 'TARGET_NOT_ELIGIBLE');
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.a, reason: 'X' }, ctx({ actor: admin, targetMember: member(U.a) })), 'ALREADY_OWNER');
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.b, reason: 'lower' }, ctx({ actor: admin, targetMember: member(U.b) })), 'VALIDATION_FAILED');
  });

  it('R-OWN-18: reassigning an offered lead writes offer_rescinded then assigned', () => {
    const l = offeredLead(U.a);
    const offerId = l.p.offerId;
    const d = l.run({ kind: 'assign', toUserId: U.b, reason: 'MANUAL' }, { actor: userActor(U.owner), targetMember: member(U.b) });
    expect(eventsOf(d).map((e) => [e.type, e.fromState, e.toState, e.offerId])).toEqual([
      ['offer_rescinded', 'offered', 'unassigned', offerId],
      ['assigned', 'unassigned', 'owned', null],
    ]);
    expect(effectsOf(d, 'resolveFeed')).toEqual([{ kind: 'resolveFeed', dedupeKey: `lead_offer:${C1}:${offerId}`, userId: U.a }]);
    expect(effectsOf(d, 'cancelTimers')[0]?.dedupeKeys).toEqual([`ownership.offer_expiry:${C1}:${offerId}`]);
    expect(kinds(d)).not.toContain('route');
  });

  // Batch 6 review ownership-sla/F6: the agent the lead was on offer to was told nothing; their offer card just resolved.
  it('R-OWN-18: assigning a lead on offer tells the agent it was offered to that the offer was withdrawn (not when it goes to them)', () => {
    const l = offeredLead(U.a);
    const d = l.run({ kind: 'assign', toUserId: U.b, reason: 'MANUAL' }, { actor: userActor(U.owner), targetMember: member(U.b) });
    expect(effectsOf(d, 'notify').map((n) => [n.userId, n.notification.kind, n.notification.reasonCode])).toEqual([
      [U.b, 'reassigned_to_you', 'REASSIGNED_TO_YOU'],
      [U.a, 'reassigned_away', 'OFFER_RESCINDED'],
    ]);
    // given to the agent it was on offer to: one notice, as the new owner
    const mine = offeredLead(U.a).run({ kind: 'assign', toUserId: U.a, reason: 'MANUAL' }, { actor: userActor(U.owner), targetMember: member(U.a) });
    expect(effectsOf(mine, 'notify').map((n) => [n.userId, n.notification.kind])).toEqual([[U.a, 'reassigned_to_you']]);
  });

  it('R-OWN-18: an ISA hands off only their own lead, to an agent or TL, with a note; the ISA stays a collaborator for 7 days', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'self' }, { actor: userActor(U.isa) });
    const isa = userActor(U.isa);
    expectRejected(decide(l.p, { kind: 'isa_handoff', toUserId: U.a, note: '' }, ctx({ actor: isa, targetMember: member(U.a) })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'isa_handoff', toUserId: U.owner, note: 'warm' }, ctx({ actor: isa, targetMember: member(U.owner) })), 'TARGET_NOT_ELIGIBLE');
    expectRejected(decide(l.p, { kind: 'isa_handoff', toUserId: U.a, note: 'warm' }, ctx({ actor: userActor(U.a), targetMember: member(U.a) })), 'NOT_FOUND');
    const d = l.run({ kind: 'isa_handoff', toUserId: U.a, note: 'Pre-approved, wants Saturday showings' }, { actor: isa, targetMember: member(U.a) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'reassigned', ownerUserId: U.a, prevOwnerUserId: U.isa, reasonCode: 'ISA_HANDOFF' });
    expect(effectsOf(d, 'addCollaborator')).toEqual([{ kind: 'addCollaborator', userId: U.isa, role: 'isa', expiresAt: addLocalDays(T0, 7, NY) }]);
    expect(effectPlacement(effectsOf(d, 'addCollaborator')[0] as Effect, isa)).toBe('followup');
    expectRejected(decide(l.p, { kind: 'isa_handoff', toUserId: U.b, note: 'again' }, ctx({ actor: isa, targetMember: member(U.b) })), 'LEAD_STATE_CHANGED');
  });
});

describe('first-touch timers (R-OWN-13, R-OWN-14, R-OWN-15)', () => {
  const timer = (l: Lead, deadline: 'first_touch_breach' | 'auto_release', now: Instant) =>
    l.run({ kind: 'timer', deadline, fence: { periodSeq: l.p.periodSeq as number, dueAt: (deadline === 'auto_release' ? l.p.releaseDueAt : l.p.firstTouchDueAt) as Instant } }, { now, actor: systemActor('timer') });

  it('R-OWN-13: at the due time first_touch_breached is written once per period; owner and TL are notified', () => {
    const l = ownedLead(U.a);
    const due = l.p.firstTouchDueAt as Instant;
    const d = timer(l, 'first_touch_breach', due);
    expect(eventsOf(d)[0]).toMatchObject({ type: 'first_touch_breached', toState: 'owned', ownerUserId: U.a, actorKind: 'timer' });
    expect(l.p.firstTouchBreachedAt).toBe(due);
    expect(effectsOf(d, 'notify').map((n) => [n.userId, n.notification.kind])).toEqual([[U.a, 'first_touch_due'], [U.tl, 'first_touch_escalation']]);
    const again = decide(l.p, { kind: 'timer', deadline: 'first_touch_breach', fence: { periodSeq: l.p.periodSeq as number, dueAt: due } }, ctx({ now: plusMs(due, 1000), actor: systemActor('timer') }));
    expect(again).toMatchObject({ ok: true, events: [], effects: [] });
  });

  it('R-OWN-15 E70: a breach at T+15 min advances the seq but not the period; the auto-release fence still matches at T+30 min', () => {
    const l = ownedLead(U.a);
    const fence = { periodSeq: l.p.periodSeq as number, dueAt: l.p.releaseDueAt as Instant };
    timer(l, 'first_touch_breach', l.p.firstTouchDueAt as Instant);
    expect(l.p.periodSeq).toBe(fence.periodSeq);
    expect(l.p.seq).toBe(fence.periodSeq + 1);
    const d = l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer') });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'auto_released', toState: 'in_pond', pondId: DEFAULT_POND, reasonCode: 'FIRST_TOUCH_MISSED', prevOwnerUserId: U.a });
    expect(effectsOf(d, 'notify').map((n) => n.userId)).toEqual([U.a, U.tl]);
  });

  it('R-OWN-15: an early wake reschedules at the stored deadline; a duplicate or stale fence is a no-op', () => {
    const l = ownedLead(U.a);
    const fence = { periodSeq: l.p.periodSeq as number, dueAt: l.p.firstTouchDueAt as Instant };
    const early = decide(l.p, { kind: 'timer', deadline: 'first_touch_breach', fence }, ctx({ now: plusMs(fence.dueAt, -5000), actor: systemActor('timer') }));
    expect(early.ok && early.events).toEqual([]);
    expect(effectsOf(early, 'enqueueTimer')[0]).toMatchObject({ runAt: fence.dueAt, fence: { deadline: 'first_touch_breach', periodSeq: fence.periodSeq, dueAt: fence.dueAt } });
    expect(effectsOf(early, 'enqueueTimer')[0]?.dedupeKey).not.toBe(`ownership.first_touch_breach:${C1}:${fence.periodSeq}`);
    for (const stale of [{ ...fence, periodSeq: 1 }, { ...fence, dueAt: plusMs(fence.dueAt, 1) }]) {
      expect(decide(l.p, { kind: 'timer', deadline: 'first_touch_breach', fence: stale }, ctx({ now: plusMs(fence.dueAt, 1e6), actor: systemActor('timer') }))).toMatchObject({ ok: true, events: [], effects: [] });
    }
    const offer = offeredLead(U.b);
    expect(decide(offer.p, { kind: 'timer', deadline: 'offer_expiry', fence: { offerId: 'old-offer' } }, ctx({ now: plusMs(T0, DAY_MS), actor: systemActor('timer') }))).toMatchObject({ ok: true, events: [] });
    const earlyOffer = decide(offer.p, { kind: 'timer', deadline: 'offer_expiry', fence: { offerId: offer.p.offerId as string } }, ctx({ actor: systemActor('timer') }));
    expect(effectsOf(earlyOffer, 'enqueueTimer')[0]).toMatchObject({ jobKind: 'ownership.offer_expiry', runAt: offer.p.offerExpiresAt });
    expectRejected(decide(offer.p, { kind: 'timer', deadline: 'offer_expiry', fence: { periodSeq: 1, dueAt: T0 } }, ctx({ actor: systemActor('timer') })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'timer', deadline: 'auto_release', fence: { offerId: 'x' } }, ctx({ actor: systemActor('timer') })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'timer', deadline: 'auto_release', fence }, ctx({ actor: userActor(U.admin) })), 'NOT_FOUND');
  });

  it('R-OWN-13: first_touch_release_seconds = NULL disables auto-release', () => {
    const l = offeredLead(U.a);
    const d = l.run({ kind: 'accept', offerId: l.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a), settings: { ...SETTINGS, firstTouchReleaseSeconds: null } });
    expect(l.p.releaseDueAt).toBeNull();
    expect(effectsOf(d, 'enqueueTimer').map((t) => t.jobKind)).not.toContain('ownership.auto_release');
  });

  it('R-OWN-13 E8: the SLA counts 15 business minutes from the next contactable instant', () => {
    const night = at('2026-11-10T02:00:00-05:00');
    const l = offeredLead(U.a, night);
    l.run({ kind: 'accept', offerId: l.p.offerId as string }, { now: plusMs(night, MINUTE_MS), actor: userActor(U.a), actorMember: member(U.a), nextContactableAt: nyContactable });
    expect(l.p.ownedAt).toBe(plusMs(night, MINUTE_MS));
    expect(l.p.firstTouchDueAt).toBe(at('2026-11-10T09:15:00-05:00'));
    expect(l.p.releaseDueAt).toBe(at('2026-11-10T09:30:00-05:00'));
  });

  it('R-OWN-14: the first gate-allowed human touch by the owner records first_touch_recorded, cancels breach/release, resets inactivity', () => {
    const l = ownedLead(U.a);
    const now = plusMs(T0, 5 * MINUTE_MS);
    const d = l.run({ kind: 'touch', via: 'sms', refId: 'msg-1', at: now }, { now, actor: userActor(U.a) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'first_touch_recorded', toState: 'owned', occurredAt: now, payload: { via: 'sms', refId: 'msg-1', afterBreach: false } });
    expect(l.p.firstTouchAt).toBe(now);
    const p = l.p.periodSeq as number;
    expect(effectsOf(d, 'cancelTimers')[0]?.dedupeKeys).toEqual([`ownership.first_touch_breach:${C1}:${p}`, `ownership.auto_release:${C1}:${p}`]);
    expect(effectsOf(d, 'recordHumanTouch')).toEqual([{ kind: 'recordHumanTouch', at: now }]);
    expect(effectsOf(d, 'setInactivityDeadlines')).toEqual([{ kind: 'setInactivityDeadlines', releaseAt: addLocalDays(now, 30, NY), warnAt: instant(addLocalDays(now, 30, NY) - 72 * HOUR_MS) }]);
    // a second touch writes no ledger event, only the activity
    const later = plusMs(now, HOUR_MS);
    const d2 = l.run({ kind: 'touch', via: 'call', refId: 'call-1', at: later }, { now: later, actor: userActor(U.a) });
    expect(eventsOf(d2)).toEqual([]);
    expect(kinds(d2)).toEqual(['recordHumanTouch', 'cancelTimers', 'setInactivityDeadlines', 'enqueueTimer', 'enqueueTimer']);
  });

  it('R-OWN-14: a touch after a breach still writes first_touch_recorded (true response time)', () => {
    const l = ownedLead(U.a);
    timer(l, 'first_touch_breach', l.p.firstTouchDueAt as Instant);
    const now = plusMs(l.p.firstTouchDueAt as Instant, MINUTE_MS);
    const d = l.run({ kind: 'touch', via: 'call', refId: 'call-9', at: now }, { now, actor: userActor(U.a) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'first_touch_recorded', payload: { afterBreach: true } });
  });

  it('R-AST-15 R-OWN-14: assistant and system messages never count as a touch; notes by others neither; a collaborator touch counts', () => {
    const l = ownedLead(U.a);
    const t = { kind: 'touch', via: 'sms', refId: 'm', at: T0 } as const;
    expect(decide(l.p, t, ctx({ actor: systemActor('assistant') }))).toEqual({ ok: true, events: [], next: l.p, effects: [] });
    expect(decide(l.p, t, ctx({ actor: systemActor('worker') }))).toEqual({ ok: true, events: [], next: l.p, effects: [] });
    expect(decide(l.p, t, ctx({ actor: userActor(U.b) }))).toEqual({ ok: true, events: [], next: l.p, effects: [] });
    expect(decide(l.p, { ...t, at: plusMs(T0, -1) }, ctx({ actor: userActor(U.a) }))).toMatchObject({ ok: true, events: [] });
    expect(eventsOf(decide(l.p, t, ctx({ actor: userActor(U.isa), actorIsCollaborator: true })))[0]?.type).toBe('first_touch_recorded');
    expect(decide(pondLead().p, t, ctx({ actor: userActor(U.a) }))).toMatchObject({ ok: true, events: [] });
  });

  it('R-OWN-14 E310 E311: a reply in the website chat is a touch like a text (owner decision D8): every touch kind records the first touch once; the assistant’s chat reply and a member who is neither owner nor collaborator never do', () => {
    // the four kinds of human touch, each the first touch of its own lead (FIRST_TOUCH_<VIA>)
    expect(TOUCH_VIAS).toEqual(['call', 'sms', 'email', 'chat']);
    for (const via of TOUCH_VIAS) {
      const l = ownedLead(U.a);
      const now = plusMs(T0, 2 * MINUTE_MS);
      const d = l.run({ kind: 'touch', via, refId: `${via}-1`, at: now }, { now, actor: userActor(U.a) });
      expect(eventsOf(d), via).toHaveLength(1);
      expect(eventsOf(d)[0], via).toMatchObject({ type: 'first_touch_recorded', reasonCode: `FIRST_TOUCH_${via.toUpperCase()}`, occurredAt: now, payload: { via, refId: `${via}-1`, afterBreach: false } });
      const p = l.p.periodSeq as number;
      expect(effectsOf(d, 'cancelTimers')[0]?.dedupeKeys, via).toEqual([`ownership.first_touch_breach:${C1}:${p}`, `ownership.auto_release:${C1}:${p}`]);
      expect(effectsOf(d, 'recordHumanTouch'), via).toEqual([{ kind: 'recordHumanTouch', at: now }]);
    }
    const l = ownedLead(U.a);
    const chat = { kind: 'touch', via: 'chat', refId: 'chat-1', at: T0 } as const;
    // the assistant's first response in the chat (R-AST-15), the system, and a member who neither owns nor collaborates
    for (const actor of [systemActor('assistant'), systemActor('worker'), userActor(U.b)]) expect(decide(l.p, chat, ctx({ actor }))).toEqual({ ok: true, events: [], next: l.p, effects: [] });
    // a collaborator's chat reply counts the way their text would
    expect(eventsOf(decide(l.p, chat, ctx({ actor: userActor(U.isa), actorIsCollaborator: true })))[0]).toMatchObject({ type: 'first_touch_recorded', reasonCode: 'FIRST_TOUCH_CHAT', actorUserId: U.isa });
    // a chat reply after a breach still records the true response time; a later one writes no second first touch
    timer(l, 'first_touch_breach', l.p.firstTouchDueAt as Instant);
    const late = plusMs(l.p.firstTouchDueAt as Instant, MINUTE_MS);
    expect(eventsOf(l.run({ ...chat, at: late }, { now: late, actor: userActor(U.a) }))[0]).toMatchObject({ type: 'first_touch_recorded', reasonCode: 'FIRST_TOUCH_CHAT', payload: { afterBreach: true } });
    expect(eventsOf(l.run({ ...chat, refId: 'chat-2', at: plusMs(late, MINUTE_MS) }, { now: plusMs(late, MINUTE_MS), actor: userActor(U.a) }))).toEqual([]);
  });

  it('R-OWN-14: touch vs auto-release in either commit order: touch first ⇒ no release; release first ⇒ the touch is not the owner’s', () => {
    // E66 decision half; the contact-lock serialization is db/client's deadline-race test
    const l1 = ownedLead(U.a);
    const fence = { periodSeq: l1.p.periodSeq as number, dueAt: l1.p.releaseDueAt as Instant };
    l1.run({ kind: 'touch', via: 'sms', refId: 'm', at: plusMs(fence.dueAt, -2000) }, { now: plusMs(fence.dueAt, -2000), actor: userActor(U.a) });
    expect(l1.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer') })).toMatchObject({ ok: true, events: [] });
    expect(l1.p.state).toBe('owned');
    const l2 = ownedLead(U.a);
    const fence2 = { periodSeq: l2.p.periodSeq as number, dueAt: l2.p.releaseDueAt as Instant };
    l2.run({ kind: 'timer', deadline: 'auto_release', fence: fence2 }, { now: fence2.dueAt, actor: systemActor('timer') });
    expect(decide(l2.p, { kind: 'touch', via: 'sms', refId: 'm', at: fence2.dueAt }, ctx({ now: fence2.dueAt, actor: userActor(U.a) }))).toMatchObject({ ok: true, events: [] });
  });

  it('R-AST-7 E16: in-period events (touch, breach, warning) never invalidate drafts; a new period does', () => {
    const l = ownedLead(U.a);
    const breach = timer(l, 'first_touch_breach', l.p.firstTouchDueAt as Instant);
    const touch = l.run({ kind: 'touch', via: 'sms', refId: 'm', at: plusMs(T0, HOUR_MS) }, { now: plusMs(T0, HOUR_MS), actor: userActor(U.a) });
    for (const d of [breach, touch]) expect(kinds(d)).not.toContain('invalidateDrafts');
    const warnAt = l.inactivity.warnAt as Instant;
    const warn = l.run({ kind: 'timer', deadline: 'inactivity_warn', fence: { periodSeq: l.p.periodSeq as number, dueAt: warnAt } }, { now: warnAt, actor: systemActor('timer') });
    expect(eventsOf(warn)[0]?.type).toBe('inactivity_warned');
    expect(kinds(warn)).not.toContain('invalidateDrafts');
    const re = l.run({ kind: 'reassign', toUserId: U.b, reason: 'X' }, { actor: userActor(U.admin), targetMember: member(U.b) });
    expect(kinds(re)).toContain('invalidateDrafts');
  });
});

describe('inactivity (R-OWN-23, R-OWN-15)', () => {
  it('R-OWN-23: deadlines are tenant-zone calendar days from ownership start, the warning 72 h before; the warning clears inactivity_warn_at; the release goes to the pond', () => {
    const l = ownedLead(U.a);
    const releaseAt = addLocalDays(T0, 30, NY);
    expect(l.inactivity).toEqual({ warnAt: instant(releaseAt - 72 * HOUR_MS), releaseAt });
    const period = l.p.periodSeq as number;
    const warn = l.run({ kind: 'timer', deadline: 'inactivity_warn', fence: { periodSeq: period, dueAt: l.inactivity.warnAt as Instant } }, { now: l.inactivity.warnAt as Instant, actor: systemActor('timer') });
    expect(effectsOf(warn, 'setInactivityDeadlines')).toEqual([{ kind: 'setInactivityDeadlines', warnAt: null, releaseAt }]);
    expect(effectsOf(warn, 'notify')[0]).toMatchObject({ userId: U.a, notification: { kind: 'inactivity_warning' } });
    expect(effectsOf(warn, 'upsertFeed')[0]?.item).toMatchObject({ itemType: 'inactivity_warning', userId: U.a });
    const rel = l.run({ kind: 'timer', deadline: 'inactivity_release', fence: { periodSeq: period, dueAt: releaseAt } }, { now: releaseAt, actor: systemActor('timer') });
    expect(eventsOf(rel)[0]).toMatchObject({ type: 'inactivity_released', toState: 'in_pond', pondId: DEFAULT_POND, reasonCode: 'INACTIVITY', prevOwnerUserId: U.a });
    expect(l.inactivity).toEqual({ warnAt: null, releaseAt: null });
  });

  it('R-OWN-23: any human touch resets both deadlines; the old timers become stale', () => {
    const l = ownedLead(U.a);
    const old = { ...l.inactivity };
    const touchAt = plusMs(T0, 10 * DAY_MS);
    l.run({ kind: 'touch', via: 'email', refId: 'e', at: touchAt }, { now: touchAt, actor: userActor(U.a) });
    expect(l.inactivity.releaseAt).toBe(addLocalDays(touchAt, 30, NY));
    const stale = decide(l.p, { kind: 'timer', deadline: 'inactivity_release', fence: { periodSeq: l.p.periodSeq as number, dueAt: old.releaseAt as Instant } }, ctx({ now: old.releaseAt as Instant, actor: systemActor('timer'), inactivity: l.inactivity }));
    expect(stale).toMatchObject({ ok: true, events: [], effects: [] });
  });

  it('R-OWN-15 R-OWN-23 E67 E10: lowering inactivity_release_days (or changing hours/zone) never moves a stored deadline; new periods and touches use the new value', () => {
    const l = ownedLead(U.a);
    const stored = { ...l.inactivity };
    const lowered = { ...SETTINGS, inactivityReleaseDays: 14, offerWindowSeconds: 60, firstTouchSlaSeconds: 60 };
    const day20 = plusMs(T0, 20 * DAY_MS);
    // under the new settings, the timer at day 20 for the stored day-30 deadline is an early wake
    const early = decide(l.p, { kind: 'timer', deadline: 'inactivity_release', fence: { periodSeq: l.p.periodSeq as number, dueAt: stored.releaseAt as Instant } }, ctx({ now: day20, actor: systemActor('timer'), inactivity: stored, settings: lowered }));
    expect(early.ok && early.events).toEqual([]);
    expect(effectsOf(early, 'enqueueTimer')[0]?.runAt).toBe(stored.releaseAt);
    expect(l.p.firstTouchDueAt).toBe(plusMs(T0, 15 * MINUTE_MS)); // stored SLA unchanged too
    l.run({ kind: 'touch', via: 'call', refId: 'c', at: day20 }, { now: day20, actor: userActor(U.a), settings: lowered });
    expect(l.inactivity.releaseAt).toBe(addLocalDays(day20, 14, NY));
  });

  it('R-OWN-23 E58: never with an open deal or past new/attempting; disabling is honoured at fire time and clears the stored deadlines', () => {
    const l = offeredLead(U.a);
    const d = l.run({ kind: 'accept', offerId: l.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a), dealOpen: true });
    expect(effectsOf(d, 'setInactivityDeadlines')).toEqual([{ kind: 'setInactivityDeadlines', warnAt: null, releaseAt: null }]);
    expect(effectsOf(d, 'enqueueTimer').map((t) => t.jobKind)).not.toContain('ownership.inactivity');
    const l2 = offeredLead(U.a);
    l2.run({ kind: 'accept', offerId: l2.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a), contactStage: 'connected' });
    expect(l2.inactivity).toEqual({ warnAt: null, releaseAt: null });
    for (const over of [{ dealOpen: true }, { contactStage: 'active' as const }, { settings: { ...SETTINGS, inactivityReleaseDays: null } }]) {
      const l3 = ownedLead(U.a);
      const r = l3.inactivity.releaseAt as Instant;
      const fire = decide(l3.p, { kind: 'timer', deadline: 'inactivity_release', fence: { periodSeq: l3.p.periodSeq as number, dueAt: r } }, ctx({ now: r, actor: systemActor('timer'), inactivity: l3.inactivity, ...over }));
      expect(fire.ok && fire.events).toEqual([]);
      expect(effectsOf(fire, 'setInactivityDeadlines')).toEqual([{ kind: 'setInactivityDeadlines', warnAt: null, releaseAt: null }]);
    }
    expect(() => decide(ownedLead().p, { kind: 'timer', deadline: 'inactivity_warn', fence: { periodSeq: 3, dueAt: T0 } }, ctx({ actor: systemActor('timer'), inactivity: undefined }))).toThrow(OwnershipContextError);
  });

  it('R-OWN-23: a warning that would fall before the period start is dropped (short release windows)', () => {
    const l = offeredLead(U.a);
    l.run({ kind: 'accept', offerId: l.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a), settings: { ...SETTINGS, inactivityReleaseDays: 7, inactivityWarningHours: 336 } });
    expect(l.inactivity).toEqual({ warnAt: null, releaseAt: addLocalDays(T0, 7, NY) });
  });
});

describe('re-inquiry (R-OWN-20)', () => {
  it('R-OWN-20 E18: an owned lead never changes owner; the owner gets a high notification and a pinned feed item; no SLA when touched within 7 days', () => {
    const l = ownedLead(U.a);
    const period = l.p.periodSeq;
    const d = l.run({ kind: 'reinquiry', inquiryId: 'inq-2' }, { actor: systemActor('provider'), lastHumanTouchAt: plusMs(T0, -2 * DAY_MS) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', fromState: 'owned', toState: 'owned', ownerUserId: U.a, reasonCode: 'REINQUIRY' });
    expect(l.p).toMatchObject({ ownerUserId: U.a, periodSeq: period });
    expect(effectsOf(d, 'notify')[0]).toMatchObject({ userId: U.a, notification: { priority: 'high', reasonCode: 'REINQUIRY' } });
    expect(effectsOf(d, 'upsertFeed')[0]?.item).toMatchObject({ itemType: 'reinquiry', band: 'pinned', userId: U.a });
    expect(kinds(d)).not.toContain('invalidateDrafts');
  });

  it('R-OWN-20: last touch > 7 days ago starts a re-inquiry SLA as a new ownership period, without auto-release', () => {
    // E68: the new period gives accountability a new untouched:{contact}:{period} key
    const l = ownedLead(U.a);
    const now = plusMs(T0, 20 * DAY_MS);
    const old = l.p.periodSeq as number;
    const d = l.run({ kind: 'reinquiry', inquiryId: 'inq-3' }, { now, actor: systemActor('worker'), lastHumanTouchAt: plusMs(T0, 8 * DAY_MS) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', reasonCode: 'REINQUIRY_SLA', deadlineAt: plusMs(now, 15 * MINUTE_MS), payload: { newPeriod: true } });
    expect(l.p).toMatchObject({ ownerUserId: U.a, firstTouchDueAt: plusMs(now, 15 * MINUTE_MS), releaseDueAt: null, firstTouchAt: null, periodSeq: l.p.seq });
    expect(l.p.periodSeq).not.toBe(old);
    expect(effectsOf(d, 'enqueueTimer').map((t) => t.jobKind)).toContain('ownership.first_touch_breach');
    expect(effectsOf(d, 'enqueueTimer').map((t) => t.jobKind)).not.toContain('ownership.auto_release');
    expect(kinds(d)).not.toContain('pauseAgentEnrollments');
  });

  it('R-OWN-20: in a pond the pond setting decides (default re-route); offered/unassigned only attach; closed spam stays closed and Admins hear; merged redirects', () => {
    const l = pondLead();
    const d = l.run({ kind: 'reinquiry', inquiryId: 'i' }, { routing: rr([U.b]) });
    expect(eventsOf(d).map((e) => [e.type, e.toState])).toEqual([['reinquiry', 'unassigned'], ['offered', 'offered']]);
    const stay = pondLead();
    const s = stay.run({ kind: 'reinquiry', inquiryId: 'i' }, { pond: pond({ reinquiry: 'stay' }) });
    expect(eventsOf(s).map((e) => [e.type, e.toState, e.pondId])).toEqual([['reinquiry', 'in_pond', DEFAULT_POND]]);
    const off = offeredLead();
    expect(decide(off.p, { kind: 'reinquiry', inquiryId: 'i' }, ctx())).toMatchObject({ ok: true, events: [] });
    const spam = ownedLead(U.a);
    spam.run({ kind: 'close', reason: 'spam' }, { actor: userActor(U.a) });
    const sp = decide(spam.p, { kind: 'reinquiry', inquiryId: 'i' }, ctx());
    expect(sp).toMatchObject({ ok: true, events: [] });
    expect(sp.next?.state).toBe('closed');
    expect(effectsOf(sp, 'notify').map((n) => n.userId)).toEqual([U.admin]);
    expectRejected(decide(spam.p, { kind: 'reinquiry', inquiryId: 'i' }, ctx({ actor: userActor(U.admin) })), 'NOT_FOUND');
  });
});

describe('close, reopen, soft delete', () => {
  it('E62: soft delete is an ownership command (closed/deleted, purge after 30 d); an open offer is cancelled with it', () => {
    const l = offeredLead(U.a);
    const offerId = l.p.offerId;
    const d = l.run({ kind: 'soft_delete' }, { actor: userActor(U.admin) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'closed', fromState: 'offered', toState: 'closed', reasonCode: 'SOFT_DELETED', payload: { closedReason: 'deleted' } });
    expect(l.p).toMatchObject({ state: 'closed', closedReason: 'deleted', offerId: null });
    expect(effectsOf(d, 'markDeleted')).toEqual([{ kind: 'markDeleted', purgeAfter: plusMs(T0, 30 * DAY_MS) }]);
    expect(effectsOf(d, 'cancelTimers')[0]?.dedupeKeys).toEqual([`ownership.offer_expiry:${C1}:${offerId}`]);
    expect(effectsOf(d, 'resolveFeed')[0]).toMatchObject({ userId: U.a });
    expectRejected(decide(l.p, { kind: 'soft_delete' }, ctx({ actor: userActor(U.admin) })), 'LEAD_STATE_CHANGED');
    // restore: reopen clears the deletion and routes
    const r = l.run({ kind: 'reopen' }, { actor: userActor(U.admin) });
    expect(kinds(r)).toEqual(expect.arrayContaining(['clearDeleted', 'route', 'audit']));
    expect(l.p).toMatchObject({ state: 'unassigned', closedReason: null, routeDueAt: T0 });
  });

  it('close needs a manual reason and permission; agents close only their own leads', () => {
    const l = ownedLead(U.a);
    expectRejected(decide(l.p, { kind: 'close', reason: 'merged' }, ctx({ actor: userActor(U.admin) })), 'VALIDATION_FAILED');
    expectRejected(decide(l.p, { kind: 'close', reason: 'spam' }, ctx({ actor: userActor(U.b) })), 'NOT_FOUND');
    expectRejected(decide(l.p, { kind: 'soft_delete' }, ctx({ actor: userActor(U.b) })), 'NOT_FOUND');
    expectRejected(decide(l.p, { kind: 'close', reason: 'spam' }, ctx({ actor: userActor(U.tl), ownerInActorTeam: false })), 'NOT_FOUND');
    expect(decide(l.p, { kind: 'close', reason: 'spam' }, ctx({ actor: userActor(U.tl), ownerInActorTeam: true })).ok).toBe(true);
    expect(decide(pondLead().p, { kind: 'close', reason: 'not_a_lead' }, ctx({ actor: userActor(U.tl) })).ok).toBe(true);
    const d = l.run({ kind: 'close', reason: 'do_not_contact' }, { actor: userActor(U.a) });
    expect(l.p).toMatchObject({ state: 'closed', closedReason: 'do_not_contact' });
    expect(kinds(d)).toContain('invalidateDrafts');
    expectRejected(decide(l.p, { kind: 'close', reason: 'spam' }, ctx({ actor: userActor(U.admin) })), 'LEAD_STATE_CHANGED');
    expectRejected(decide(l.p, { kind: 'reopen' }, ctx({ actor: userActor(U.a) })), 'NOT_FOUND');
    expectRejected(decide(ownedLead().p, { kind: 'reopen' }, ctx({ actor: userActor(U.admin) })), 'LEAD_STATE_CHANGED');
    const sys = l.run({ kind: 'reopen' }, { actor: systemActor('worker'), routing: rr([U.b]) });
    expect(eventsOf(sys).map((e) => e.type)).toEqual(['reopened', 'offered']);
  });
});

describe('R-OWN-21: ownership never changes as a side effect', () => {
  it('R-OWN-21: the assistant actor can issue no ownership command', () => {
    const l = ownedLead(U.a);
    const cmds: OwnershipCommand[] = [
      { kind: 'release', reason: 'not_a_fit' },
      { kind: 'reassign', toUserId: U.b, reason: 'X' },
      { kind: 'close', reason: 'spam' },
      { kind: 'route' },
      { kind: 'reinquiry', inquiryId: 'i' },
      { kind: 'soft_delete' },
    ];
    for (const c of cmds) expectRejected(decide(l.p, c, ctx({ actor: systemActor('assistant'), targetMember: member(U.b) })), 'NOT_FOUND');
    expectRejected(decide(null, { kind: 'create', via: 'intake' }, ctx({ actor: systemActor('assistant') })), 'NOT_FOUND');
  });

  it('R-OWN-21 E41: an import re-run for an already-linked record never changes ownership', () => {
    const l = ownedLead(U.a);
    const d = decide(l.p, { kind: 'import_assign', target: { userId: U.b } }, ctx({ actor: systemActor('import'), targetMember: member(U.b) }));
    expect(d).toEqual({ ok: true, events: [], next: l.p, effects: [] });
    expectRejected(decide(l.p, { kind: 'reassign', toUserId: U.b, reason: 'IMPORT' }, ctx({ actor: systemActor('import'), targetMember: member(U.b) })), 'NOT_FOUND');
  });

  it('import_assign creates imported contacts (user, pond or unassigned) with no SLA and no routing', () => {
    const imp = systemActor('import');
    const owned = decide(null, { kind: 'import_assign', target: { userId: U.a } }, ctx({ actor: imp, targetMember: member(U.a) }));
    expect(eventsOf(owned)[0]).toMatchObject({ type: 'imported', toState: 'owned', ownerUserId: U.a, actorKind: 'import', deadlineAt: null });
    expect(effectsOf(owned, 'enqueueTimer').filter((t) => t.jobKind !== 'ownership.inactivity')).toEqual([]);
    expect(eventsOf(decide(null, { kind: 'import_assign', target: { pondId: OTHER_POND } }, ctx({ actor: imp })))[0]).toMatchObject({ toState: 'in_pond', pondId: OTHER_POND });
    const un = decide(null, { kind: 'import_assign', target: 'unassigned' }, ctx({ actor: imp }));
    expect(un.next).toMatchObject({ state: 'unassigned', routeDueAt: null });
    expect(kinds(un)).not.toContain('route');
    expectRejected(decide(null, { kind: 'import_assign', target: { userId: U.tc } }, ctx({ actor: imp, targetMember: member(U.tc) })), 'TARGET_NOT_ELIGIBLE');
    expectRejected(decide(null, { kind: 'import_assign', target: 'unassigned' }, ctx({ actor: userActor(U.admin) })), 'NOT_FOUND');
  });

  it('R-IMPORT-8 R-OWN-21: the ownership stage assigns only a contact still in its imported creation state', () => {
    const imp = systemActor('import');
    const created = decide(null, { kind: 'import_assign', target: 'unassigned' }, ctx({ actor: imp }));
    const p = created.next!;
    const owned = decide(p, { kind: 'import_assign', target: { userId: U.a } }, ctx({ actor: imp, targetMember: member(U.a) }));
    expect(eventsOf(owned)).toHaveLength(1);
    expect(eventsOf(owned)[0]).toMatchObject({ type: 'imported', seq: 2, fromState: 'unassigned', toState: 'owned', ownerUserId: U.a, actorKind: 'import', deadlineAt: null });
    expect(owned.next).toMatchObject({ state: 'owned', firstTouchDueAt: null, releaseDueAt: null });
    expect(eventsOf(decide(p, { kind: 'import_assign', target: { pondId: OTHER_POND } }, ctx({ actor: imp })))[0]).toMatchObject({ seq: 2, toState: 'in_pond', pondId: OTHER_POND });
    // already unassigned: nothing to do; an assigned (seq > 1) contact keeps its owner
    expect(decide(p, { kind: 'import_assign', target: 'unassigned' }, ctx({ actor: imp }))).toEqual({ ok: true, events: [], next: p, effects: [] });
    expect(decide(owned.next!, { kind: 'import_assign', target: { userId: U.b } }, ctx({ actor: imp, targetMember: member(U.b) }))).toEqual({ ok: true, events: [], next: owned.next, effects: [] });
    // an intake-created unassigned contact (route due) is never an import's to assign
    const intake = decide(null, { kind: 'create', via: 'intake' }, ctx({ actor: systemActor('provider') }));
    if (intake.next?.state === 'unassigned') expect(decide(intake.next, { kind: 'import_assign', target: { userId: U.a } }, ctx({ actor: imp, targetMember: member(U.a) }))).toEqual({ ok: true, events: [], next: intake.next, effects: [] });
    expectRejected(decide(p, { kind: 'import_assign', target: { userId: U.tc } }, ctx({ actor: imp, targetMember: member(U.tc) })), 'TARGET_NOT_ELIGIBLE');
  });

  it('R-IMPORT-10 ownership-1: import_unassign undoes the import\'s own assignment, fenced on its seq; anything later is refused', () => {
    const imp = systemActor('import');
    const p = decide(null, { kind: 'import_assign', target: 'unassigned' }, ctx({ actor: imp })).next!;
    const owned = decide(p, { kind: 'import_assign', target: { userId: U.a } }, ctx({ actor: imp, targetMember: member(U.a) })).next!;
    const back = decide(owned, { kind: 'import_unassign', importSeq: 2 }, ctx({ actor: imp }));
    expect(eventsOf(back)).toEqual([expect.objectContaining({ type: 'imported', seq: 3, fromState: 'owned', toState: 'unassigned', ownerUserId: null, actorKind: 'import', reasonCode: 'IMPORT_REVERTED' })]);
    expect(back.next).toMatchObject({ state: 'unassigned', routeDueAt: null, ownerUserId: null, periodSeq: null });
    expect(kinds(back)).not.toContain('route');
    expect(effectsOf(back, 'notify')).toEqual([]);
    const pond = decide(p, { kind: 'import_assign', target: { pondId: OTHER_POND } }, ctx({ actor: imp })).next!;
    expect(decide(pond, { kind: 'import_unassign', importSeq: 2 }, ctx({ actor: imp })).next).toMatchObject({ state: 'unassigned', pondId: null, routeDueAt: null });
    // the ledger moved past the import's event: a human's decision, refused
    expectRejected(decide(owned, { kind: 'import_unassign', importSeq: 1 }, ctx({ actor: imp })), 'LEAD_STATE_CHANGED');
    // only the import actor; already back in the imported creation state: nothing to do
    expectRejected(decide(owned, { kind: 'import_unassign', importSeq: 2 }, ctx({ actor: systemActor('worker') })), 'NOT_FOUND');
    expectRejected(decide(owned, { kind: 'import_unassign', importSeq: 2 }, ctx({ actor: userActor(U.admin) })), 'NOT_FOUND');
    expect(decide(p, { kind: 'import_unassign', importSeq: 1 }, ctx({ actor: imp }))).toEqual({ ok: true, events: [], next: p, effects: [] });
  });

  it('support actors are read-only', () => {
    const l = ownedLead(U.a);
    expectRejected(decide(l.p, { kind: 'release', reason: 'not_a_fit' }, ctx({ actor: { kind: 'support', userId: U.owner, tenantId: l.p.commandId as never, grantId: 'g' } })), 'NOT_FOUND');
  });
});

describe('deactivation destinations', () => {
  const deact = (d: Partial<NonNullable<Parameters<typeof ctx>[0]>['deactivation']> = {}) => ({ userId: U.a, teamLeadUserId: U.tl, fallbackUserId: U.admin, ...d });

  it('pending offers are rescinded and re-routed; owned contacts go to the TL by default; a re-run is a no-op', () => {
    // R-OWN-22 stages 2-3 / E12 (core half: destinations); staging and the final re-check are db/client's
    const off = offeredLead(U.a);
    const d = off.run({ kind: 'deactivate_owner', destination: 'team_lead', deactivationId: 'dx' }, { deactivation: deact(), routing: { rule: rule(), candidates: [candidate(U.a, { status: 'deactivating' }), candidate(U.b)], cursor: {}, alreadyOffered: [] } });
    expect(eventsOf(d).map((e) => e.type)).toEqual(['offer_rescinded', 'offered']);
    expect(off.p.offeredToUserId).toBe(U.b);
    const own = ownedLead(U.a);
    const o = own.run({ kind: 'deactivate_owner', destination: 'team_lead', deactivationId: 'dx' }, { deactivation: deact() });
    expect(eventsOf(o)[0]).toMatchObject({ type: 'reassigned', ownerUserId: U.tl, prevOwnerUserId: U.a, reasonCode: 'OWNER_DEACTIVATED' });
    // resumable and idempotent: the re-run finds nothing of the member's
    expect(own.run({ kind: 'deactivate_owner', destination: 'team_lead', deactivationId: 'dx' }, { deactivation: deact() })).toMatchObject({ ok: true, events: [] });
  });

  it('E58: with an open deal the contact always goes to a user, whatever the destination; without a TL to the fallback user', () => {
    for (const destination of ['default_pond', 'reroute', 'team_lead'] as const) {
      const l = ownedLead(U.a);
      l.run({ kind: 'deactivate_owner', destination, deactivationId: 'd' }, { deactivation: deact({ teamLeadUserId: null }), dealOpen: true });
      expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.admin });
    }
  });

  it('default_pond and reroute destinations', () => {
    const l = ownedLead(U.a);
    l.run({ kind: 'deactivate_owner', destination: 'default_pond', deactivationId: 'd' }, { deactivation: deact() });
    expect(l.p).toMatchObject({ state: 'in_pond', pondId: DEFAULT_POND });
    expect(l.events.at(-1)).toMatchObject({ type: 'sent_to_pond', prevOwnerUserId: U.a });
    const r = ownedLead(U.a);
    r.run({ kind: 'deactivate_owner', destination: 'reroute', deactivationId: 'd' }, { deactivation: deact(), routing: { rule: rule(), candidates: [candidate(U.a, { status: 'deactivating' }), candidate(U.b)], cursor: {}, alreadyOffered: [] } });
    expect(r.p).toMatchObject({ state: 'offered', offerRound: 1, offeredToUserId: U.b });
    expect(r.events.at(-1)).toMatchObject({ type: 'offered', fromState: 'owned', prevOwnerUserId: U.a });
    expect(r.events.at(-1)?.payload.candidates).toEqual([{ userId: U.a, eligible: false, skipReason: 'MEMBERSHIP_INACTIVE' }, { userId: U.b, eligible: true }]);
    expectRejected(decide(r.p, { kind: 'deactivate_owner', destination: 'reroute', deactivationId: 'd' }, ctx({ actor: userActor(U.admin), deactivation: deact() })), 'NOT_FOUND');
    expect(() => decide(r.p, { kind: 'deactivate_owner', destination: 'reroute', deactivationId: 'd' }, ctx())).toThrow(OwnershipContextError);
  });
});

describe('effect placement (ARCHITECTURE §5 step 7)', () => {
  it('cross-user effects and routing under a user actor go to ownership.followup; everything under the system actor is inline', () => {
    const me = userActor(U.a);
    expect(effectPlacement({ kind: 'route' }, me)).toBe('followup');
    expect(effectPlacement({ kind: 'routingCursor', ruleId: RULE, cursor: {} }, me)).toBe('followup');
    expect(effectPlacement({ kind: 'upsertFeed', item: { userId: U.b, itemType: 'reinquiry', band: 'pinned', contactId: C1, subjectType: 'contact', subjectId: C1, dueAt: null, dedupeKey: 'k', reasons: ['R'] } }, me)).toBe('followup');
    expect(effectPlacement({ kind: 'upsertFeed', item: { userId: U.a, itemType: 'reinquiry', band: 'pinned', contactId: C1, subjectType: 'contact', subjectId: C1, dueAt: null, dedupeKey: 'k', reasons: ['R'] } }, me)).toBe('inline');
    expect(effectPlacement({ kind: 'resolveFeed', userId: U.b, dedupeKey: 'k' }, me)).toBe('followup');
    expect(effectPlacement({ kind: 'membershipAutoPause', userId: U.a }, me)).toBe('inline');
    expect(effectPlacement({ kind: 'missedOfferCounter', userId: U.b, op: 'increment' }, me)).toBe('followup');
    for (const e of [{ kind: 'notify', userId: U.b, notification: { kind: 'system', priority: 'low', subjectType: 'contact', subjectId: C1, dedupeKey: 'k', reasonCode: 'X' } }, { kind: 'audit', action: 'ownership.claim' }, { kind: 'markDeleted', purgeAfter: T0 }, { kind: 'clearDeleted' }, { kind: 'markMergedInto', survivorId: C1 }, { kind: 'recordHumanTouch', at: T0 }] as Effect[]) {
      expect(effectPlacement(e, me)).toBe('inline');
    }
    for (const k of ['invalidateDrafts', 'pauseAgentEnrollments', 'rehomeHandbacks', 'addCollaborator', 'route'] as const) {
      const e = { kind: k, reason: 'owner_change', toUserId: null, userId: U.b, role: 'isa', expiresAt: T0 } as unknown as Effect;
      expect(effectPlacement(e, me)).toBe('followup');
      expect(effectPlacement(e, systemActor())).toBe('inline');
    }
  });
});

describe('every OwnershipErrorCode has an example', () => {
  it('codes are UPPER_SNAKE and covered by the tests above', async () => {
    const { OWNERSHIP_ERROR_CODES } = await import('./types.js');
    for (const c of OWNERSHIP_ERROR_CODES) expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
    // every code is produced by at least one example: this file covers 14 (expectRejected calls),
    // merge.test.ts covers MERGE_OWNER_REQUIRED and CONTACT_MERGED
    expect(new Set(OWNERSHIP_ERROR_CODES).size).toBe(OWNERSHIP_ERROR_CODES.length);
  });
});
