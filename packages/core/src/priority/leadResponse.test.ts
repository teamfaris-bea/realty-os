// The lead response report's roll-up (b19 team-queue lane; DATA_MODEL R-TEAMQ-7..9, E827..E832): per inbound inquiry,
// the time from ARRIVAL to the first human attempt by anyone, rolled up by source with every denominator. Pure and
// table-tested.
import { describe, expect, it } from 'vitest';
import { at, businessCalendar, type LeadSourceId } from '../foundation/index.js';
import {
  RESPONSE_MEDIAN_MIN_SAMPLE,
  RESPONSE_NOT_WITHIN_CAP,
  RESPONSE_P90_MIN_SAMPLE,
  RESPONSE_WITHIN_SECONDS,
  type ResponseInquiryFacts,
  measureInquiry,
  rollUpResponses,
} from './index.js';
import { NOW, NY, contact, hours, inquiry, min, t, user } from './testing/fixtures.js';

const CAL = businessCalendar({ zone: NY, open: '08:00', close: '21:00' });
const WEB = 'b0000000-0000-7000-8000-000000000001' as LeadSourceId;
const SIGN = 'b0000000-0000-7000-8000-000000000002' as LeadSourceId;

let n = 0;
const inq = (o: Partial<ResponseInquiryFacts> = {}): ResponseInquiryFacts => {
  n += 1;
  return { inquiryId: inquiry(n), contactId: contact(n), sourceId: WEB, sourceName: 'Website form', arrivedAt: t(-hours(2)), firstAttempt: null, automatedReplyAt: null, ...o };
};
const tried = (afterSeconds: number, o: Partial<ResponseInquiryFacts> = {}, who: Partial<NonNullable<ResponseInquiryFacts['firstAttempt']>> = {}): ResponseInquiryFacts => {
  const arrivedAt = o.arrivedAt ?? t(-hours(2));
  return inq({ ...o, arrivedAt, firstAttempt: { at: (arrivedAt + afterSeconds * 1000) as never, kind: 'call', byUserId: user(1), role: 'owner', ...who } });
};

describe('the rules of the measure', () => {
  it('R-TEAMQ-8: the thresholds are 5 and 15 minutes; a median needs 5 attempts and a 90th percentile 10', () => {
    expect([...RESPONSE_WITHIN_SECONDS]).toEqual([300, 900]);
    expect([RESPONSE_MEDIAN_MIN_SAMPLE, RESPONSE_P90_MIN_SAMPLE]).toEqual([5, 10]);
  });
});

describe('R-TEAMQ-7 one inquiry, measured from arrival', () => {
  it('R-TEAMQ-7: the first human attempt gives wall-clock and staffed seconds from ARRIVAL; within 5 and within 15 minutes are staffed time, the boundary included', () => {
    const table: [number, boolean, boolean][] = [
      [0, true, true],
      [300, true, true],
      [301, false, true],
      [900, false, true],
      [901, false, false],
    ];
    for (const [seconds, within5, within15] of table) {
      const m = measureInquiry(tried(seconds), NOW, CAL);
      expect([m.attempt?.staffedSeconds, m.attempt?.wallSeconds, m.within5, m.within15, m.waiting]).toEqual([seconds, seconds, within5, within15, null]);
    }
  });

  it('R-TEAMQ-7 E827: an automated reply is reported apart and is never an attempt: the inquiry is still waiting', () => {
    const m = measureInquiry(inq({ arrivedAt: t(-min(30)), automatedReplyAt: t(-min(29)) }), NOW, CAL);
    expect(m.attempt).toBeNull();
    expect(m.waiting).toEqual({ wallSeconds: 1800, staffedSeconds: 1800 });
    expect([m.within5, m.within15, m.automatedReplyAt]).toEqual([false, false, t(-min(29))]);
  });

  it('R-TEAMQ-7 E829: an off-hours arrival is counted from opening and marked: a call three minutes after opening is within 5 minutes', () => {
    const night = at('2026-11-10T07:00:00Z'); // 02:00 New York; opens 08:00 (13:00Z)
    const m = measureInquiry(inq({ arrivedAt: night, firstAttempt: { at: at('2026-11-10T13:03:00Z'), kind: 'text', byUserId: user(1), role: 'owner' } }), NOW, CAL);
    expect([m.offHours, m.countedFrom, m.attempt?.staffedSeconds, m.attempt?.wallSeconds, m.within5]).toEqual([true, at('2026-11-10T13:00:00Z'), 180, 6 * 3600 + 180, true]);
    // a daytime arrival is counted from itself
    const day = measureInquiry(tried(60), NOW, CAL);
    expect([day.offHours, day.countedFrom]).toEqual([false, t(-hours(2))]);
  });

  it('R-TEAMQ-7 E828: the attempt keeps who made it and their role to the lead at that moment', () => {
    const m = measureInquiry(tried(120, {}, { byUserId: user(7), role: 'other', kind: 'email' }), NOW, CAL);
    expect(m.attempt).toMatchObject({ byUserId: user(7), role: 'other', kind: 'email' });
  });
});

