// What happens after a call transcript is stored (local transcription, draft lane; docs/design/draft-local-transcription.md).
//
// timingCueHook runs the deterministic timing-cue scan (@realty/core/transcription timingCues) over the fresh transcript
// and hands the result to a sink: ids, horizon and transcript offsets, never the quote text (the quote stays inside the
// encrypted transcript and is shown to an agent through the audited transcript view). The sink that feeds Monday's
// nudge list is the next step: a table or job that needs its own migration and review, so nothing is wired here yet
// and CommsDeps.onTranscriptReady stays unset in every runtime.
//
// Lead summaries need no hook: assistant/prompt.ts already reads every stored call transcript as evidence.
import type { CallId, ContactId } from '@realty/core/foundation';
import { nearestActionableCue, timingCues } from '@realty/core/transcription';
import type { MoveIntent } from '@realty/core/transcription';
import type { TranscriptReady } from './types.js';

/** One call's timing result, with no words from the call in it. */
export interface TimingCueRecord {
  tenantId: string;
  contactId: string;
  callId: string;
  transcriptId: string;
  /** every cue, as transcript ranges to open in the transcript view */
  cues: { startMs: number; endMs: number; intent: MoveIntent; horizonMonths: number | null; withinSixMonths: boolean; leaseContext: boolean }[];
  /** the nearest buy/sell window within six months, or null: what the nudge list ranks by */
  actionable: { intent: MoveIntent; horizonMonths: number; startMs: number; endMs: number } | null;
}

export type TimingCueSink = (r: TimingCueRecord) => Promise<void>;

export function timingCueRecord(e: TranscriptReady): TimingCueRecord {
  const cues = timingCues({ callId: e.callId as CallId, contactId: e.contactId as ContactId, callAt: e.callAt, segments: e.segments });
  const best = nearestActionableCue(cues);
  return {
    tenantId: e.tenantId,
    contactId: e.contactId,
    callId: e.callId,
    transcriptId: e.transcriptId,
    cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, intent: c.intent, horizonMonths: c.horizonMonths, withinSixMonths: c.withinSixMonths, leaseContext: c.leaseContext })),
    actionable: best ? { intent: best.intent, horizonMonths: best.horizonMonths!, startMs: best.startMs, endMs: best.endMs } : null,
  };
}

/** A CommsDeps.onTranscriptReady that scans for timing cues and passes calls with any cue to the sink. */
export function timingCueHook(sink: TimingCueSink): (e: TranscriptReady) => Promise<void> {
  return async (e) => {
    const r = timingCueRecord(e);
    if (r.cues.length > 0) await sink(r);
  };
}
