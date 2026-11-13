// Worker jobs of module 75 (docs/AI_ISA.md §9.2). Lease recovery has ONE path, the job lease (worker/loop.ts): a
// replayed turn's TX-B is attempt-guarded and discards everything; the sweep re-enqueues a `deciding` turn only when
// no live job holds its key and 8 minutes have passed.
import type { Instant, SystemActor } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import type { Providers } from '../providers/index.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { refusalClass, step, type IsaFacts } from './coreSeam.js';
import { finalizeInTx, systemEndInTx } from './controls.js';
import { applyActionsInTx, cancelForAssignmentInTx, contextFor, type IsaDeps, pauseCardInTx } from './effects.js';
import { slaSweepInTx } from './handoff.js';
import { type AssignmentRow, assignmentById, lockForTurn } from './repo.js';
import { HOLD_CODES } from './send.js';
import { backstopInTx } from './backstop.js';
import { runTurn, type TurnDeps } from './turn.js';

type DepsFor = (providers: Providers) => CommsDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

const TurnPayload = jobPayload({ assignmentId: zId, trigger: z.enum(['start', 'inbound', 'timer', 'control', 'sweep']), timer: z.enum(['follow_up', 'offer_expiry', 'pause_expiry', 'inactivity_warning']).optional(), epoch: z.number().int().min(1) });
const SendResultPayload = jobPayload({ messageId: zId, status: z.string().regex(/^[a-z_]{2,20}$/) });
const SignalPayload = jobPayload({ signalId: zId });
const AssignmentPayload = jobPayload({ assignmentId: zId, epoch: z.number().int().min(1).optional() });
const BackstopPayload = jobPayload({ assignmentId: zId, messageId: zId.optional() });
const OfferPayload = jobPayload({ assignmentId: zId, epoch: z.number().int().min(1), kind: z.enum(['buyer_consult', 'listing_appointment', 'consult']) });
const BookPayload = jobPayload({ assignmentId: zId, offerId: zId, slot: z.number().int().min(1).max(3), messageId: zId });
const Empty = jobPayload({});

export const AI_ISA_SWEEP_EVERY_MS = 5 * 60_000;
export const AI_ISA_SLA_EVERY_MS = 60_000;
export const STUCK_TURN_MS = 8 * 60_000;
export const PAUSE_EXPIRY_MS = 72 * 3_600_000;

function isaDeps(depsFor: DepsFor, providers: Providers): TurnDeps {
  return depsFor(providers) as TurnDeps;
}

async function locked(tx: Tx, id: string): Promise<AssignmentRow | null> {
  const peek = await assignmentById(tx, id);
  if (peek === null) return null;
  await lockForTurn(tx, peek.contactId, peek.id);
  return assignmentById(tx, id, 'update');
}

/**
 * send_result (§9.2 Dispatch): every terminal status of an AI ISA message moves its turn, facts, offer and handoff.
 * The job handles the status it names (b12 recheck R1): each status change enqueues its own job (send.ts
 * emitSendResultInTx), statuses only move forward, so a job whose status the message has already left was overtaken
 * by a later status with its own job and does nothing (one carrier failure is counted once, E518). The status is
 * read after the turn lock, which the status callback and TX2 also take.
 */
export async function sendResultInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, messageId: string, status: string, now: Instant): Promise<string> {
  const read = () => sql<{ status: string; reason: string | null; turn_id: string | null; assignment_id: string | null; category: string }>`
    SELECT m.status, m.status_reason AS reason, t.id AS turn_id, t.assignment_id, m.action_category AS category FROM messages m
      LEFT JOIN ai_isa_turns t ON t.tenant_id = m.tenant_id AND t.message_id = m.id WHERE m.tenant_id = app.tenant_id() AND m.id = ${messageId}`.execute(tx);
  const peek = (await read()).rows[0];
  if (!peek?.assignment_id) return 'NO_TURN';
  const a = await locked(tx, peek.assignment_id);
  if (a === null) return 'NO_ASSIGNMENT';
  const r = (await read()).rows[0]!;
  if (r.status !== status) return 'OVERTAKEN';
  const ok = r.status === 'sent' || r.status === 'delivered';
  await sql`UPDATE ai_isa_shared_facts SET status = ${ok ? 'sent' : 'canceled'} WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND status = 'pending'`.execute(tx);
  await sql`UPDATE ai_isa_turns SET status = ${ok ? 'sent' : r.status === 'dispatch_unknown' ? 'unknown' : r.status === 'canceled' ? 'canceled' : 'blocked'}
    WHERE tenant_id = app.tenant_id() AND id = ${r.turn_id} AND status IN ('sending','deferred','unknown')`.execute(tx);
  await sql`UPDATE ai_isa_handoffs SET confirmation_status = ${ok ? 'sent' : r.status === 'canceled' ? 'canceled' : 'refused'}
    WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND pending_message_id = ${messageId} AND confirmation_status IN ('queued','scheduled')`.execute(tx);
  if (!ok && r.status !== 'dispatch_unknown') {
    await sql`UPDATE assistant_actions SET status = 'blocked' WHERE tenant_id = app.tenant_id() AND id = (SELECT assistant_action_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId}) AND status = 'proposed'`.execute(tx);
  }
  if (a.endedAt !== null) return 'POST_HANDOFF';
  const reason = r.reason ?? '';
  // a hold: no pause, no per-lead card, no self-retry of that message; the turn waits for the switch or the cap (§5.5)
  if (HOLD_CODES.has(reason)) {
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'sweep', epoch: a.epoch }, runAt: (now + 15 * 60_000) as Instant, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:hold` });
    return 'HOLD';
  }
  const cls = ok ? 'ok' : refusalClass([reason]);
  if (cls === 'end_care') {
    await systemEndInTx(tx, deps, actor, a, 'opted_out', now, { stop: 'opted_out' });
    return 'END_CARE';
  }
  if (cls === 'replan' && !ok) {
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'sweep', epoch: a.epoch }, runAt: (now + 1000) as Instant, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:replan:${messageId}` });
    return 'REPLAN';
  }
  const ctx = await contextFor(tx, a, now);
  const kind = (await sql<{ k: string | null }>`SELECT payload->>'messageKind' AS k FROM assistant_actions WHERE tenant_id = app.tenant_id()
    AND id = (SELECT assistant_action_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId})`.execute(tx)).rows[0]?.k ?? 'conversation';
  const st = step(a.machine, { type: 'send_result', at: now, messageId, messageKind: kind as never, status: r.status as never, reasonCodes: reason ? [reason] : [] }, ctx.facts);
  await applyActionsInTx({ tx, deps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, st);
  return ok ? 'SENT' : cls.toUpperCase();
}

