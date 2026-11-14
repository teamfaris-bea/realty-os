// The one path that carries out the core machine's actions (docs/AI_ISA.md §4.1, §9.2). Turns, controls, the stop-
// signal job, the sweep and the send-result job all call applyActionsInTx inside a SYSTEM transaction that already
// holds locks 2 → 4 (§3.7). Nothing here calls a provider. Every message goes through queueOutboundInTx and then
// dispatchOutbound (D1, the gate's checks 0/8/12 and the DB guard decide again at send).
import { createHash } from 'node:crypto';
import type { IdGenerator, Instant, SystemActor } from '@realty/core/foundation';
import { type IanaZone, toIso } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { adminUserIds, contactLabel, notifyUser, upsertFeedItem } from '../comms/repos/notify.js';
import type { CommsDeps } from '../comms/types.js';
import {
  AI_ISA_PROMPT_VERSION, AI_ISA_RULES_VERSION, type AiIsaContent, aiIsaRecipientZones, aiIsaSendWindow, composeMessage, DEFAULT_AI_ISA_CONTENT, fillLine,
  type IsaAction, type IsaFacts, type IsaState, type LineIdentity, parseAiIsaContent, type QueueMessage, renderConfirmation, renderOffer, step, type StepResult,
} from './coreSeam.js';
import { writeHandoffInTx } from './handoff.js';
import { emitIsaSendResultsInTx } from './sendResult.js';
import { markAcceptingInTx, reconcileOfferRowsInTx } from './booking/rows.js';
import type { BuyerBundle } from './buyer/bundle.js';
import { pauseAiSearchesAtHandoffInTx } from './buyer/handoffSearches.js';
import { insertPendingFactsInTx, type PlannedFacts, planFactsMessageInTx } from './buyer/facts.js';
import { type AssignmentRow, type ChainEnv, saveMachine } from './repo.js';
import { onEscalationInTx, renderSellerFactsInTx, writeSellerFactsInTx } from './seller/index.js';

export type IsaDeps = Pick<CommsDeps, 'db' | 'ids' | 'providers' | 'aiIsaLiveOff'>;

