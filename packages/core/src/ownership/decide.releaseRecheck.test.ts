// The waiver of the auto-release is RE-EVALUATED, not one-shot (b19 team-queue lane, review fix M1; DATA_MODEL
// R-TEAMQ-20, E974 to E978). A waived release (R-TEAMQ-13) comes back when its reason is gone: the source is no longer
// covered now, or the lead's own owner is no longer an active member. Decided by the `release_recheck` command (the
// system's, issued by apps/api leads/releaseRecheck.ts when coverage or a member's status changes): it writes a
// ledgered `sla_restored` event that stores a NEW release deadline, the tenant's release window counted from that
// moment, and the ordinary `auto_release` timer (and the sweeper, from the stored deadline) does the rest.
import { describe, expect, it } from 'vitest';
import { type Instant, addBusinessDuration, plusMs } from '../foundation/index.js';
import { autoReleaseWaivedNow, coveredNow } from './coverage.js';
import { fold } from './fold.js';
import { CAL, DEFAULT_POND, SETTINGS, U, eventsOf, expectRejected, ownedLead, systemActor, userActor } from './testing/fixtures.js';
import type { Decision, Effect } from './types.js';

const timers = (d: Decision) => d.effects.filter((e): e is Extract<Effect, { kind: 'enqueueTimer' }> => e.kind === 'enqueueTimer');
const notifies = (d: Decision) => d.effects.filter((e): e is Extract<Effect, { kind: 'notify' }> => e.kind === 'notify');
const releaseFence = (l: ReturnType<typeof ownedLead>) => ({ periodSeq: l.p.periodSeq as number, dueAt: l.p.releaseDueAt as Instant });

/** A lead whose release was waived at its deadline (covered then). */
function waivedLead() {
  const l = ownedLead(U.a);
  const fence = releaseFence(l);
  l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer'), autoReleaseWaived: true });
  expect(l.p.releaseDueAt).toBeNull();
  return { l, waivedAt: fence.dueAt };
}

describe('R-TEAMQ-20 covered now, and when a lead\'s auto-release is waived', () => {
  it('R-TEAMQ-20 E974: covered now needs the switch on and BOTH named members active; the waiver also needs the LEAD\'s own owner to be an active member', () => {
    expect(coveredNow({ setting: true, ownerStatus: 'active', backupStatus: 'active' })).toBe(true);
    expect(coveredNow({ setting: false, ownerStatus: 'active', backupStatus: 'active' })).toBe(false);
    for (const out of ['suspended', 'deactivating', 'removed', 'invited', null] as const) {
      expect(coveredNow({ setting: true, ownerStatus: out, backupStatus: 'active' })).toBe(false);
      expect(coveredNow({ setting: true, ownerStatus: 'active', backupStatus: out })).toBe(false);
      // the source is covered, its named owner and backup are fine, and the person holding THIS lead is not: not waived
      expect(autoReleaseWaivedNow({ setting: true, ownerStatus: 'active', backupStatus: 'active', leadOwnerStatus: out })).toBe(false);
    }
    expect(autoReleaseWaivedNow({ setting: true, ownerStatus: 'active', backupStatus: 'active', leadOwnerStatus: 'active' })).toBe(true);
    expect(autoReleaseWaivedNow({ setting: false, ownerStatus: 'active', backupStatus: 'active', leadOwnerStatus: 'active' })).toBe(false);
  });
});

