// The call review rubric (PHASE2_3_PLAN module 35; R-COACH-2, R-COACH-6).
//
// Every item is an observable thing the agent did or did not do on a call with a lead, so a
// transcript quote can show it. R-COACH-6: no voice-tone, sentiment, personality or "energy"
// items, and no weights (items are never summed into an overall score).
//
// Keys are stable: they are stored in call_scores.items and tenant_settings.coaching_rubric_disabled.
// Changing what an item means requires a new rubric version (rubric/2), never an edit in place.
import { RUBRIC_VERSION_RE, type Rubric, type RubricItem, type RubricVersion } from './types.js';

export const RUBRIC_V1: Rubric = Object.freeze({
  version: 'rubric/1',
  items: Object.freeze([
    {
      key: 'introduced_self',
      label: 'Introduced self and brokerage',
      good: 'Said their name and the brokerage name near the start of the call.',
      tip: 'Open with your name and the brokerage before anything else.',
    },
    {
      key: 'asked_timeline',
      label: 'Asked about timeline',
      good: 'Asked when the lead hopes to buy, sell or move.',
      tip: 'Ask "When would you ideally like to be moved in?"',
    },
    {
      key: 'asked_financing',
      label: 'Asked about financing',
      good: 'Asked whether the lead has talked to a lender or how they plan to pay.',
      tip: 'Ask "Have you had a chance to talk with a lender yet?"',
    },
    {
      key: 'asked_motivation',
      label: 'Asked what is prompting the move',
      good: 'Asked what is behind the move, in the lead\'s own words.',
      tip: 'Ask "What has you thinking about a move right now?"',
    },
    {
      key: 'confirmed_contact_preference',
      label: 'Confirmed how to stay in touch',
      good: 'Asked whether the lead prefers a call, text or email, and when.',
      tip: 'Before you hang up, ask "Is text or a call better for you?"',
    },
    {
      key: 'proposed_next_step',
      label: 'Proposed a specific next step',
      good: 'Suggested a concrete next step with a day and time.',
      tip: 'Offer two options: "Would Tuesday at 5 or Wednesday at 6 work?"',
    },
    {
      key: 'set_follow_up',
      label: 'Set an appointment or follow-up',
      good: 'Ended with an agreed appointment or follow-up time.',
      tip: 'Confirm the day and time out loud and say you will send a reminder.',
    },
    {
      key: 'recapped_call',
      label: 'Recapped the call',
      good: 'Summarised what was agreed before ending the call.',
      tip: 'Close with "So to recap..." and repeat the next step.',
    },
  ] satisfies RubricItem[]),
});

/** Throws unless `rubric` has a valid version and unique, non-empty keys. */
export function assertRubric(rubric: Rubric): void {
  if (!RUBRIC_VERSION_RE.test(rubric.version)) throw new RangeError(`coaching: bad rubric version ${rubric.version}`);
  const seen = new Set<string>();
  for (const it of rubric.items) {
    if (!/^[a-z][a-z0-9_]*$/.test(it.key)) throw new RangeError(`coaching: bad rubric item key ${it.key}`);
    if (seen.has(it.key)) throw new RangeError(`coaching: duplicate rubric item key ${it.key}`);
    seen.add(it.key);
  }
}

/** Validates a stored rubric_version string. */
export function isRubricVersion(s: string): s is RubricVersion {
  return RUBRIC_VERSION_RE.test(s);
}