export function chainEnvOf(deps: Pick<CommsDeps, 'providers' | 'aiIsaLiveOff'>): ChainEnv {
  return { liveOff: deps.aiIsaLiveOff ?? { sms: false, email: false }, telephonyOff: deps.providers.telephony.liveRequestsOff?.() === true };
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const ISA_CATS = { conversation: 'ai_isa_message', facts: 'ai_isa_message', offer: 'ai_isa_message', confirmation: 'ai_isa_confirmation', holding_line: 'ai_isa_holding_line' } as const;

export interface IsaContext {
  a: AssignmentRow;
  content: AiIsaContent;
  versionSha: string;
  who: LineIdentity;
  zones: IanaZone[];
  zoneSource: 'explicit' | 'union';
  facts: IsaFacts;
  channels: ('sms' | 'email')[];
}

/** The facts one transition needs, read in `tx` (the policy content, the identity, the zones, the thread's team texts). */
export async function contextFor(tx: Tx, a: AssignmentRow, now: Instant): Promise<IsaContext> {
  const v = await sql<{ steps: unknown; sha: string }>`SELECT steps, content_sha256 AS sha FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${a.playbookVersionId}`.execute(tx);
  const content = parseAiIsaContent(v.rows[0]?.steps) ?? (DEFAULT_AI_ISA_CONTENT as AiIsaContent);
  const id = await sql<{ first: string | null; team: string | null; brokerage: string; tz: string; ctz: string | null; csrc: string | null }>`
    SELECT split_part(COALESCE(u.display_name, ''), ' ', 1) AS first, s.team_name AS team, s.brokerage_legal_name AS brokerage, s.default_timezone AS tz,
           c.timezone AS ctz, c.timezone_source AS csrc
      FROM tenant_settings s JOIN contacts c ON c.tenant_id = s.tenant_id AND c.id = ${a.contactId}
      LEFT JOIN users u ON u.id = ${a.ownerUserId}
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const r = id.rows[0]!;
  const who: LineIdentity = { agentFirstName: r.first && r.first.trim() !== '' ? r.first : 'your agent', teamName: r.team ?? r.brokerage, brokerageName: r.brokerage };
  const pts = await sql<{ kind: string; address: string; tz: string | null }>`SELECT kind, address, timezone AS tz FROM contact_points
    WHERE tenant_id = app.tenant_id() AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid))
      AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM 'wrong_number')`.execute(tx);
  const addr = await sql<{ region: string | null }>`SELECT region FROM contact_addresses WHERE tenant_id = app.tenant_id()
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid))`.execute(tx);
  const inq = await sql<{ pc: string | null }>`SELECT postal_code AS pc FROM lead_inquiries WHERE tenant_id = app.tenant_id() AND contact_id = ${a.contactId}
    ORDER BY received_at DESC LIMIT 1`.execute(tx);
  const rz = aiIsaRecipientZones({
    contactTz: r.ctz, contactTzSource: r.csrc, phones: pts.rows.filter((p) => p.kind === 'phone').map((p) => p.address), pointTzs: pts.rows.map((p) => p.tz),
    tenantZone: r.tz, inquiryPostalCode: inq.rows[0]?.pc ?? null, addressStates: addr.rows.map((x) => x.region),
  });
  const team = await sql<{ body: string }>`SELECT m.body FROM messages m WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${a.contactId}
    AND m.direction = 'outbound' ORDER BY m.created_at DESC LIMIT 40`.execute(tx);
  const recent = await sql<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${a.contactId}
    AND direction = 'inbound' AND created_at > now() - interval '10 minutes'`.execute(tx);
  const channels = (Object.keys(a.boundPoints) as ('sms' | 'email')[]).filter((c) => content.channels.includes(c));
  const windowOpenNow = aiIsaSendWindow({ at: now, zones: rz.zones, startSec: content.window.startSec, endSec: content.window.endSec, initiated: false, initiatedDays: content.initiatedDays, noInitiatedOnHolidays: false }) === now;
  const facts: IsaFacts = {
    who, content, windowOpenNow, teamTexts: team.rows.map((t) => t.body), recentInboundCount: recent.rows[0]!.n, zone: (rz.zones[0] ?? r.tz) as IanaZone,
    mlsListedElsewhere: false, subjectConfirmed: false,
  };
  return { a, content, versionSha: v.rows[0]?.sha ?? '', who, zones: rz.zones, zoneSource: rz.source, facts, channels };
}

/** One turn row (the system appends; trigger_key unique per assignment). Returns the id (an existing row is reused). */
export async function ensureTurn(tx: Tx, ids: IdGenerator, ctx: IsaContext, t: { triggerKind: string; triggerKey: string; pinnedSeq: number; status?: string }): Promise<{ id: string; attempt: number; reused: boolean }> {
  const ex = await sql<{ id: string; attempt: number }>`SELECT id, attempt FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${ctx.a.id} AND trigger_key = ${t.triggerKey}`.execute(tx);
  if (ex.rows[0]) {
    const u = await sql<{ attempt: number }>`UPDATE ai_isa_turns SET attempt = attempt + 1 WHERE tenant_id = app.tenant_id() AND id = ${ex.rows[0].id} RETURNING attempt`.execute(tx);
    return { id: ex.rows[0].id, attempt: u.rows[0]!.attempt, reused: true };
  }
  const seq = await sql<{ n: number }>`SELECT COALESCE(max(seq), 0)::int + 1 AS n FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${ctx.a.id}`.execute(tx);
  const id = ids.next<'X'>() as string;
  await sql`INSERT INTO ai_isa_turns (tenant_id, id, assignment_id, contact_id, seq, epoch, trigger_kind, trigger_key, pinned_inbound_seq, state_before, status,
      rules_version, policy_version, prompt_version)
    VALUES (app.tenant_id(), ${id}, ${ctx.a.id}, ${ctx.a.contactId}, ${seq.rows[0]!.n}, ${ctx.a.epoch}, ${t.triggerKind}, ${t.triggerKey}, ${t.pinnedSeq},
      ${ctx.a.machine.phase}, ${t.status ?? 'deciding'}, ${AI_ISA_RULES_VERSION}, ${ctx.versionSha}, ${AI_ISA_PROMPT_VERSION})`.execute(tx);
  return { id, attempt: 1, reused: false };
}

