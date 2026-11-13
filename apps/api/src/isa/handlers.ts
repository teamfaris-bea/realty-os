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
import { ISA_BOOKING_DEFAULTS, refusalClass, step, type IsaFacts } from './coreSeam.js';
import { finalizeInTx, systemEndInTx } from './controls.js';
import { applyActionsInTx, cancelForAssignmentInTx, contextFor, type IsaDeps, pauseCardInTx } from './effects.js';
import { confirmationNotSentInTx, slaSweepInTx } from './handoff.js';
import { runBookJob } from './booking/book.js';
import { runOfferJob } from './booking/offer.js';
import { proposeAiSavedSearchInTx } from './buyer/savedSearch.js';
import { emitIsaSendResultsInTx } from './sendResult.js';
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
const BookPayload = jobPayload({ assignmentId: zId, offerId: zId });
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

/** send_result (§9.2 Dispatch): every terminal status of an AI ISA message moves its turn, facts, offer and handoff. */
export async function sendResultInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, messageId: string, now: Instant): Promise<string> {
  const m = await sql<{ status: string; reason: string | null; turn_id: string | null; assignment_id: string | null; category: string; dispatched_at: Date | null }>`
    SELECT m.status, m.status_reason AS reason, t.id AS turn_id, t.assignment_id, m.action_category AS category, m.dispatched_at FROM messages m
      LEFT JOIN ai_isa_turns t ON t.tenant_id = m.tenant_id AND t.message_id = m.id WHERE m.tenant_id = app.tenant_id() AND m.id = ${messageId}`.execute(tx);
  const r = m.rows[0];
  if (!r?.assignment_id) return 'NO_TURN';
  const a = await locked(tx, r.assignment_id);
  if (a === null) return 'NO_ASSIGNMENT';
  const ok = r.status === 'sent' || r.status === 'delivered';
  // R-ISA-21: a fact is sent only after its send result; dispatch_unknown keeps it pending until a reconcile decides
  if (r.status !== 'dispatch_unknown') {
    await sql`UPDATE ai_isa_shared_facts SET status = ${ok ? 'sent' : 'canceled'} WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND status = 'pending'`.execute(tx);
  }
  await sql`UPDATE ai_isa_turns SET status = ${ok ? 'sent' : r.status === 'dispatch_unknown' ? 'unknown' : r.status === 'canceled' ? 'canceled' : 'blocked'}
    WHERE tenant_id = app.tenant_id() AND id = ${r.turn_id} AND status IN ('sending','deferred')`.execute(tx);
  // the post-handoff message (§4.7): dispatch_unknown leaves it open; anything else but sent/delivered is not sent
  const ho = r.status === 'dispatch_unknown' ? { rows: [] } : await sql<{ id: string; recipient_user_id: string | null }>`UPDATE ai_isa_handoffs
      SET confirmation_status = ${ok ? 'sent' : r.status === 'canceled' ? 'canceled' : 'refused'}
    WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND pending_message_id = ${messageId} AND confirmation_status IN ('queued','scheduled')
    RETURNING id, recipient_user_id`.execute(tx);
  // item 9 (R-ISA-14 E533): an appointment confirmation that did not go out makes the card critical; ISA_HANDOFF_CLOSED
  // (a person reached them first) only says so
  if (!ok && ho.rows[0] && r.category === 'ai_isa_confirmation') {
    await confirmationNotSentInTx(tx, deps.ids, { id: ho.rows[0].id, assignmentId: a.id, contactId: a.contactId, recipientUserId: ho.rows[0].recipient_user_id },
      (r.reason ?? '').startsWith('ISA_HANDOFF_CLOSED') ? 'closed' : 'not_sent', now);
  }
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
  // the result steps at the dispatch instant, so a fast reply after the offer counts as after delivery (machine row 10)
  const at = ok && r.dispatched_at !== null ? (Math.min(now, r.dispatched_at.getTime()) as Instant) : now;
  const st = step(a.machine, { type: 'send_result', at, messageId, messageKind: kind as never, status: r.status as never, reasonCodes: reason ? [reason] : [] }, ctx.facts);
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
  await bookingSweepInTx(tx, deps, now);
  return { checked: rows.rows.length };
}

export const BOOKING_STUCK_MS = 5 * 60_000;

/**
 * The booking part of the sweep (items 8–9): an offer unsent at its expiry is canceled (OFFER_EXPIRED_UNSENT); a row
 * accepting for 5 minutes, or decided while the machine still says accepting, gets its book job again (tx#1 replays
 * a decided row straight to TX-C); a post-handoff confirmation still unsent at the slot's notice time is canceled
 * (CONFIRMATION_LATE) and the card made critical.
 */
