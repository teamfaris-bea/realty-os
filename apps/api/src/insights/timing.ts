// The timing-cue scan and today's nudge list (b20 timing-cue lane; DATA_MODEL R-TCUE-1 to R-TCUE-8).
//
//   scanTimingCues   the nightly job's body (standalone: the model is never called inside a transaction).
//                    TX-A (system): the tenant's zone and AI switch, then the next notes not yet read (or edited
//                    since). Outside any transaction: core prefilter → the LOCAL model (`providers.timingAi`,
//                    never `providers.ai`) → strict contract → verbatim quote → rental rule → window from the day
//                    written. TX-B per note (system): one timing_cues row. Nothing is sent; no task, stage, owner,
//                    tag or sequence is touched.
//   timingNudges     today's ranked internal list per agent (core buildNudgeList), computed at read time.
import { type IanaZone, type IdGenerator, type Instant, ianaZone, instantFromDate, localDateOf, toIso } from '@realty/core/foundation';
import { TIMING_PROMPT_VERSION, type NudgeCueInput, type NudgeList, buildNudgeList, buildTimingPrompt, decideCue, parseTimingOutput, prefilter, sourceText } from '@realty/core/timing';
import type { Tx } from '@realty/db';
import { type AiProvider, ProviderError } from '../providers/types.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { type ScanRow, noteCandidates, nudgeRows, recordScan, timingSettings } from './repos/timing.js';

/** Notes read per run; a run that leaves more asks to run again a minute later (an 18-month backfill drains overnight). */
export const TIMING_SCAN_BATCH = 100;
/** A run stops starting new model calls after this long. */
export const TIMING_SCAN_BUDGET_MS = 10 * 60_000;
/** How far back the scan reads (the pilot's 18 months). */
export const TIMING_LOOKBACK_DAYS = 548;
/** When the local model is down (the machine is off), try again this much later instead of failing the job. */
export const TIMING_MODEL_DOWN_RETRY_MS = 60 * 60_000;

export type ScanResult =
  | { kind: 'off'; reason: 'NO_LOCAL_MODEL' | 'AI_OFF' | 'NO_SETTINGS' }
  | { kind: 'scanned'; read: number; modelCalls: number; cues: number; more: boolean; modelDown: boolean };

export interface ScanDeps {
  ids: IdGenerator;
  /** wall clock for the run's time budget (ms) */
  clockMs?: () => number;
  batch?: number;
  budgetMs?: number;
}

