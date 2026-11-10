import { describe, expect, it } from 'vitest';
import { type ContactId, MINUTE_MS, plusMs } from '../foundation/index.js';
import { decide, decideMerge } from './decide.js';
import { fold } from './fold.js';
import { mergeLockOrder, mergeOwnership, preselectMergeOwner, resolveMergeRedirect } from './merge.js';
import { C1, C2, DEFAULT_POND, Lead, T0, U, ctx, expectRejected, member, rule, candidate, systemActor, userActor } from './testing/fixtures.js';
import type { OwnershipCommand } from './types.js';

function ownedBy(contactId: ContactId, owner: typeof U.a, at = T0): Lead {
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
function offered(contactId: ContactId, to: typeof U.a): Lead {
  const l = new Lead(contactId);
  l.run({ kind: 'create', via: 'intake' }, { routing: { rule: rule({ strategy: 'direct', directUserId: to }), candidates: [candidate(to)], cursor: {}, alreadyOffered: [] } });
  return l;
}
const merge = (ownerChoice: typeof U.a | null = null): Extract<OwnershipCommand, { kind: 'merge' }> => ({ kind: 'merge', survivorId: C1, loserId: C2, ownerChoice });

describe('merge ownership matrix (R-OWN-24)', () => {
  it('R-OWN-24: only one owned → its owner; same owner → that owner; neither → the survivor state is kept', () => {
    const a = ownedBy(C1, U.a).p;
    const b = ownedBy(C2, U.b, plusMs(T0, -MINUTE_MS)).p;
    const pond = inPond(C2).p;
    expect(mergeOwnership(a, pond, null)).toMatchObject({ ok: true, rule: 'only_survivor_owned', ownerUserId: U.a, losingOwnerUserId: null });
    expect(mergeOwnership(pond, a, null)).toMatchObject({ ok: true, rule: 'only_loser_owned', ownerUserId: U.a });
    expect(mergeOwnership(a, ownedBy(C2, U.a).p, null)).toMatchObject({ ok: true, rule: 'same_owner', ownerUserId: U.a });
    expect(mergeOwnership(pond, inPond(C1).p, null)).toMatchObject({ ok: true, rule: 'neither_owned', ownerUserId: null });
    // different owners: a TL/Admin must choose; the preselection is the earliest owned_at
    expect(mergeOwnership(a, b, null)).toEqual({ ok: false, code: 'MERGE_OWNER_REQUIRED', preselected: U.b, candidates: [U.a, U.b] });
    expect(preselectMergeOwner(a, b)).toBe(U.b);
    expect(preselectMergeOwner(b, a)).toBe(U.b);
    expect(mergeOwnership(a, b, U.a)).toMatchObject({ ok: true, rule: 'different_owners', ownerUserId: U.a, losingOwnerUserId: U.b });
    expect(mergeOwnership(a, b, U.c)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(mergeOwnership(a, pond, U.b)).toMatchObject({ ok: false, code: 'LEAD_STATE_CHANGED' });
  });

  it('R-OWN-24: the loser goes merged_away → closed/merged; the survivor gets merged_in; different owners notify the losing owner', () => {
    const s = ownedBy(C1, U.a);
    const l = ownedBy(C2, U.b);
    const d = decideMerge(s.p, l.p, merge(U.a), ctx({ actor: userActor(U.admin) }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.loser.events.map((e) => [e.type, e.contactId, e.toState, e.payload.survivorId])).toEqual([['merged_away', C2, 'closed', C1]]);
    expect(d.loser.next).toMatchObject({ state: 'closed', closedReason: 'merged', ownerUserId: null });
    expect(d.loser.effects).toEqual(expect.arrayContaining([{ kind: 'markMergedInto', survivorId: C1 }, { kind: 'invalidateDrafts' }, { kind: 'rehomeHandbacks', toUserId: U.a }]));
    expect(d.loser.effects.map((e) => e.kind)).not.toContain('pauseAgentEnrollments'); // stopped 'merged' by db/client instead
    expect(d.survivor.events.map((e) => [e.type, e.contactId, e.ownerUserId])).toEqual([['merged_in', C1, U.a]]);
    expect(d.survivor.events[0]?.payload).toMatchObject({ loserId: C2, ownerRule: 'different_owners' });
    expect(d.survivor.next.periodSeq).toBe(s.p.periodSeq); // the survivor's owner kept: same period
    expect(d.survivor.effects).toContainEqual(expect.objectContaining({ kind: 'notify', userId: U.b, notification: expect.objectContaining({ reasonCode: 'MERGED' }) }));
    expect(d.survivor.effects).toContainEqual({ kind: 'audit', action: 'ownership.merge' });
    // both sides share the command id; each ledger stays gapless and folds to its projection
    expect(new Set([...d.loser.events, ...d.survivor.events].map((e) => e.commandId)).size).toBe(1);
    expect(fold([...s.events, ...d.survivor.events])).toEqual(d.survivor.next);
    expect(fold([...l.events, ...d.loser.events])).toEqual(d.loser.next);
  });

  it('R-OWN-24: choosing the loser’s owner moves the survivor to that owner in a new period (old drafts invalidated)', () => {
    const s = ownedBy(C1, U.a);
    const l = ownedBy(C2, U.b);
    const d = decideMerge(s.p, l.p, merge(U.b), ctx({ actor: userActor(U.tl) }));
    if (!d.ok) throw new Error(d.code);
    expect(d.survivor.next).toMatchObject({ ownerUserId: U.b, periodSeq: s.p.seq + 1 });
    expect(d.survivor.events[0]).toMatchObject({ prevOwnerUserId: U.a, ownerUserId: U.b });
    expect(d.survivor.effects.map((e) => e.kind)).toEqual(expect.arrayContaining(['invalidateDrafts', 'pauseAgentEnrollments', 'rehomeHandbacks']));
    expect(d.survivor.effects).toContainEqual(expect.objectContaining({ kind: 'notify', userId: U.a }));
  });

  it('R-OWN-24: an owned loser hands its owner to an unowned survivor (an offered survivor’s offer is rescinded first)', () => {
    const s = offered(C1, U.c);
    const l = ownedBy(C2, U.b);
    const d = decideMerge(s.p, l.p, merge(), ctx({ actor: systemActor('worker') }));
    if (!d.ok) throw new Error(d.code);
    expect(d.survivor.events.map((e) => [e.type, e.toState])).toEqual([['offer_rescinded', 'unassigned'], ['merged_in', 'owned']]);
    expect(d.survivor.next).toMatchObject({ state: 'owned', ownerUserId: U.b });
    expect(d.survivor.effects).toContainEqual({ kind: 'cancelTimers', dedupeKeys: [`ownership.offer_expiry:${C1}:${s.p.offerId}`] });
  });

  it('R-OWN-24: neither owned keeps the survivor’s state (offered, pond, unassigned, closed) and its fields', () => {
    for (const make of [() => offered(C1, U.c), () => inPond(C1)]) {
      const s = make();
      const l = inPond(C2);
      const d = decideMerge(s.p, l.p, merge(), ctx({ actor: userActor(U.admin) }));
      if (!d.ok) throw new Error(d.code);
      const { seq: _s, commandId: _c, actorUserId: _a, ...rest } = d.survivor.next;
      const { seq: _s2, commandId: _c2, actorUserId: _a2, ...before } = s.p;
      expect(rest).toEqual(before);
      expect(d.survivor.effects.map((e) => e.kind)).not.toContain('cancelTimers');
    }
    const un = new Lead(C1);
    un.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider') });
    const d = decideMerge(un.p, inPond(C2).p, merge(), ctx({ actor: userActor(U.admin) }));
    if (!d.ok) throw new Error(d.code);
    expect(d.survivor.next).toMatchObject({ state: 'unassigned', routeDueAt: T0 });
    const closed = ownedBy(C1, U.a);
    closed.run({ kind: 'close', reason: 'not_a_lead' }, { actor: userActor(U.a) });
    const c = decideMerge(closed.p, inPond(C2).p, merge(), ctx({ actor: userActor(U.admin) }));
    if (!c.ok) throw new Error(c.code);
    expect(c.survivor.next).toMatchObject({ state: 'closed', closedReason: 'not_a_lead' });
  });

  it('R-OWN-24: different owners need a TL/Admin choice (MERGE_OWNER_REQUIRED, agents NOT_FOUND); merged contacts cannot merge again (CONTACT_MERGED)', () => {
    const s = ownedBy(C1, U.a);
    const l = ownedBy(C2, U.b);
    const r = decideMerge(s.p, l.p, merge(), ctx({ actor: userActor(U.admin) }));
    expectRejected(r as never, 'MERGE_OWNER_REQUIRED');
    if (!r.ok) expect(r.rejection).toMatchObject({ contactId: C1, payload: { preselected: U.a } });
    expectRejected(decideMerge(s.p, l.p, merge(U.a), ctx({ actor: userActor(U.a) })) as never, 'NOT_FOUND');
    expectRejected(decideMerge(s.p, l.p, merge(U.a), ctx({ actor: userActor(U.tc) })) as never, 'NOT_FOUND');
    expectRejected(decideMerge(s.p, l.p, merge(U.a), ctx({ actor: systemActor('assistant') })) as never, 'NOT_FOUND');
    expectRejected(decideMerge(s.p, s.p, { ...merge(), loserId: C1 }, ctx({ actor: userActor(U.admin) })) as never, 'VALIDATION_FAILED');
    const done = decideMerge(s.p, l.p, merge(U.a), ctx({ actor: userActor(U.admin) }));
    if (!done.ok) throw new Error(done.code);
    expectRejected(decideMerge(s.p, done.loser.next, merge(), ctx({ actor: userActor(U.admin) })) as never, 'CONTACT_MERGED');
    expectRejected(decide(done.loser.next, { kind: 'reinquiry', inquiryId: 'i' }, ctx({ contactId: C2 })), 'CONTACT_MERGED');
    expectRejected(decide(done.loser.next, { kind: 'reopen' }, ctx({ contactId: C2, actor: userActor(U.admin) })), 'CONTACT_MERGED');
    expectRejected(decide(done.loser.next, { kind: 'soft_delete' }, ctx({ contactId: C2, actor: userActor(U.admin) })), 'CONTACT_MERGED');
    const del = ownedBy(C2, U.a);
    del.run({ kind: 'soft_delete' }, { actor: userActor(U.a) });
    expectRejected(decideMerge(s.p, del.p, merge(), ctx({ actor: userActor(U.admin) })) as never, 'LEAD_STATE_CHANGED');
    expectRejected(decideMerge(s.p, l.p, merge(U.a), ctx({ actor: userActor(U.admin), expectedSeq: 1 })) as never, 'LEAD_STATE_CHANGED');
  });

  it('decide() serves either side of a merge from the peer projection', () => {
    const s = ownedBy(C1, U.a);
    const l = inPond(C2);
    // a pond side needs a TL/Admin (an agent sees only its card: decide.adversarial.test.ts)
    const sv = decide(s.p, merge(), ctx({ contactId: C1, mergePeer: l.p, actor: userActor(U.tl) }));
    const lv = decide(l.p, merge(), ctx({ contactId: C2, mergePeer: s.p, actor: userActor(U.tl) }));
    expect(sv.ok && sv.events[0]?.type).toBe('merged_in');
    expect(lv.ok && lv.events[0]?.type).toBe('merged_away');
    expect(lv.next).toMatchObject({ state: 'closed', closedReason: 'merged', pondId: null });
    const rej = decide(l.p, merge(), ctx({ contactId: C2, mergePeer: ownedBy(C1, U.b).p, actor: userActor(U.admin) }));
    expect(rej).toMatchObject({ ok: true }); // pond loser + owned survivor: no choice needed
    const lb = ownedBy(C2, U.b);
    const both = decide(lb.p, merge(), ctx({ contactId: C2, mergePeer: s.p, actor: userActor(U.admin) }));
    expectRejected(both, 'MERGE_OWNER_REQUIRED');
    if (!both.ok) expect(both.rejection.contactId).toBe(C2);
    expect(() => decide(s.p, merge(), ctx({ contactId: C1 }))).toThrow();
    expect(() => decide(s.p, merge(), ctx({ contactId: 'c0000000-0000-7000-8000-000000000099' as ContactId, mergePeer: l.p }))).toThrow();
    expectRejected(decide(null, merge(), ctx({ mergePeer: l.p })), 'NOT_FOUND');
    expect(l.p.pondId).toBe(DEFAULT_POND);
  });

  it('R-OWN-24: merges lock both contacts in ascending id order', () => {
    expect(mergeLockOrder(C2, C1)).toEqual([C1, C2]);
    expect(mergeLockOrder(C1, C2)).toEqual([C1, C2]);
  });
});

describe('merge redirects (R-OWN-20)', () => {
  const id = (n: number) => `c0000000-0000-7000-8000-${n.toString().padStart(12, '0')}` as ContactId;
  it('R-OWN-20: a re-inquiry for a merged contact is redirected along merged_into, at most five hops', () => {
    const chain = (len: number) => (c: ContactId) => {
      const n = Number(c.slice(-12));
      return n < len ? id(n + 1) : null;
    };
    expect(resolveMergeRedirect(id(0), chain(0))).toEqual({ ok: true, contactId: id(0), hops: 0 });
    expect(resolveMergeRedirect(id(0), chain(5))).toEqual({ ok: true, contactId: id(5), hops: 5 });
    expect(resolveMergeRedirect(id(0), chain(6))).toEqual({ ok: false, code: 'MERGE_REDIRECT_TOO_DEEP' });
    expect(resolveMergeRedirect(id(1), (c) => (c === id(1) ? id(2) : id(1)))).toEqual({ ok: false, code: 'MERGE_REDIRECT_CYCLE' });
  });
});
