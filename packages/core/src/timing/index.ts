// @realty/core/timing — timing cues (b20 timing-cue lane; DATA_MODEL R-TCUE-1 to R-TCUE-8): the prefilter, the
// prompt and strict output contract for ONE source, verbatim verification, the rental rule, the move window computed
// from the day the words were written, and today's ranked internal nudge list per agent (LIVE / PAST_WINDOW / STALE).
// Pure: no I/O, no clock (today is passed in), no randomness. The API calls the model (a local one only).
export * from './types.js';
export { prefilter, plainText, TIMING_CUE_RE, BOILERPLATE_RE, REMINDER_RE, FORM_FIELD_RE, type PrefilterResult } from './prefilter.js';
export { projectWindow, addMonths, parseYmd, TIMEFRAME_MONTHS } from './window.js';
export {
  buildTimingPrompt,
  parseTimingOutput,
  quoteInSource,
  isRentalPlan,
  decideCue,
  sourceText,
  RENT_OUT_RE,
  RENT_SEEK_RE,
  TIMING_TEMPLATE_KEY,
  TIMING_PROMPT_VERSION,
  TIMING_MIN_CONFIDENCE,
  TIMING_SNIPPET_MAX,
  TIMING_SOURCE_MAX,
  type TimingPrompt,
  type CueDecision,
} from './extract.js';
export { buildNudgeList, classifyCue, compareLive, LIVE_HORIZON_MONTHS, PAST_WINDOW_LOOKBACK_MONTHS, type NudgeCueInput, type NudgeItem, type AgentNudges, type NudgeList, type Classified } from './nudges.js';
