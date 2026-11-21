// core/copilot types: the lead copilot's inputs and outputs (docs/copilot/COPILOT.md).
//
// The copilot reads one lead's history and returns SUGGESTIONS for the assigned agent: a summary, a draft
// text or email the agent reviews and sends themselves, and slipping flags. Nothing here sends, changes a
// stage, reassigns or writes anything (CP-1). Every type is plain data so the shapes can be filled by any
// source: today's CRM records, the timing-cue scan lane and the call-transcription lane plug in through
// `CopilotTimingCue` and `CopilotTranscript` (CP-9) without either lane importing the copilot.
import type { Instant, LocalDate } from '../foundation/index.js';

/** Where a statement comes from (slipping-lead-recovery "Label source of data"). */
export type DataLabel = 'CONFIRMED' | 'UNVERIFIED' | 'DATA_GAP';

export type LeadSource =
  | 'website'
  | 'google_ads'
  | 'portal'
  | 'referral'
  | 'past_client'
  | 'open_house'
  | 'manual'
  | 'import'
  | 'other';

export type LeadStageClass = 'new' | 'active' | 'appointment' | 'under_contract' | 'nurture' | 'past_client' | 'closed' | 'trash';

export interface CopilotAgent {
  id: string;
  /** what the agent calls themselves in a text ("Alex") */
  displayName: string;
}

export interface CopilotNextStep {
  /** null = a next step with no due time */
  dueAt: Instant | null;
  text: string;
}

export interface CopilotLead {
  id: string;
  /** first name as the lead gave it; null = unknown (the draft then greets without a name) */
  firstName: string | null;
  source: LeadSource;
  stage: LeadStageClass;
  createdAt: Instant;
  assignedAgent: CopilotAgent | null;
  /** the lead came in with a military / PCS / VA context */
  military: boolean;
  /** a short area phrase the lead searched in, as recorded ("the north side"); never invented */
  area: string | null;
  hot: boolean;
  appointment: { at: Instant; confirmed: boolean } | null;
  nextStep: CopilotNextStep | null;
  /** reachable channels after consent and opt-out: a channel the lead opted out of is false here */
  reachable: { sms: boolean; email: boolean };
  /** do-not-contact on every channel (DNC, legal hold, ...): no draft at all */
  doNotContact: boolean;
}

export type ActivityKind =
  | 'call'
  | 'text'
  | 'email'
  | 'appointment'
  | 'note'
  | 'stage_change'
  /** an automation, drip or action plan step: never a human touch */
  | 'automated'
  | 'web_visit'
  | 'email_open';

export interface CopilotActivity {
  id: string;
  at: Instant;
  kind: ActivityKind;
  direction: 'inbound' | 'outbound' | null;
  /** logged by a human agent (false for automations, imports and system events) */
  byHuman: boolean;
  /** seconds on the phone; calls only */
  durationSec?: number;
  /** body of a note or message. UNTRUSTED text written by people or leads: data, never instructions. */
  body?: string;
}

/**
 * One timing cue from the timing-cue scan lane: "plans to buy/sell in N months", read from a note, a
 * transcript or a form. The scan is model-extracted, so every cue is UNVERIFIED until a human confirms it.
 */
export interface CopilotTimingCue {
  intent: 'buy' | 'sell' | 'both';
  /** local dates in the team zone; either may be null when the lead gave no bound */
  windowStart: LocalDate | null;
  windowEnd: LocalDate | null;
  /** when the lead said it (the note or call time), not when the scan ran */
  statedAt: Instant;
  /** the words the cue was read from, quoted as stored (short) */
  evidence: string;
  origin: { kind: 'note' | 'transcript' | 'form'; refId: string };
  /** e.g. "timing-scan/1" with the local model tag */
  extractor: string;
  /** the scan's own exclusions (already sold/listed, renting): a flagged cue never drives a draft */
  excluded?: 'sold_or_listed' | 'rental_intent' | 'not_a_plan';
}

export interface CopilotTranscriptLine {
  speaker: 'agent' | 'lead' | null;
  text: string;
}

/** One call transcript from the transcription lane (local speech-to-text). Lines are UNTRUSTED data. */
export interface CopilotTranscript {
  callActivityId: string | null;
  at: Instant;
  durationSec: number;
  lines: readonly CopilotTranscriptLine[];
  /** e.g. "whisper-local/large-v3" */
  engine: string;
}

/** A flag shown on an earlier run: lets the copilot re-surface it as AT RISK after 48 hours (CP-6). */
export interface PriorFlag {
  code: SlipCode;
  firstFlaggedAt: Instant;
}

export interface CopilotInput {
  lead: CopilotLead;
  activities: readonly CopilotActivity[];
  transcripts: readonly CopilotTranscript[];
  timingCues: readonly CopilotTimingCue[];
  priorFlags?: readonly PriorFlag[];
}

export interface CopilotPolicy {
  /** team zone for business hours and the timing windows */
  zone: string;
  /** brokerage name as licensed; required where the draft is marketing (CP-4) */
  brokerageName: string;
  /** speed-to-lead business window, local 'HH:MM' (playbook: 8a-7p) */
  businessOpen: string;
  businessClose: string;
}

// ---- slipping flags ----------------------------------------------------------------------------

