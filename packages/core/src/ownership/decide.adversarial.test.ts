// Adversarial verification of core/ownership: each test pins a defect found by trying to break the
// module against DATA_MODEL R-OWN-* / §3 and ARCHITECTURE §5 (see the verifier report).
import { describe, expect, it } from 'vitest';
import { DAY_MS, type Instant, MINUTE_MS, isUuid, plusMs } from '../foundation/index.js';
import { OwnershipContextError, deactivationCommandId, decide, decideMerge } from './decide.js';
import { fold } from './fold.js';
import {
  C1,
  C2,
  Lead,
  T0,
  U,
  candidate,
  ctx,
  eventsOf,
  expectRejected,
  member,
  offeredLead,
  ownedLead,
  pondLead,
  rule,
  systemActor,
  userActor,
} from './testing/fixtures.js';
import type { ContactId, UserId } from '../foundation/index.js';
import type { Decision, Effect, OwnershipCommand } from './types.js';

const effectsOf = <K extends Effect['kind']>(d: Decision, k: K) => d.effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === k);

function ownedBy(contactId: ContactId, owner: UserId, at: Instant = T0): Lead {
  const l = new Lead(contactId);
  l.run({ kind: 'create', via: 'intake' }, { now: at, routing: { rule: rule({ strategy: 'direct', directUserId: owner }), candidates: [candidate(owner)], cursor: {}, alreadyOffered: [] } });
  l.run({ kind: 'accept', offerId: l.p.offerId as string }, { now: at, actor: userActor(owner), actorMember: member(owner) });
  return l;
}
function inPond(contactId: ContactId): Lead {
  const l = new Lead(contactId);
  l.run({ kind: 'create', via: 'intake' }, { routing: { rule: null, candidates: [], cursor: {}, alreadyOffered: [] } });
  return l;
}
function offeredTo(contactId: ContactId, to: UserId): Lead {
  const l = new Lead(contactId);
  l.run({ kind: 'create', via: 'intake' }, { routing: { rule: rule({ strategy: 'direct', directUserId: to }), candidates: [candidate(to)], cursor: {}, alreadyOffered: [] } });
  return l;
}
const merge = (ownerChoice: UserId | null = null): Extract<OwnershipCommand, { kind: 'merge' }> => ({ kind: 'merge', survivorId: C1, loserId: C2, ownerChoice });

