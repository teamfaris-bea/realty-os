// Source coverage (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11, E833 to E836): the pure rules
// behind "covered" and its warnings. Names here are made up.
import { describe, expect, it } from 'vitest';
import type { LeadSourceId, PondId, RuleId, UserId } from '../foundation/index.js';
import { COVERAGE_WARNING_CODES, type SourceCoverageFacts, sourceCoverage, sourceRouting } from './coverage.js';
import type { RuleFacts } from './types.js';

const S1 = '00000000-0000-7000-8000-0000000000a1' as LeadSourceId;
const S2 = '00000000-0000-7000-8000-0000000000a2' as LeadSourceId;
const DEFAULT = '00000000-0000-7000-8000-0000000000d0' as PondId;
const OVERFLOW = '00000000-0000-7000-8000-0000000000d1' as PondId;
const OWNER = '00000000-0000-7000-8000-0000000000b1' as UserId;
const BACKUP = '00000000-0000-7000-8000-0000000000b2' as UserId;

const rule = (o: Omit<Partial<RuleFacts>, 'id'> & { id: string }): RuleFacts => ({
  position: 1,
  name: 'Rule',
  enabled: true,
  version: 1,
  strategy: 'round_robin',
  match: {},
  directUserId: null,
  targetPondId: null,
  fallbackPondId: null,
  offerWindowSeconds: null,
  maxOffers: null,
  ...o,
  id: o.id as RuleId,
});

const facts = (o: Partial<SourceCoverageFacts> = {}): SourceCoverageFacts => ({
  owner: { userId: OWNER, name: 'Jordan P.', status: 'active' },
  backup: { userId: BACKUP, name: 'Sam T.', status: 'active' },
  highIntent: false,
  coveredSetting: true,
  routing: { named: true, ruleId: null, ruleName: 'Website leads', pondId: OVERFLOW },
  fallbackPondName: 'Overflow',
  sharedWith: [],
  ...o,
});
const codes = (f: SourceCoverageFacts) => sourceCoverage(f).warnings.map((w) => w.code);

