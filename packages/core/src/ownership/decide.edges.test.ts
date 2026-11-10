// Edge branches of decide(): missing context, actor kinds, and optional facts.
import { describe, expect, it } from 'vitest';
import { type Instant, MINUTE_MS, plusMs } from '../foundation/index.js';
import { OwnershipContextError, decide } from './decide.js';
import { DEFAULT_POND, Lead, SETTINGS, U, candidate, ctx, expectRejected, member, offeredLead, ownedLead, pond, pondLead, rule, systemActor, userActor } from './testing/fixtures.js';

describe('decide() edges', () => {
  it('commands on a contact that does not exist are NOT_FOUND', () => {
    expectRejected(decide(null, { kind: 'accept', offerId: 'o' }, ctx({ actor: userActor(U.a) })), 'NOT_FOUND');
    const r = decide(null, { kind: 'route' }, ctx());
    expectRejected(r, 'NOT_FOUND');
    if (!r.ok) expect(r.rejection.observedSeq).toBeNull();
  });

  it('accept and claim are user commands; their membership facts are required context', () => {
    const off = offeredLead(U.a);
    expectRejected(decide(off.p, { kind: 'accept', offerId: off.p.offerId as string }, ctx({ actor: systemActor() })), 'NOT_FOUND');
    expect(() => decide(off.p, { kind: 'accept', offerId: off.p.offerId as string }, ctx({ actor: userActor(U.a) }))).toThrow(OwnershipContextError);
    const p = pondLead();
    expectRejected(decide(p.p, { kind: 'claim', pondId: DEFAULT_POND }, ctx({ actor: systemActor() })), 'NOT_FOUND');
    expect(() => decide(p.p, { kind: 'claim', pondId: DEFAULT_POND }, ctx({ actor: userActor(U.a), pond: pond() }))).toThrow(OwnershipContextError);
    expect(() => decide(p.p, { kind: 'claim', pondId: DEFAULT_POND }, ctx({ actor: userActor(U.a), pond: pond(), actorMember: member(U.a) }))).toThrow(OwnershipContextError);
  });

  it('R-OWN-18: with isa_access_after_handoff_days = 0 the ISA keeps no access', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'self' }, { actor: userActor(U.isa) });
    const d = l.run({ kind: 'isa_handoff', toUserId: U.a, note: 'warm' }, { actor: userActor(U.isa), targetMember: member(U.a), settings: { ...SETTINGS, isaAccessAfterHandoffDays: 0 } });
    expect(d.effects.map((e) => e.kind)).not.toContain('addCollaborator');
  });

  it('R-OWN-15: an early auto-release wake reschedules at the stored deadline', () => {
    const l = ownedLead(U.a);
    const fence = { periodSeq: l.p.periodSeq as number, dueAt: l.p.releaseDueAt as Instant };
    const d = decide(l.p, { kind: 'timer', deadline: 'auto_release', fence }, ctx({ now: plusMs(fence.dueAt, -MINUTE_MS), actor: systemActor('timer') }));
    expect(d.ok && d.events).toEqual([]);
    expect(d.effects).toEqual([expect.objectContaining({ kind: 'enqueueTimer', jobKind: 'ownership.auto_release', runAt: fence.dueAt })]);
  });

  it('R-OWN-10: a pond rule without a target pond falls back to the default pond; no people facts ⇒ no escalation recipients', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { routing: { rule: rule({ strategy: 'pond', targetPondId: null }), candidates: [], cursor: {}, alreadyOffered: [] } });
    expect(l.p.pondId).toBe(DEFAULT_POND);
    const n = new Lead();
    const d = n.run({ kind: 'create', via: 'intake' }, { people: undefined, routing: { rule: rule(), candidates: [candidate(U.a, { status: 'removed' })], cursor: {}, alreadyOffered: [] } });
    expect(d.effects.filter((e) => e.kind === 'notify')).toEqual([]);
    const spam = ownedLead(U.a);
    spam.run({ kind: 'close', reason: 'spam' }, { actor: userActor(U.a) });
    expect(decide(spam.p, { kind: 'reinquiry', inquiryId: 'i' }, ctx({ people: undefined }))).toMatchObject({ ok: true, events: [], effects: [] });
  });

  it('close / soft delete by the system worker are allowed; by other system vias not', () => {
    const l = ownedLead(U.a);
    expect(decide(l.p, { kind: 'close', reason: 'not_a_lead' }, ctx({ actor: systemActor('worker') })).ok).toBe(true);
    expectRejected(decide(l.p, { kind: 'soft_delete' }, ctx({ actor: systemActor('provider') })), 'NOT_FOUND');
  });
});
