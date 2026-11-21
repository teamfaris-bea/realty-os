// Turn processing (R-ISA-4, R-ISA-5, R-ISA-20, R-ISA-27; docs/AI_ISA.md §4.2, §7, §9.2). The `ai_isa.turn` job:
//
//   TX-A (locks 2 → 3 → 4): debounce through retryAt; the link-failure table (a hold defers BEFORE any model call);
//        the events (turn inbounds from bound points since the last consumed one, timers, start); the deterministic
//        step(); when the machine awaits the model, a turn row `deciding` with the pinned inbound seq and the epoch.
//        A turn held at a daily model-call budget (below) is reopened here on its retry, with its prompt rebuilt.
//   The reservation (spend.ts reserveForTurn; R-ISA-20), before EACH provider call, in a transaction of its own:
//        the team model-budget lock, the count of today's reserved calls and one ai_runs row. No other lock is held
//        with it, so it lasts only for that count and insert; a turn that makes no model call never takes it. At a
//        limit the turn is held `deferred` until the next team-local day, without a provider call.
//   The provider call, with NO lock held (the TX-A/TX-B pattern of assistant/runs.ts), through the unchanged
//        AiProvider.complete; tool-less; one repair retry on a schema failure. Its outcome is recorded on the
//        reserved ai_runs row in a transaction of its own (no lock) before TX-B can discard the decision.
//   TX-B (locks 2 → 3 → 4): the attempt-guarded UPDATE (zero rows ⇒ a replayed lease: discard everything, E492);
//        a newer inbound ⇒ stale, re-enqueued (E493); the chain, the pause and the epoch again; parse, decideAction,
//        step(model_output); link the already-recorded ai_runs row; the actions through effects.applyActionsInTx.
import type { Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { aiRunAad } from '../assistant/runs.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { hideForDisplay } from '../portal/shared/redact.js';
import { systemActor } from '../worker/systemActor.js';
import {
  buildIsaPrompt, capabilitiesInEffect, clientOwnText, confirmationInTime, decideAction, formatSlot, isAcknowledgementOnly, type IsaEvent, type IsaInbound, parseIsaModelOutput, repairNote, step,
} from './coreSeam.js';
import { backstopInTx } from './backstop.js';
import { ACTIVITY_ANSWERING, ACTIVITY_WAITING_BUDGET } from './sentences.js';
import { RESUME_OWNER, reserveForTurn, supersedeHeldTurns } from './spend.js';
import { systemEndInTx, systemPauseInTx } from './controls.js';
import { applyActionsInTx, chainEnvOf, contextFor, ensureTurn, type IsaContext, type IsaDeps, turnByKey } from './effects.js';
import { type AssignmentRow, assignmentById, evaluateChain, lockForTurn } from './repo.js';
import { calendarLiveInTx, nextSendAtInTx } from './booking/rows.js';
import { buildBuyerBundleInTx, type BuyerBundle, EMPTY_BUNDLE } from './buyer/bundle.js';
import { savedSearchAllowedInTx } from './buyer/savedSearch.js';
import { factPlaceholdersInTx, sellerBundleInTx } from './seller/index.js';

export type TurnDeps = IsaDeps & { envelope: EnvelopeService };

export const DEBOUNCE_MS = 20_000;
export const DEBOUNCE_CAP_MS = 120_000;
export const HOLD_RETRY_MS = 15 * 60_000;
export const SEND_RESULT_WAIT_MS = 2_000;
/** A turn `deciding` this long with no change is stuck: the sweep sends a recover job for it (handlers.ts sweepInTx). */
export const STUCK_TURN_MS = 8 * 60_000;
/** E906: a stuck turn is adopted again by the recover job only below this many attempts; at it, care is paused for a person to check. */
export const ISA_TURN_MAX_ATTEMPTS = 8;

export interface TurnPayload {
  assignmentId: string;
  trigger: 'start' | 'inbound' | 'timer' | 'control' | 'sweep';
  timer?: 'follow_up' | 'offer_expiry' | 'pause_expiry' | 'inactivity_warning';
  epoch: number;
  /** The instant a schedule_timer job was scheduled for (effects.ts). Absent on a job queued before the payload carried it. */
  at?: number;
  /** E906: the sweep's job for a turn stuck `deciding` (handlers.ts sweepInTx): it adopts the turn again, or gives it up */
  recover?: boolean;
  /** E908: the job queued for the rollover when a sweep-triggered turn is held at a budget (spend.ts holdTurn); it owns that turn */
  resume?: boolean;
}

/**
 * The turn row's key (unique per assignment; `^[A-Za-z0-9_:.-]{1,120}$`). An inbound turn is keyed by the last inbound
 * it reads. A follow-up is keyed by the instant its timer was scheduled for, so every follow-up of an epoch is its own
 * turn: with one key per epoch (`timer:<epoch>:follow_up`) the second follow-up reused the first one's row, already
 * decided, and TX-B threw its model call away. Anything that looks a turn up by key builds the key here.
 */
export function turnTriggerKey(k: { trigger: TurnPayload['trigger']; epoch: number; inboundSeq: number | null; timer: TurnPayload['timer'] | null; followUpAt: number | null }): string {
  if (k.inboundSeq !== null) return `${k.trigger}:${k.epoch}:${k.inboundSeq}`;
  if (k.timer === 'follow_up' && k.followUpAt !== null) return `${k.trigger}:${k.epoch}:follow_up:${k.followUpAt}`;
  return `${k.trigger}:${k.epoch}:${k.timer ?? 'start'}`;
}

export type TurnResult = { kind: 'done'; code: string } | { kind: 'retry'; retryAt: Instant };

/** The worker run, when there is one. Its id owns a turn held at a budget (E904). A legacy follow-up is identified by that job's `run_at`. */
export interface TurnRun {
  jobId?: string;
}

interface Prepared {
  /** set when a held repair call resumes: the provider loop starts at the repair call */
  repair?: boolean;
  a: AssignmentRow;
  ctx: IsaContext;
  turnId: string;
  attempt: number;
  pinnedSeq: number;
  event: IsaEvent;
  prompt: ReturnType<typeof buildIsaPrompt>;
  /** item 10: the buyer bundle built from the database in TX-A (handles → facts); rides to TX-B */
  bundle: BuyerBundle;
  decideBase: Omit<Parameters<typeof decideAction>[1], 'now'>;
}

/** The bound-point turn inbounds not yet consumed, with their per-conversation ordinal as seq (R-ISA-28). */
async function turnInbounds(tx: Tx, a: AssignmentRow): Promise<IsaInbound[]> {
  const bound = Object.values(a.boundPoints).map((p) => p!.point_id);
  const r = await sql<{ id: string; channel: 'sms' | 'email'; body: string; created_at: Date; seq: string; kw: string | null; reaction: boolean }>`
    WITH ordered AS (
      SELECT m.id, m.channel, m.body, m.created_at, m.from_address, m.is_auto_reply, m.email_dkim_aligned, m.opt_out_keyword,
             row_number() OVER (ORDER BY m.created_at, m.id) AS seq
        FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
       WHERE m.tenant_id = app.tenant_id() AND c.contact_id = ${a.contactId} AND m.direction = 'inbound')
    SELECT o.id, o.channel, o.body, o.created_at, o.seq, o.opt_out_keyword AS kw,
           EXISTS (SELECT 1 FROM message_reactions r WHERE r.tenant_id = app.tenant_id() AND r.message_id = o.id) AS reaction FROM ordered o
     WHERE o.seq > ${a.machine.lastInboundSeq} AND o.created_at >= ${new Date(a.startedAt - (a.machine.lastInboundSeq === 0 ? 86_400_000 : 0))}
       AND o.channel IN ('sms','email') AND NOT o.is_auto_reply AND (o.channel = 'sms' OR o.email_dkim_aligned IS TRUE)
       AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.id = ANY (${bound}::uuid[]) AND p.address = o.from_address)
       AND NOT EXISTS (SELECT 1 FROM message_text_parts tp WHERE tp.tenant_id = app.tenant_id() AND tp.message_id = o.id)
     ORDER BY o.seq`.execute(tx);
  return r.rows.map((m) => {
    // b18 round 3 item 8 (R-PORTAL-20): a quoted portal sign-in token in a record stored before 0093 is hidden before
    // the body reaches the turn machine (and, through it, a claim or the stored state); the record is not rewritten
    const own = clientOwnText(hideForDisplay(m.body).text ?? '', m.channel);
    return {
      seq: Number(m.seq), messageId: m.id, channel: m.channel, at: instantFromDate(m.created_at), ownText: own.text.slice(0, 1600), ownTextReliable: own.reliable,
      classification: { kind: (m.kw ? 'stop' : 'none') as 'stop' | 'none', needsReview: false },
      // R-ISA-13 E529: a tapback (message_reactions names this inbound) is an acknowledgement and never a slot choice
      reaction: m.reaction,
    };
  });
}

async function convSeq(tx: Tx, contactId: string): Promise<{ seq: number; lastInboundAt: Instant | null; oldestUnconsumedAt: Instant | null }> {
  const r = await sql<{ seq: string | null; last: Date | null }>`SELECT inbound_seq AS seq, last_inbound_at AS last FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  return { seq: Number(r.rows[0]?.seq ?? 0), lastInboundAt: r.rows[0]?.last ? instantFromDate(r.rows[0].last) : null, oldestUnconsumedAt: null };
}

function actor(tenantId: string): SystemActor {
  return systemActor(tenantId as TenantId, 'assistant');
}

/** TX-A. Returns a prepared model call, or the turn's outcome when no model call is needed. */
async function txA(deps: TurnDeps, tenantId: string, p: TurnPayload, run: TurnRun = {}): Promise<Prepared | TurnResult> {
  return withTenantTx(actor(tenantId), async (tx, now) => {
    const me = p.resume === true ? RESUME_OWNER : run.jobId ?? null;
    const peek = await assignmentById(tx, p.assignmentId);
    if (peek === null || peek.endedAt !== null) return { kind: 'done', code: 'ENDED' } as const;
    await lockForTurn(tx, peek.contactId, peek.id);
    let a = (await assignmentById(tx, p.assignmentId, 'update'))!;
    if (a.endedAt !== null) return { kind: 'done', code: 'ENDED' } as const;
    if (p.epoch !== a.epoch && p.trigger === 'timer') return { kind: 'done', code: 'STALE_EPOCH' } as const;
    // the link-failure table: a hold defers before any model call; a pause or end applies and stops (§3.1)
    const chain = await evaluateChain(tx, a, chainEnvOf(deps));
    if (chain.effect === 'hold') return { kind: 'retry', retryAt: (now + HOLD_RETRY_MS) as Instant } as const;
    if (chain.effect === 'pause' && a.pausedAt === null) {
      await systemPauseInTx(tx, deps, actor(tenantId), a, (chain.worst!.reason ?? 'pack_withdrawn') as never, now);
      return { kind: 'done', code: `PAUSED:${chain.worst!.code}` } as const;
    }
    if (chain.effect === 'end') {
      const stop = chain.worst!.link === 7 ? (chain.worst!.reason as never) : undefined;
      await systemEndInTx(tx, deps, actor(tenantId), a, (chain.worst!.reason ?? 'tenant_off') as never, now, stop ? { stop } : {});
      return { kind: 'done', code: `ENDED:${chain.worst!.code}` } as const;
    }
    if (a.pausedAt !== null) {
      // R-ISA-16 E516: the inactivity warning ends paused care too (core machine.ts onTimer), with the pinned handoff
      if (p.timer === 'pause_expiry' || p.timer === 'inactivity_warning') {
        const ctx = await contextFor(tx, a, now);
        const r = step(a.machine, { type: 'timer', at: now, timer: p.timer }, ctx.facts);
        await applyActionsInTx({ tx, deps, actor: actor(tenantId), ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, r);
        return { kind: 'done', code: p.timer === 'pause_expiry' ? 'PAUSE_EXPIRY' : 'INACTIVITY_WARNING' } as const;
      }
      return { kind: 'done', code: 'PAUSED' } as const;
    }
    const conv = await convSeq(tx, a.contactId);
    const inbounds = p.trigger === 'timer' ? [] : await turnInbounds(tx, a);
    // debounce (§4.2): the worker's retryAt, capped at 2 minutes of total deferral
    if (inbounds.length > 0 && conv.lastInboundAt !== null && now - conv.lastInboundAt < DEBOUNCE_MS && now - inbounds[0]!.at < DEBOUNCE_CAP_MS) {
      return { kind: 'retry', retryAt: (conv.lastInboundAt + DEBOUNCE_MS) as Instant } as const;
    }
    // R-ISA-4: an AI message already terminal whose send_result has not run yet (its turn still sending or deferred):
    // wait 2 s so core sees the delivery first (a fast "2" after the offer), within the debounce cap
    if (inbounds.length > 0 && now - inbounds[0]!.at < DEBOUNCE_CAP_MS) {
      const pend = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ai_isa_turns t JOIN messages m ON m.tenant_id = t.tenant_id AND m.id = t.message_id
        WHERE t.tenant_id = app.tenant_id() AND t.assignment_id = ${a.id} AND t.status IN ('sending','deferred')
          AND m.status IN ('sent','delivered','failed','undelivered','blocked','canceled','dispatch_unknown')`.execute(tx);
      if (pend.rows[0]!.n > 0) return { kind: 'retry', retryAt: (now + SEND_RESULT_WAIT_MS) as Instant } as const;
    }
    // item 8: an inbound waits (2 s, within the debounce cap) while the offer is being booked
    if (inbounds.length > 0 && a.machine.offer?.status === 'accepting' && now - inbounds[0]!.at < DEBOUNCE_CAP_MS) {
      return { kind: 'retry', retryAt: (now + SEND_RESULT_WAIT_MS) as Instant } as const;
    }
    let ctx = await contextFor(tx, a, now);
    // item 8: a due offer expiry is applied BEFORE an inbound event, so row 10 never books an expired offer
    const off = a.machine.offer;
    if (inbounds.length > 0 && off !== null && off.status === 'offered' && off.expiresAt !== null && off.expiresAt <= now) {
      const ex = step(a.machine, { type: 'timer', at: now, timer: 'offer_expiry' }, ctx.facts);
      await applyActionsInTx({ tx, deps, actor: actor(tenantId), ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, ex);
      a = (await assignmentById(tx, a.id, 'update'))!;
      ctx = await contextFor(tx, a, now);
    }
    // Q10: while an offer is offered, acknowledgement-only own text ("ok", "great", a tapback) reaches core as a
    // reaction: one clarification, never a booking (core's YES_RE would book a one-slot offer: an ISA-1 follow-up)
    if (a.machine.offer?.status === 'offered') {
      for (const m of inbounds) if (!m.reaction && isAcknowledgementOnly(m.ownText, false) && !/^\s*(?:yes|yeah|yep|yup|that\s+works|works(?:\s+for\s+me)?)[\s.!]*$/iu.test(m.ownText)) m.reaction = true;
    }
    const event: IsaEvent = p.trigger === 'timer' && p.timer ? { type: 'timer', at: now, timer: p.timer }
      : inbounds.length > 0 ? { type: 'inbound', at: now, messages: inbounds }
      : a.machine.phase === 'starting' ? { type: 'start', at: now }
      : { type: 'timer', at: now, timer: 'follow_up' };
    // The assignment's one open model turn (E904, E906): the machine awaits the model and a turn row carries that
    // pending call, either held at a daily budget (`deferred`, R-ISA-20) or `deciding`. A run that finds it, with no
    // newer inbound to consume, adopts it again when it is its own: attempt + 1 (a TX-B of an earlier attempt then
    // updates zero rows, E492), the prompt rebuilt, and a fresh reservation after this transaction (runTurn). The inbound
    // is already consumed and a repair keeps its schema-failure counter. This happens only after the normal chain,
    // pause and epoch checks above. A newer inbound takes the ordinary path instead and supersedes the held turn.
    //   held:     the retry of the job that owns it (its trigger_key starts with this job's trigger and epoch, and the
    //             hold recorded this job's id, so of the jobs parked for one person exactly one resumes);
    //   deciding: the retry of the job that prepared it (the same job id: a throw or a lost lease between TX-A and
    //             TX-B), or the sweep's recover job once the turn has not changed for 8 minutes. Never another job of
    //             the person (a text inside the debounce has its own job, which finds the first job's turn in flight).
    if (inbounds.length === 0) {
      const stuckBefore = new Date(now - STUCK_TURN_MS);
      const open = !a.machine.awaitingModel ? undefined : (await sql<{ id: string; attempt: number; status: string; trigger_key: string; job: string | null; repair: boolean; stuck: boolean }>`
        SELECT id, attempt, status, trigger_key, decision->>'job' AS job, updated_at < ${stuckBefore} AS stuck,
               (COALESCE(decision->>'budgetRepair', 'false') = 'true' OR COALESCE(decision->>'repair', 'false') = 'true') AS repair
          FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND epoch = ${a.epoch}
           AND (status = 'deciding' OR (status = 'deferred' AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')))
         ORDER BY seq DESC LIMIT 1`.execute(tx)).rows[0];
      // the recover job: any other turn of this care stuck `deciding` has nothing waiting for it (the machine does not
      // await the model, or a newer turn carries the pending call): it is canceled, as the sweep used to do
      if (p.recover) {
        await sql`UPDATE ai_isa_turns SET status = 'canceled', decision = '{"code":"ISA_TURN_STUCK"}'::jsonb WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}
          AND status = 'deciding' AND updated_at < ${stuckBefore} AND id IS DISTINCT FROM ${open?.id ?? null}`.execute(tx);
      }
      if (open) {
        const held = open.status === 'deferred';
        const followUpTimerKey = p.timer === 'follow_up' && p.at !== undefined ? `timer:${a.epoch}:follow_up:${p.at}` : null;
        const ownTrigger = open.trigger_key.startsWith(`${p.trigger}:${a.epoch}:`) && (p.trigger !== 'timer' || open.trigger_key === (followUpTimerKey ?? `timer:${a.epoch}:${p.timer ?? 'start'}`));
        // held: the recorded owner decides (a job id, or the resume job: E908, whose turn may carry any trigger, e.g. a
        // recovered inbound turn). A turn held by a run outside a job, or resumed by one, has no owner to compare
        // (tests): there the trigger decides, as before. Every worker run has an identity.
        const adopt = held ? (open.job !== null && me !== null ? open.job === me : ownTrigger)
          : (me !== null && open.job === me) || (p.recover === true && open.stuck);
        if (adopt && !held && p.recover === true && open.attempt >= ISA_TURN_MAX_ATTEMPTS) {
          // E906: recovered too often. The turn is given up and the machine must not be left awaiting it: care is
          // paused for a person to check (the pause clears awaitingModel, cancels the turn and tells the owner), and
          // a reply that was waiting is pinned for the owner now.
          await sql`UPDATE ai_isa_turns SET decision = '{"code":"ISA_TURN_ABANDONED"}'::jsonb WHERE tenant_id = app.tenant_id() AND id = ${open.id} AND status = 'deciding'`.execute(tx);
          await systemPauseInTx(tx, deps, actor(tenantId), a, 'check_this', now);
          await backstopInTx(tx, deps, (await assignmentById(tx, a.id))!, null, now);
          return { kind: 'done', code: 'ABANDONED' } as const;
        }
        if (adopt) {
          const decision = { ...(open.job !== null ? { job: open.job } : {}), ...(me !== null ? { job: me } : {}), ...(open.repair ? { repair: true } : {}) };
          await sql`UPDATE ai_isa_turns SET status = 'deciding', not_before = NULL, attempt = attempt + 1, decision = ${JSON.stringify(decision)}::jsonb
            WHERE tenant_id = app.tenant_id() AND id = ${open.id}`.execute(tx);
          // E905: the reply's activity card said it waits for tomorrow's budget; the assistant is answering again
          if (held && a.machine.inboundUnanswered) {
            await sql`UPDATE priority_feed_items SET reasons = ${JSON.stringify([ACTIVITY_ANSWERING])}::jsonb, updated_at = now() WHERE tenant_id = app.tenant_id()
              AND dedupe_key = ${`ai_isa_activity:${a.id}`} AND state IN ('open','snoozed') AND reasons->0->>'code' = ${ACTIVITY_WAITING_BUDGET.code}`.execute(tx);
          }
          return { ...await prepare(tx, ctx, a, open.id, open.attempt + 1, conv.seq, event, now, { repair: open.repair, initiated: !a.machine.inboundUnanswered }), repair: open.repair };
        }
      }
    }
    if (event.type === 'timer' && event.timer === 'follow_up' && p.trigger !== 'timer') return { kind: 'done', code: 'NOTHING_TO_DO' } as const;
    const r = step(a.machine, event, ctx.facts);
    // a follow-up's own instant: the job's `at` (schedule_timer). A job queued before the payload carried `at` is not
    // the assignment's current next_follow_up_at: two such jobs would both adopt it and both text. It sends only when
    // its own run_at is that instant. A hand-run with no job row still uses next_follow_up_at.
    const followUp = event.type === 'timer' && event.timer === 'follow_up';
    const nextFollowUpAt = !followUp ? null : (await sql<{ at: Date | null }>`SELECT next_follow_up_at AS at FROM ai_isa_assignments
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx)).rows[0]?.at?.getTime() ?? null;
    const jobRunAt = !followUp || p.at !== undefined || run.jobId === undefined ? null
      : (await sql<{ at: Date | null }>`SELECT app.job_run_at(${run.jobId}::bigint) AS at`.execute(tx)).rows[0]?.at?.getTime() ?? null;
    const followUpAt = !followUp ? null : p.at ?? jobRunAt ?? nextFollowUpAt ?? now;
    const triggerKey = turnTriggerKey({ trigger: p.trigger, epoch: a.epoch, inboundSeq: event.type === 'inbound' ? inbounds.at(-1)!.seq : null, timer: p.timer ?? null, followUpAt });
    const awaiting = r.actions.find((x) => x.kind === 'await_model');
    // A decided turn row is never the row of a new model call: TX-B's guard (`status = 'deciding'`) would match nothing,
    // the call would be thrown away (a reserved call spent, R-ISA-20) and the machine left awaiting the model. A
    // follow-up whose row is decided has run: the same job again (a worker lost after TX-B) changes nothing.
    const decided = (await turnByKey(tx, a.id, triggerKey))?.status;
    if (decided !== undefined && decided !== 'deciding' && (awaiting !== undefined || followUp)) return { kind: 'done', code: 'TURN_ALREADY_DECIDED' } as const;
    // Every AI message schedules its own follow-up and nothing cancels the earlier timer (cancel_timers, effects.ts), so
    // after a reply two timers are pending. Only the one the assignment names (next_follow_up_at, the latest scheduled)
    // is the follow-up; an earlier one is a no-op, or the person would be followed up once per timer, not once per cadence.
    // A payload with `at` is that instant. A legacy payload without it is the job's own run_at, not the assignment's
    // current next_follow_up_at (two queued jobs would otherwise both adopt it and both send).
    if (followUp && nextFollowUpAt !== null && p.at !== undefined && nextFollowUpAt !== p.at) return { kind: 'done', code: 'FOLLOW_UP_SUPERSEDED' } as const;
    if (followUp && p.at === undefined && run.jobId !== undefined && (jobRunAt === null || nextFollowUpAt === null || jobRunAt !== nextFollowUpAt)) return { kind: 'done', code: 'FOLLOW_UP_SUPERSEDED' } as const;
    const turn = await ensureTurn(tx, deps.ids, ctx, { triggerKind: p.trigger === 'control' || p.trigger === 'sweep' ? p.trigger : event.type === 'inbound' ? 'inbound' : p.trigger, triggerKey, pinnedSeq: conv.seq });
    const lastSeq = inbounds.at(-1)?.seq ?? a.machine.lastInboundSeq;
    const applied = await applyActionsInTx({ tx, deps, actor: actor(tenantId), ctx, now, turnId: turn.id, pinnedSeq: conv.seq }, { state: r.state, actions: r.actions.filter((x) => x.kind !== 'await_model') });
    await sql`UPDATE ai_isa_assignments SET last_inbound_seq = GREATEST(last_inbound_seq, ${lastSeq}) WHERE tenant_id = app.tenant_id() AND id = ${a.id} AND ended_at IS NULL AND last_inbound_seq < ${lastSeq}`.execute(tx);
    if (!awaiting || applied.ended || applied.paused) {
      await sql`UPDATE ai_isa_turns SET status = CASE WHEN message_id IS NOT NULL THEN status WHEN ${applied.ended} THEN 'handed_off' ELSE 'no_reply' END,
          state_after = ${r.state.ended !== null ? 'ended' : r.state.phase}
        WHERE tenant_id = app.tenant_id() AND id = ${turn.id} AND status = 'deciding'`.execute(tx);
      return { kind: 'done', code: applied.ended ? 'ENDED' : 'NO_MODEL' } as const;
    }
    // E904: this turn now carries the assignment's one pending model call; an older turn still held at a budget is superseded
    await supersedeHeldTurns(tx, a.id, turn.id);
    // E906: the job that prepared the turn owns it until TX-B: only its own retry adopts it again
    if (me !== null) await sql`UPDATE ai_isa_turns SET decision = decision || ${JSON.stringify({ job: me })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${turn.id} AND status = 'deciding'`.execute(tx);
    const fresh = (await assignmentById(tx, a.id))!;
    return prepare(tx, { ...ctx, a: fresh }, fresh, turn.id, turn.attempt, conv.seq, event, now, awaiting.kind === 'await_model' ? awaiting : null);
  }, { db: deps.db, retries: 2 });
}

async function prepare(tx: Tx, ctx: IsaContext, a: AssignmentRow, turnId: string, attempt: number, pinnedSeq: number, event: IsaEvent, now: Instant, aw: { repair: boolean; initiated: boolean } | null): Promise<Prepared> {
  // R-ISA-20: the last 20 messages to and from bound points only; inbound as client own text; team text not quotable;
  // never a portal sign-in link (module 45, b14 audit F1: flagged edit, defence in depth behind its sealed URL)
  const bound = Object.values(a.boundPoints).map((p) => p!.point_id);
  const msgs = await sql<{ id: string; direction: 'inbound' | 'outbound'; channel: 'sms' | 'email'; body: string; created_at: Date }>`
    SELECT m.id, m.direction, m.channel,
           -- R-ISA-17 E509: a facts message never re-enters a prompt (its prices, addresses and brokerages are server data)
           CASE WHEN m.direction = 'outbound' AND EXISTS (SELECT 1 FROM ai_isa_shared_facts f WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id)
                THEN '[listing details sent by the server]' ELSE m.body END AS body, m.created_at FROM messages m
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${a.contactId} AND m.channel IN ('sms','email')
       AND ((m.direction = 'inbound' AND NOT m.is_auto_reply AND (m.channel = 'sms' OR m.email_dkim_aligned IS TRUE)
             AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = m.tenant_id AND p.id = ANY (${bound}::uuid[]) AND p.address = m.from_address)
             AND NOT EXISTS (SELECT 1 FROM message_text_parts tp WHERE tp.tenant_id = m.tenant_id AND tp.message_id = m.id))
         OR (m.direction = 'outbound' AND m.status IN ('sent','delivered') AND m.action_category <> 'portal_login_link'
             AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = m.tenant_id AND p.id = ANY (${bound}::uuid[]) AND p.address = m.to_address)))
     ORDER BY m.created_at DESC LIMIT 20`.execute(tx);
  // ISA-3 H8 (R-ISA-20): a sent facts message enters the prompt as a fixed placeholder, never its body
  const placeholders = await factPlaceholdersInTx(tx, msgs.rows.map((m) => m.id));
  // ISA-3 H1: the seller bundle (handles, unavailable codes, flags); empty for a buyer
  const sb = await sellerBundleInTx(tx, actor((await sql<{ t: string }>`SELECT app.tenant_id()::text AS t`.execute(tx)).rows[0]!.t), a, now);
  const caps = capabilitiesInEffect(ctx.content, (await sql<{ c: string[] }>`SELECT capabilities AS c FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND id = ${a.optinId}`.execute(tx)).rows[0]?.c ?? ['converse']);
  const first = (await sql<{ n: string | null }>`SELECT split_part(COALESCE(display_name, ''), ' ', 1) AS n FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${a.contactId}`.execute(tx)).rows[0]?.n ?? null;
  // R-ISA-27 E495: an inbound email's own text is reliable only when clientOwnText says so (an inline reply under a
  // quoted offer is not); SMS and team text keep their text as written. ISA-3 H8: a sent facts message (buyer or
  // seller) is its fixed placeholder (R-ISA-20, E509)
  // b18 round 3 item 8 (R-PORTAL-20, after review item 5c for the assistant's contactBundle): every loaded body, inbound
  // or the team's, has a quoted portal sign-in token hidden before it becomes a prompt source (a record stored before
  // 0093 still holds one, and an outbound body is never redacted at storage); the stored record is not rewritten
  const messages = msgs.rows.reverse().map((m) => {
    const body = hideForDisplay(m.body).text ?? '';
    const own = m.direction === 'inbound' ? clientOwnText(body, m.channel) : null;
    return { messageId: m.id, direction: m.direction, channel: m.channel, text: own ? own.text : (placeholders.get(m.id) ?? body), at: instantFromDate(m.created_at), ownTextReliable: m.channel === 'sms' || m.direction === 'outbound' || own!.reliable };
  });
  // item 8: the calendar and the offer as decideAction sees them
  const calendarLive = await calendarLiveInTx(tx, a.ownerUserId);
  const mo = a.machine.offer;
  const turnOffer = mo === null ? null : { handle: 'O1', status: (mo.status === 'requested' ? 'pending_delivery' : mo.status) as 'pending_delivery' | 'offered' | 'accepting', slots: mo.slots, deliveredAt: mo.deliveredAt, zones: mo.zones };
  const nextSend = mo?.status === 'offered' ? await nextSendAtInTx(tx, { contactId: a.contactId, zones: ctx.zones, content: ctx.content, now }) : null;
  const inTime = (slot: Parameters<typeof confirmationInTime>[0]['slot']) => confirmationInTime({ slot, nextSendAt: nextSend, minNoticeHours: ctx.content.booking.minNoticeHours });
  // item 10: the buyer listing bundle (the database only; the model sees HandleLabels and nothing else)
  const bundle = aw !== null ? await buildBuyerBundleInTx(tx, ctx, { shareAllowed: caps.has('share_listings'), now }) : EMPTY_BUNDLE;
  const savedSearch = aw !== null ? await savedSearchAllowedInTx(tx, ctx, { capability: caps.has('propose_saved_search') }) : false;
  const replyChannel = (a.machine.lastInboundChannel && ctx.channels.includes(a.machine.lastInboundChannel) ? a.machine.lastInboundChannel : ctx.channels[0]) ?? 'sms';
  const prompt = buildIsaPrompt({
    side: a.side, phase: a.machine.phase, agentFirstName: ctx.who.agentFirstName, clientFirstName: first, allowedActions: ['reply', 'record_qualification', 'escalate', 'ready', 'follow_up', 'end',
      ...(bundle.handles.length > 0 ? ['share_listings'] : []), ...(savedSearch ? ['propose_saved_search'] : []),
      // ISA-3: the seller actions, offered only when its bundle has something to send (decideAction re-checks both)
      ...(caps.has('seller_competition') && sb.competitionHandles.length > 0 ? ['share_competition'] : []), ...(caps.has('seller_sold_comps') && sb.compsAvailable ? ['send_comps'] : []),
      ...(caps.has('book_appointments') && calendarLive && mo === null ? ['offer_slots'] : []), ...(caps.has('book_appointments') && mo?.status === 'offered' ? ['book_slot'] : [])],
    replyAllowedNow: ctx.facts.windowOpenNow, replyChannel, windowLabel: `${ctx.content.window.startSec / 3600}:00–${ctx.content.window.endSec / 3600}:00 local`,
    // ISA-2b's buyer bundle and ISA-3's seller bundle (H1): each is empty for the other side
    heldTopics: a.machine.held.map((h) => h.class), messages, claims: a.machine.claims, handles: [...bundle.handles, ...sb.handles],
    unavailable: [...(bundle.unavailable ? [`listings: ${bundle.unavailable}`] : []), ...(a.side === 'buyer' ? ['sold_comps_unavailable: PLATFORM_NOT_CLEARED'] : sb.unavailable)],
    offer: mo !== null && mo.status === 'offered' ? { handle: 'O1', slotLabels: mo.slots.map((sl, k) => `${k + 1}) ${formatSlot(sl, mo.zones[0]!)}`) } : null, ...(aw?.repair ? { repairNote: repairNote(['root']) } : {}),
  });
  const sources = messages.map((m, i) => ({ handle: `S${i + 1}`, messageId: m.messageId, author: m.direction === 'inbound' ? ('client_own' as const) : ('team' as const), channel: m.channel, text: m.text, at: m.at, ownTextReliable: m.ownTextReliable }));
  const decideBase: Prepared['decideBase'] = {
    side: a.side, capabilities: caps, replyChannel, sources, teamTexts: ctx.facts.teamTexts, listingHandles: new Set(bundle.handles.map((x) => x.handle)), competitionHandles: new Set(sb.competitionHandles), compsAvailable: sb.compsAvailable,
    heldClasses: new Set(a.machine.held.map((h) => h.class)), calendarLive, offer: turnOffer, meetRequested: a.machine.intents.length > 0,
    confirmationInTime: inTime, savedSearchAllowed: savedSearch, intents: a.machine.intents, priorClaims: a.machine.claims, appointmentBooked: a.machine.appointment,
    mlsListedElsewhere: sb.mlsListedElsewhere, subjectConfirmed: sb.subjectConfirmed, zone: ctx.facts.zone,
    identity: { brokerageLegalName: ctx.who.brokerageName, teamName: ctx.who.teamName, agentFirstName: ctx.who.agentFirstName, scope: 'agent', allowedLinkHosts: [] } as never,
    promptSources: prompt.sources, claimId: (i: number) => `${turnId.slice(0, 24)}${String(i).padStart(12, '0')}`.slice(0, 36),
  };
  return { a, ctx, turnId, attempt, pinnedSeq, event, prompt, bundle, decideBase };
}

/** One full turn (the job body). `run` is optional: the worker passes its job id so a legacy follow-up is told by its run_at and a budget hold knows its owner. */
export async function runTurn(deps: TurnDeps, tenantId: string, p: TurnPayload, run: TurnRun = {}): Promise<TurnResult> {
  // E908: a job with trigger `sweep` runs under a dedupe key every later sweep enqueue shares (…:sweep, :chain, :hold,
  // :replan, :recover). Parked until the rollover it would make those enqueues no-ops, and the sweep's other duties for
  // the care would wait with it. So it never parks at a budget: it finishes, and one resume job per care and epoch
  // (payload `resume`, its own key) owns the held turn. Every other job parks itself, and owns its turn by its job id.
  const park = p.trigger !== 'sweep' || p.resume === true;
  const me = p.resume === true ? RESUME_OWNER : run.jobId ?? null;
  const pre = await txA(deps, tenantId, p, run);
  if ('kind' in pre) return pre;
  let note: string | undefined;
  for (let call = pre.repair ? 1 : 0; call < 2; call += 1) {
    // R-ISA-20: every provider call is reserved first, with no turn lock held; at a daily limit the turn is held here
    const reservation = await reserveForTurn(deps, tenantId, pre.a, { id: pre.turnId, pinnedSeq: pre.pinnedSeq, repair: call > 0, owner: park ? me : RESUME_OWNER, park, inboundUnanswered: pre.a.machine.inboundUnanswered });
    if ('kind' in reservation) return reservation;
    const { runId } = reservation;
    const started = Date.now();
    let text = '';
    let model = 'none';
    let failed = false;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
      // E903 (R-ISA-20): one reservation is one provider request; the adapter makes no retry of its own (the turn has its
      // own repair call, reserved separately, and its own failure handling)
      const res = await deps.providers.ai.complete({ templateKey: pre.prompt.templateKey, system: pre.prompt.system, user: note ? `${pre.prompt.user}\n\nnote: ${note}` : pre.prompt.user, maxOutputTokens: pre.prompt.maxOutputTokens, singleRequest: true });
      text = res.text;
      model = res.model;
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
    } catch {
      failed = true;
    }
    const latency = Math.max(0, Date.now() - started);
    // Persist every provider outcome before the stale/control guards in TX-B can discard its decision.
    await withTenantTx(actor(tenantId), async (tx) => {
      const parsed = failed ? null : parseIsaModelOutput(text);
      const enc = text === '' ? null : Buffer.from(await deps.envelope.inTx(tx, tenantId as TenantId).encrypt(tenantId as TenantId, aiRunAad(runId as never), Buffer.from(text.slice(0, 64_000), 'utf8')));
      await sql`UPDATE ai_runs SET model = ${model.slice(0, 100)}, prompt_template_key = ${pre.prompt.templateKey},
        prompt_version = ${pre.prompt.templateVersion}, output_enc = ${enc}, key_version = ${enc === null ? null : 1},
        internal_signals = ${JSON.stringify(parsed === null ? { error: 'PROVIDER' } : parsed.ok ? {} : { error: parsed.code })}::jsonb,
        input_tokens = ${inputTokens}, output_tokens = ${outputTokens}, latency_ms = ${latency},
        status = ${parsed !== null && parsed.ok ? 'succeeded' : 'failed'}
        WHERE tenant_id = app.tenant_id() AND id = ${runId}`.execute(tx);
    }, { db: deps.db, retries: 2 });
    const r = await txB(deps, tenantId, pre, { runId, text, failed, repairAllowed: call === 0 });
    if (r.kind !== 'repair') return r.result;
    note = r.note;
  }
  return { kind: 'done', code: 'REPAIR_EXHAUSTED' };
}

type TxBResult = { kind: 'final'; result: TurnResult } | { kind: 'repair'; note: string };

async function txB(deps: TurnDeps, tenantId: string, pre: Prepared, m: { runId: string; text: string; failed: boolean; repairAllowed: boolean }): Promise<TxBResult> {
  return withTenantTx(actor(tenantId), async (tx, now): Promise<TxBResult> => {
    await lockForTurn(tx, pre.a.contactId, pre.a.id);
    const a = await assignmentById(tx, pre.a.id, 'update');
    // E492: a replayed attempt (or a turn a control canceled) updates zero rows and discards everything
    const guard = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'deciding' WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}
      AND status = 'deciding' AND attempt = ${pre.attempt} RETURNING id`.execute(tx);
    if (guard.rows.length === 0 || a === null) return { kind: 'final', result: { kind: 'done', code: 'DISCARDED' } };
    const fail = async (status: string, code: string): Promise<TxBResult> => {
      await sql`UPDATE ai_isa_turns SET status = ${status}, decision = ${JSON.stringify({ code })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
      return { kind: 'final', result: { kind: 'done', code } };
    };
    if (a.endedAt !== null || a.pausedAt !== null || a.epoch !== pre.a.epoch) return fail('canceled_paused', 'CONTROL_DURING_MODEL_CALL');
    const conv = await convSeq(tx, a.contactId);
    if (conv.seq > pre.pinnedSeq) {
      // E493: an inbound arrived during the model call: stale; a new turn reads both
      await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch }, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:${conv.seq}`, runAt: (now + 1000) as Instant });
      return fail('stale', 'ISA_STALE_REPLY');
    }
    const chain = await evaluateChain(tx, a, chainEnvOf(deps));
    if (chain.effect !== 'ok') return fail(chain.effect === 'hold' ? 'deferred' : 'canceled_paused', `CHAIN_${chain.effect.toUpperCase()}:${chain.worst?.code ?? ''}`);
    // Usage and encrypted output were persisted before the decision guards above.
    const parsed = m.failed ? null : parseIsaModelOutput(m.text);
    await sql`UPDATE ai_isa_turns SET ai_run_id = ${m.runId} WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
    const ctx = await contextFor(tx, a, now);
    const env = { tx, deps, actor: actor(tenantId), ctx, now, turnId: pre.turnId, pinnedSeq: pre.pinnedSeq, bundle: pre.bundle };
    if (parsed === null || !parsed.ok) {
      const r = step(a.machine, { type: 'model_failed', at: now, epoch: a.epoch, reason: parsed === null ? 'provider' : 'schema' }, ctx.facts);
      const repair = r.actions.some((x) => x.kind === 'await_model');
      await applyActionsInTx(env, { state: r.state, actions: r.actions.filter((x) => x.kind !== 'await_model') });
      if (repair && m.repairAllowed && parsed !== null) {
        // E906: the turn is in its repair phase; a retry that adopts it again makes the repair call, not a second first call
        await sql`UPDATE ai_isa_turns SET attempt = attempt + 1, decision = decision || '{"repair":true}'::jsonb WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
        pre.attempt += 1;
        return { kind: 'repair', note: repairNote(parsed.ok ? [] : parsed.paths) };
      }
      return fail(r.state.ended !== null ? 'escalated' : 'no_reply', parsed === null ? 'MODEL_FAILED' : `SCHEMA:${parsed.code}`);
    }
    const decision = decideAction(parsed.output, { ...pre.decideBase, now });
    const r = step(a.machine, { type: 'model_output', at: now, epoch: a.epoch, decision }, ctx.facts);
    const out = await applyActionsInTx(env, r);
    const codes = { reply: decision.reply !== null, replyBlocked: decision.replyBlocked?.codes ?? [], escalations: decision.escalations, claims: decision.claims.length, unusable: decision.unusableClaims.map((u) => u.code), ready: decision.ready?.rule ?? null, queued: out.queued.length };
    await sql`UPDATE ai_isa_turns SET decision = ${JSON.stringify(codes)}::jsonb,
        denied = ${JSON.stringify(decision.denied.map((d) => `${d.code}:${d.item}`.replace(/[^A-Za-z0-9_:.@-]/g, '_').slice(0, 64)))}::jsonb,
        status = CASE WHEN message_id IS NOT NULL THEN 'sending' WHEN ${out.ended} THEN 'handed_off' ELSE 'no_reply' END, state_after = ${r.state.ended !== null ? 'ended' : r.state.phase}
      WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
    return { kind: 'final', result: { kind: 'done', code: out.queued.length > 0 ? 'QUEUED' : out.ended ? 'ENDED' : 'NO_REPLY' } };
  }, { db: deps.db, retries: 2 });
}
