// Property tests on module 31's decisions (pure: core confirmDate, core detectFirings, reminderFact, staleRuns) and the
// validation rules module 31 added to core's playbook content (finding 1 and 4).
//   - no firing for a date that does not drive updates;
//   - at most one firing per date version, step and recipient (the firing key);
//   - after any sequence of confirms, moves and completions (and the date-changed job), no scheduled run cites a
//     version that is not current.
import { validatePlaybookContent } from '@realty/core/assistant';
import { type Instant, type LocalDate, type UserId, instant } from '@realty/core/foundation';
import { detectFirings } from '@realty/core/nurture';
import { type DealDate, confirmDate, drivesUpdates } from '@realty/core/transactions';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { updatesContent } from './testing.js';
import { type Recipient, reminderFact, staleRuns } from './decide.js';

const ZONE = 'America/Chicago' as Parameters<typeof confirmDate>[2];
const T0 = Date.UTC(2027, 0, 4, 15, 0, 0);
const TEAM = { playbookId: 'p-team', versionId: 'v-1', scope: 'team' as const, ownerUserId: null, steps: [{ trigger: 'deal_date_upcoming' as const, stepKey: 'deal_date_upcoming', offsetSeconds: 0 }] };

function day(n: number): LocalDate {
  return new Date(T0 + n * 86_400_000).toISOString().slice(0, 10) as LocalDate;
}

const recipients: Recipient[] = [
  { contactId: 'c-1', ownerUserId: 'u-1', live: true, roles: ['buyer'] },
  { contactId: 'c-2', ownerUserId: 'u-1', live: true, roles: ['co_buyer'] },
  { contactId: 'c-3', ownerUserId: null, live: true, roles: ['buyer'] },
  { contactId: 'c-4', ownerUserId: 'u-2', live: false, roles: ['seller'] },
];

type Op = { kind: 'confirm'; dueIn: number; reminder: number | null } | { kind: 'complete' } | { kind: 'uncomplete' } | { kind: 'waive' } | { kind: 'reconcile' };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('confirm' as const), dueIn: fc.integer({ min: -3, max: 40 }), reminder: fc.option(fc.integer({ min: 0, max: 10 }), { nil: null }) }),
  fc.constant({ kind: 'complete' as const }),
  fc.constant({ kind: 'uncomplete' as const }),
  fc.constant({ kind: 'waive' as const }),
  fc.constant({ kind: 'reconcile' as const }),
);

/** A model of the stored date, the scheduled runs and the job, driven by the same decisions the code uses. */
function simulate(ops: readonly Op[], now: Instant) {
  let d: DealDate & { dealId: string } = { id: 'dd-1' as DealDate['id'], dealId: 'd-1', kind: 'closing', label: null, dueOn: day(30), source: 'template', status: 'proposed', dueVersion: 1, dueAt: null, reminderAt: null, completedAt: null, responsible: null, basis: {} };
  const runs = new Map<string, { key: string; dueVersion: number; status: 'scheduled' | 'skipped' }>();
  let firings = 0;
  for (const o of ops) {
    if (o.kind === 'confirm') {
      const r = confirmDate(d, { actor: { kind: 'user', userId: 'u-1' as UserId }, dueOn: day(o.dueIn), source: d.source, reminderDaysBefore: o.reminder, now }, ZONE);
      if (!r.ok) continue;
      d = { ...d, dueOn: day(o.dueIn), status: 'confirmed', dueAt: r.dueAt, reminderAt: r.reminderAt, dueVersion: r.dueVersion, basis: r.basis };
    } else if (o.kind === 'complete') {
      d = { ...d, completedAt: now, reminderAt: null };
    } else if (o.kind === 'uncomplete') {
      d = { ...d, completedAt: null };
    } else if (o.kind === 'waive') {
      d = { ...d, status: 'waived', reminderAt: null };
    } else {
      const dec = reminderFact(d, recipients, instant(now + 365 * 86_400_000), 'dual');
      if (dec.fire) {
        expect(drivesUpdates(d)).toBe(true);
        for (const f of detectFirings(dec.fact, dec.rels.map((c) => ({ contactId: c.contactId, ownerUserId: c.ownerUserId, relation: c.relation, playbook: TEAM })))) {
          firings += 1;
          if (!runs.has(f.triggerKey)) runs.set(f.triggerKey, { key: f.triggerKey, dueVersion: d.dueVersion, status: 'scheduled' });
        }
        d = { ...d, reminderAt: null };
      }
    }
    // the date-changed job (a person's move, completion or waive enqueues it; it reads the date as it stands)
    for (const s of staleRuns(d, [...runs.values()].filter((r) => r.status === 'scheduled'))) runs.get(s.run.key)!.status = 'skipped';
  }
  return { d, runs: [...runs.values()], firings };
}