/** The stop-signal job (R-ISA-31): idempotent on the signal; ends every live assignment of the person it names. */
export async function stopSignalInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, signalId: string, now: Instant): Promise<number> {
  const s = await sql<{ reason: string; hmac: string | null; contact_id: string | null }>`SELECT reason, encode(address_hmac, 'hex') AS hmac, contact_id FROM ai_isa_stop_signals
    WHERE tenant_id = app.tenant_id() AND id = ${signalId}`.execute(tx);
  const sig = s.rows[0];
  if (!sig) return 0;
  const live = await sql<{ id: string }>`SELECT DISTINCT a.id FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL AND (
      (${sig.contact_id}::uuid IS NOT NULL AND a.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${sig.contact_id}::uuid)))
      OR EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = a.tenant_id AND encode(p.address_hmac, 'hex') = ${sig.hmac ?? ''}
                   AND (a.contact_id = ANY (app.contact_person_ids(app.tenant_id(), p.contact_id)))))`.execute(tx);
  let n = 0;
  for (const row of live.rows) {
    const a = await locked(tx, row.id);
    if (a === null || a.endedAt !== null) continue;
    if (await systemEndInTx(tx, deps, actor, a, sig.reason as never, now, { stop: sig.reason as never })) n += 1;
    await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.backstop', payload: { assignmentId: a.id }, dedupeKey: `ai_isa.backstop_all:${a.id}` });
  }
  return n;
}

/** The sweep (every 5 minutes): link failures, pause expiry, inactivity warnings, stuck turns, overdue finalizes. */
export async function sweepInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, now: Instant): Promise<{ checked: number }> {
  const rows = await sql<{ id: string; paused_at: Date | null; finalize_at: Date | null; warn: Date | null; epoch: number }>`SELECT a.id, a.paused_at, a.finalize_at,
      c.inactivity_warn_at AS warn, a.epoch FROM ai_isa_assignments a JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
    WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL ORDER BY a.updated_at LIMIT 200`.execute(tx);
  for (const r of rows.rows) {
    if (r.finalize_at !== null && r.finalize_at.getTime() <= now) { await finalizeInTx(tx, deps, actor, r.id, now); continue; }
    if (r.paused_at !== null && now - r.paused_at.getTime() >= PAUSE_EXPIRY_MS) {
      await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.turn', payload: { assignmentId: r.id, trigger: 'timer', timer: 'pause_expiry', epoch: r.epoch }, dedupeKey: `ai_isa.timer:${r.id}:pause_expiry` });
      continue;
    }
    if (r.warn !== null && r.warn.getTime() <= now) {
      await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.turn', payload: { assignmentId: r.id, trigger: 'timer', timer: 'inactivity_warning', epoch: r.epoch }, dedupeKey: `ai_isa.timer:${r.id}:inactivity` });
      continue;
    }
    // the link-failure table and the stop-signal backstop run through the turn's TX-A (one table everywhere)
    await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.turn', payload: { assignmentId: r.id, trigger: 'sweep', epoch: r.epoch }, dedupeKey: `ai_isa.turn:${r.id}:${r.epoch}:sweep` });
  }
  // stuck turns: deciding for 8 minutes with no live job holding the turn key
  const stuck = await sql<{ assignment_id: string; epoch: number }>`SELECT t.assignment_id, t.epoch FROM ai_isa_turns t WHERE t.tenant_id = app.tenant_id()
    AND t.status = 'deciding' AND t.updated_at < ${new Date(now - STUCK_TURN_MS)}`.execute(tx);
  for (const t of stuck.rows) {
    await sql`UPDATE ai_isa_turns SET status = 'canceled' WHERE tenant_id = app.tenant_id() AND assignment_id = ${t.assignment_id} AND status = 'deciding' AND updated_at < ${new Date(now - STUCK_TURN_MS)}`.execute(tx);
    await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.turn', payload: { assignmentId: t.assignment_id, trigger: 'sweep', epoch: t.epoch }, dedupeKey: `ai_isa.turn:${t.assignment_id}:${t.epoch}:recover` });
  }
  return { checked: rows.rows.length };
}