describe('R-TEAMQ-8 the roll-up by source', () => {
  it('R-TEAMQ-8: every count carries its denominator: inquiries, with a human attempt, within 5 and 15 minutes, still waiting, automatic replies', () => {
    const r = rollUpResponses(
      [tried(60), tried(200), tried(400), tried(1000), inq(), inq({ automatedReplyAt: t(-hours(2) + min(1)) }), tried(30, { sourceId: SIGN, sourceName: 'Open house sign-in' })],
      NOW,
      CAL,
    );
    expect(r.sources.map((s) => [s.sourceName, s.inquiries, s.attempted, s.within5, s.within15, s.waiting, s.automatedReplies])).toEqual([
      ['Website form', 6, 4, 2, 3, 2, 1],
      ['Open house sign-in', 1, 1, 1, 1, 0, 0],
    ]);
    expect([r.totals.inquiries, r.totals.attempted, r.totals.within5, r.totals.within15, r.totals.waiting, r.totals.automatedReplies]).toEqual([7, 5, 3, 4, 2, 1]);
    for (const s of [...r.sources, r.totals]) expect(s.attempted + s.waiting).toBe(s.inquiries);
  });

  it('R-TEAMQ-8: the inquiries not within 5 minutes are listed under their source: the ones still waiting first (longest first), then the slowest', () => {
    const waitingLong = inq({ arrivedAt: t(-hours(5)) });
    const waitingShort = inq({ arrivedAt: t(-min(2)) });
    const slow = tried(1000);
    const slower = tried(4000);
    const r = rollUpResponses([tried(60), slow, waitingShort, slower, waitingLong], NOW, CAL);
    const s = r.sources[0]!;
    expect([s.inquiries, s.within5]).toEqual([5, 1]);
    expect(s.notWithin5.map((m) => m.inquiryId)).toEqual([waitingLong.inquiryId, waitingShort.inquiryId, slower.inquiryId, slow.inquiryId]);
    expect(s.notWithin5More).toBe(0);
  });

  it('R-TEAMQ-8: that list is capped and says how many more', () => {
    const many = Array.from({ length: RESPONSE_NOT_WITHIN_CAP + 3 }, () => inq());
    const s = rollUpResponses(many, NOW, CAL).sources[0]!;
    expect([s.notWithin5.length, s.notWithin5More]).toEqual([RESPONSE_NOT_WITHIN_CAP, 3]);
  });

  it('R-TEAMQ-8 E830: two inquiries from one person are two arrivals, each with its own first attempt after it', () => {
    const first = tried(120, { contactId: contact(900), arrivedAt: t(-min(100)) });
    const second = inq({ contactId: contact(900), arrivedAt: t(-min(10)) });
    const r = rollUpResponses([first, second], NOW, CAL);
    expect([r.totals.inquiries, r.totals.attempted, r.totals.within5, r.totals.waiting]).toEqual([2, 1, 1, 1]);
    expect(r.measured.map((m) => [m.inquiryId, m.attempt?.staffedSeconds ?? null, m.waiting?.wallSeconds ?? null])).toEqual(
      expect.arrayContaining([[first.inquiryId, 120, null], [second.inquiryId, null, 600]]),
    );
  });

  it('R-TEAMQ-8 E831: no percentile is shown on a small sample: a median needs 5 attempts, a 90th percentile 10; the sample size is always there', () => {
    const attempts = (k: number) => Array.from({ length: k }, (_, i) => tried((i + 1) * 60));
    const table: [number, number | null, number | null][] = [
      [0, null, null],
      [3, null, null],
      [4, null, null],
      [5, 180, null], // 60 120 180 240 300
      [9, 300, null],
      [10, 330, 540], // median of 1..10 minutes: (300 + 360) / 2; nearest-rank 90th: the 9th of 10
      [11, 360, 600],
    ];
    for (const [k, median, p90] of table) {
      const s = rollUpResponses([...attempts(k), inq()], NOW, CAL).totals;
      expect([s.sample, s.medianStaffedSeconds, s.p90StaffedSeconds]).toEqual([k, median, p90]);
    }
  });

  it('R-TEAMQ-8: percentiles are over staffed time of attempted inquiries only; a waiting inquiry is never a sample', () => {
    const night = at('2026-11-10T07:00:00Z');
    const offHours = Array.from({ length: 5 }, () => inq({ arrivedAt: night, firstAttempt: { at: at('2026-11-10T13:02:00Z'), kind: 'call', byUserId: user(1), role: 'owner' } }));
    const s = rollUpResponses([...offHours, inq(), inq()], NOW, CAL).totals;
    expect([s.sample, s.medianStaffedSeconds, s.within5, s.inquiries]).toEqual([5, 120, 5, 7]);
  });

  it('R-TEAMQ-8: sources are ordered by inquiries, then by name; a source with no name keeps its row; the order of the facts does not matter', () => {
    const facts = [inq({ sourceId: SIGN, sourceName: 'Open house sign-in' }), inq(), inq(), inq({ sourceId: 'b0000000-0000-7000-8000-000000000003' as LeadSourceId, sourceName: null })];
    const a = rollUpResponses(facts, NOW, CAL);
    const b = rollUpResponses([...facts].reverse(), NOW, CAL);
    expect(a.sources.map((s) => s.sourceName)).toEqual(['Website form', 'Open house sign-in', null]);
    expect(b.sources.map((s) => [s.sourceId, s.inquiries])).toEqual(a.sources.map((s) => [s.sourceId, s.inquiries]));
  });

  it('R-TEAMQ-8: no inquiries gives zeros and no percentile, never a division', () => {
    const r = rollUpResponses([], NOW, CAL);
    expect(r.sources).toEqual([]);
    expect(r.totals).toMatchObject({ inquiries: 0, attempted: 0, within5: 0, within15: 0, waiting: 0, sample: 0, medianStaffedSeconds: null, p90StaffedSeconds: null });
  });
});