describe('R-TEAMQ-10 sourceCoverage: covered only with an owner and a backup who are both on the team', () => {
  it('R-TEAMQ-10: the switch on, an active owner and an active backup: covered, said in words, no warning', () => {
    const c = sourceCoverage(facts());
    expect(c).toEqual({ covered: true, setting: true, sentence: 'Covered: Jordan P. owns this source and Sam T. is the backup.', warnings: [] });
  });

  it('R-TEAMQ-10 E833: not covered says why in words: nobody named, no owner, no backup, or coverage turned off', () => {
    expect(sourceCoverage(facts({ owner: null, backup: null, coveredSetting: false }))).toMatchObject({ covered: false, sentence: 'Not covered: no owner and no backup are named.' });
    expect(sourceCoverage(facts({ owner: null, coveredSetting: false }))).toMatchObject({ covered: false, sentence: 'Not covered: no owner is named.' });
    expect(sourceCoverage(facts({ backup: null, coveredSetting: false }))).toMatchObject({ covered: false, sentence: 'Not covered: no backup is named.' });
    expect(sourceCoverage(facts({ coveredSetting: false }))).toMatchObject({ covered: false, setting: false, sentence: 'Not covered: Jordan P. and Sam T. are named, but coverage is turned off.' });
    expect(codes(facts({ owner: null, backup: null, coveredSetting: false }))).toEqual(['NO_OWNER', 'NO_BACKUP']);
    // the switch can never read as covered without both people, whatever was stored
    expect(sourceCoverage(facts({ backup: null, coveredSetting: true })).covered).toBe(false);
  });

  it('R-TEAMQ-11 E834: a suspended or deactivated owner or backup flags the source and it reads as not covered; the person stays named (nothing is reassigned)', () => {
    const suspendedBackup = sourceCoverage(facts({ backup: { userId: BACKUP, name: 'Sam T.', status: 'suspended' } }));
    expect(suspendedBackup).toMatchObject({ covered: false, setting: true });
    expect(suspendedBackup.sentence).toBe('Not covered: the backup, Sam T., is suspended.');
    expect(suspendedBackup.warnings).toEqual([{ code: 'BACKUP_UNAVAILABLE', sentence: 'The backup, Sam T., is suspended. Nobody was put in their place: until another backup is named, the backup alert goes to the team lead of whoever has the lead.' }]);
    const goneOwner = sourceCoverage(facts({ owner: { userId: OWNER, name: 'Jordan P.', status: 'removed' } }));
    expect(goneOwner).toMatchObject({ covered: false, setting: true, sentence: 'Not covered: the owner, Jordan P., is no longer on the team.' });
    expect(goneOwner.warnings).toEqual([{ code: 'OWNER_UNAVAILABLE', sentence: 'The owner, Jordan P., is no longer on the team. Nobody was put in their place: name another owner.' }]);
    for (const status of ['deactivating', 'removed', 'invited'] as const) {
      expect(codes(facts({ backup: { userId: BACKUP, name: 'Sam T.', status } }))).toEqual(['BACKUP_UNAVAILABLE']);
    }
    // a member with no name on file is still described
    expect(sourceCoverage(facts({ owner: { userId: OWNER, name: null, status: 'suspended' } })).sentence).toBe('Not covered: the owner, a member with no name, is suspended.');
  });

  it('R-TEAMQ-11 E835: the same person as owner and backup is said, not hidden', () => {
    const c = sourceCoverage(facts({ backup: { userId: OWNER, name: 'Jordan P.', status: 'active' } }));
    expect(c.warnings).toEqual([{ code: 'SAME_PERSON', sentence: 'The owner and the backup are the same person, Jordan P.: nobody else is alerted when they do not respond.' }]);
  });

  it('R-TEAMQ-21 E881: the backup is in the source\'s routing rotation: said, with what then happens (their team lead is alerted instead); never when they are not in it', () => {
    const inRotation = sourceCoverage(facts({ rotation: [OWNER, BACKUP] }));
    expect(inRotation.warnings).toEqual([{ code: 'BACKUP_IN_ROTATION', sentence: 'The backup also receives these leads. When a lead is with them, their team lead is alerted instead.' }]);
    expect(inRotation.covered).toBe(true);
    expect(codes(facts({ rotation: [OWNER] }))).toEqual([]);
    expect(codes(facts({ rotation: [] }))).toEqual([]);
    expect(codes(facts())).toEqual([]);
    expect(COVERAGE_WARNING_CODES).toContain('BACKUP_IN_ROTATION');
  });

  it('R-TEAMQ-11 E836: no rule names the source, and a shared fallback pond, each a code and a sentence', () => {
    const viaCatchAll = sourceCoverage(facts({ routing: { named: false, ruleId: null, ruleName: 'Everyone', pondId: DEFAULT }, fallbackPondName: 'Main pond' }));
    expect(viaCatchAll.warnings).toEqual([{ code: 'NO_ROUTING_RULE', sentence: 'No routing rule names this source: its leads follow the rule "Everyone", which is not specific to it.' }]);
    const toPond = sourceCoverage(facts({ routing: { named: false, ruleId: null, ruleName: null, pondId: DEFAULT }, fallbackPondName: 'Main pond' }));
    expect(toPond.warnings).toEqual([{ code: 'NO_ROUTING_RULE', sentence: 'No routing rule names this source: its leads go straight to the pond "Main pond".' }]);
    const shared = sourceCoverage(facts({ sharedWith: ['Portal', 'Open house', 'Sign calls', 'Referrals'] }));
    expect(shared.warnings).toEqual([{ code: 'SHARED_FALLBACK_POND', sentence: 'Its fallback pond, "Overflow", is also the fallback pond of Portal, Open house, Sign calls and 1 more source.' }]);
    expect(sourceCoverage(facts({ sharedWith: ['Portal'] })).warnings[0]!.sentence).toBe('Its fallback pond, "Overflow", is also the fallback pond of Portal.');
    // these two never change whether the source is covered
    expect(viaCatchAll.covered && shared.covered).toBe(true);
    // every code the function can return is a declared code, in one order
    const all = codes(facts({ owner: null, backup: null, coveredSetting: false, routing: { named: false, ruleId: null, ruleName: null, pondId: DEFAULT }, sharedWith: ['Portal'] }));
    expect(all).toEqual(['NO_OWNER', 'NO_BACKUP', 'NO_ROUTING_RULE', 'SHARED_FALLBACK_POND']);
    for (const c of all) expect(COVERAGE_WARNING_CODES).toContain(c);
  });
});