describe('re-inquiry never lets an open first-touch SLA escape (R-OWN-13, R-OWN-20)', () => {
  it('R-OWN-20 R-OWN-13: a re-inquiry 5 minutes after accept, before any touch, keeps the period, its first-touch due and its auto-release', () => {
    for (const lastHumanTouchAt of [null, undefined]) {
      const l = ownedLead(U.a);
      const before = l.p;
      const d = l.run({ kind: 'reinquiry', inquiryId: 'inq-dup' }, { now: plusMs(T0, 5 * MINUTE_MS), actor: systemActor('provider'), lastHumanTouchAt });
      expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', reasonCode: 'REINQUIRY', fromState: 'owned', toState: 'owned' });
      expect(eventsOf(d)[0]?.payload.newPeriod).toBeUndefined();
      expect(l.p).toMatchObject({ periodSeq: before.periodSeq, ownedAt: before.ownedAt, firstTouchDueAt: before.firstTouchDueAt, releaseDueAt: before.releaseDueAt });
      expect(d.effects.map((e) => e.kind)).not.toContain('cancelTimers');
      expect(d.effects.map((e) => e.kind)).not.toContain('invalidateDrafts');
      // the original period's auto-release still fires on its fence
      const release = before.releaseDueAt as Instant;
      const r = l.run({ kind: 'timer', deadline: 'auto_release', fence: { periodSeq: before.periodSeq as number, dueAt: release } }, { now: release, actor: systemActor('timer') });
      expect(eventsOf(r).map((e) => e.type)).toEqual(['auto_released']);
    }
  });

  // Batch 6 review ownership-sla/F2: contacts.last_human_touch_at belongs to the contact, so it survives an owner change.
  // Measured from it alone, a duplicate inquiry minutes after an accept of a lead someone touched months ago (an earlier
  // period, maybe another agent's) started a new period inside the fresh first-touch window: the accepted period counted
  // as unanswered, its late first touch was erased, and the lead could never auto-release.
  it('R-OWN-20 E18 E68: a re-inquiry minutes after an accept of a lead last touched in an EARLIER period (last touch before owned_at) keeps the period, its first-touch due and its auto-release', () => {
    for (const daysAgo of [8, 30, 400]) {
      const l = ownedLead(U.b);
      const before = l.p;
      const d = l.run({ kind: 'reinquiry', inquiryId: `inq-dup-${daysAgo}` }, { now: plusMs(T0, 5 * MINUTE_MS), actor: systemActor('provider'), lastHumanTouchAt: plusMs(T0, -daysAgo * DAY_MS) });
      expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', reasonCode: 'REINQUIRY', fromState: 'owned', toState: 'owned' });
      expect(eventsOf(d)[0]?.payload.newPeriod).toBeUndefined();
      expect(l.p).toMatchObject({ periodSeq: before.periodSeq, ownedAt: before.ownedAt, firstTouchDueAt: before.firstTouchDueAt, releaseDueAt: before.releaseDueAt });
      expect(d.effects.map((e) => e.kind)).not.toContain('cancelTimers');
      const release = before.releaseDueAt as Instant;
      const r = l.run({ kind: 'timer', deadline: 'auto_release', fence: { periodSeq: before.periodSeq as number, dueAt: release } }, { now: release, actor: systemActor('timer') });
      expect(eventsOf(r).map((e) => e.type)).toEqual(['auto_released']);
    }
  });

  it('R-OWN-20 E18: the re-inquiry SLA is measured from the current period: 8 days after an accept with its last touch 8 days ago it starts; with a touch yesterday it does not', () => {
    const quiet = ownedLead(U.b);
    // touched right after the accept, then nothing for 8 days
    const q = quiet.run({ kind: 'reinquiry', inquiryId: 'inq-quiet' }, { now: plusMs(T0, 8 * DAY_MS), actor: systemActor('provider'), lastHumanTouchAt: plusMs(T0, 10 * MINUTE_MS) });
    expect(eventsOf(q)[0]).toMatchObject({ reasonCode: 'REINQUIRY_SLA', payload: { newPeriod: true } });
    const busy = ownedLead(U.b);
    const b = busy.run({ kind: 'reinquiry', inquiryId: 'inq-busy' }, { now: plusMs(T0, 8 * DAY_MS), actor: systemActor('provider'), lastHumanTouchAt: plusMs(T0, 7 * DAY_MS) });
    expect(eventsOf(b)[0]).toMatchObject({ reasonCode: 'REINQUIRY' });
    // a touch from before this period (months ago) counts from the accept: 8 days after it, the SLA starts
    const old = ownedLead(U.b);
    const o = old.run({ kind: 'reinquiry', inquiryId: 'inq-old-touch' }, { now: plusMs(T0, 8 * DAY_MS), actor: systemActor('provider'), lastHumanTouchAt: plusMs(T0, -90 * DAY_MS) });
    expect(eventsOf(o)[0]).toMatchObject({ reasonCode: 'REINQUIRY_SLA', payload: { newPeriod: true } });
  });

  // Review of that fix (R1): the owned_at floor protects a first-touch window, so it applies only to a period that has one
  // (accept, claim, a re-inquiry period). A reassign, an ISA handoff or an owner-changing merge starts a period with no
  // first-touch deadline: a lead nobody has touched for 30 days that inquires again the day after still starts a new clock.
  it('R-OWN-20 E18: a re-inquiry a day after a reassign, an ISA handoff or an owner-changing merge of a lead last touched 30 days ago starts the re-inquiry SLA', () => {
    const touched = plusMs(T0, 10 * MINUTE_MS);
    const changed = plusMs(T0, 29 * DAY_MS);
    const now = plusMs(T0, 30 * DAY_MS);
    const reinquiry = (p: Parameters<typeof decide>[0], contactId: ContactId = C1) =>
      decide(p, { kind: 'reinquiry', inquiryId: 'inq-back' }, ctx({ contactId, now, actor: systemActor('provider'), lastHumanTouchAt: touched }));

    const reassigned = ownedLead(U.a);
    eventsOf(reassigned.run({ kind: 'reassign', toUserId: U.b, reason: 'MANUAL' }, { now: changed, actor: userActor(U.admin), targetMember: member(U.b) }));
    expect(reassigned.p).toMatchObject({ ownerUserId: U.b, ownedAt: changed, firstTouchDueAt: null });

    const handed = new Lead();
    handed.run({ kind: 'create', via: 'self' }, { actor: userActor(U.isa) });
    eventsOf(handed.run({ kind: 'isa_handoff', toUserId: U.a, note: 'Wants Saturday showings' }, { now: changed, actor: userActor(U.isa), targetMember: member(U.a) }));
    expect(handed.p).toMatchObject({ ownerUserId: U.a, ownedAt: changed, firstTouchDueAt: null });

    const s = ownedBy(C1, U.a);
    const m = decideMerge(s.p, ownedBy(C2, U.b).p, merge(U.b), ctx({ now: changed, actor: userActor(U.admin) }));
    if (!m.ok) throw new Error(m.code);
    expect(m.survivor.next).toMatchObject({ ownerUserId: U.b, ownedAt: changed, firstTouchDueAt: null });

    for (const p of [reassigned.p, handed.p, m.survivor.next]) {
      const d = reinquiry(p);
      expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', reasonCode: 'REINQUIRY_SLA', payload: { newPeriod: true } });
      expect(d.ok && d.next.firstTouchDueAt).not.toBeNull();
    }
    // with a touch since the owner change it does not
    expect(eventsOf(decide(reassigned.p, { kind: 'reinquiry', inquiryId: 'inq-busy' }, ctx({ now, actor: systemActor('provider'), lastHumanTouchAt: plusMs(changed, 1) })))[0]).toMatchObject({ reasonCode: 'REINQUIRY' });
  });

  it('R-OWN-20: a never-touched contact owned more than 7 days ago gets the re-inquiry SLA; one owned yesterday does not', () => {
    const old = new Lead();
    old.run({ kind: 'create', via: 'self' }, { actor: userActor(U.a) });
    const d = old.run({ kind: 'reinquiry', inquiryId: 'inq-old' }, { now: plusMs(T0, 8 * DAY_MS), actor: systemActor('provider'), lastHumanTouchAt: null });
    expect(eventsOf(d)[0]).toMatchObject({ reasonCode: 'REINQUIRY_SLA', payload: { newPeriod: true } });

    const fresh = new Lead();
    fresh.run({ kind: 'create', via: 'self' }, { actor: userActor(U.a) });
    const f = fresh.run({ kind: 'reinquiry', inquiryId: 'inq-new' }, { now: plusMs(T0, DAY_MS), actor: systemActor('provider'), lastHumanTouchAt: null });
    expect(eventsOf(f)[0]).toMatchObject({ reasonCode: 'REINQUIRY' });
    expect(fresh.p.periodSeq).toBe(1);
  });
});

