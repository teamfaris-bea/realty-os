// Property tests of the module 56 decision functions (PARITY_PLAN §4.4: stageChangeAllowed against the
// DB guard's truth table, parseMentions, nextAnnualOccurrence over leap years and DST).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../../foundation/authz.js';
import { DAY_MS, instant } from '../../foundation/time.js';
import { localDate, localDateOf, zone } from '../../foundation/tz.js';
import { STAGES, type StageActor, type StageFacts, mentionToken, nextAnnualOccurrence, parseMentions, planReplacePoint, stageChangeAllowed } from './index.js';

/**
 * app.contacts_stage_guard, transcribed from SQL (the trigger fires only WHEN NEW.stage IS DISTINCT FROM
 * OLD.stage):
 *   NEW.stage NOT IN ('new','attempting') AND OLD.ownership_state = 'owned' AND OLD.first_touch_due_at IS NOT NULL
 *   AND OLD.first_touch_at IS NULL AND app.actor_kind() = 'user' AND app.my_role() IN ('agent','isa')  => refuse
 */
function dbGuardRefuses(c: StageFacts, actor: StageActor, to: string): boolean {
  if (to === c.stage) return false;
  const actorKind = actor.kind;
  const role = actor.kind === 'user' ? actor.role : null;
  return !['new', 'attempting'].includes(to) && c.ownershipState === 'owned' && c.firstTouchDueAt !== null && c.firstTouchAt === null && actorKind === 'user' && (role === 'agent' || role === 'isa');
}

const facts = fc.record({
  stage: fc.constantFrom(...STAGES),
  ownershipState: fc.constantFrom('unassigned', 'offered', 'owned', 'in_pond', 'closed' as const),
  firstTouchDueAt: fc.option(fc.integer({ min: 0, max: 2e12 }).map(instant), { nil: null }),
  firstTouchAt: fc.option(fc.integer({ min: 0, max: 2e12 }).map(instant), { nil: null }),
}) as fc.Arbitrary<StageFacts>;
const actor: fc.Arbitrary<StageActor> = fc.oneof(
  fc.constantFrom(...ROLES).map((role) => ({ kind: 'user' as const, role })),
  fc.constant({ kind: 'system' as const }),
  fc.constant({ kind: 'support' as const }),
);

describe('property: stageChangeAllowed mirrors the DB guard (R-PAR-14)', () => {
  it('R-PAR-14 agrees with app.contacts_stage_guard on every input', () => {
    fc.assert(
      fc.property(facts, actor, fc.constantFrom(...STAGES), (c, a, to) => {
        expect(stageChangeAllowed(c, a, to).ok).toBe(!dbGuardRefuses(c, a, to));
      }),
      { numRuns: 5000 },
    );
  });
});

const uuid = fc.uuid().map((x) => x.toLowerCase());

describe('property: parseMentions (R-PAR-3)', () => {
  it('R-PAR-3 output is deduped, never contains self or a non-member, and never exceeds 10', () => {
    fc.assert(
      fc.property(fc.array(uuid, { maxLength: 30 }), fc.array(uuid, { maxLength: 15 }), uuid, fc.array(fc.string({ maxLength: 20 }), { maxLength: 10 }), (mentioned, members, self, noise) => {
        const body = mentioned.map((id, i) => `${noise[i % Math.max(1, noise.length)] ?? ''} ${mentionToken(id, 'n')}`).join(' ');
        const r = parseMentions(body, { members: [...members, self], self });
        const expected = [...new Set(mentioned)].filter((x) => x !== self && members.includes(x));
        if (expected.length > 10) {
          expect(r).toEqual({ ok: false, code: 'MENTION_LIMIT', count: expected.length });
        } else {
          expect(r).toEqual({ ok: true, userIds: expected });
        }
      }),
    );
  });
});

const ZONES = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'Etc/UTC', 'America/St_Johns'];

describe('property: nextAnnualOccurrence (R-PAR-20)', () => {
  it('R-PAR-20 is today or later, within a year, and keeps the month/day (29 Feb → 28 Feb off leap years) across DST', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2020 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.constantFrom(...ZONES),
        fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2090, 0, 1) }),
        (y, m, d, z, nowMs) => {
          const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
          if (d > dim) return;
          const date = localDate(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
          const tz = zone(z);
          const now = instant(nowMs);
          const today = localDateOf(now, tz);
          const next = nextAnnualOccurrence(date, tz, now);
          expect(next >= today).toBe(true);
          const span = (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
          expect(span).toBeLessThan(366);
          const [ny, nm, nd] = next.split('-').map(Number) as [number, number, number];
          const leap = new Date(Date.UTC(ny, 2, 0)).getUTCDate() === 29;
          if (m === 2 && d === 29 && !leap) expect([nm, nd]).toEqual([2, 28]);
          else expect([nm, nd]).toEqual([m, d]);
        },
      ),
      { numRuns: 3000 },
    );
  });
});

describe('property: planReplacePoint never edits in place (R-PAR-11)', () => {
  it('R-PAR-11 a successful plan always removes the old id as replaced and adds a different address of the same kind', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2002000000, max: 9899999999 }), fc.integer({ min: 2002000000, max: 9899999999 }), (a, b) => {
        const old = { id: 'p1', kind: 'phone' as const, address: `+1${a}`, label: 'mobile' as const, removed: false, removedReason: null };
        const r = planReplacePoint(old, `+1${b}`);
        if (!r.ok) return;
        expect(r.plan.remove).toEqual({ id: 'p1', reason: 'replaced' });
        expect(r.plan.add.kind).toBe('phone');
        expect(r.plan.add.address).not.toBe(old.address);
      }),
    );
  });
});