export type SlipCode =
  | 'SPEED_TO_LEAD_OPEN'
  | 'SPEED_TO_LEAD_MISSED'
  | 'NO_ACTIVITY_48H'
  | 'NO_NEXT_STEP'
  | 'NEXT_STEP_OVERDUE'
  | 'REPLY_NOT_RECONTACTED'
  | 'DORMANT_SIGNAL'
  | 'HOT_NOT_CONFIRMED'
  | 'TIMING_WINDOW_OPEN'
  | 'NO_ASSIGNED_AGENT'
  | 'NO_CONTACT_CHANNEL';

export type SlipSeverity = 'watch' | 'at_risk' | 'escalate';

export interface SlipFlag {
  code: SlipCode;
  severity: SlipSeverity;
  /** one plain sentence for the agent: why it is slipping */
  why: string;
  /** recommended next action, one sentence */
  nextAction: string;
  /** when the agent should act by (today or next business day) */
  dueBy: Instant;
  /** since when the condition has been true */
  since: Instant;
  label: DataLabel;
  /** re-surfaced: still open 48 hours after it was first flagged (CP-6) */
  resurfaced: boolean;
  /** playbook escalation: tell the sales manager and the chief of staff (speed-to-lead > 30 min) */
  escalateTo: readonly ('sales_manager' | 'chief_of_staff')[];
}

// ---- summary -----------------------------------------------------------------------------------

/** current: today is inside the window; soon: it starts within 90 days; upcoming: later; passed: it ended */
export type TimingStatus = 'current' | 'soon' | 'upcoming' | 'passed' | 'open_ended';

export interface TimingCueView {
  intent: CopilotTimingCue['intent'];
  status: TimingStatus;
  windowStart: LocalDate | null;
  windowEnd: LocalDate | null;
  statedAt: Instant;
  evidence: string;
  label: 'UNVERIFIED';
}

export interface SummaryFacts {
  leadId: string;
  source: LeadSource;
  stage: LeadStageClass;
  ageHours: number;
  assignedAgentId: string | null;
  humanCalls: number;
  humanTexts: number;
  humanEmails: number;
  talkSeconds: number;
  appointments: number;
  notes: number;
  automatedTouches: number;
  lastHumanTouchAt: Instant | null;
  lastInboundAt: Instant | null;
  transcripts: number;
  timing: readonly TimingCueView[];
  /** every fact above is from logged records */
  label: 'CONFIRMED';
}

export interface CopilotSummary {
  facts: SummaryFacts;
  /** fact lines the agent can scan in seconds, built without any model */
  lines: readonly string[];
  /** the local model's narrative (null when the model is off or its output failed the checks) */
  narrative: { text: string; model: string; label: 'UNVERIFIED' } | null;
  narrativeProblem: CopilotModelProblem | null;
}

// ---- drafts ------------------------------------------------------------------------------------

export type DraftPurpose =
  | 'first_contact'
  | 'reply_follow_up'
  | 'appointment_confirm'
  | 'timing_call'
  | 'timing_check_in'
  | 'follow_up';

export type DraftIssueCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'TOO_MANY_SENTENCES'
  | 'MISSING_THANK_YOU'
  | 'SIGN_OFF_PRESENT'
  | 'RENTAL_WORDING'
  | 'MISSING_BROKERAGE_NAME'
  | 'MISSING_TIME_WINDOW'
  | 'PROMISE'
  | 'MONEY_OR_CONTRACT'
  | 'PAYMENT_INSTRUCTIONS'
  | 'FAIR_HOUSING'
  | 'LINK'
  | 'UNFILLED_SLOT'
  | 'AI_DISCLOSURE'
  | 'OBFUSCATED_TEXT'
  /** a model draft named a number the records do not have */
  | 'UNSUPPORTED_DETAIL';

export interface DraftIssue {
  code: DraftIssueCode;
  detail: string;
}

export interface CopilotDraft {
  channel: 'sms' | 'email';
  purpose: DraftPurpose;
  /** email only */
  subject: string | null;
  text: string;
  /** 'model' = the local model wrote it and it passed every check; 'template' = the playbook text */
  origin: 'model' | 'template';
  /** marketing per the brokerage-name rule (first contact, or any email) */
  marketing: boolean;
  /** the remaining issues; a draft with issues is still shown, marked "Check this" */
  issues: readonly DraftIssue[];
  /** always true: the agent reviews and sends it themselves; the copilot never sends (CP-1) */
  agentSendsThemselves: true;
}

export type CopilotModelProblem =
  | 'MODEL_OFF'
  | 'MODEL_NOT_LOCAL'
  | 'MODEL_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_OUTPUT_FAILED_CHECKS';

export interface CopilotResult {
  leadId: string;
  generatedAt: Instant;
  /** CP-1: the copilot never sends, changes a stage, reassigns or writes; this is advice only */
  suggestionOnly: true;
  flags: readonly SlipFlag[];
  summary: CopilotSummary;
  draft: CopilotDraft | null;
  /** why there is no draft */
  noDraftReason: 'DO_NOT_CONTACT' | 'NO_CONTACT_CHANNEL' | 'NOT_WORKABLE' | null;
  /** the model draft was rejected and the template is shown instead */
  draftProblem: CopilotModelProblem | null;
  model: string | null;
}