describe('Team Lead reach is own + team only (R-OWN-18, DATA_MODEL §3 "within team")', () => {
  const tl = userActor(U.tl);
  const assign: OwnershipCommand = { kind: 'assign', toUserId: U.a, reason: 'MANUAL' };

  it('R-OWN-18: a TL cannot assign a pond or unassigned lead (no current owner in their team); an Admin can', () => {
    const p = pondLead();
    expectRejected(decide(p.p, assign, ctx({ actor: tl, targetMember: member(U.a, { inActorTeam: true }) })), 'NOT_FOUND');
    expect(decide(p.p, assign, ctx({ actor: userActor(U.admin), targetMember: member(U.a) })).ok).toBe(true);
    const u = new Lead();
    u.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider') });
    expect(u.p.state).toBe('unassigned');
    expectRejected(decide(u.p, assign, ctx({ actor: tl, targetMember: member(U.a, { inActorTeam: true }) })), 'NOT_FOUND');
  });

  it('R-OWN-18: a TL cannot rescind an offer made to an agent outside their teams; inside the team they can', () => {
    const o = offeredLead(U.b);
    expectRejected(decide(o.p, assign, ctx({ actor: tl, targetMember: member(U.a, { inActorTeam: true }), ownerInActorTeam: false })), 'NOT_FOUND');
    const ok = decide(o.p, assign, ctx({ actor: tl, targetMember: member(U.a, { inActorTeam: true }), ownerInActorTeam: true }));
    expect(ok.ok && ok.events.map((e) => e.type)).toEqual(['offer_rescinded', 'assigned']);
  });

  it('a TL cannot close a lead offered to an agent outside their teams', () => {
    const o = offeredLead(U.b);
    expectRejected(decide(o.p, { kind: 'close', reason: 'spam' }, ctx({ actor: tl, ownerInActorTeam: false })), 'NOT_FOUND');
    expect(decide(o.p, { kind: 'close', reason: 'spam' }, ctx({ actor: tl, ownerInActorTeam: true })).ok).toBe(true);
    // ponds are visible to every Team Lead (DATA_MODEL §2), so closing a pond lead stays allowed
    expect(decide(pondLead().p, { kind: 'close', reason: 'spam' }, ctx({ actor: tl })).ok).toBe(true);
  });
});