export interface ApplyEnv {
  tx: Tx;
  deps: IsaDeps;
  actor: SystemActor;
  ctx: IsaContext;
  now: Instant;
  turnId: string | null;
  pinnedSeq: number;
  /**
   * TX-C: the booking's appointment detail and notes for the handoff package (codes, ids, times, the verified quote).
   * confirmationNotQueued: booked while paused (E523), so the planned confirmation is not queued (b13 final M2).
   */
  handoffExtra?: { appointmentDetail?: Record<string, unknown>; notes?: string[]; confirmationNotQueued?: boolean } | undefined;
  /** TX-B: this turn's buyer bundle (item 10); a facts message renders only from it */
  bundle?: BuyerBundle | undefined;
}

export interface ApplyOutcome {
  state: IsaState;
  queued: string[];
  handoffId: string | null;
  ended: boolean;
  paused: boolean;
  denied: string[];
}

/** Applies a step result: persists the state and carries out each action in order. */
export async function applyActionsInTx(env: ApplyEnv, r: StepResult): Promise<ApplyOutcome> {
  const { tx, deps, ctx, now } = env;
  const out: ApplyOutcome = { state: r.state, queued: [], handoffId: null, ended: false, paused: false, denied: [] };
  let pendingMessageId: string | null = null;
  let handoffAction: Extract<IsaAction, { kind: 'handoff' }> | null = null;
  let bookNotOffered = false;
  let confirmationNotQueued = false;
  for (const act of r.actions) {
    switch (act.kind) {
      case 'cancel_messages':
        await cancelForAssignmentInTx(tx, ctx.a, 'AI_ISA_CARE_CHANGED');
        break;
      case 'cancel_timers':
        // timers are idempotent jobs that re-read the state; a stale timer is a no-op (epoch and phase checks)
        break;
      case 'queue_message': {
        const id = await queueIsaMessageInTx(env, act, r.state);
        if (id !== null) {
          out.queued.push(id);
          if (handoffAction !== null || r.state.ended !== null) pendingMessageId = id;
        } else if (act.messageKind === 'confirmation') confirmationNotQueued = true; // b13 review B13-MRG-3
        break;
      }
      case 'handoff':
        handoffAction = act;
        break;
      case 'block_person':
        await sql`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, assignment_id, reason)
          SELECT app.tenant_id(), ${deps.ids.next<'X'>() as string}, ${ctx.a.contactId}, ${ctx.a.id}, ${blockReason(String(act.reason))}
          WHERE NOT EXISTS (SELECT 1 FROM ai_isa_person_blocks b WHERE b.tenant_id = app.tenant_id() AND b.contact_id = ${ctx.a.contactId} AND b.lifted_at IS NULL)`.execute(tx);
        break;
      case 'escalate':
        if (act.type !== 'terminal') await escalationCardInTx(env, act.class, act.type, act.priority);
        await onEscalationInTx(tx, ctx.a, act.class, env.actor); // ISA-3 H6: a pricing hold suspends comps (E502), audited (b13 review B13-MRG-4)
        break;
      case 'pause':
        await sql`UPDATE ai_isa_assignments SET paused_at = ${new Date(now)}, paused_by_kind = 'system', pause_reason = ${act.reason}
          WHERE tenant_id = app.tenant_id() AND id = ${ctx.a.id} AND paused_at IS NULL AND ended_at IS NULL`.execute(tx);
        await control(tx, deps.ids, ctx.a, 'system_pause', act.reason);
        await audit(tx, env.actor, { action: 'ai_isa.system_paused', entity: { type: 'ai_isa_assignment', id: ctx.a.id }, reason: act.reason });
        await pauseCardInTx(env, act.reason);
        out.paused = true;
        break;
      case 'schedule_timer':
        await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.turn', payload: { assignmentId: ctx.a.id, trigger: 'timer', timer: act.timer, epoch: ctx.a.epoch },
          runAt: act.at, dedupeKey: `ai_isa.timer:${ctx.a.id}:${act.timer}:${act.at}` });
        if (act.timer === 'follow_up') await sql`UPDATE ai_isa_assignments SET next_follow_up_at = ${new Date(act.at)} WHERE tenant_id = app.tenant_id() AND id = ${ctx.a.id} AND ended_at IS NULL`.execute(tx);
        break;
      case 'request_offer':
        await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.offer', payload: { assignmentId: ctx.a.id, epoch: ctx.a.epoch, kind: act.appointmentKind },
          dedupeKey: `ai_isa.offer:${ctx.a.id}:${ctx.a.epoch}:${r.state.counters.bookingFailures}` });
        break;
      case 'book':
        // item 9: only an `offered`, unexpired row moves to accepting (the agreed slot, the message, the own-text quote)
        if (await markAcceptingInTx(tx, { offerId: act.offerId, assignmentId: ctx.a.id, slotIndex: act.slotIndex, messageId: act.messageId })) {
          await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.book', payload: { assignmentId: ctx.a.id, offerId: act.offerId }, dedupeKey: `ai_isa.book:${act.offerId}` });
        } else {
          out.denied.push('book:OFFER_NOT_OFFERED');
          bookNotOffered = true;
        }
        break;
      case 'propose_saved_search':
        await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.saved_search', payload: { assignmentId: ctx.a.id }, dedupeKey: `ai_isa.saved_search:${ctx.a.id}` });
        break;
      case 'denied':
        out.denied.push(...act.codes);
        break;
      case 'end':
        // the counters' columns end with the machine (b12 recheck R12: the text that reached the limit is counted there too)
        await sql`UPDATE ai_isa_assignments SET ended_at = ${new Date(now)}, end_reason = ${act.reason}, ended_by_kind = 'system', state = 'ended',
            machine = ${JSON.stringify(r.state)}::jsonb, finalize_at = NULL, finalize_kind = NULL, messages_sent = ${r.state.counters.messagesSent},
            unanswered_initiated = ${r.state.counters.unansweredInitiated}, undelivered_streak = ${r.state.counters.undeliveredStreak}
          WHERE tenant_id = app.tenant_id() AND id = ${ctx.a.id} AND ended_at IS NULL`.execute(tx);
        await control(tx, deps.ids, ctx.a, 'system_end', act.reason);
        await audit(tx, env.actor, { action: 'ai_isa.system_ended', entity: { type: 'ai_isa_assignment', id: ctx.a.id }, reason: act.reason });
        await pauseSavedSearchesInTx(tx, ctx.a.contactId);
        // b14 to-do (b13 review B13-MRG-3 side effect): a merge ends care on a record nobody opens any more; its "they
        // replied, the AI assistant is answering" card is resolved there (the merge handoff on the survivor carries on)
        if (act.reason === 'merged') {
          await sql`UPDATE priority_feed_items SET state = 'done', resolved_at = ${new Date(now)}, snoozed_until = NULL, updated_at = now()
            WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`ai_isa_activity:${ctx.a.id}`} AND state IN ('open','snoozed')`.execute(tx);
        }
        out.ended = true;
        break;
      case 'await_model':
      case 'record_claims':
      case 'resume':
        break;
    }
  }
  if (handoffAction !== null) {
    const ins = await inFlightNotes(tx, ctx.a.contactId, pendingMessageId);
    out.handoffId = await writeHandoffInTx(tx, deps.ids, env.actor, ctx.a, { handoff: handoffAction.handoff, pendingMessageId,
      confirmationNotQueued: confirmationNotQueued || env.handoffExtra?.confirmationNotQueued === true, notes: [...(env.handoffExtra?.notes ?? []), ...ins],
      ...(env.handoffExtra?.appointmentDetail ? { appointmentDetail: env.handoffExtra.appointmentDetail } : {}) }, now);
  }
  if (!out.ended) {
    await saveMachine(tx, ctx.a, r.state);
    await reconcileOfferRowsInTx(tx, ctx.a.id, r.state);
  }
  if (bookNotOffered && !out.ended && r.state.offer?.status === 'accepting') {
    // the row was not `offered` (expired or replaced): no booking; the machine hears an honest failure
    const next = step(r.state, { type: 'booking_result', at: now, ok: false, code: 'CALENDAR_UNAVAILABLE' }, ctx.facts);
    const more = await applyActionsInTx({ ...env, ctx: { ...ctx, a: { ...ctx.a, machine: r.state } } }, next);
    return { ...more, queued: [...out.queued, ...more.queued], denied: [...out.denied, ...more.denied] };
  }
  return out;
}

