// Response and request schemas of api/coaching (module 36). R-COACH-6: no score, grade, rank, percentage,
// tone or sentiment field anywhere (snapshot test); R-AST-13: no confidence field; R-TEN-3: no tenant id.
import { RUBRIC_V1 } from '@realty/core/coaching';
import { z } from 'zod';

const RUBRIC_KEYS = RUBRIC_V1.items.map((i) => i.key) as [string, ...string[]];

export const QuoteSchema = z.object({
  callId: z.uuid(),
  recordingId: z.uuid().nullable(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  snippet: z.string().nullable(),
  callLabel: z.string(),
});

const FixBody = {
  itemKey: z.string(),
  label: z.string(),
  tip: z.string(),
  why: z.string(),
  quotes: z.array(QuoteSchema).max(2),
};

export const CoachingStateSchema = z.enum(['not_cleared', 'scoring_off', 'ready']);

export const TodayResponse = z.object({
  coaching: z.object({
    state: CoachingStateSchema,
    date: z.string(),
    fix: z.object({ date: z.string(), ...FixBody }).nullable(),
    noFix: z.object({ reason: z.enum(['not_enough_calls', 'nothing_missed', 'all_dismissed', 'dismissed_today']), text: z.string() }).nullable(),
    cardId: z.uuid().nullable(),
  }),
});

export const TeamResponse = z.object({
  team: z.object({
    state: CoachingStateSchema,
    visible: z.boolean(),
    sentence: z.string(),
    members: z.array(
      z.object({
        userId: z.uuid(),
        name: z.string(),
        fix: z.object(FixBody).nullable(),
        noFix: z.object({ reason: z.enum(['not_enough_calls', 'nothing_missed', 'all_dismissed']), text: z.string() }).nullable(),
      }),
    ),
  }),
});

export const SettingsResponse = z.object({
  settings: z.object({
    pack: z.object({ cleared: z.boolean(), version: z.string().nullable(), reviewedAt: z.string().nullable(), sentence: z.string() }),
    scoringEnabled: z.boolean(),
    tlSeesCallScores: z.boolean(),
    rubric: z.array(z.object({ key: z.string(), label: z.string(), good: z.string(), enabled: z.boolean() })),
    scoringSentence: z.string(),
  }),
});

export const SettingsBody = z
  .object({
    scoringEnabled: z.boolean(),
    tlSeesCallScores: z.boolean(),
    disabledKeys: z.array(z.enum(RUBRIC_KEYS)).max(RUBRIC_KEYS.length),
  })
  .strict();
