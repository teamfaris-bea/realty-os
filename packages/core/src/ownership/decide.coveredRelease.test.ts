// The 30-minute auto-release does not fire for a covered source (b19 team-queue lane, step 2; owner decision 3,
// 2026-11-19; DATA_MODEL R-TEAMQ-13, E843 to E845). Tested where it is decided: the `auto_release` timer command.
import { describe, expect, it } from 'vitest';
import { type Instant, plusMs } from '../foundation/index.js';
import { decide } from './decide.js';
import { fold } from './fold.js';
import { C1, DEFAULT_POND, SETTINGS, U, ctx, eventsOf, ownedLead, systemActor } from './testing/fixtures.js';
import type { Decision, Effect } from './types.js';

const notifies = (d: Decision) => d.effects.filter((e): e is Extract<Effect, { kind: 'notify' }> => e.kind === 'notify');
const releaseFence = (l: ReturnType<typeof ownedLead>) => ({ periodSeq: l.p.periodSeq as number, dueAt: l.p.releaseDueAt as Instant });
const breachFence = (l: ReturnType<typeof ownedLead>) => ({ periodSeq: l.p.periodSeq as number, dueAt: l.p.firstTouchDueAt as Instant });

describe('R-TEAMQ-13 the auto-release of a lead from a covered source', () => {
  it('R-TEAMQ-13 E843: covered: the timer fires and nothing is released: the lead stays with its owner, the release deadline is cleared by a ledgered `sla_waived` event, and nobody is notified about a pond', () => {
    const l = ownedLead(U.a);
    const fence = releaseFence(l);
    const before = l.p;
    const d = l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer'), autoReleaseWaived: true });
    expect(eventsOf(d)).toHaveLength(1);
    expect(eventsOf(d)[0]).toMatchObject({ type: 'sla_waived', fromState: 'owned', toState: 'owned', ownerUserId: U.a, prevOwnerUserId: U.a, reasonCode: 'AUTO_RELEASE_OFF_COVERED_SOURCE', actorKind: 'timer', payload: { releaseDueAt: null } });
    expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.a, pondId: null, releaseDueAt: null, periodSeq: before.periodSeq, ownedAt: before.ownedAt, firstTouchDueAt: before.firstTouchDueAt, firstTouchAt: null });
    expect(fold(l.events)).toEqual(l.p);
    // no alert, no timer change, no draft or enrolment touched: the period did not end
    expect(d.effects).toEqual([]);
    expect(notifies(d)).toEqual([]);
  });

  it('R-TEAMQ-13 E843: the existing breach alert still fires for a covered lead, before or after the waived release', () => {
    // breach first (the usual order: 15 minutes, then 30)
    const a = ownedLead(U.a);
    const rel = releaseFence(a);
    const breach = a.run({ kind: 'timer', deadline: 'first_touch_breach', fence: breachFence(a) }, { now: a.p.firstTouchDueAt as Instant, actor: systemActor('timer'), autoReleaseWaived: true });
    expect(eventsOf(breach)[0]).toMatchObject({ type: 'first_touch_breached' });
    expect(notifies(breach).map((n) => [n.userId, n.notification.kind, n.notification.priority])).toEqual([[U.a, 'first_touch_due', 'critical'], [U.tl, 'first_touch_escalation', 'high']]);
    a.run({ kind: 'timer', deadline: 'auto_release', fence: rel }, { now: rel.dueAt, actor: systemActor('timer'), autoReleaseWaived: true });
    expect(a.p).toMatchObject({ state: 'owned', ownerUserId: U.a, releaseDueAt: null });
    expect(a.p.firstTouchBreachedAt).not.toBeNull();
    // the release timer wakes first (a late breach job): the breach still fires afterwards, on the same period
    const b = ownedLead(U.b);
    const bf = breachFence(b);
    b.run({ kind: 'timer', deadline: 'auto_release', fence: releaseFence(b) }, { now: b.p.releaseDueAt as Instant, actor: systemActor('timer'), autoReleaseWaived: true });
    const late = b.run({ kind: 'timer', deadline: 'first_touch_breach', fence: bf }, { now: plusMs(bf.dueAt, 60 * 60_000), actor: systemActor('timer'), autoReleaseWaived: true });
    expect(eventsOf(late)[0]).toMatchObject({ type: 'first_touch_breached', toState: 'owned', ownerUserId: U.b });
    expect(notifies(late).map((n) => n.userId)).toEqual([U.b, U.tl]);
  });

  it('R-TEAMQ-13 E844: not covered, or unknown: the tenant setting decides exactly as before (released to the default pond)', () => {
    for (const autoReleaseWaived of [false, undefined]) {
      const l = ownedLead(U.a);
      const fence = releaseFence(l);
      const d = l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer'), ...(autoReleaseWaived === undefined ? {} : { autoReleaseWaived }) });
      expect(eventsOf(d)[0]).toMatchObject({ type: 'auto_released', toState: 'in_pond', pondId: DEFAULT_POND, reasonCode: 'FIRST_TOUCH_MISSED' });
    }
    // and a tenant with the auto-release turned off schedules none, covered or not (unchanged)
    expect(SETTINGS.firstTouchReleaseSeconds).toBe(1800);
  });

  it('R-TEAMQ-13 E845: the waived timer delivered again, or the sweeper asking again, is a no-op: the cleared deadline no longer matches any fence', () => {
    const l = ownedLead(U.a);
    const fence = releaseFence(l);
    l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer'), autoReleaseWaived: true });
    const seq = l.p.seq;
    // the same fence under a new command id (the sweeper's re-issue derives the same id; a different one must also do nothing)
    for (const covered of [true, false]) {
      const again = decide(l.p, { kind: 'timer', deadline: 'auto_release', fence }, ctx({ now: plusMs(fence.dueAt, 60_000), actor: systemActor('timer'), autoReleaseWaived: covered }));
      expect(again).toMatchObject({ ok: true, events: [], effects: [] });
    }
    expect(l.p.seq).toBe(seq);
    // a first touch after the waiver is recorded as usual
    expect(l.p.firstTouchAt).toBeNull();
    expect(l.p.ownerUserId).toBe(U.a);
    expect(l.events.at(-1)!.contactId).toBe(C1);
  });

  it('R-TEAMQ-13: an early wake of a covered lead\'s release timer still waits for the stored deadline (nothing is waived early)', () => {
    const l = ownedLead(U.a);
    const fence = releaseFence(l);
    const early = decide(l.p, { kind: 'timer', deadline: 'auto_release', fence }, ctx({ now: plusMs(fence.dueAt, -5000), actor: systemActor('timer'), autoReleaseWaived: true }));
    expect(early.ok && early.events).toEqual([]);
    expect(early.effects.map((e) => e.kind)).toEqual(['enqueueTimer']);
  });
});