async function inFlightNotes(tx: Tx, contactId: string, except: string | null): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT id FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'outbound'
    AND initiator = 'assistant' AND status IN ('dispatching','dispatch_unknown') ${except ? sql`AND id <> ${except}` : sql``}`.execute(tx);
  return r.rows.map((m) => `IN_FLIGHT:${m.id}`);
}

const BLOCKS = new Set(['opted_out', 'possible_opt_out', 'complaint', 'wrong_number', 'has_agent', 'ai_declined', 'consent_dispute', 'do_not_contact']);
function blockReason(r: string): string {
  if (BLOCKS.has(r)) return r;
  if (r === 'opt_out' || r === 'suppressed') return 'opted_out';
  return 'complaint';
}

export async function control(tx: Tx, ids: IdGenerator, a: Pick<AssignmentRow, 'id' | 'contactId'>, kind: string, reason: string, byUserId: string | null = null): Promise<void> {
  await sql`INSERT INTO ai_isa_controls (tenant_id, id, assignment_id, contact_id, kind, by_kind, by_user_id, reason)
    VALUES (app.tenant_id(), ${ids.next<'X'>() as string}, ${a.id}, ${a.contactId}, ${kind}, ${byUserId ? 'user' : 'system'}, ${byUserId}, ${reason.replace(/[^a-z_:]/g, '_').slice(0, 64) || 'unspecified'})`.execute(tx);
}

/**
 * The system cancels of a control or an end (messages_update RLS lets only tenant-wide actors or the initiator update
 * them, and AI rows have no initiating user): queued/scheduled AI messages of the person, their proposed actions,
 * pending facts and undelivered offers. A post-handoff pending message is kept.
 */
export async function cancelForAssignmentInTx(tx: Tx, a: Pick<AssignmentRow, 'id' | 'contactId'>, reason: string): Promise<number> {
  const keep = await sql<{ id: string | null }>`SELECT pending_message_id AS id FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
  const keepId = keep.rows[0]?.id ?? null;
  const c = await sql<{ id: string }>`UPDATE messages SET status = 'canceled', status_reason = ${reason}
    WHERE tenant_id = app.tenant_id() AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid))
      AND direction = 'outbound' AND initiator = 'assistant' AND status IN ('queued','scheduled')
      AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') ${keepId ? sql`AND id <> ${keepId}` : sql``}
    RETURNING id`.execute(tx);
  await emitIsaSendResultsInTx(tx, c.rows.map((x) => x.id), 'canceled');
  await sql`UPDATE assistant_actions SET status = 'invalidated' WHERE tenant_id = app.tenant_id()
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid)) AND kind = 'ai_isa_message' AND status = 'proposed'
    ${keepId ? sql`AND id NOT IN (SELECT assistant_action_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${keepId} AND assistant_action_id IS NOT NULL)` : sql``}`.execute(tx);
  await sql`UPDATE ai_isa_shared_facts SET status = 'canceled' WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND status = 'pending'`.execute(tx);
  await sql`UPDATE ai_isa_slot_offers SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND status IN ('pending_delivery','offered')`.execute(tx);
  await sql`UPDATE ai_isa_turns SET status = 'canceled_paused' WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND status IN ('deciding','sending')`.execute(tx);
  return c.rows.length;
}

