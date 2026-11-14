// b18 review F2 (owner product boundary 2026-11-14: agent contact attempts are not connected conversations; batch 18
// item g, E724). A human touch is an ATTEMPT (R-OWN-14: a dialed call, answered or not, or a text or email the gate let
// through, even one whose send later fails), so no surface that a touch closes or decides may say the person was
// reached: the AI care handoff's close, the confirmation the guard holds back after a person's attempt, the
// scoreboard's Speed to lead tile and the Routing page's first-contact hint. The panel's and the feed card's "Done" line
// for a deadline a touch met says so too (b18 review F2 remainder), and the two surfaces' sources are scanned for any
// phrase that claims a connection, so a line written straight into the markup is caught as well.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIMER_FIELDS } from '../admin/RoutingPage.js';
import { scoreboardLines } from '../team/lib.js';
import { CLOSED_REASON_WORDS, CONFIRMATION_NOT_SENT_SHORT, CONFIRMATION_NOT_SENT_WORDS, handoffDoneWords } from './words.js';

/** words that claim a connection was made, which a touch never proves ("Done: Jane was reached at …" included) */
const CLAIMS_CONTACT = /reached them|reached the|(?:was|were) reached|connected with|spoke (?:to|with)|talked (?:to|with)/i;
const here = dirname(fileURLToPath(import.meta.url));

describe('E724 (b18 review F2): what a human touch closes or decides is worded as an attempt', () => {
  it('E724 R-ISA-30 (b18 review F2): a handoff closed by a touch says someone called, texted or emailed them in time, an attempt answered or not, never that they were reached', () => {
    expect(CLOSED_REASON_WORDS.deadline_met).toBe('Closed: someone on the team called, texted or emailed them in time (an attempt, answered or not).');
    for (const w of Object.values(CLOSED_REASON_WORDS)) expect(w).not.toMatch(CLAIMS_CONTACT);
  });

  it('E724 R-ISA-14 E533 (b18 review F2): the AI confirmation held back after a person\'s attempt says it was an attempt, in the panel and on the feed line', () => {
    expect(CONFIRMATION_NOT_SENT_WORDS.not_needed).toBe('AI confirmation not sent: someone on the team called, texted or emailed them first (an attempt, answered or not).');
    expect(CONFIRMATION_NOT_SENT_SHORT.not_needed).toBe('not sent: the team called, texted or emailed them first');
    for (const w of [...Object.values(CONFIRMATION_NOT_SENT_WORDS), ...Object.values(CONFIRMATION_NOT_SENT_SHORT)]) expect(w).not.toMatch(CLAIMS_CONTACT);
  });

  it('E724 R-ACC-4 (b18 review F2): Speed to lead names a first attempt, and the first-contact hint counts call attempts, answered or not', () => {
    const lines = scoreboardLines({ userId: 'u', name: 'Ava Agent', speedToLead: { medianSeconds: 240, withinSla: 12, total: 14, responded: 13, pending: 1 }, touches: { count: 34, calls: 20, textsAndEmails: 14, days: 7 }, appointmentsSet: { count: 1, days: 7 }, appointmentsHeld: { count: 3, of: 5 }, agreementsSigned: { count: 1, days: 7 } });
    expect(lines[0]!.label).toBe('Speed to lead (first attempt)');
    expect(lines[0]!.text).toBe('12 of 14 within the first-touch window');
    const hint = TIMER_FIELDS.find((f) => f.key === 'firstTouchSlaSeconds')!.hint!;
    expect(hint).toBe('Counts call attempts (answered or not), texts, emails and chat replies a person sends. The assistant’s instant reply does not count.');
    for (const l of lines) expect(`${l.label} ${l.text} ${l.detail ?? ''}`).not.toMatch(CLAIMS_CONTACT);
  });

  it('E724 R-ISA-30 (b18 review F2): the panel\'s and the feed card\'s "Done" line for a deadline a touch met says someone on the team called, texted or emailed them, an attempt, never that they were reached; neither surface\'s source claims a connection', () => {
    expect(handoffDoneWords('Jane', '3:05 PM')).toBe('Done: someone on the team called, texted or emailed Jane at 3:05 PM (an attempt, answered or not).');
    expect(handoffDoneWords('Jane', '3:05 PM')).not.toMatch(CLAIMS_CONTACT);
    for (const f of ['Person.tsx', 'Feed.tsx']) expect(readFileSync(resolve(here, f), 'utf8'), f).not.toMatch(CLAIMS_CONTACT);
  });

  it('E724 R-ISA-14 OQ-B18-G3 (b18 review): the owner question about an attempt that did not connect is recorded in the PLAN Needed table with the built default and the alternative', () => {
    const plan = readFileSync(resolve(here, '../../../../../docs/PHASE2_3_PLAN.md'), 'utf8');
    const row = plan.split('\n').find((l) => l.startsWith('| OQ-B18-G3 '));
    expect(row, 'OQ-B18-G3 row').toBeDefined();
    expect(row).toMatch(/unanswered (?:dial|call)/);
    expect(row).toMatch(/failed (?:human )?text/);
    expect(row).toMatch(/closes the AI care handoff/);
    expect(row).toMatch(/holds back the AI appointment confirmation/);
    expect(row).toMatch(/Default: as built/);
    expect(row).toMatch(/Alternative:.*keeps the confirmation.*confirm (?:it )?by hand/);
  });
});
