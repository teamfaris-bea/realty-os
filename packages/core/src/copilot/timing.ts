// Timing cues from the timing-cue scan lane (CP-9): where today falls against the window the lead stated.
//
// A plan date that has passed is NOT a "call today" (the notes are often months old): it becomes a
// "still planning to move?" check-in. Excluded cues (already sold or listed, renting, not a plan) never
// drive a flag or a draft.
import { type Instant, type LocalDate, addLocalDays, localDateOf, zone } from '../foundation/index.js';
import type { CopilotTimingCue, TimingCueView, TimingStatus } from './types.js';

export function timingStatus(cue: CopilotTimingCue, now: Instant, teamZone: string, lookaheadDays = 90): TimingStatus {
  const z = zone(teamZone);
  const today: LocalDate = localDateOf(now, z);
  const soonLimit: LocalDate = localDateOf(addLocalDays(now, lookaheadDays, z), z);
  const { windowStart: s, windowEnd: e } = cue;
  if (s === null && e === null) return 'open_ended';
  if (e !== null && e < today) return 'passed';
  if (s === null || s <= today) return 'current';
  return s <= soonLimit ? 'soon' : 'upcoming';
}

/** The cues an agent should see, newest first; excluded cues are left out. */
export function timingViews(cues: readonly CopilotTimingCue[], now: Instant, teamZone: string): TimingCueView[] {
  return cues
    .filter((c) => c.excluded === undefined && c.statedAt <= now)
    .slice()
    .sort((a, b) => b.statedAt - a.statedAt)
    .map((c) => ({
      intent: c.intent,
      status: timingStatus(c, now, teamZone),
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      statedAt: c.statedAt,
      evidence: c.evidence.slice(0, 200),
      label: 'UNVERIFIED' as const,
    }));
}