/** R-ISA-17: at the handoff an AI-origin saved search is paused for review (alerts follow D1 again after re-approval). */
export async function pauseSavedSearchesInTx(tx: Tx, contactId: string): Promise<void> {
  await pauseAiSearchesAtHandoffInTx(tx, contactId);
}

async function owners(tx: Tx, a: AssignmentRow): Promise<string[]> {
  const m = await sql<{ active: boolean }>`SELECT status = 'active' AS active FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${a.ownerUserId}`.execute(tx);
  return m.rows[0]?.active ? [a.ownerUserId] : await adminUserIds(tx);
}

/** The owner's pause card (pinned when an inbound is unanswered or an offer is open; R-ISA-15). */
export async function pauseCardInTx(env: Pick<ApplyEnv, 'tx' | 'deps' | 'ctx' | 'now'>, reason: string): Promise<void> {
  const { tx, deps, ctx, now } = env;
  const label = (await contactLabel(tx, ctx.a.contactId)) ?? 'A lead';
  for (const userId of await owners(tx, ctx.a)) {
    await notifyUser(tx, deps.ids, { userId, kind: 'ai_isa_paused', priority: ctx.a.machine.inboundUnanswered ? 'high' : 'normal',
      title: `AI care paused: ${label}`.slice(0, 120), body: null, subjectType: 'contact', subjectId: ctx.a.contactId, dedupeKey: `ai_isa_paused:${ctx.a.id}:${ctx.a.epoch}:${reason}` }, now);
  }
}