describe('R-TEAMQ-18 the backup in the roll-up (b19 step 2)', () => {
  const alerted = (o: Partial<ResponseInquiryFacts> = {}) => ({ backupAlert: { at: t(-hours(2) + min(3)), byUserId: user(7), recipient: 'backup' as const }, ...o });

  it('R-TEAMQ-18 E858: "backup alerted" is counted over the inquiries, and "first attempt by the backup" over the inquiries whose backup was alerted', () => {
    const list = [
      tried(600, alerted(), { byUserId: user(7), role: 'backup' }), // alerted, and the backup made the first attempt
      tried(700, alerted(), { byUserId: user(1), role: 'owner' }), // alerted, but the owner got there first
      inq(alerted()), // alerted, still waiting
      tried(60), // nobody alerted: tried within a minute
      inq(), // not a covered source: waiting, no alert
    ];
    const r = rollUpResponses(list, NOW, CAL);
    expect(r.totals).toMatchObject({ inquiries: 5, attempted: 3, waiting: 2, backupAlerted: 3, byBackup: 1 });
    expect(r.sources[0]).toMatchObject({ inquiries: 5, backupAlerted: 3, byBackup: 1 });
    // each measured inquiry keeps its alert
    expect(r.measured.filter((m) => m.backupAlert !== null)).toHaveLength(3);
    expect(measureInquiry(list[0]!, NOW, CAL).backupAlert).toEqual({ at: t(-hours(2) + min(3)), byUserId: user(7), recipient: 'backup' });
    expect(measureInquiry(list[3]!, NOW, CAL).backupAlert).toBeNull();
  });

  it('R-TEAMQ-18: with no alert anywhere both counts are zero, never missing; a team lead alerted as the fallback counts as alerted and as the backup when they try', () => {
    expect(rollUpResponses([tried(60), inq()], NOW, CAL).totals).toMatchObject({ backupAlerted: 0, byBackup: 0 });
    const fallback = tried(500, { backupAlert: { at: t(-hours(2) + min(3)), byUserId: user(9), recipient: 'team_lead' } }, { byUserId: user(9), role: 'backup' });
    expect(rollUpResponses([fallback], NOW, CAL).totals).toMatchObject({ inquiries: 1, backupAlerted: 1, byBackup: 1 });
  });
});