describe('R-TEAMQ-20 release_recheck: a waived release comes back when its reason is gone', () => {
  it('R-TEAMQ-20 E975: the waiver still holds (covered now, owner active): nothing is written', () => {
    const { l, waivedAt } = waivedLead();
    const seq = l.p.seq;
    const d = l.run({ kind: 'release_recheck' }, { now: plusMs(waivedAt, 3_600_000), actor: systemActor('worker'), autoReleaseWaived: true, releaseWaivedInPeriod: true });
    expect(d).toMatchObject({ ok: true, events: [], effects: [] });
    expect(l.p.seq).toBe(seq);
  });

  it('R-TEAMQ-20 E976: the waiver no longer holds: a ledgered `sla_restored` stores a new release deadline, the tenant\'s release window of staffed time from that moment, with its timer; the owner is unchanged and nobody is notified by the re-arming', () => {
    const { l, waivedAt } = waivedLead();
    const now = plusMs(waivedAt, 3_600_000);
    const before = l.p;
    const d = l.run({ kind: 'release_recheck' }, { now, actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true });
    const due = addBusinessDuration(now, SETTINGS.firstTouchReleaseSeconds as number, CAL);
    expect(eventsOf(d)).toHaveLength(1);
    expect(eventsOf(d)[0]).toMatchObject({ type: 'sla_restored', fromState: 'owned', toState: 'owned', ownerUserId: U.a, prevOwnerUserId: U.a, reasonCode: 'AUTO_RELEASE_BACK_ON', payload: { restored: 'auto_release', releaseDueAt: due } });
    expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.a, pondId: null, releaseDueAt: due, periodSeq: before.periodSeq, ownedAt: before.ownedAt, firstTouchDueAt: before.firstTouchDueAt, firstTouchAt: null });
    expect(fold(l.events)).toEqual(l.p);
    expect(timers(d)).toEqual([{ kind: 'enqueueTimer', jobKind: 'ownership.auto_release', runAt: due, dedupeKey: expect.stringContaining('ownership.auto_release:'), fence: { contactId: l.contactId, deadline: 'auto_release', periodSeq: before.periodSeq, dueAt: due } }]);
    expect(notifies(d)).toEqual([]);
    // asked again (a second change, a replayed job): the deadline is stored, so there is nothing to restore
    const again = l.run({ kind: 'release_recheck' }, { now: plusMs(now, 1000), actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true });
    expect(again).toMatchObject({ ok: true, events: [], effects: [] });
  });

  it('R-TEAMQ-20 E976 E977: at the restored deadline the ordinary timer decides again: still not waived, the lead is released to the default pond and the team leads hear of the pond arrival; covered again by then, it is waived again', () => {
    const released = waivedLead();
    const now = plusMs(released.waivedAt, 60_000);
    released.l.run({ kind: 'release_recheck' }, { now, actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true });
    const fence = releaseFence(released.l);
    const d = released.l.run({ kind: 'timer', deadline: 'auto_release', fence }, { now: fence.dueAt, actor: systemActor('timer'), autoReleaseWaived: false });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'auto_released', toState: 'in_pond', pondId: DEFAULT_POND, reasonCode: 'FIRST_TOUCH_MISSED' });
    expect(notifies(d).map((n) => [n.userId, n.notification.kind])).toEqual([[U.a, 'reassigned_away'], [U.tl, 'first_touch_escalation']]);

    const kept = waivedLead();
    kept.l.run({ kind: 'release_recheck' }, { now: plusMs(kept.waivedAt, 60_000), actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true });
    const f2 = releaseFence(kept.l);
    const w = kept.l.run({ kind: 'timer', deadline: 'auto_release', fence: f2 }, { now: f2.dueAt, actor: systemActor('timer'), autoReleaseWaived: true });
    expect(eventsOf(w)[0]).toMatchObject({ type: 'sla_waived', reasonCode: 'AUTO_RELEASE_OFF_COVERED_SOURCE', payload: { releaseDueAt: null } });
    expect(kept.l.p).toMatchObject({ state: 'owned', ownerUserId: U.a, releaseDueAt: null });
  });

  it('R-TEAMQ-20 E978: nothing to restore: a release that was never waived, a lead already touched, a lead no longer owned, a tenant with the auto-release turned off, unknown facts; and only the system may ask', () => {
    // never waived in this period (its deadline is simply still ahead, or the tenant has none)
    const fresh = ownedLead(U.a);
    expect(fresh.run({ kind: 'release_recheck' }, { now: plusMs(fresh.p.ownedAt as Instant, 1000), actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: false })).toMatchObject({ ok: true, events: [] });
    // unknown facts read as "leave it alone"
    const unknown = waivedLead();
    expect(unknown.l.run({ kind: 'release_recheck' }, { now: plusMs(unknown.waivedAt, 1000), actor: systemActor('worker') })).toMatchObject({ ok: true, events: [] });
    // touched since the waiver
    const touched = waivedLead();
    touched.l.run({ kind: 'touch', via: 'call', refId: 'call-1', at: plusMs(touched.waivedAt, 500) }, { now: plusMs(touched.waivedAt, 500), actor: userActor(U.a) });
    expect(touched.l.p.firstTouchAt).not.toBeNull();
    expect(touched.l.run({ kind: 'release_recheck' }, { now: plusMs(touched.waivedAt, 1000), actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true })).toMatchObject({ ok: true, events: [] });
    // the tenant turned the auto-release off since: there is no release to bring back
    const off = waivedLead();
    expect(off.l.run({ kind: 'release_recheck' }, { now: plusMs(off.waivedAt, 1000), actor: systemActor('worker'), autoReleaseWaived: false, releaseWaivedInPeriod: true, settings: { ...SETTINGS, firstTouchReleaseSeconds: null } })).toMatchObject({ ok: true, events: [] });
    // a member cannot ask
    const mine = waivedLead();
    expectRejected(mine.l.run({ kind: 'release_recheck' }, { now: plusMs(mine.waivedAt, 1000), actor: userActor(U.a), autoReleaseWaived: false, releaseWaivedInPeriod: true }), 'NOT_FOUND');
  });
});