describe('merge is not a back door to claim or accept (R-OWN-16, R-OWN-24, DATA_MODEL §3)', () => {
  it('R-OWN-24 R-OWN-16: an agent cannot merge a pond lead into, or out of, their own contact', () => {
    const own = ownedBy(C1, U.a);
    const pond = inPond(C2);
    expectRejected(decideMerge(own.p, pond.p, merge(), ctx({ actor: userActor(U.a) })) as never, 'NOT_FOUND');
    // survivor = pond lead, loser = the agent's own (e.g. a junk self-created) contact
    const ownL = new Lead(C2);
    ownL.run({ kind: 'create', via: 'self' }, { contactId: C2, actor: userActor(U.a) });
    const pondS = inPond(C1);
    expectRejected(decideMerge(pondS.p, ownL.p, merge(), ctx({ actor: userActor(U.a) })) as never, 'NOT_FOUND');
    // the same goes through decide() for either side
    expectRejected(decide(pond.p, merge(), ctx({ contactId: C2, mergePeer: own.p, actor: userActor(U.a) })), 'NOT_FOUND');
  });

  it('R-OWN-24 R-OWN-8: an agent or ISA cannot merge a contact that is on offer (to anyone) with their own', () => {
    const own = ownedBy(C1, U.a);
    for (const to of [U.b, U.a]) {
      expectRejected(decideMerge(own.p, offeredTo(C2, to).p, merge(), ctx({ actor: userActor(U.a) })) as never, 'NOT_FOUND');
    }
    const isaOwn = new Lead(C1);
    isaOwn.run({ kind: 'create', via: 'self' }, { actor: userActor(U.isa) });
    expectRejected(decideMerge(isaOwn.p, inPond(C2).p, merge(), ctx({ actor: userActor(U.isa) })) as never, 'NOT_FOUND');
  });

  it('R-OWN-24: an agent still merges two of their own contacts; a TL or Admin may merge a pond duplicate into an owned contact', () => {
    const d = decideMerge(ownedBy(C1, U.a).p, ownedBy(C2, U.a).p, merge(), ctx({ actor: userActor(U.a) }));
    expect(d.ok).toBe(true);
    for (const who of [U.tl, U.admin]) {
      const m = decideMerge(ownedBy(C1, U.a).p, inPond(C2).p, merge(), ctx({ actor: userActor(who) }));
      expect(m.ok).toBe(true);
    }
  });

  it('R-OWN-7: replaying the merge command that produced both projections is a no-op', () => {
    const s = ownedBy(C1, U.a);
    const l = ownedBy(C2, U.a);
    const c = ctx({ actor: userActor(U.admin) });
    const first = decideMerge(s.p, l.p, merge(), c);
    if (!first.ok) throw new Error(first.code);
    const again = decideMerge(first.survivor.next, first.loser.next, merge(), c);
    expect(again).toEqual({ ok: true, survivor: { events: [], next: first.survivor.next, effects: [] }, loser: { events: [], next: first.loser.next, effects: [] } });
    expect(fold([...s.events, ...first.survivor.events])).toEqual(first.survivor.next);
  });
});

