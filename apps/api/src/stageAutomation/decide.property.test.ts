// Property and mutation-style tests of the stage-entry decision (parity module 67; R-PAR-16, E172, D1).
import { readFileSync, readdirSync } from 'node:fs';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ChannelReach, OPT_OUT_REASONS, SKIP_REASONS, type StageEntryFacts, type StagePlaybook, choosePlaybook, decideStageEntry, outcomeOf, reachableOn } from './decide.js';
import { annualDedupeKey, annualTaskId, stageEnrollmentId } from './ids.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));
const STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
const USERS = ['u1', 'u2', 'u3'] as const;

const playbookArb: fc.Arbitrary<StagePlaybook> = fc.record({
  id: fc.uuid(),
  name: fc.constantFrom('Buyer plan', 'Agent plan', 'Other'),
  scope: fc.constantFrom('team' as const, 'agent' as const),
  ownerUserId: fc.constantFrom<string | null>(...USERS, null),
  approvedVersionId: fc.option(fc.uuid(), { nil: null }),
}).map((p) => (p.scope === 'team' ? { ...p, ownerUserId: null } : { ...p, ownerUserId: p.ownerUserId ?? 'u1' }));

const factsArb: fc.Arbitrary<StageEntryFacts> = fc.record({
  actorKind: fc.constantFrom('user' as const, 'system' as const, 'support' as const, 'none' as const),
  protectedAudience: fc.boolean(),
  toStage: fc.constantFrom(...STAGES),
  contact: fc.record({ exists: fc.boolean(), deleted: fc.boolean(), merged: fc.boolean(), stage: fc.constantFrom(...STAGES), ownerUserId: fc.constantFrom<string | null>(...USERS, null) }),
  changerSeesDetail: fc.boolean(),
  candidates: fc.array(playbookArb, { maxLength: 4 }),
  liveEnrollment: fc.boolean(),
  reachable: fc.boolean(),
});

describe('R-PAR-16 E172 decideStageEntry (property)', () => {
  it('R-PAR-16 a start happens exactly when every condition holds, from the approved version of the chosen plan', () => {
    fc.assert(
      fc.property(factsArb, (f) => {
        const d = decideStageEntry(f);
        const chosen = choosePlaybook(f.candidates, f.contact.ownerUserId);
        const all = f.actorKind === 'user' && !f.protectedAudience && f.contact.exists && !f.contact.deleted && !f.contact.merged && f.contact.stage === f.toStage
          && f.changerSeesDetail && chosen !== null && chosen.approvedVersionId !== null && !f.liveEnrollment && f.reachable;
        expect(d.kind === 'start').toBe(all);
        if (d.kind === 'start') expect(d.versionId).toBe(chosen!.approvedVersionId);
        if (chosen === null) expect(d.kind).toBe('none');
        else expect(d.kind).not.toBe('none');
      }),
      { numRuns: 2000 },
    );
  });

  it('R-PAR-16 R-PAR-8 never an import/system change, never a protected bulk audience, never a live enrollment, never an unreachable person, never an unapproved version', () => {
    fc.assert(
      fc.property(factsArb, (f) => {
        const d = decideStageEntry(f);
        if (f.actorKind !== 'user' || f.protectedAudience || f.liveEnrollment || !f.reachable) expect(d.kind).not.toBe('start');
        if (d.kind === 'start') expect(d.playbook.approvedVersionId).not.toBeNull();
      }),
      { numRuns: 2000 },
    );
  });

  it('E172 the contact owner\'s own agent plan wins over the team\'s; another agent\'s plan never covers the contact', () => {
    fc.assert(
      fc.property(fc.array(playbookArb, { maxLength: 5 }), fc.constantFrom<string | null>(...USERS, null), (cands, owner) => {
        const p = choosePlaybook(cands, owner);
        const own = cands.filter((c) => c.scope === 'agent' && owner !== null && c.ownerUserId === owner);
        const team = cands.filter((c) => c.scope === 'team');
        if (own.length > 0) expect(p?.scope).toBe('agent');
        else if (team.length > 0) expect(p?.scope).toBe('team');
        else expect(p).toBeNull();
        if (p?.scope === 'agent') expect(p.ownerUserId).toBe(owner);
        // the order the candidates arrive in never changes the choice
        expect(choosePlaybook([...cands].reverse(), owner)).toEqual(p);
      }),
      { numRuns: 2000 },
    );
  });

  it('E172 mutation guards: each single condition flipped from a start skips with its own reason', () => {
    const plan: StagePlaybook = { id: '00000000-0000-4000-8000-000000000001', name: 'Buyer plan', scope: 'team', ownerUserId: null, approvedVersionId: '00000000-0000-4000-8000-000000000002' };
    const ok: StageEntryFacts = { actorKind: 'user', protectedAudience: false, toStage: 'active', contact: { exists: true, deleted: false, merged: false, stage: 'active', ownerUserId: 'u1' }, changerSeesDetail: true, candidates: [plan], liveEnrollment: false, reachable: true };
    expect(decideStageEntry(ok)).toEqual({ kind: 'start', playbook: plan, versionId: plan.approvedVersionId });
    const cases: [Partial<StageEntryFacts>, string][] = [
      [{ actorKind: 'system' }, 'not_a_person_change'],
      [{ actorKind: 'none' }, 'not_a_person_change'],
      [{ protectedAudience: true }, 'protected_audience'],
      [{ contact: { ...ok.contact, deleted: true } }, 'person_removed'],
      [{ contact: { ...ok.contact, merged: true } }, 'person_removed'],
      [{ contact: { ...ok.contact, stage: 'nurture' } }, 'stage_changed_again'],
      [{ changerSeesDetail: false }, 'not_visible'],
      [{ candidates: [{ ...plan, approvedVersionId: null }] }, 'plan_not_approved'],
      [{ liveEnrollment: true }, 'already_in_a_plan'],
      [{ reachable: false }, 'cannot_be_reached'],
    ];
    for (const [patch, reason] of cases) expect(decideStageEntry({ ...ok, ...patch }), reason).toMatchObject({ kind: 'skip', reason });
    // an agent plan of another agent is no candidate at all
    expect(decideStageEntry({ ...ok, candidates: [{ ...plan, scope: 'agent', ownerUserId: 'u2' }] })).toEqual({ kind: 'none' });
  });

  it('R-PAR-16 outcomeOf says only names from the closed set (or nothing)', () => {
    expect(outcomeOf(null)).toBeNull();
    expect(outcomeOf({ outcome: 'started', reason: null, playbookName: 'Buyer plan' })).toEqual({ started: 'Buyer plan' });
    expect(outcomeOf({ outcome: 'skipped', reason: 'already_in_a_plan', playbookName: 'Buyer plan' })).toEqual({ skipped: 'already_in_a_plan', plan: 'Buyer plan' });
    expect(outcomeOf({ outcome: 'skipped', reason: 'SOMETHING_ELSE', playbookName: 'Buyer plan' })).toBeNull();
  });

  it('R-PAR-16 the closed set of skip reasons is exactly the DB CHECK of stage_automation_decisions.reason (as the last migration that defines it leaves it)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    // the table's own CHECK (0036), replaced since by name (0041 adds protected_audience)
    const defining = files.map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8').replace(/\s+/g, ' '))
      .filter((t) => t.includes('CREATE TABLE stage_automation_decisions') || t.includes('ADD CONSTRAINT stage_automation_decisions_reason_check'));
    expect(defining.length).toBeGreaterThanOrEqual(2);
    const last = defining.at(-1)!;
    const at = last.includes('ADD CONSTRAINT stage_automation_decisions_reason_check') ? last.slice(last.indexOf('ADD CONSTRAINT stage_automation_decisions_reason_check')) : last;
    const m = /CHECK \(reason IN \(([^)]*)\)\)/.exec(at);
    expect(m).not.toBeNull();
    const inDb = m![1]!.split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(inDb.sort()).toEqual([...SKIP_REASONS].sort());
  });
});