export async function bookingSweepInTx(tx: Tx, deps: IsaDeps, now: Instant): Promise<void> {
  const unsent = await sql<{ id: string; m: string | null }>`SELECT o.id, o.offered_message_id AS m FROM ai_isa_slot_offers o WHERE o.tenant_id = app.tenant_id()
    AND o.status = 'pending_delivery' AND o.expires_at <= now() LIMIT 100`.execute(tx);
  for (const o of unsent.rows) {
    if (o.m) {
      const c = await sql<{ id: string }>`UPDATE messages SET status = 'canceled', status_reason = 'OFFER_EXPIRED_UNSENT' WHERE tenant_id = app.tenant_id() AND id = ${o.m}
        AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
      await emitIsaSendResultsInTx(tx, c.rows.map((x) => x.id), 'canceled');
    }
    await sql`UPDATE ai_isa_slot_offers SET status = 'expired', refusal_code = 'OFFER_EXPIRED_UNSENT' WHERE tenant_id = app.tenant_id() AND id = ${o.id} AND status = 'pending_delivery'`.execute(tx);
  }
  const stuck = await sql<{ id: string; assignment_id: string }>`SELECT o.id, o.assignment_id FROM ai_isa_slot_offers o JOIN ai_isa_assignments a ON a.tenant_id = o.tenant_id AND a.id = o.assignment_id
    WHERE o.tenant_id = app.tenant_id() AND (
        (o.status = 'accepting' AND o.updated_at < ${new Date(now - BOOKING_STUCK_MS)})
     OR (o.status IN ('accepted','refused') AND a.machine->'offer'->>'id' = o.id::text AND a.machine->'offer'->>'status' = 'accepting'))
    LIMIT 100`.execute(tx);
  for (const o of stuck.rows) {
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.book', payload: { assignmentId: o.assignment_id, offerId: o.id }, dedupeKey: `ai_isa.book:${o.id}` }); // the same key: deduped while a job is pending or running
  }
  const late = await sql<{ id: string; assignment_id: string; contact_id: string; recipient_user_id: string | null; m: string }>`SELECT h.id, h.assignment_id, h.contact_id, h.recipient_user_id, h.pending_message_id AS m
      FROM ai_isa_handoffs h JOIN messages m ON m.tenant_id = h.tenant_id AND m.id = h.pending_message_id
     WHERE h.tenant_id = app.tenant_id() AND h.confirmation_status IN ('queued','scheduled') AND m.action_category = 'ai_isa_confirmation' AND m.status IN ('queued','scheduled')
       AND (h.package->'appointmentDetail'->>'startsAt') IS NOT NULL
       AND (h.package->'appointmentDetail'->>'startsAt')::timestamptz - make_interval(hours => ${ISA_BOOKING_DEFAULTS.minNoticeHours}) <= now()
     LIMIT 100`.execute(tx);
  for (const x of late.rows) {
    const c = await sql<{ id: string }>`UPDATE messages SET status = 'canceled', status_reason = 'CONFIRMATION_LATE' WHERE tenant_id = app.tenant_id() AND id = ${x.m}
      AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
    if (c.rows.length === 0) continue;
    await sql`UPDATE ai_isa_handoffs SET confirmation_status = 'canceled' WHERE tenant_id = app.tenant_id() AND id = ${x.id}`.execute(tx);
    await confirmationNotSentInTx(tx, deps.ids, { id: x.id, assignmentId: x.assignment_id, contactId: x.contact_id, recipientUserId: x.recipient_user_id }, 'not_sent', now);
  }
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
  const calDeps = (providers: Providers) => { const d = isaDeps(depsFor, providers); return { ...d, adapters: providers.integrations, now: () => Date.now() }; };
  const offer: StandaloneJobHandler<z.infer<typeof OfferPayload>> = {
    kind: 'ai_isa.offer', queue: 'default', mode: 'standalone', via: 'assistant', schema: OfferPayload, maxAttempts: 5,
    async run(ctx, p) { await runOfferJob(calDeps(ctx.providers), ctx.actor.tenantId, p); },
  };
  const book: StandaloneJobHandler<z.infer<typeof BookPayload>> = {
    kind: 'ai_isa.book', queue: 'realtime', mode: 'standalone', via: 'assistant', schema: BookPayload, maxAttempts: 5,
    async run(ctx, p) { await runBookJob(calDeps(ctx.providers), ctx.actor.tenantId, p); },
  };
  const tx = <P>(kind: `${string}.${string}`, schema: TxJobHandler<P>['schema'], fn: (t: Tx, deps: IsaDeps, actor: SystemActor, p: P, now: Instant) => Promise<unknown>, queue: 'realtime' | 'default' = 'realtime'): TxJobHandler<P> => ({
    kind, queue, via: 'assistant', schema, async run(ctx, p) { await fn(ctx.tx, isaDeps(depsFor, ctx.providers), ctx.actor, p, ctx.now); },
  });
  return [
    turn as JobHandler<unknown>,
    tx('ai_isa.send_result', SendResultPayload, (t, d, a, p, now) => sendResultInTx(t, d, a, p.messageId, now)),
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
    // booking (§4.6): standalone jobs; the live calendar read holds no ISA lock (offer) or only lock 5 (book)
    offer as JobHandler<unknown>,
    book as JobHandler<unknown>,
    tx('ai_isa.saved_search', AssignmentPayload, async (t, d, _a, p, now) => {
      const asg = await locked(t, p.assignmentId);
      if (asg === null) return;
      await proposeAiSavedSearchInTx(t, d, await contextFor(t, asg, now), now);
    }, 'default'),
    { ...tx('ai_isa.sla', Empty, (t, d, _a, _p, now) => slaSweepInTx(t, d.ids, now), 'default'), every: { ms: AI_ISA_SLA_EVERY_MS, offsetMs: 20_000 }, periodicPayload: {} } as JobHandler<unknown>,
    { ...tx('ai_isa.sweep', Empty, (t, d, a, _p, now) => sweepInTx(t, d, a, now), 'default'), every: { ms: AI_ISA_SWEEP_EVERY_MS, offsetMs: 40_000 }, periodicPayload: {} } as JobHandler<unknown>,
  ] as JobHandler<unknown>[];
}

export const isaHandlers: JobHandler<unknown>[] = makeIsaHandlers();
export { NOFACTS, instantFromDate };
