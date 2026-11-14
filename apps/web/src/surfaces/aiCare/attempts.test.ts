// b18 review F2 (owner product boundary 2026-11-14: agent contact attempts are not connected conversations; batch 18
// item g, E724). A human touch is an ATTEMPT (R-OWN-14: a dialed call, answered or not, or a text or email the gate let
// through, even one whose send later fails), so no surface that a touch closes or decides may say the person was
// reached: the AI care handoff's close, the confirmation the guard holds back after a person's attempt, the
// scoreboard's Speed to lead tile and the Routing page's first-contact hint.
import { describe, expect, it } from 'vitest';
import { TIMER_FIELDS } from '../admin/RoutingPage.js';
import { scoreboardLines } from '../team/lib.js';
import { CLOSED_REASON_WORDS, CONFIRMATION_NOT_SENT_SHORT, CONFIRMATION_NOT_SENT_WORDS } from './words.js';

/** words that claim a connection was made, which a touch never proves */
const CLAIMS_CONTACT = /reached them|reached the|connected with|spoke (?:to|with)|talked (?:to|with)/i;

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
});