describe('destructive decisions fail closed on missing facts (R-OWN-22, R-OWN-23, E58)', () => {
  it('R-OWN-23 E58: an inactivity release with unknown stage or unknown deal state is refused as a programming error, never applied', () => {
    const l = ownedLead(U.a);
    const rel = l.inactivity.releaseAt as Instant;
    const warn = l.inactivity.warnAt as Instant;
    const fire = (deadline: 'inactivity_release' | 'inactivity_warn', dueAt: Instant, over: Parameters<typeof ctx>[0]) =>
      decide(l.p, { kind: 'timer', deadline, fence: { periodSeq: l.p.periodSeq as number, dueAt } }, ctx({ now: dueAt, actor: systemActor('timer'), inactivity: l.inactivity, ...over }));
    expect(() => fire('inactivity_release', rel, { dealOpen: undefined })).toThrow(OwnershipContextError);
    expect(() => fire('inactivity_release', rel, { contactStage: undefined })).toThrow(OwnershipContextError);
    expect(() => fire('inactivity_warn', warn, { dealOpen: undefined })).toThrow(OwnershipContextError);
    // with the facts present it still fires
    const ok = fire('inactivity_release', rel, {});
    expect(ok.ok && ok.events.map((e) => e.type)).toEqual(['inactivity_released']);
  });

  it('R-OWN-22 E58: deactivating an owner to the pond (or re-route) without knowing whether a deal is open is refused; to the TL it proceeds', () => {
    const deactivation = { userId: U.a, teamLeadUserId: U.tl, fallbackUserId: U.admin };
    for (const destination of ['default_pond', 'reroute'] as const) {
      const l = ownedLead(U.a);
      expect(() =>
        decide(l.p, { kind: 'deactivate_owner', destination, deactivationId: 'dx' }, ctx({ actor: systemActor('worker'), deactivation, dealOpen: undefined, routing: { rule: null, candidates: [], cursor: {}, alreadyOffered: [] } })),
      ).toThrow(OwnershipContextError);
    }
    const l = ownedLead(U.a);
    const d = decide(l.p, { kind: 'deactivate_owner', destination: 'team_lead', deactivationId: 'dx' }, ctx({ actor: systemActor('worker'), deactivation, dealOpen: undefined }));
    expect(d.ok && d.next.ownerUserId).toBe(U.tl);
  });

  it('R-OWN-22: the per-contact deactivation command id is a deterministic uuid of (deactivation_id, contact_id)', () => {
    const a = deactivationCommandId('0190a000-0000-7000-8000-00000000000d', C1);
    expect(isUuid(a)).toBe(true);
    expect(deactivationCommandId('0190a000-0000-7000-8000-00000000000d', C1)).toBe(a);
    expect(deactivationCommandId('0190a000-0000-7000-8000-00000000000d', C2)).not.toBe(a);
    expect(deactivationCommandId('0190a000-0000-7000-8000-00000000000e', C1)).not.toBe(a);
    expect(a[14]).toBe('8'); // UUIDv8 (custom, name-based): never collides with a v7 command id
  });
});

describe('contact delete / restore / merge are always audited (R-AUDIT-5)', () => {
  it('R-AUDIT-5: a soft delete, the restore of a deleted contact, and a merge by the system worker each emit their audit effect', () => {
    const l = ownedLead(U.a);
    const del = l.run({ kind: 'soft_delete' }, { actor: systemActor('worker') });
    expect(effectsOf(del, 'audit')).toEqual([{ kind: 'audit', action: 'ownership.soft_delete' }]);
    const back = l.run({ kind: 'reopen' }, { actor: systemActor('worker') });
    expect(effectsOf(back, 'audit')).toEqual([{ kind: 'audit', action: 'ownership.reopen' }]);
    const m = decideMerge(ownedBy(C1, U.a).p, inPond(C2).p, merge(), ctx({ actor: systemActor('worker') }));
    if (!m.ok) throw new Error(m.code);
    expect(m.survivor.effects).toContainEqual({ kind: 'audit', action: 'ownership.merge' });
    // a system close / reopen of a non-deleted contact is not one of these actions
    const s = pondLead();
    const cl = s.run({ kind: 'close', reason: 'spam' }, { actor: systemActor('worker') });
    expect(effectsOf(cl, 'audit')).toEqual([]);
    expect(s.p).toMatchObject({ state: 'closed', closedReason: 'spam', pondId: null });
  });
});

describe('only expiries and declines use up offer rounds (R-OWN-9)', () => {
  it('R-OWN-9 R-OWN-22: an offer rescinded because its offeree is deactivated does not count toward max_offers', () => {
    // max_offers = 1: the single offer is rescinded by the deactivation, so the lead is offered again
    const r = rule({ strategy: 'round_robin', maxOffers: 1 });
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { routing: { rule: r, candidates: [candidate(U.a), candidate(U.b)], cursor: {}, alreadyOffered: [] } });
    expect(l.p).toMatchObject({ state: 'offered', offeredToUserId: U.a, offerRound: 1 });
    const d = l.run(
      { kind: 'deactivate_owner', destination: 'team_lead', deactivationId: 'dx' },
      {
        actor: systemActor('worker'),
        deactivation: { userId: U.a, teamLeadUserId: U.tl, fallbackUserId: U.admin },
        routing: { rule: r, candidates: [candidate(U.a, { status: 'deactivating' }), candidate(U.b)], cursor: { lastUserId: U.a }, alreadyOffered: [U.a] },
      },
    );
    expect(eventsOf(d).map((e) => e.type)).toEqual(['offer_rescinded', 'offered']);
    expect(l.p).toMatchObject({ state: 'offered', offeredToUserId: U.b, offerRound: 1 });
    expect(eventsOf(d)[1]?.payload.round).toBe(1);
  });
});