describe('R-TEAMQ-11 sourceRouting: the rule a source\'s leads follow and the pond they fall back to', () => {
  const rules = [
    rule({ id: '00000000-0000-7000-8000-0000000000c1', position: 2, name: 'Everyone', fallbackPondId: null }),
    rule({ id: '00000000-0000-7000-8000-0000000000c2', position: 1, name: 'Website leads', match: { sources: [S1] }, fallbackPondId: OVERFLOW }),
    rule({ id: '00000000-0000-7000-8000-0000000000c3', position: 0, name: 'Off', enabled: false, match: { sources: [S2] }, fallbackPondId: OVERFLOW }),
  ];

  it('R-TEAMQ-11: the first enabled rule that names the source, with its fallback pond', () => {
    expect(sourceRouting(rules, S1, DEFAULT)).toEqual({ named: true, ruleId: '00000000-0000-7000-8000-0000000000c2', ruleName: 'Website leads', pondId: OVERFLOW });
  });

  it('R-TEAMQ-11 E836: a source no enabled rule names follows the first rule that names no source (its fallback pond, else the default pond); with no such rule, the default pond', () => {
    expect(sourceRouting(rules, S2, DEFAULT)).toEqual({ named: false, ruleId: '00000000-0000-7000-8000-0000000000c1', ruleName: 'Everyone', pondId: DEFAULT });
    expect(sourceRouting([rules[1]!], S2, DEFAULT)).toEqual({ named: false, ruleId: null, ruleName: null, pondId: DEFAULT });
    expect(sourceRouting([], S2, DEFAULT)).toEqual({ named: false, ruleId: null, ruleName: null, pondId: DEFAULT });
  });

  it('R-TEAMQ-11 E836: a rule that names the source AFTER a rule with no condition is never reached: the source is not named in effect', () => {
    const everyoneFirst = [
      rule({ id: '00000000-0000-7000-8000-0000000000c1', position: 1, name: 'Everyone' }),
      rule({ id: '00000000-0000-7000-8000-0000000000c2', position: 2, name: 'Website leads', match: { sources: [S1] }, fallbackPondId: OVERFLOW }),
    ];
    expect(sourceRouting(everyoneFirst, S1, DEFAULT)).toEqual({ named: false, ruleId: '00000000-0000-7000-8000-0000000000c1', ruleName: 'Everyone', pondId: DEFAULT });
    // a rule with another condition before it does not hide it (it takes only some leads)
    const buyersFirst = [rule({ id: '00000000-0000-7000-8000-0000000000c1', position: 1, name: 'Buyers', match: { leadTypes: ['buy'] } }), everyoneFirst[1]!];
    expect(sourceRouting(buyersFirst, S1, DEFAULT)).toEqual({ named: true, ruleId: '00000000-0000-7000-8000-0000000000c2', ruleName: 'Website leads', pondId: OVERFLOW });
  });

  it('R-TEAMQ-11: a rule that sends leads to a pond falls back to that pond', () => {
    const pondRule = rule({ id: '00000000-0000-7000-8000-0000000000c4', name: 'To the pond', strategy: 'pond', match: { sources: [S1] }, targetPondId: OVERFLOW });
    expect(sourceRouting([pondRule], S1, DEFAULT)).toEqual({ named: true, ruleId: '00000000-0000-7000-8000-0000000000c4', ruleName: 'To the pond', pondId: OVERFLOW });
  });
});
