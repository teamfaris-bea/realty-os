// The ONE arrival instant of an inbound inquiry (b19 team-queue lane, review fix M3; DATA_MODEL R-TEAMQ-19).
//
// An inquiry carries two times:
//   claimedAt   lead_inquiries.received_at   the time its SOURCE says the person asked. Intake keeps a claim up to 5
//                                            minutes ahead of the team's clock and up to 7 days behind it.
//   reachedAt   lead_inquiries.created_at    the moment the inquiry reached the team: the first moment anybody on the
//                                            team could see it, and so could respond to it.
// "Arrival" is ONE instant, used by everything that counts from it: when the minute-three backup alert is due, "has a
// person tried since the arrival" (the job, the team work queue, the response report), the queue's wait, and the
// report's response times and periods. It is the LATER of the two times, where a claim can never be later than the
// reach:
//   - a claim BEFORE the reach (the source delivered late, or back-dated the inquiry): the later is the reach. A text
//     sent before the lead reached the team is not a response to it, and the team's three minutes start when it has it;
//   - a claim AFTER the reach (the source's clock runs ahead): a lead cannot arrive after the team already has it, so
//     the claim is not a later time at all and reads as the reach. A text one second after the lead reached the team
//     is a response to it. (Main already reads a future claim this way: intake dates the consent it records at
//     min(claimed, now).)
// So the arrival always equals the reach, and the claim is kept on the row as what the source said. The SQL twin is
// ARRIVAL in apps/api accountability/repos/teamQueue.ts; apps/api leads/arrival.test.ts holds the two to each other.
import { type Instant, maxInstant, minInstant } from '../foundation/index.js';

/**
 * The arrival of an inquiry: the later of the time its source claims (`claimedAt`) and the moment it reached the
 * team (`reachedAt`), a claim ahead of the reach counting as the reach. Never before the reach and never after it.
 */
export function arrivalInstant(claimedAt: Instant, reachedAt: Instant): Instant {
  // a lead cannot arrive after the team already has it: a claim ahead of the reach is the reach
  const claim = minInstant(claimedAt, reachedAt);
  return maxInstant(claim, reachedAt);
}
