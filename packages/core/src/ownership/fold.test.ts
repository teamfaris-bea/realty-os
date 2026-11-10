import { describe, expect, it } from 'vitest';
import { MINUTE_MS, plusMs } from '../foundation/index.js';
import { OwnershipFoldError, applyEvent, diffProjection, fold, foldFrom, startsPeriod } from './fold.js';
import { checkShape } from './invariants.js';
import { DEFAULT_POND, T0, U, member, ownedLead, userActor } from './testing/fixtures.js';
import type { OwnershipEvent, OwnershipProjection } from './types.js';

const base = (): OwnershipProjection => ownedLead(U.a).p;

describe('fold (R-OWN-4)', () => {
  it('R-OWN-4: fold(ledger) reproduces every guarded projection column, including command and actor', () => {
    const l = ownedLead(U.a);
    l.run({ kind: 'touch', via: 'sms', refId: 'm1', at: plusMs(T0, MINUTE_MS) }, { now: plusMs(T0, MINUTE_MS), actor: userActor(U.a) });
    l.run({ kind: 'release', reason: 'unresponsive' }, { now: plusMs(T0, 2 * MINUTE_MS), actor: userActor(U.a) });
    const p = fold(l.events);
    expect(p).toEqual(l.p);
    expect(p).toMatchObject({ state: 'in_pond', pondId: DEFAULT_POND, seq: 5, actorUserId: U.a, commandId: l.events[4]?.commandId });
    expect(foldFrom(null, l.events)).toEqual(p);
    expect(foldFrom(p, [])).toBe(p);
  });

  it('R-OWN-4: the drift check lists every differing field and never corrects anything', () => {
    const l = ownedLead(U.a);
    expect(diffProjection(l.events, l.p)).toEqual([]);
    const drifted = { ...l.p, ownerUserId: U.b, firstTouchDueAt: null };
    expect(diffProjection(l.events, drifted).map((d) => d.field).sort()).toEqual(['firstTouchDueAt', 'ownerUserId']);
    const gap = diffProjection([l.events[0] as OwnershipEvent, l.events[2] as OwnershipEvent], l.p);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ field: 'seq', stored: 3 });
    expect(String(gap[0]?.ledger)).toContain('expected seq 2');
  });

  it('fold refuses a ledger with a gap, a wrong start or a broken from_state chain', () => {
    // R-OWN-3 is DB-enforced (gapless seq trigger, smoke); this is fold's own check
    const l = ownedLead(U.a);
    const [e1, e2, e3] = l.events as [OwnershipEvent, OwnershipEvent, OwnershipEvent];
    expect(() => fold([])).toThrow(OwnershipFoldError);
    expect(() => fold([e2])).toThrow(/expected seq 1/);
    expect(() => fold([e1, e3])).toThrow(/expected seq 2/);
    expect(() => fold([e1, e2, { ...e3, fromState: 'in_pond' }])).toThrow(/from_state/);
    expect(() => fold([{ ...e1, fromState: 'owned' }])).toThrow(/from_state NULL/);
    try {
      fold([e1, e3]);
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipFoldError);
      expect((err as OwnershipFoldError).code).toBe('SEQ_GAP');
    }
  });

  it('R-OWN-1: an event that would break the shape (owner outside owned, pond missing, closed without reason) is refused', () => {
    const l = ownedLead(U.a);
    const head = l.p;
    const ev = (over: Partial<OwnershipEvent>): OwnershipEvent => ({ ...(l.events[2] as OwnershipEvent), seq: head.seq + 1, fromState: 'owned', payload: {}, ...over });
    expect(() => applyEvent(head, ev({ type: 'released', toState: 'in_pond', ownerUserId: null, pondId: null }))).toThrow(/in_pond has exactly a pond/);
    expect(() => applyEvent(head, ev({ type: 'closed', toState: 'closed', ownerUserId: null }))).toThrow(/closedReason/);
    expect(() => applyEvent(head, ev({ type: 'closed', toState: 'closed', ownerUserId: null, payload: { closedReason: 'bogus' as never } }))).toThrow(OwnershipFoldError);
    expect(() => applyEvent(head, ev({ type: 'offered', toState: 'offered', ownerUserId: null, offerId: 'o', offeredToUserId: U.b, deadlineAt: null }))).toThrow(/offered has exactly an offer/);
    expect(() => applyEvent(head, ev({ type: 'reassigned', toState: 'owned', ownerUserId: null }))).toThrow(/owned has exactly an owner/);
    expect(() => applyEvent(head, ev({ type: 'offer_rescinded', toState: 'unassigned', ownerUserId: null, payload: { routeDueAt: 1.5 } }))).toThrow(/epoch ms/);
  });

  it('ownership periods start on entering owned, on an owner change, or on payload.newPeriod; in-period events keep them', () => {
    const l = ownedLead(U.a);
    const head = l.p;
    const e = { ...(l.events[2] as OwnershipEvent), seq: head.seq + 1, fromState: 'owned' as const };
    expect(startsPeriod(null, { ...e, fromState: null })).toBe(true);
    expect(startsPeriod(head, { ...e, type: 'first_touch_breached', payload: {} })).toBe(false);
    expect(startsPeriod(head, { ...e, type: 'reassigned', ownerUserId: U.b })).toBe(true);
    expect(startsPeriod(head, { ...e, type: 'reinquiry', payload: { newPeriod: true } })).toBe(true);
    expect(startsPeriod(head, { ...e, type: 'released', toState: 'in_pond', ownerUserId: null })).toBe(false);
    expect(member(U.a).status).toBe('active');
  });
});

describe('shape invariants (R-OWN-1)', () => {
  it('R-OWN-1: exactly one of five states; the state fixes which of owner / offer / pond are set; one owner, only when owned', () => {
    const owned = base();
    expect(checkShape(owned)).toEqual([]);
    const bad: [Partial<OwnershipProjection>, RegExp][] = [
      [{ state: 'in_pond' }, /in_pond/],
      [{ state: 'unassigned', ownerUserId: null, periodSeq: null, ownedAt: null, firstTouchDueAt: null, releaseDueAt: null, offerId: 'x' }, /unassigned/],
      [{ state: 'closed', ownerUserId: null, periodSeq: null, ownedAt: null, firstTouchDueAt: null, releaseDueAt: null, closedReason: null }, /closed <=> closed_reason/],
      [{ state: 'offered', ownerUserId: null, periodSeq: null, ownedAt: null, firstTouchDueAt: null, releaseDueAt: null }, /offered/],
      [{ ownedAt: null }, /owned_at/],
      [{ periodSeq: null }, /period_seq/],
      [{ periodSeq: 99 }, /<= ownership_seq/],
      [{ routeDueAt: T0 }, /route_due_at/],
      [{ seq: 0, periodSeq: null }, />= 1/],
      [{ offerRound: -1 }, /offer_round/],
      [{ pondId: DEFAULT_POND }, /owned has exactly/],
      [{ state: 'closed', periodSeq: null, ownedAt: null, firstTouchDueAt: null, releaseDueAt: null, closedReason: 'spam' }, /closed has no owner/],
    ];
    for (const [over, re] of bad) expect(checkShape({ ...owned, ...over }).join('; ')).toMatch(re);
    const pond: OwnershipProjection = { ...owned, state: 'in_pond', pondId: DEFAULT_POND, ownerUserId: null, periodSeq: null, ownedAt: null, firstTouchDueAt: null, releaseDueAt: null };
    expect(checkShape(pond)).toEqual([]);
    expect(checkShape({ ...pond, firstTouchAt: T0 }).join()).toMatch(/owned-period fields/);
  });
});
