// The ONE arrival instant of an inbound inquiry (b19 team-queue lane, review fix M3; DATA_MODEL R-TEAMQ-19, E971 to
// E973). Every measure "from arrival" (the backup alert's due time, "a human attempt since the arrival", the queue's
// wait, the response report) reads this one function, or its SQL twin in apps/api accountability/repos/teamQueue.ts.
import { describe, expect, it } from 'vitest';
import { at, businessCalendar } from '../foundation/index.js';
import { arrivalInstant } from './arrival.js';
import { backupAlertDueAt } from './backupAlert.js';
import { measureFromArrival } from './teamQueue.js';

const CAL = businessCalendar({ zone: 'America/New_York', open: '08:00', close: '21:00' });
const reached = at('2026-11-10T10:00:00-05:00');

describe('R-TEAMQ-19 arrivalInstant: the later of the time the source claims and the moment the lead reached the team, a claim never later than the reach', () => {
  const table = [
    { name: 'E971 a claim in the FUTURE (the source\'s clock runs 4 minutes ahead): a lead cannot arrive after the team has it, so the arrival is the reach', claimed: at('2026-11-10T10:04:00-05:00'), want: reached },
    { name: 'E972 a claim in the PAST (delivered late, or back-dated by 19 hours): nobody could respond before it reached the team, so the arrival is the reach', claimed: at('2026-11-09T15:00:00-05:00'), want: reached },
    { name: 'E972 a claim one millisecond before the reach', claimed: at('2026-11-10T09:59:59.999-05:00'), want: reached },
    { name: 'E973 a claim EQUAL to the reach', claimed: reached, want: reached },
  ];
  for (const row of table) {
    it(`R-TEAMQ-19 ${row.name}`, () => {
      expect(arrivalInstant(row.claimed, reached)).toBe(row.want);
      // never before the reach (an earlier text is not a response to it) and never after it (a text one second later is)
      expect(arrivalInstant(row.claimed, reached)).toBeGreaterThanOrEqual(reached);
      expect(arrivalInstant(row.claimed, reached)).toBeLessThanOrEqual(reached + 0);
    });
  }

  it('R-TEAMQ-19 E970 E971 E972: an inquiry carries two times and ONE arrival: the backup alert is due three staffed minutes after THAT instant, and a wait is measured from it, whatever the source claims', () => {
    for (const row of table) {
      expect(backupAlertDueAt(row.claimed, reached, CAL)).toBe(at('2026-11-10T10:03:00-05:00'));
      const arrival = arrivalInstant(row.claimed, reached);
      // a text one second after the lead reached the team is one second after the arrival, in every row
      expect(measureFromArrival(arrival, at('2026-11-10T10:00:01-05:00'), CAL).wallSeconds).toBe(1);
    }
  });
});