const NOFACTS = {} as IsaFacts;

export function makeIsaHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const turn: StandaloneJobHandler<z.infer<typeof TurnPayload>> = {
    kind: 'ai_isa.turn', queue: 'realtime', mode: 'standalone', via: 'assistant', schema: TurnPayload, maxAttempts: 5,
    async run(ctx, p) {
      const deps = isaDeps(depsFor, ctx.providers);
      const r = await runTurn(deps, ctx.actor.tenantId, p);
      if (r.kind === 'retry') return { retryAt: r.retryAt };
    },
  };
  const tx = <P>(kind: `${string}.${string}`, schema: TxJobHandler<P>['schema'], fn: (t: Tx, deps: IsaDeps, actor: SystemActor, p: P, now: Instant) => Promise<unknown>, queue: 'realtime' | 'default' = 'realtime'): TxJobHandler<P> => ({
    kind, queue, via: 'assistant', schema, async run(ctx, p) { await fn(ctx.tx, isaDeps(depsFor, ctx.providers), ctx.actor, p, ctx.now); },
  });
  return [
    turn as JobHandler<unknown>,
    tx('ai_isa.send_result', SendResultPayload, (t, d, a, p, now) => sendResultInTx(t, d, a, p.messageId, p.status, now)),
    tx('ai_isa.stop_signal', SignalPayload, (t, d, a, p, now) => stopSignalInTx(t, d, a, p.signalId, now)),
    tx('ai_isa.finalize', AssignmentPayload, (t, d, a, p, now) => finalizeInTx(t, d, a, p.assignmentId, now)),
    tx('ai_isa.after_control', AssignmentPayload, async (t, d, _a, p, now) => {
      const a = await locked(t, p.assignmentId);
      if (a === null) return;
      await cancelForAssignmentInTx(t, a, 'AI_ISA_PAUSED');
      if (a.pausedAt !== null) await pauseCardInTx({ tx: t, deps: d, ctx: await contextFor(t, a, now), now }, a.pauseReason ?? 'user');
      await backstopInTx(t, d, a, null, now);
    }),
    tx('ai_isa.backstop', BackstopPayload, async (t, d, _a, p, now) => {
      const a = await assignmentById(t, p.assignmentId);
      if (a !== null) await backstopInTx(t, d, a, p.messageId ?? null, now);
    }, 'default'),
    // booking (§4.6) is not built in this lane's slice: an offer request is answered honestly as unavailable
    // (hold_topic booking_unavailable: "I couldn't confirm a time right now. {Agent} will reach out to set one.")
    tx('ai_isa.offer', OfferPayload, async (t, d, a, p, now) => {
      const asg = await locked(t, p.assignmentId);
      if (asg === null || asg.endedAt !== null || asg.epoch !== p.epoch) return;
      const ctx = await contextFor(t, asg, now);
      const r = step(asg.machine, { type: 'offer_unavailable', at: now }, ctx.facts);
      await applyActionsInTx({ tx: t, deps: d, actor: a, ctx, now, turnId: null, pinnedSeq: asg.lastInboundSeq }, r);
    }, 'default'),
    tx('ai_isa.book', BookPayload, async (t, d, a, p, now) => {
      const asg = await locked(t, p.assignmentId);
      if (asg === null || asg.endedAt !== null) return;
      const ctx = await contextFor(t, asg, now);
      const r = step(asg.machine, { type: 'booking_result', at: now, ok: false, code: 'CALENDAR_UNAVAILABLE' }, ctx.facts);
      await applyActionsInTx({ tx: t, deps: d, actor: a, ctx, now, turnId: null, pinnedSeq: asg.lastInboundSeq }, r);
    }),
    tx('ai_isa.saved_search', AssignmentPayload, async () => undefined, 'default'),
    { ...tx('ai_isa.sla', Empty, (t, d, _a, _p, now) => slaSweepInTx(t, d.ids, now), 'default'), every: { ms: AI_ISA_SLA_EVERY_MS, offsetMs: 20_000 }, periodicPayload: {} } as JobHandler<unknown>,
    { ...tx('ai_isa.sweep', Empty, (t, d, a, _p, now) => sweepInTx(t, d, a, now), 'default'), every: { ms: AI_ISA_SWEEP_EVERY_MS, offsetMs: 40_000 }, periodicPayload: {} } as JobHandler<unknown>,
  ] as JobHandler<unknown>[];
}

export const isaHandlers: JobHandler<unknown>[] = makeIsaHandlers();
export { NOFACTS, instantFromDate };