async function escalationCardInTx(env: ApplyEnv, cls: string, type: string, priority: string): Promise<void> {
  const { tx, deps, ctx, now } = env;
  const label = (await contactLabel(tx, ctx.a.contactId)) ?? 'A lead';
  for (const userId of await owners(tx, ctx.a)) {
    await upsertFeedItem(tx, deps.ids, { userId, itemType: 'ai_isa_escalation', band: 'pinned', contactId: ctx.a.contactId, subjectType: 'ai_isa_assignment', subjectId: ctx.a.id,
      assistantActionId: null, score: priority === 'critical' ? 97 : priority === 'high' ? 88 : 70,
      reasons: [{ code: `AI_ISA_${type.toUpperCase()}:${cls}`, text: type === 'check_this' ? 'Check this: the AI assistant paused' : 'Waiting on you: the AI assistant is staying off this topic' }],
      dedupeKey: `ai_isa_escalation:${ctx.a.id}:${cls}` });
    await notifyUser(tx, deps.ids, { userId, kind: 'ai_isa_escalation', priority: priority === 'critical' ? 'critical' : priority === 'high' ? 'high' : 'normal',
      title: `AI assistant needs you: ${label}`.slice(0, 120), body: null, subjectType: 'contact', subjectId: ctx.a.contactId, dedupeKey: `ai_isa_escalation:${ctx.a.id}:${cls}` }, now);
  }
}

/**
 * queue_message: the server composes the body (fixed lines, model conversation text OR facts, never both), adds the
 * platform disclosure and sign-off, plans the channel and the not-before instant over the conservative zone set, and
 * queues it to the bound point under one proposed `ai_isa_message` action with the frozen body hash (R-ISA-7, -10, -28).
 */
