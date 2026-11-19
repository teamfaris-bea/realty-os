// The backup's time-boxed access ends when the lead's OWNER makes a human attempt (b19 team-queue lane, step 2;
// DATA_MODEL R-TEAMQ-16, E852). Decided with the touch itself, so it commits with it.
import { describe, expect, it } from 'vitest';
import { MINUTE_MS, plusMs } from '../foundation/index.js';
import { effectPlacement } from './decide.js';
import { T0, U, eventsOf, ownedLead, userActor } from './testing/fixtures.js';
import type { Decision } from './types.js';

const kinds = (d: Decision) => d.effects.map((e) => e.kind);
const touchAt = plusMs(T0, 5 * MINUTE_MS);
const touch = { kind: 'touch' as const, via: 'call' as const, refId: 'call-1', at: touchAt };

describe('R-TEAMQ-16 the backup\'s access and the owner\'s own attempt', () => {
  it('R-TEAMQ-16 E852: the owner\'s touch ends a live backup grant, in the owner\'s own transaction (inline)', () => {
    const l = ownedLead(U.a);
    const d = l.run(touch, { actor: userActor(U.a), now: touchAt, backupAccessLive: true });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'first_touch_recorded', actorUserId: U.a });
    expect(kinds(d)).toContain('endBackupAccess');
    expect(effectPlacement({ kind: 'endBackupAccess' }, userActor(U.a))).toBe('inline');
    // a later touch by the owner (not the first of the period) ends a grant given since, too
    const later = l.run({ ...touch, refId: 'call-2', at: plusMs(touchAt, MINUTE_MS) }, { actor: userActor(U.a), now: plusMs(touchAt, MINUTE_MS), backupAccessLive: true });
    expect(later.ok && later.events).toEqual([]);
    expect(kinds(later)).toContain('endBackupAccess');
  });

  it('R-TEAMQ-16: no live grant, no effect (the usual touch is unchanged)', () => {
    const l = ownedLead(U.a);
    const d = l.run(touch, { actor: userActor(U.a), now: touchAt });
    expect(kinds(d)).not.toContain('endBackupAccess');
    const off = ownedLead(U.a).run(touch, { actor: userActor(U.a), now: touchAt, backupAccessLive: false });
    expect(kinds(off)).not.toContain('endBackupAccess');
  });

  it('R-TEAMQ-16 E851: the backup\'s own attempt, as a collaborator, is the first touch and is credited to the backup; it does not end their own access', () => {
    const l = ownedLead(U.a);
    const d = l.run(touch, { actor: userActor(U.b), now: touchAt, actorIsCollaborator: true, backupAccessLive: true });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'first_touch_recorded', actorKind: 'user', actorUserId: U.b, ownerUserId: U.a });
    expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.a });
    expect(l.p.firstTouchAt).not.toBeNull();
    expect(kinds(d)).not.toContain('endBackupAccess');
  });

  it('R-TEAMQ-16: someone who is neither the owner nor a collaborator changes nothing', () => {
    const l = ownedLead(U.a);
    const d = l.run(touch, { actor: userActor(U.c), now: touchAt, backupAccessLive: true });
    expect(d.ok && d.events).toEqual([]);
    expect(d.effects).toEqual([]);
  });
});
