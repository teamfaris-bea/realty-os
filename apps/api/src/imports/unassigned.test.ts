// Owner decision B4 (2026-11-11, E230, E231): the plain words for a planned assignment the ownership commit brought
// in unassigned, for every reason the engine can refuse the mapped member, in the review list, the verification and
// the report. Pure (no database): the journeys in migration.journeys.test.ts prove the suspended case end to end.
import { describe, expect, it } from 'vitest';
import type { UnassignedPersonRow } from './repos/records.js';
import { OWNER_UNAVAILABLE, type UnassignedIssue } from './types.js';
import { documentedView, issueView, namedMembers, unassignedReport, unassignedSentence } from './views.js';

const BLAKE = '01900000-0000-7000-8000-0000000000b1';
const issue = (reason: UnassignedIssue['reason'], userId = BLAKE): UnassignedIssue => ({ code: OWNER_UNAVAILABLE, severity: 'info', reason, userId });
const names = new Map([[BLAKE, 'Blake Chen']]);
const row = (n: number, still: boolean, reason: UnassignedIssue['reason'] = 'suspended', userId = BLAKE): UnassignedPersonRow => ({
  record_id: `r${n}`,
  source_ref: `fub:people/${n}`,
  contact_id: `01900000-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`,
  issue: issue(reason, userId),
  display_name: `Person ${n}`,
  still_unassigned: still,
});

describe('E230 the reason a planned assignment came in unassigned, in plain words', () => {
  it('E230 names the member and says why, for each reason the engine refuses a target (TARGET_NOT_ELIGIBLE)', () => {
    expect(unassignedSentence(issue('suspended'), names)).toBe("Brought in unassigned: Blake Chen's account is suspended.");
    expect(unassignedSentence(issue('inactive'), names)).toBe('Brought in unassigned: Blake Chen is no longer an active member of the team.');
    expect(unassignedSentence(issue('role'), names)).toBe("Brought in unassigned: Blake Chen's role can't hold leads.");
    expect(unassignedSentence(issue('unavailable'), names)).toBe("Brought in unassigned: Blake Chen couldn't take leads when the owners were imported.");
    // a member whose name cannot be found is described, never left blank
    expect(unassignedSentence(issue('suspended'), new Map())).toBe('Brought in unassigned: the account of the member they were matched to is suspended.');
  });

  it('E230 the review list shows it through issueView; anything malformed falls back to the plain generic sentence, never a stored name', () => {
    expect(issueView(issue('suspended'), names).sentence).toBe("Brought in unassigned: Blake Chen's account is suspended.");
    expect(issueView({ code: OWNER_UNAVAILABLE, severity: 'info' }, names).sentence).toBe("Brought in unassigned: the member they were matched to can't hold leads now.");
    expect(issueView({ code: OWNER_UNAVAILABLE, severity: 'info', reason: 'hacked', userId: BLAKE } as never, names).sentence).toBe("Brought in unassigned: the member they were matched to can't hold leads now.");
    expect(namedMembers([{ issues: [issue('suspended'), { code: 'COMMIT_FAILED' }] }, { issues: [issue('role')] }])).toEqual([BLAKE]);
  });

  it('E230 the verification says what the commit documented (and nothing when it documented nothing)', () => {
    expect(documentedView({ unassigned: 0 })).toEqual([]);
    expect(documentedView({ unassigned: 1 })).toEqual([{ code: OWNER_UNAVAILABLE, count: 1, sentence: "1 planned assignment came in unassigned because the member it was matched to can't hold leads now (each record says why). It is counted as not imported." }]);
    expect(documentedView({ unassigned: 1204 })[0]!.sentence).toMatch(/^1,204 planned assignments came in unassigned because the member they were matched to/);
  });
});

describe('E231 the report lists the people brought in unassigned and offers "Assign these people"', () => {
  it('E231 groups the reasons per member, counts who still has no owner, and selects exactly those for the bulk Assign', () => {
    const r = unassignedReport([row(1, true), row(2, false), row(3, true, 'role', 'u2')], names)!;
    expect(r.lines).toEqual([
      "2 people came in unassigned because Blake Chen's account is suspended.",
      "1 person came in unassigned because the role of the member they were matched to can't hold leads.",
      'Nothing was assigned to them, and the import started no offer, timer or routing.',
      '2 people still have no owner: use "Assign these people" to give them one.',
    ]);
    expect(r.view.contactIds).toEqual([row(1, true).contact_id, row(3, true).contact_id]);
    expect([r.view.total, r.view.stillUnassigned]).toEqual([3, 2]);
    expect(unassignedReport([row(1, true)], names)!.lines.at(-1)).toBe('1 person still has no owner: use "Assign this person" to give them one.');
    expect(unassignedReport([row(1, false)], names)!.lines.at(-1)).toBe('That person has an owner now.');
    expect(unassignedReport([row(1, false), row(2, false), row(3, false)], names)!.lines.at(-1)).toBe('All of them have an owner now.');
    expect(unassignedReport([], names)).toBeNull();
  });

  it('E231 lists the first 50 by name, but selects up to the bulk Assign cap (2,000) of those still unassigned', () => {
    const rows = Array.from({ length: 2_100 }, (_, i) => row(i + 1, true));
    const r = unassignedReport(rows, names)!;
    expect([r.view.total, r.view.stillUnassigned, r.view.people.length, r.view.contactIds.length]).toEqual([2_100, 2_100, 50, 2_000]);
    expect(r.lines[0]).toBe("2,100 people came in unassigned because Blake Chen's account is suspended.");
  });
});
