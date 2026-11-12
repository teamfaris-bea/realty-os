// Shapes of api/coaching responses (apps/api/src/coaching/schemas.ts). Types only: the web app never imports
// API code. R-COACH-6: no score, grade or rank field exists to show.
export interface QuoteView {
  callId: string;
  recordingId: string | null;
  startMs: number;
  endMs: number;
  snippet: string | null;
  callLabel: string;
}

export interface FixView {
  itemKey: string;
  label: string;
  tip: string;
  why: string;
  quotes: QuoteView[];
}

export type CoachingState = 'not_cleared' | 'scoring_off' | 'ready';

export interface TodayView {
  state: CoachingState;
  date: string;
  fix: (FixView & { date: string }) | null;
  noFix: { reason: 'not_enough_calls' | 'nothing_missed' | 'all_dismissed' | 'dismissed_today'; text: string } | null;
  cardId: string | null;
}

export interface TeamView {
  state: CoachingState;
  visible: boolean;
  sentence: string;
  members: { userId: string; name: string; fix: FixView | null; noFix: { reason: string; text: string } | null }[];
}

export interface CoachingSettingsView {
  pack: { cleared: boolean; version: string | null; reviewedAt: string | null; sentence: string };
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  rubric: { key: string; label: string; good: string; enabled: boolean }[];
  scoringSentence: string;
}
