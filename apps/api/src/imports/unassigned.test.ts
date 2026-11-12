// Owner decision B4 (2026-11-11, E230, E231): the plain words for a planned assignment the ownership commit brought
// in unassigned, in the review list, the verification and the report. The owner decided it for a member suspended
// between the ownership approval and the commit; the implementation words every reason the engine can refuse the
// mapped member (TARGET_NOT_ELIGIBLE) the same way. Pure (no database): the journeys in migration.journeys.test.ts
// prove the suspended case end to end.
//
// Reviews B4-R1/F1 and B4-R2/F2: every sentence is true when it is read. A reason is said in the present only while
// the member's membership still shows it, and otherwise as it was when the owners were imported; a person is said to
// have an owner only while they are owned, and anyone closed, deleted, merged away, in a pond or on offer is said so.
import { describe, expect, it } from 'vitest';
import type { UnassignedPersonRow } from './repos/records.js';
import { OWNER_UNAVAILABLE, type UnassignedIssue, type UnassignedNow } from './types.js';
import { type MemberNames, askedAgainSentence, documentedView, issueView, namedMembers, unassignedReport, unassignedSentence } from './views.js';

const BLAKE = '01900000-0000-7000-8000-0000000000b1';
const issue = (reason: UnassignedIssue['reason'], userId = BLAKE): UnassignedIssue => ({ code: OWNER_UNAVAILABLE, severity: 'info', reason, userId });
/** Blake Chen's membership as the page reads it now */
const blake = (status = 'suspended', role = 'agent'): MemberNames => new Map([[BLAKE, { name: 'Blake Chen', status, role }]]);
const names = blake();
const row = (n: number, now: UnassignedNow = 'unassigned', reason: UnassignedIssue['reason'] = 'suspended', userId = BLAKE): UnassignedPersonRow => ({
  record_id: `r${n}`,
  source_ref: `fub:people/${n}`,
  contact_id: `01900000-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`,
  issue: issue(reason, userId),
  display_name: `Person ${n}`,
  now,
  merged_into_contact_id: null,
  asked_again_at: null,
  asked_again_next: null,
  asked_again_offered_to: null,
  asked_again_pond: null,
});