describe('D1 R-PAR-12 reachableOn: only opt-outs skip a plan', () => {
  const reasonArb = fc.constantFrom('CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT', 'WRONG_NUMBER', 'SENDER_UNAVAILABLE', 'QUIET_HOURS', 'EMAIL_DOMAIN_UNVERIFIED', 'CATEGORY_NOT_AUTONOMOUS');
  const chArb: fc.Arbitrary<ChannelReach> = fc.record({ hasAddress: fc.boolean(), reasons: fc.array(reasonArb, { maxLength: 3 }) });

  it('D1 reachable exactly when some channel has an address with no opt-out reason; non-opt-out reasons never skip', () => {
    fc.assert(
      fc.property(fc.array(chArb, { maxLength: 4 }), (chs) => {
        const want = chs.length === 0 || chs.some((c) => c.hasAddress && !c.reasons.some((r) => OPT_OUT_REASONS.has(r)));
        expect(reachableOn(chs)).toBe(want);
      }),
      { numRuns: 2000 },
    );
  });

  it('R-PAR-12 a STOP (consent revoked) on every channel the plan uses makes the person unreachable', () => {
    expect(reachableOn([{ hasAddress: true, reasons: ['CONSENT_REVOKED'] }])).toBe(false);
    expect(reachableOn([{ hasAddress: true, reasons: ['CONSENT_REVOKED'] }, { hasAddress: true, reasons: [] }])).toBe(true);
    expect(reachableOn([{ hasAddress: false, reasons: [] }])).toBe(false);
  });
});

describe('R-PAR-16 R-PAR-20 derived ids', () => {
  it('R-PAR-20 one id per person, field and occurrence; R-PAR-16 one enrollment id per stage event', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.uuid(), fc.integer({ min: 2000, max: 2100 }), (c, f, e, y) => {
        const occ = `${y}-02-28`;
        expect(annualTaskId(c, f, occ)).toBe(annualTaskId(c.toUpperCase(), f, occ));
        expect(annualTaskId(c, f, occ)).not.toBe(annualTaskId(c, f, `${y + 1}-02-28`));
        expect(annualTaskId(c, f, occ)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(stageEnrollmentId(e)).toBe(stageEnrollmentId(e.toUpperCase()));
        expect(stageEnrollmentId(e)).not.toBe(annualTaskId(c, f, occ));
      }),
    );
    expect(() => annualDedupeKey('a', 'b', '2026-2-1')).toThrow();
  });
});