describe('module 31 decisions (property)', () => {
  it('R-TXN-2: no firing for a date that does not drive updates (proposed, waived, completed, no instants)', () => {
    fc.assert(
      fc.property(fc.constantFrom<'proposed' | 'confirmed' | 'waived'>('proposed', 'confirmed', 'waived'), fc.boolean(), fc.boolean(), fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }), (status, completed, hasDue, rem) => {
        const d = { id: 'dd' as DealDate['id'], dealId: 'd', kind: 'closing' as const, label: null, dueOn: day(10), source: 'manual' as const, status, dueVersion: 1, dueAt: hasDue ? instant(T0 + 10 * 86_400_000) : null, reminderAt: rem === null ? null : instant(T0 + rem * 3_600_000), completedAt: completed ? instant(T0) : null, responsible: null, basis: {} };
        const dec = reminderFact(d, recipients, instant(T0), 'dual');
        if (dec.fire) expect(drivesUpdates(d)).toBe(true);
        if (!drivesUpdates(d)) expect(dec.fire).toBe(false);
      }),
    );
  });

  it('R-TXN-4 R-NURT-7: at most one firing per date version, step and recipient; only live, owned recipients', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
        const { runs } = simulate(ops, instant(T0));
        const keys = runs.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) expect(k).toMatch(/^deal_date:dd-1:v\d+:deal_date_upcoming:c-[12]$/);
      }),
    );
  });

  it('R-TXN-5 E96: after any sequence of confirms, moves and completions, no scheduled run cites a version that is not current', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const { d, runs } = simulate(ops, instant(T0));
        for (const r of runs.filter((x) => x.status === 'scheduled')) {
          expect(r.dueVersion).toBe(d.dueVersion);
          expect(drivesUpdates(d)).toBe(true);
        }
      }),
    );
  });
});

describe('finding 1 and 4: deal_date_upcoming step validation', () => {
  it('a deal_date_upcoming step with offsetSeconds ≠ 0 or without roles is refused at validation; roles on another trigger are refused', () => {
    const ok = updatesContent();
    expect(validatePlaybookContent(ok, { kind: 'trigger' })).toEqual([]);
    const step = (ok['triggers'] as Record<string, unknown>[])[0]!;
    const withStep = (s: Record<string, unknown>) => ({ ...ok, triggers: [s] });
    expect(validatePlaybookContent(withStep({ ...step, offsetSeconds: -172_800 }), { kind: 'trigger' })).toEqual([expect.objectContaining({ code: 'SCHEMA', detail: 'offsetSeconds' })]);
    const { roles: _r, ...noRoles } = step;
    expect(validatePlaybookContent(withStep(noRoles), { kind: 'trigger' })).toEqual([expect.objectContaining({ code: 'SCHEMA', detail: 'roles' })]);
    expect(validatePlaybookContent(withStep({ ...step, roles: [] }), { kind: 'trigger' }).map((i) => i.code)).toContain('SCHEMA');
    expect(validatePlaybookContent(withStep({ ...step, roles: ['buyer', 'landlord'] }), { kind: 'trigger' }).map((i) => i.code)).toContain('SCHEMA');
    expect(validatePlaybookContent(withStep({ ...step, roles: ['buyer', 'buyer'] }), { kind: 'trigger' })).toEqual([expect.objectContaining({ code: 'SCHEMA', detail: 'roles duplicate' })]);
    const anniversary = { trigger: 'home_anniversary', stepKey: 'a', channel: 'email', offsetSeconds: 0, purpose: 'marketing', category: 'nurture_step', intent: 'home_anniversary', subject: 's', template: 'Hi {{first_name}}', slots: ['first_name'], maxLength: 2000, roles: ['buyer'] };
    expect(validatePlaybookContent({ kind: 'triggers', digestWindowMinutes: 0, triggers: [anniversary] }, { kind: 'trigger' })).toEqual([expect.objectContaining({ code: 'SCHEMA', detail: 'roles' })]);
  });
});