describe('E230 the reason a planned assignment came in unassigned, in plain words', () => {
  it('E230 names the member and says why, in the present while their membership still shows it, for each reason the engine refuses a target (TARGET_NOT_ELIGIBLE)', () => {
    expect(unassignedSentence(issue('suspended'), names)).toBe("Brought in unassigned: Blake Chen's account is suspended.");
    expect(unassignedSentence(issue('inactive'), blake('deactivating'))).toBe('Brought in unassigned: Blake Chen is no longer an active member of the team.');
    expect(unassignedSentence(issue('role'), blake('active', 'tc'))).toBe("Brought in unassigned: Blake Chen's role can't hold leads.");
    expect(unassignedSentence(issue('unavailable'), blake('active'))).toBe("Brought in unassigned: Blake Chen couldn't take leads when the owners were imported.");
    // a member whose name cannot be found is described, never left blank
    expect(unassignedSentence(issue('suspended'), new Map([[BLAKE, { name: ' ', status: 'suspended', role: 'agent' }]]))).toBe('Brought in unassigned: the account of the member they were matched to is suspended.');
  });

  // Review B4-R2/F2: the reason was read at the commit but always said in the present, so a member reactivated since
  // was still "suspended" in the review list, the report and the verification.
  it('E230 once the reason no longer holds, or the membership cannot be read, it is said as it was when the owners were imported, never as now (review B4-R2, F2)', () => {
    expect(unassignedSentence(issue('suspended'), blake('active'))).toBe("Brought in unassigned: Blake Chen's account was suspended when the owners were imported.");
    expect(unassignedSentence(issue('suspended'), blake('removed'))).toBe("Brought in unassigned: Blake Chen's account was suspended when the owners were imported.");
    expect(unassignedSentence(issue('inactive'), blake('active'))).toBe('Brought in unassigned: Blake Chen was no longer an active member of the team when the owners were imported.');
    expect(unassignedSentence(issue('role'), blake('active', 'agent'))).toBe("Brought in unassigned: Blake Chen's role couldn't hold leads when the owners were imported.");
    expect(unassignedSentence(issue('role'), new Map([[BLAKE, { name: '', status: 'active', role: 'agent' }]]))).toBe("Brought in unassigned: the role of the member they were matched to couldn't hold leads when the owners were imported.");
    // nothing read now (no such member): never a claim about now
    expect(unassignedSentence(issue('suspended'), new Map())).toBe('Brought in unassigned: the account of the member they were matched to was suspended when the owners were imported.');
    expect(unassignedSentence(issue('inactive'), new Map())).toBe('Brought in unassigned: the member they were matched to was no longer an active member of the team when the owners were imported.');
    // the report says it the same way
    expect(unassignedReport([row(1), row(2)], blake('active'))!.lines[0]).toBe("2 people came in unassigned because Blake Chen's account was suspended when the owners were imported.");
  });

  it('E230 the review list shows it through issueView; anything malformed falls back to the plain generic sentence, never a stored name', () => {
    expect(issueView(issue('suspended'), names).sentence).toBe("Brought in unassigned: Blake Chen's account is suspended.");
    expect(issueView({ code: OWNER_UNAVAILABLE, severity: 'info' }, names).sentence).toBe("Brought in unassigned: the member they were matched to couldn't hold leads when the owners were imported.");
    expect(issueView({ code: OWNER_UNAVAILABLE, severity: 'info', reason: 'hacked', userId: BLAKE } as never, names).sentence).toBe("Brought in unassigned: the member they were matched to couldn't hold leads when the owners were imported.");
    expect(namedMembers([{ issues: [issue('suspended'), { code: 'COMMIT_FAILED' }] }, { issues: [issue('role')] }])).toEqual([BLAKE]);
  });

  it('E230 the verification says what the commit documented, as it was at the commit (and nothing when it documented nothing)', () => {
    expect(documentedView({ unassigned: 0 })).toEqual([]);
    expect(documentedView({ unassigned: 1 })).toEqual([{ code: OWNER_UNAVAILABLE, count: 1, sentence: "1 planned assignment came in unassigned because the member it was matched to couldn't hold leads when the owners were imported (each record says why). It is counted as not imported." }]);
    expect(documentedView({ unassigned: 1204 })[0]!.sentence).toMatch(/^1,204 planned assignments came in unassigned because the member they were matched to couldn't hold leads when the owners were imported/);
  });
});

describe('E231 the report lists the people brought in unassigned and offers "Assign these people"', () => {
  it('E231 groups the reasons per member, says where they are now, and selects exactly those still unassigned for the bulk Assign', () => {
    const r = unassignedReport([row(1), row(2, 'owned'), row(3, 'unassigned', 'role', 'u2')], names)!;
    expect(r.lines).toEqual([
      "2 people came in unassigned because Blake Chen's account is suspended.",
      "1 person came in unassigned because the role of the member they were matched to couldn't hold leads when the owners were imported.",
      'Nothing was assigned to them, and the import started no offer, timer or routing.',
      'After the import, 1 was given an owner.',
      '2 people are still unassigned: use "Assign these people" to give them an owner.',
    ]);
    expect(r.view.summary).toEqual(r.lines.slice(3));
    expect(r.view.contactIds).toEqual([row(1).contact_id, row(3).contact_id]);
    expect([r.view.total, r.view.stillUnassigned]).toEqual([3, 2]);
    expect(unassignedReport([row(1)], names)!.lines.at(-1)).toBe('1 person is still unassigned: use "Assign this person" to give them an owner.');
    expect(unassignedReport([row(1, 'owned')], names)!.lines.at(-1)).toBe('That person has an owner now.');
    expect(unassignedReport([row(1, 'owned'), row(2, 'owned')], names)!.lines.at(-1)).toBe('Both of them have an owner now.');
    expect(unassignedReport([row(1, 'owned'), row(2, 'owned'), row(3, 'owned')], names)!.lines.at(-1)).toBe('All of them have an owner now.');
    expect(unassignedReport([], names)).toBeNull();
  });

  // Review B4-R1/F1: anyone not still unassigned was said to "have an owner now", including people closed, deleted,
  // merged away or put in a pond, none of whom has an owner.
  it('E231 a person closed, deleted, merged away, in a pond or on offer since is said so; "has an owner" only of someone owned (review B4-R1, F1)', () => {
    const states: UnassignedNow[] = ['closed', 'deleted', 'merged', 'in_pond', 'offered', 'owned', 'unassigned'];
    const r = unassignedReport(states.map((s, i) => row(i + 1, s)), names)!;
    expect(r.view.people.map((p) => [p.now, p.nowSentence, p.stillUnassigned])).toEqual([
      ['closed', 'Closed after the import.', false],
      ['deleted', 'Deleted after the import.', false],
      ['merged', 'Merged into another contact after the import.', false],
      ['in_pond', 'In a pond now, with no owner.', false],
      ['offered', 'On offer to an agent now, with no owner yet.', false],
      ['owned', 'Has an owner now.', false],
      ['unassigned', null, true],
    ]);
    expect(r.view.summary).toEqual([
      'After the import, 1 was given an owner, 1 was put in a pond, 1 was offered to an agent, 1 was closed, 1 was deleted and 1 was merged into another contact.',
      '1 person is still unassigned: use "Assign this person" to give them an owner.',
    ]);
    expect([r.view.stillUnassigned, r.view.contactIds]).toEqual([1, [row(7).contact_id]]);
    // nobody is unassigned any more, and nobody has an owner either
    const gone = unassignedReport([row(1, 'closed'), row(2, 'deleted')], names)!;
    expect(gone.lines.at(-1)).toBe('After the import, 1 was closed and 1 was deleted.');
    expect(gone.lines.join(' ')).not.toMatch(/an owner now/);
    expect([gone.view.stillUnassigned, gone.view.contactIds]).toEqual([0, []]);
    // the words agree with each count
    expect(unassignedReport([row(1, 'merged'), row(2, 'merged'), row(3, 'in_pond'), row(4, 'in_pond'), row(5, 'offered'), row(6, 'offered')], names)!.view.summary).toEqual([
      'After the import, 2 were put in a pond, 2 were each offered to an agent and 2 were each merged into another contact.',
    ]);
  });

  // Batch 6 review ownership-sla/F3: people who left the import's creation state before the owners were imported come in
  // unassigned too, said as what happened to them; two records a merge joined are one person.
  it('E230 E231 a person merged, or changed by someone, after the contacts were imported comes in unassigned with that reason; one line per person; the verification says each kind once (review F3)', () => {
    const person = (n: number, code: 'PERSON_MERGED' | 'PERSON_CHANGED', now: UnassignedNow = 'unassigned', contact = n): UnassignedPersonRow => ({
      ...row(n, now),
      contact_id: row(contact).contact_id,
      issue: { code, severity: 'info' },
    });
    const r = unassignedReport([row(1), person(2, 'PERSON_MERGED'), person(3, 'PERSON_MERGED', 'unassigned', 2), person(4, 'PERSON_CHANGED', 'closed')], names)!;
    expect(r.lines).toEqual([
      "1 person came in unassigned because Blake Chen's account is suspended.",
      '1 person came in unassigned because they were merged with another person after the contacts were imported.',
      '1 person came in unassigned because someone changed who holds them after the contacts were imported.',
      'Nothing was assigned to them, and the import started no offer, timer or routing.',
      'After the import, 1 was closed.',
      '2 people are still unassigned: use "Assign these people" to give them an owner.',
    ]);
    expect(r.view.people.map((p) => [p.contactId, p.sentence])).toEqual([
      [row(1).contact_id, "Brought in unassigned: Blake Chen's account is suspended."],
      [row(2).contact_id, 'Brought in unassigned: they were merged with another person after the contacts were imported.'],
      [row(4).contact_id, 'Brought in unassigned: someone changed who holds them after the contacts were imported.'],
    ]);
    expect([r.view.total, r.view.stillUnassigned, r.view.contactIds]).toEqual([3, 2, [row(1).contact_id, row(2).contact_id]]);
    expect(issueView({ code: 'PERSON_MERGED', severity: 'info' }).sentence).toBe('Brought in unassigned: they were merged with another person after the contacts were imported.');
    expect(issueView({ code: 'OWNER_KEPT', severity: 'info' }).sentence).toBe("This person was already here, or someone gave them an owner after the contacts were imported, so the import doesn't change who owns them.");
    expect(documentedView({ unassigned: 3, kept: 1 }, { person: 2 })).toEqual([
      { code: OWNER_UNAVAILABLE, count: 1, sentence: "1 planned assignment came in unassigned because the member it was matched to couldn't hold leads when the owners were imported (each record says why). It is counted as not imported." },
      { code: 'PERSON_CHANGED', count: 2, sentence: '2 planned assignments came in unassigned because the person was merged with another person, or someone changed who holds them, after the contacts were imported (each record says which). They are counted as not imported.' },
      { code: 'OWNER_KEPT', count: 1, sentence: '1 planned assignment was not made because someone gave the person an owner after the contacts were imported (the record says so). It is counted as already here.' },
    ]);
  });

  it('E231 lists the first 50 by name, but selects up to the bulk Assign cap (2,000) of those still unassigned', () => {
    const rows = Array.from({ length: 2_100 }, (_, i) => row(i + 1));
    const r = unassignedReport(rows, names)!;
    expect([r.view.total, r.view.stillUnassigned, r.view.people.length, r.view.contactIds.length]).toEqual([2_100, 2_100, 50, 2_000]);
    expect(r.lines[0]).toBe("2,100 people came in unassigned because Blake Chen's account is suspended.");
    expect(r.lines.at(-1)).toBe('2,100 people are still unassigned: use "Assign these people" to give them an owner.');
  });
});

// Owner decision D8 (2026-11-12; batch 6 review ownership-sla/F4): a person brought in unassigned who asks again is
// routed like a returning lead. The report says when (the team's time) and where the routing took them, from their own
// ledger; "Assign these people" selects only those still unassigned. The journeys prove it end to end.
describe('E341 a person brought in unassigned who asked again since (owner decision D8)', () => {
  const AVERY = '01900000-0000-7000-8000-0000000000a1';
  const who: MemberNames = new Map([...blake(), [AVERY, { name: 'Avery Stone', status: 'active', role: 'agent' }]]);
  const at = new Date('2026-11-12T15:04:00Z');
  const asked = (n: number, now: UnassignedNow, next: string | null, o: Partial<UnassignedPersonRow> = {}): UnassignedPersonRow => ({ ...row(n, now), asked_again_at: at, asked_again_next: next, ...o });

  it('E341 says when they asked again in the team\'s time and to whom the routing offered them, or the pond; one line counts them; only those still unassigned stay selected', () => {
    const rows = [row(1), asked(2, 'offered', 'offered', { asked_again_offered_to: AVERY }), asked(3, 'in_pond', 'sent_to_pond', { asked_again_pond: 'Team Pond' }), asked(4, 'unassigned', null), asked(5, 'owned', 'assigned')];
    const r = unassignedReport(rows, who, 'America/New_York')!;
    expect(r.view.people.map((p) => [p.now, p.askedAgainSentence])).toEqual([
      ['unassigned', null],
      ['offered', 'Asked again on Nov 12, 2026, 10:04 AM EST and was offered to Avery Stone.'],
      ['in_pond', 'Asked again on Nov 12, 2026, 10:04 AM EST and was put in Team Pond.'],
      // the routing is due and has not run yet (the follow-up runs it)
      ['unassigned', 'Asked again on Nov 12, 2026, 10:04 AM EST and is waiting to be routed.'],
      // someone acted on them before any routing: the line about now says where they are
      ['owned', 'Asked again on Nov 12, 2026, 10:04 AM EST.'],
    ]);
    // after what the import itself did, counting those the routing took somewhere (not the one still waiting, nor the one
    // someone acted on first); where they are now is said once, by the people card (review F8)
    expect(r.lines.slice(1)).toEqual([
      'Nothing was assigned to them, and the import started no offer, timer or routing.',
      '2 of them asked again since they were imported and were routed by your routing rules.',
      ...r.view.summary,
    ]);
    expect(r.view.contactIds).toEqual([row(1).contact_id, row(4).contact_id]);
    expect(unassignedReport([asked(6, 'offered', 'offered', { asked_again_offered_to: AVERY })], who, 'America/New_York')!.lines).toContain('1 of them asked again since they were imported and was routed by your routing rules.');
  });

  it('E341 never leaves a blank or a guess: an unreadable name is "an agent", a pond without a name is "a pond", a zone the runtime cannot read is said in UTC; nobody asked again, nothing is said', () => {
    expect(askedAgainSentence(asked(7, 'offered', 'offered', { asked_again_offered_to: '01900000-0000-7000-8000-0000000000ff' }), who, 'UTC')).toBe('Asked again on Nov 12, 2026, 3:04 PM UTC and was offered to an agent.');
    expect(askedAgainSentence(asked(8, 'in_pond', 'sent_to_pond'), who, 'Not/AZone')).toBe('Asked again on Nov 12, 2026, 3:04 PM UTC and was put in a pond.');
    expect(askedAgainSentence(row(9), who, 'America/New_York')).toBeNull();
    expect(unassignedReport([row(10)], who)!.lines.join(' ')).not.toMatch(/asked again/);
  });
});