export async function queueIsaMessageInTx(env: ApplyEnv, q: QueueMessage, s: IsaState): Promise<string | null> {
  const { tx, deps, ctx, now } = env;
  // ISA-3 H2: a seller facts message is server-built and re-checked here (TX-B); comps need the bound email, no fallback;
  // only ctx.channels (bound and allowed by the policy) and an SMS fit judged on the longest composed body (audit F5)
  const sf = await renderSellerFactsInTx(tx, env.actor, ctx.a, now, q, {
    channels: ctx.channels, compose: (core, ch) => composeMessage({ body: core, who: ctx.who, firstInThread: true, optOutHint: true, channel: ch }),
  });
  if (sf !== null && !sf.ok) return null;
  const channel = sf !== null ? sf.channel : ctx.channels.includes(q.channel) ? q.channel : ctx.channels[0];
  if (channel === undefined) return null;
  const point = ctx.a.boundPoints[channel];
  if (!point) return null;
  // item 11: a buyer facts message is server text only, re-checked and planned (channel, whole lines) from the bundle;
  // a seller facts message (sf, ISA-3 H2) was built above, and ISA-2b's plan leaves 'comps' to it
  let channelFinal: 'sms' | 'email' = channel;
  let factsPlan: PlannedFacts | null = null;
  if (sf === null && q.messageKind === 'facts') {
    if (!env.bundle || q.handles.length === 0 || q.handles.some((h) => h === 'comps')) return null; // seller kinds: ISA-3
    const prior0 = await sql<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${ctx.a.contactId} AND initiator = 'assistant'
      AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') AND status IN ('sent','delivered','dispatching')`.execute(tx);
    const p = await planFactsMessageInTx(tx, ctx, { bundle: env.bundle, handles: q.handles, preferred: channel, now,
      compose: (core, ch) => composeMessage({ body: core, who: ctx.who, firstInThread: prior0.rows[0]!.n === 0, optOutHint: true, channel: ch }) });
    if (!p.ok) {
      if (env.turnId) await sql`UPDATE ai_isa_turns SET decision = decision || ${JSON.stringify({ facts: p.code.replace(/[^A-Za-z0-9_:.@-]/g, '_').slice(0, 64) })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${env.turnId}`.execute(tx);
      return null;
    }
    factsPlan = p.plan;
    channelFinal = p.plan.channel;
  }
  const parts: string[] = sf !== null ? [sf.body] : q.lines.map((l) => fillLine(l, ctx.who));
  const offer = s.offer;
  if (q.messageKind === 'offer' && offer !== null) parts.push(renderOffer({ slots: offer.slots, agentFirstName: ctx.who.agentFirstName, zones: offer.zones, kindLabel: kindLabel(offer.appointmentKind) }));
  // the machine's slot index is 0-based (matchSlotChoice, acceptedIndex)
  if (q.messageKind === 'confirmation' && offer !== null && q.slotIndex !== null && offer.slots[q.slotIndex]) {
    parts.unshift(renderConfirmation({ slot: offer.slots[q.slotIndex]!, agentFirstName: ctx.who.agentFirstName, zones: offer.zones, kindLabel: kindLabel(offer.appointmentKind) }));
  }
  if (sf === null && q.text !== null && q.text.trim() !== '') parts.push(q.text.trim());
  const bodyCore = factsPlan ? 'facts' : parts.join(channel === 'email' ? '\n\n' : ' ').trim();
  if (bodyCore === '') return null;
  const prior = await sql<{ n: number; last: Date | null }>`SELECT count(*)::int AS n, max(dispatched_at) AS last FROM messages WHERE tenant_id = app.tenant_id()
    AND contact_id = ${ctx.a.contactId} AND initiator = 'assistant' AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
    AND status IN ('sent','delivered','dispatching')`.execute(tx);
  const first = prior.rows[0]!.n === 0;
  const silent7d = prior.rows[0]!.last !== null && now - prior.rows[0]!.last.getTime() > 7 * 86_400_000;
  const body = factsPlan ? factsPlan.body : composeMessage({ body: bodyCore, who: ctx.who, firstInThread: first, optOutHint: first || (q.initiated && silent7d), channel });
  const initiated = q.initiated || q.messageKind === 'facts';
  const notBefore = aiIsaSendWindow({ at: now, zones: ctx.zones, startSec: ctx.content.window.startSec, endSec: ctx.content.window.endSec, initiated,
    initiatedDays: ctx.content.initiatedDays, noInitiatedOnHolidays: ctx.content.noInitiatedOnHolidays });
  if (notBefore === null) return null; // the machine sees no send; the sweep ends care ZONE_WINDOWS_DO_NOT_OVERLAP
  // a turn binds one message: a second message of the same step gets its own turn row
  let turn = env.turnId;
  if (turn !== null) {
    const t = await sql<{ m: string | null }>`SELECT message_id AS m FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND id = ${turn}`.execute(tx);
    if (t.rows[0]?.m) turn = null;
  }
  turn ??= (await ensureTurn(tx, deps.ids, ctx, { triggerKind: 'control', triggerKey: `q:${q.messageKind}:${ctx.a.epoch}:${now}:${deps.ids.next<'X'>() as string}`, pinnedSeq: env.pinnedSeq, status: 'sending' })).id;
  // one open AI message per contact: a newer message supersedes the pending one (§4.2)
  await sql`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND contact_id = ${ctx.a.contactId}
    AND kind = 'ai_isa_message' AND status = 'proposed'`.execute(tx);
  const superseded = await sql<{ id: string }>`UPDATE messages SET status = 'canceled', status_reason = 'AI_ISA_SUPERSEDED' WHERE tenant_id = app.tenant_id() AND contact_id = ${ctx.a.contactId}
    AND direction = 'outbound' AND initiator = 'assistant' AND status IN ('queued','scheduled') AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
    RETURNING id`.execute(tx);
  await emitIsaSendResultsInTx(tx, superseded.rows.map((x) => x.id), 'canceled');
  const actionId = deps.ids.next<'X'>() as string;
  const category = ISA_CATS[q.messageKind];
  await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id, explanation,
      payload, pinned_inbound_seq, bound_ownership_seq, ai_isa_turn_id, epoch, dedupe_key)
    VALUES (app.tenant_id(), ${actionId}, ${ctx.a.contactId}, 'ai_isa_message', ${category}, 'ai_isa_mandate', ${ctx.a.playbookVersionId}, 'proposed', ${ctx.a.ownerUserId},
      ${`AI assistant ${q.messageKind}`}, ${JSON.stringify({ assignmentId: ctx.a.id, messageKind: q.messageKind, lines: q.lines, handles: q.handles, offerId: q.offerId })}::jsonb,
      ${env.pinnedSeq}, ${ctx.a.boundOwnershipSeq}, ${turn}, ${ctx.a.epoch}, ${`ai_isa_msg:${turn}:${q.messageKind}`})`.execute(tx);
  const res = await queueOutboundInTx(tx, deps, {
    contactId: ctx.a.contactId, channel: channelFinal, body, subject: channelFinal === 'email' ? `A note from ${ctx.who.agentFirstName}'s AI assistant` : undefined,
    initiator: 'assistant', purpose: 'marketing', category, idempotencyKey: `ai_isa:${actionId}`, assistantActionId: actionId, toPointId: ctx.a.boundPoints[channelFinal]!.point_id,
    scheduleAt: notBefore > now ? notBefore : undefined,
  } as Parameters<typeof queueOutboundInTx>[2], now);
  if (!res.ok) {
    await sql`UPDATE assistant_actions SET status = 'blocked' WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
    return null;
  }
  await sql`UPDATE ai_isa_turns SET assistant_action_id = ${actionId}, message_id = ${res.messageId}, channel = ${channelFinal}, message_kind = ${initiated ? 'initiated' : 'reply'},
      zones = ${ctx.zones}::text[], zone_source = ${ctx.zoneSource}, window_start = ${secToTime(ctx.content.window.startSec)}::time,
      window_end = ${secToTime(ctx.content.window.endSec)}::time, not_before = ${notBefore > now ? toIso(notBefore) : null}::timestamptz,
      body_sha256 = ${sha256(body)}, icu_tz_version = ${process.versions.tz ?? null}, pg_tzdata_version = current_setting('server_version'),
      status = 'sending', state_after = ${s.ended !== null ? 'ended' : s.phase}
    WHERE tenant_id = app.tenant_id() AND id = ${turn} AND message_id IS NULL`.execute(tx);
  if (factsPlan) await insertPendingFactsInTx(tx, deps.ids as never, ctx, turn, res.messageId, factsPlan.facts, 'display/1');
  else if (sf !== null) await writeSellerFactsInTx(tx, deps.ids, ctx.a, turn, res.messageId, sf.pendingFacts); // ISA-3 H2: the pending facts
  return res.messageId;
}

const secToTime = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
const kindLabel = (k: string) => (k === 'buyer_consult' ? 'buyer consultation' : k === 'listing_appointment' ? 'listing appointment' : 'phone consultation');
