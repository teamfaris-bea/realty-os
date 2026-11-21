// Where the copilot's input comes from (CP-9): clean ports so the parallel lanes plug in without editing the
// copilot.
//
//   TimingCueSource    the timing-cue scan lane (notes -> "plans to buy/sell in N months") implements it
//   TranscriptSource   the call-transcription lane (local speech-to-text) implements it
//   LeadHistorySource  the CRM read (lead, activities); a repo over the people/comms tables implements it
//
// Each returns only the one lead's data, already scoped to the caller's tenant and visibility (a source never
// returns another tenant's or an invisible lead's rows; the route layer is where RBAC is enforced). Until a
// lane lands, the empty sources below keep the copilot working with what it has.
import type { CopilotActivity, CopilotLead, CopilotTimingCue, CopilotTranscript, PriorFlag } from '@realty/core/copilot';

export interface LeadHistorySource {
  load(leadId: string): Promise<{ lead: CopilotLead; activities: CopilotActivity[]; priorFlags: PriorFlag[] } | null>;
}

export interface TimingCueSource {
  cuesFor(leadId: string): Promise<CopilotTimingCue[]>;
}

export interface TranscriptSource {
  /** newest first is fine; the copilot sorts and keeps the latest few */
  transcriptsFor(leadId: string): Promise<CopilotTranscript[]>;
}

export interface CopilotSources {
  history: LeadHistorySource;
  timing: TimingCueSource;
  transcripts: TranscriptSource;
}

export const NO_TIMING_CUES: TimingCueSource = { cuesFor: async () => [] };
export const NO_TRANSCRIPTS: TranscriptSource = { transcriptsFor: async () => [] };