/** Reads the next notes of the job's tenant. `model` is `providers.timingAi`: a local model, or nothing. */
export async function scanTimingCues(ctx: Pick<StandaloneJobContext, 'withTx'>, model: AiProvider | null | undefined, deps: ScanDeps): Promise<ScanResult> {
  // R-TCUE-1: no local model, no read. There is no fallback to the cloud provider.
  if (!model) return { kind: 'off', reason: 'NO_LOCAL_MODEL' };
  const batch = deps.batch ?? TIMING_SCAN_BATCH;
  const pre = await ctx.withTx(async (tx) => {
    const s = await timingSettings(tx);
    if (!s) return null;
    // R-AST-18: the tenant's AI switch off ⇒ no model call (nothing is read, nothing recorded)
    if (!s.aiEnabled) return { s, notes: [] };
    return { s, notes: await noteCandidates(tx, { lookbackDays: TIMING_LOOKBACK_DAYS, limit: batch + 1 }) };
  });
  if (!pre) return { kind: 'off', reason: 'NO_SETTINGS' };
  if (!pre.s.aiEnabled) return { kind: 'off', reason: 'AI_OFF' };
  const zone = ianaZone(pre.s.zone) as IanaZone;
  const clock = deps.clockMs ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? TIMING_SCAN_BUDGET_MS;
  let read = 0;
  let modelCalls = 0;
  let cues = 0;
  let modelDown = false;
  for (const n of pre.notes.slice(0, batch)) {
    if (clock() - started > budget) break;
    const writtenOn = localDateOf(instantFromDate(n.written_at), zone) as string;
    const base = { id: deps.ids.next(), noteId: n.id, noteUpdatedAt: n.updated_at, writtenAt: n.written_at, cue: null, model: null, promptVersion: null };
    let row: ScanRow;
    const p = prefilter(n.body);
    if (!p.keep) {
      row = { ...base, outcome: p.outcome };
    } else {
      const text = sourceText(n.body);
      const prompt = buildTimingPrompt({ text, writtenOn });
      let answer: { text: string; model: string; stopReason: string };
      try {
        modelCalls++;
        answer = await model.complete(prompt);
      } catch (e) {
        if (e instanceof ProviderError) {
          // the local model is unreachable or refuses the request: stop here, nothing is recorded for this note
          modelDown = true;
          break;
        }
        throw e;
      }
      const parsed = answer.stopReason === 'refusal' ? ({ ok: false } as const) : parseTimingOutput(answer.text);
      const meta = { model: answer.model.slice(0, 80), promptVersion: TIMING_PROMPT_VERSION };
      if (!parsed.ok) {
        row = { ...base, ...meta, outcome: 'model_error' };
      } else {
        const d = decideCue({ text, writtenOn, proposed: parsed.cues });
        row =
          d.outcome === 'cue'
            ? {
                ...base,
                ...meta,
                outcome: 'cue',
                cue: {
                  evidence: d.cue.evidence,
                  intent: d.cue.intent,
                  timeframe: d.cue.timeframe,
                  snippet: d.cue.snippet,
                  windowStart: d.cue.window.start,
                  windowEnd: d.cue.window.end,
                  windowPrecision: d.cue.window.precision,
                  windowBasis: d.cue.window.basis,
                  windowLabel: d.cue.window.label,
                  confidence: d.cue.confidence,
                },
              }
            : { ...base, ...meta, outcome: d.outcome };
      }
    }
    const wrote = await ctx.withTx((tx) => recordScan(tx, row));
    read++;
    if (wrote && row.outcome === 'cue') cues++;
  }
  return { kind: 'scanned', read, modelCalls, cues, more: !modelDown && pre.notes.length > read, modelDown };
}

/** The sentence the list carries about how it was made (R-OWNER-1: every view says its method). */
export const TIMING_NUDGE_METHOD =
  'People whose own notes say when they plan to buy, sell or move, read nightly by a local model and checked word for word. The window is counted from the day the words were written. LIVE: the window is open now or starts within about 6 months: call today. PAST_WINDOW: the window passed with no sale or purchase on record: ask whether the plan still stands. STALE: a deal listed, went under contract or closed after the words. Closed, lost, under-contract and do-not-contact people and rental plans are left off. Latest note per person. LIVE order: open now first, then soonest start, sellers before buyers, then longest since a human call, text or email.';

/** Today's list for a human Owner or Admin (the route's permission), in the team's zone. */
export async function timingNudges(tx: Tx, now: Instant, zone: IanaZone): Promise<NudgeList & { zone: string; asOf: string }> {
  const today = localDateOf(now, zone) as string;
  const rows = await nudgeRows(tx);
  const cues: NudgeCueInput[] = rows.map((r) => ({
    contactId: r.contact_id,
    firstName: r.first_name,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    stage: r.stage,
    doNotContact: r.do_not_contact,
    laterTransaction: r.later_transaction,
    lastHumanTouchAt: r.last_human_touch_at ? toIso(instantFromDate(r.last_human_touch_at)) : null,
    sourceId: r.note_id,
    writtenOn: localDateOf(instantFromDate(r.written_at), zone) as string,
    intent: r.intent as NudgeCueInput['intent'],
    evidence: r.evidence as NudgeCueInput['evidence'],
    snippet: r.cue_snippet,
    window: { start: r.window_start, end: r.window_end, label: r.window_label, precision: r.window_precision as NudgeCueInput['window']['precision'] },
  }));
  return { ...buildNudgeList({ today, cues }), zone, asOf: toIso(now) };
}
