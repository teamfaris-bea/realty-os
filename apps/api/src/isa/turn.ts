// Turn processing (R-ISA-4, R-ISA-5, R-ISA-20, R-ISA-27; docs/AI_ISA.md §4.2, §7, §9.2). The `ai_isa.turn` job:
//
//   TX-A (locks 2 → 3 → 4): debounce through retryAt; the link-failure table (a hold defers BEFORE any model call);
//        the events (turn inbounds from bound points since the last consumed one, timers, start); the deterministic
//        step(); when the machine awaits the model, a turn row `deciding` with the pinned inbound seq and the epoch.
//   The provider call, with NO lock held (the TX-A/TX-B pattern of assistant/runs.ts), through the unchanged
//        AiProvider.complete; tool-less; one repair retry on a schema failure.
//   TX-B (locks 2 → 3 → 4): the attempt-guarded UPDATE (zero rows ⇒ a replayed lease: discard everything, E492);
//        a newer inbound ⇒ stale, re-enqueued (E493); the chain, the pause and the epoch again; parse, decideAction,
//        step(model_output); the encrypted ai_runs row; the actions through effects.applyActionsInTx.
import type { Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { aiRunAad } from '../assistant/runs.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { systemActor } from '../worker/systemActor.js';
import {
  buildIsaPrompt, capabilitiesInEffect, clientOwnText, decideAction, type IsaEvent, type IsaInbound, parseIsaModelOutput, repairNote, step,
} from './coreSeam.js';
import { systemEndInTx, systemPauseInTx } from './controls.js';
import { applyActionsInTx, chainEnvOf, contextFor, ensureTurn, type IsaContext, type IsaDeps } from './effects.js';
import { type AssignmentRow, assignmentById, evaluateChain, lockForTurn } from './repo.js';

export type TurnDeps = IsaDeps & { envelope: EnvelopeService };

export const DEBOUNCE_MS = 20_000;
export const DEBOUNCE_CAP_MS = 120_000;
export const HOLD_RETRY_MS = 15 * 60_000;

export interface TurnPayload {
  assignmentId: string;
  trigger: 'start' | 'inbound' | 'timer' | 'control' | 'sweep';
  timer?: 'follow_up' | 'offer_expiry' | 'pause_expiry' | 'inactivity_warning';
  epoch: number;
}

export type TurnResult = { kind: 'done'; code: string } | { kind: 'retry'; retryAt: Instant };

interface Prepared {
  a: AssignmentRow;
  ctx: IsaContext;
  turnId: string;
  attempt: number;
  pinnedSeq: number;
  event: IsaEvent;
  prompt: ReturnType<typeof buildIsaPrompt>;
  decideBase: Omit<Parameters<typeof decideAction>[1], 'now'>;
}

/** The bound-point turn inbounds not yet consumed, with their per-conversation ordinal as seq (R-ISA-28). */
async function turnInbounds(tx: Tx, a: AssignmentRow): Promise<IsaInbound[]> {
  const bound = Object.values(a.boundPoints).map((p) => p!.point_id);
  const r = await sql<{ id: string; channel: 'sms' | 'email'; body: string; created_at: Date; seq: string; kw: string | null }>`
    WITH ordered AS (
      SELECT m.id, m.channel, m.body, m.created_at, m.from_address, m.is_auto_reply, m.email_dkim_aligned, m.opt_out_keyword,
             row_number() OVER (ORDER BY m.created_at, m.id) AS seq
        FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
       WHERE m.tenant_id = app.tenant_id() AND c.contact_id = ${a.contactId} AND m.direction = 'inbound')
    SELECT o.id, o.channel, o.body, o.created_at, o.seq, o.opt_out_keyword AS kw FROM ordered o
     WHERE o.seq > ${a.machine.lastInboundSeq} AND o.created_at >= ${new Date(a.startedAt - (a.machine.lastInboundSeq === 0 ? 86_400_000 : 0))}
       AND o.channel IN ('sms','email') AND NOT o.is_auto_reply AND (o.channel = 'sms' OR o.email_dkim_aligned IS TRUE)
       AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.id = ANY (${bound}::uuid[]) AND p.address = o.from_address)
       AND NOT EXISTS (SELECT 1 FROM message_text_parts tp WHERE tp.tenant_id = app.tenant_id() AND tp.message_id = o.id)
     ORDER BY o.seq`.execute(tx);
  return r.rows.map((m) => {
    const own = clientOwnText(m.body, m.channel);
    return {
      seq: Number(m.seq), messageId: m.id, channel: m.channel, at: instantFromDate(m.created_at), ownText: own.text.slice(0, 1600), ownTextReliable: own.reliable,
      classification: { kind: (m.kw ? 'stop' : 'none') as 'stop' | 'none', needsReview: false }, reaction: false,
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
async function txA(deps: TurnDeps, tenantId: string, p: TurnPayload): Promise<Prepared | TurnResult> {
  return withTenantTx(actor(tenantId), async (tx, now) => {
    const peek = await assignmentById(tx, p.assignmentId);
    if (peek === null || peek.endedAt !== null) return { kind: 'done', code: 'ENDED' } as const;
    await lockForTurn(tx, peek.contactId, peek.id);
    const a = (await assignmentById(tx, p.assignmentId, 'update'))!;
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
      if (p.timer === 'pause_expiry') {
        const ctx = await contextFor(tx, a, now);
        const r = step(a.machine, { type: 'timer', at: now, timer: 'pause_expiry' }, ctx.facts);
        await applyActionsInTx({ tx, deps, actor: actor(tenantId), ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, r);
        return { kind: 'done', code: 'PAUSE_EXPIRY' } as const;
      }
      return { kind: 'done', code: 'PAUSED' } as const;
    }
    const conv = await convSeq(tx, a.contactId);
    const inbounds = p.trigger === 'timer' ? [] : await turnInbounds(tx, a);
    // debounce (§4.2): the worker's retryAt, capped at 2 minutes of total deferral
    if (inbounds.length > 0 && conv.lastInboundAt !== null && now - conv.lastInboundAt < DEBOUNCE_MS && now - inbounds[0]!.at < DEBOUNCE_CAP_MS) {
      return { kind: 'retry', retryAt: (conv.lastInboundAt + DEBOUNCE_MS) as Instant } as const;
    }
    const ctx = await contextFor(tx, a, now);
    const event: IsaEvent = p.trigger === 'timer' && p.timer ? { type: 'timer', at: now, timer: p.timer }
      : inbounds.length > 0 ? { type: 'inbound', at: now, messages: inbounds }
      : a.machine.phase === 'starting' ? { type: 'start', at: now }
      : { type: 'timer', at: now, timer: 'follow_up' };
    if (event.type === 'timer' && event.timer === 'follow_up' && p.trigger !== 'timer') return { kind: 'done', code: 'NOTHING_TO_DO' } as const;
    const r = step(a.machine, event, ctx.facts);
    const triggerKey = `${p.trigger}:${a.epoch}:${event.type === 'inbound' ? inbounds.at(-1)!.seq : p.timer ?? 'start'}`;
    const turn = await ensureTurn(tx, deps.ids, ctx, { triggerKind: p.trigger === 'control' || p.trigger === 'sweep' ? p.trigger : event.type === 'inbound' ? 'inbound' : p.trigger, triggerKey, pinnedSeq: conv.seq });
    const lastSeq = inbounds.at(-1)?.seq ?? a.machine.lastInboundSeq;
    const awaiting = r.actions.find((x) => x.kind === 'await_model');
    const applied = await applyActionsInTx({ tx, deps, actor: actor(tenantId), ctx, now, turnId: turn.id, pinnedSeq: conv.seq }, { state: r.state, actions: r.actions.filter((x) => x.kind !== 'await_model') });
    await sql`UPDATE ai_isa_assignments SET last_inbound_seq = GREATEST(last_inbound_seq, ${lastSeq}) WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    if (!awaiting || applied.ended || applied.paused) {
      await sql`UPDATE ai_isa_turns SET status = CASE WHEN message_id IS NOT NULL THEN status WHEN ${applied.ended} THEN 'handed_off' ELSE 'no_reply' END,
          state_after = ${r.state.ended !== null ? 'ended' : r.state.phase}
        WHERE tenant_id = app.tenant_id() AND id = ${turn.id} AND status = 'deciding'`.execute(tx);
      return { kind: 'done', code: applied.ended ? 'ENDED' : 'NO_MODEL' } as const;
    }
    const fresh = (await assignmentById(tx, a.id))!;
    return prepare(tx, { ...ctx, a: fresh }, fresh, turn.id, turn.attempt, conv.seq, event, now, awaiting.kind === 'await_model' ? awaiting : null);
  }, { db: deps.db, retries: 2 });
}

async function prepare(tx: Tx, ctx: IsaContext, a: AssignmentRow, turnId: string, attempt: number, pinnedSeq: number, event: IsaEvent, now: Instant, aw: { repair: boolean; initiated: boolean } | null): Promise<Prepared> {
  // R-ISA-20: the last 20 messages to and from bound points only; inbound as client own text; team text not quotable;
  // never a portal sign-in link (module 45, b14 audit F1: flagged edit, defence in depth behind its sealed URL)
  const bound = Object.values(a.boundPoints).map((p) => p!.point_id);
  const msgs = await sql<{ id: string; direction: 'inbound' | 'outbound'; channel: 'sms' | 'email'; body: string; created_at: Date }>`
    SELECT m.id, m.direction, m.channel, m.body, m.created_at FROM messages m
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${a.contactId} AND m.channel IN ('sms','email')
       AND ((m.direction = 'inbound' AND NOT m.is_auto_reply AND (m.channel = 'sms' OR m.email_dkim_aligned IS TRUE)
             AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = m.tenant_id AND p.id = ANY (${bound}::uuid[]) AND p.address = m.from_address)
             AND NOT EXISTS (SELECT 1 FROM message_text_parts tp WHERE tp.tenant_id = m.tenant_id AND tp.message_id = m.id))
         OR (m.direction = 'outbound' AND m.status IN ('sent','delivered') AND m.action_category <> 'portal_login_link'
             AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = m.tenant_id AND p.id = ANY (${bound}::uuid[]) AND p.address = m.to_address)))
     ORDER BY m.created_at DESC LIMIT 20`.execute(tx);
  const caps = capabilitiesInEffect(ctx.content, (await sql<{ c: string[] }>`SELECT capabilities AS c FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND id = ${a.optinId}`.execute(tx)).rows[0]?.c ?? ['converse']);
  const first = (await sql<{ n: string | null }>`SELECT split_part(COALESCE(display_name, ''), ' ', 1) AS n FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${a.contactId}`.execute(tx)).rows[0]?.n ?? null;
  const messages = msgs.rows.reverse().map((m) => ({ messageId: m.id, direction: m.direction, channel: m.channel, text: m.direction === 'inbound' ? clientOwnText(m.body, m.channel).text : m.body, at: instantFromDate(m.created_at) }));
  const replyChannel = (a.machine.lastInboundChannel && ctx.channels.includes(a.machine.lastInboundChannel) ? a.machine.lastInboundChannel : ctx.channels[0]) ?? 'sms';
  const prompt = buildIsaPrompt({
    side: a.side, phase: a.machine.phase, agentFirstName: ctx.who.agentFirstName, clientFirstName: first, allowedActions: ['reply', 'record_qualification', 'escalate', 'ready', 'follow_up', 'end', ...[...caps].filter((c) => c === 'book_appointments').map(() => 'offer_slots')],
    replyAllowedNow: ctx.facts.windowOpenNow, replyChannel, windowLabel: `${ctx.content.window.startSec / 3600}:00–${ctx.content.window.endSec / 3600}:00 local`,
    heldTopics: a.machine.held.map((h) => h.class), messages, claims: a.machine.claims, handles: [], unavailable: ['listings: BUNDLE_NOT_BUILT', 'sold_comps_unavailable: PLATFORM_NOT_CLEARED'],
    offer: null, ...(aw?.repair ? { repairNote: repairNote(['root']) } : {}),
  });
  const sources = messages.map((m, i) => ({ handle: `S${i + 1}`, messageId: m.messageId, author: m.direction === 'inbound' ? ('client_own' as const) : ('team' as const), channel: m.channel, text: m.text, at: m.at, ownTextReliable: m.channel === 'sms' || m.direction === 'inbound' }));
  const decideBase: Prepared['decideBase'] = {
    side: a.side, capabilities: caps, replyChannel, sources, teamTexts: ctx.facts.teamTexts, listingHandles: new Set(), competitionHandles: new Set(), compsAvailable: false,
    heldClasses: new Set(a.machine.held.map((h) => h.class)), calendarLive: false, offer: null, meetRequested: a.machine.intents.length > 0,
    confirmationInTime: () => false, savedSearchAllowed: false, intents: a.machine.intents, priorClaims: a.machine.claims, appointmentBooked: a.machine.appointment,
    mlsListedElsewhere: false, subjectConfirmed: false, zone: ctx.facts.zone,
    identity: { brokerageLegalName: ctx.who.brokerageName, teamName: ctx.who.teamName, agentFirstName: ctx.who.agentFirstName, scope: 'agent', allowedLinkHosts: [] } as never,
    promptSources: prompt.sources, claimId: (i: number) => `${turnId.slice(0, 24)}${String(i).padStart(12, '0')}`.slice(0, 36),
  };
  return { a, ctx, turnId, attempt, pinnedSeq, event, prompt, decideBase };
}

/** One full turn (the job body). */
export async function runTurn(deps: TurnDeps, tenantId: string, p: TurnPayload): Promise<TurnResult> {
  const pre = await txA(deps, tenantId, p);
  if ('kind' in pre) return pre;
  let note: string | undefined;
  for (let call = 0; call < 2; call += 1) {
    const started = Date.now();
    let text = '';
    let model = 'none';
    let failed = false;
    try {
      const res = await deps.providers.ai.complete({ templateKey: pre.prompt.templateKey, system: pre.prompt.system, user: note ? `${pre.prompt.user}\n\nnote: ${note}` : pre.prompt.user, maxOutputTokens: pre.prompt.maxOutputTokens });
      text = res.text;
      model = res.model;
    } catch {
      failed = true;
    }
    const latency = Math.max(0, Date.now() - started);
    const r = await txB(deps, tenantId, pre, { text, model, failed, latency, repairAllowed: call === 0 });
    if (r.kind !== 'repair') return r.result;
    note = r.note;
  }
  return { kind: 'done', code: 'REPAIR_EXHAUSTED' };
}

type TxBResult = { kind: 'final'; result: TurnResult } | { kind: 'repair'; note: string };

async function txB(deps: TurnDeps, tenantId: string, pre: Prepared, m: { text: string; model: string; failed: boolean; latency: number; repairAllowed: boolean }): Promise<TxBResult> {
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
    // the encrypted run (prompts and outputs stay in ai_runs.output_enc, purged after 30 days)
    const parsed = m.failed ? null : parseIsaModelOutput(m.text);
    const runId = deps.ids.next<'AiRunId'>() as string;
    const enc = m.text === '' ? null : Buffer.from(await deps.envelope.inTx(tx, tenantId as TenantId).encrypt(tenantId as TenantId, aiRunAad(runId as never), Buffer.from(m.text.slice(0, 64_000), 'utf8')));
    const signals = parsed === null ? { error: 'PROVIDER' } : parsed.ok ? {} : { error: parsed.code };
    await sql`INSERT INTO ai_runs (tenant_id, id, purpose, model, prompt_template_key, prompt_version, input_refs, output_enc, key_version, internal_signals,
        input_tokens, output_tokens, latency_ms, status, requested_for_user_id)
      VALUES (app.tenant_id(), ${runId}, 'ai_isa_turn', ${m.model.slice(0, 100)}, ${pre.prompt.templateKey}, ${pre.prompt.templateVersion},
        ${JSON.stringify({ assignmentId: a.id, turnId: pre.turnId })}::jsonb, ${enc}, ${enc === null ? null : 1}, ${JSON.stringify(signals)}::jsonb,
        0, 0, ${m.latency}, ${parsed !== null && parsed.ok ? 'succeeded' : 'failed'}, ${a.ownerUserId})`.execute(tx);
    await sql`UPDATE ai_isa_turns SET ai_run_id = ${runId} WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
    const ctx = await contextFor(tx, a, now);
    const env = { tx, deps, actor: actor(tenantId), ctx, now, turnId: pre.turnId, pinnedSeq: pre.pinnedSeq };
    if (parsed === null || !parsed.ok) {
      const r = step(a.machine, { type: 'model_failed', at: now, epoch: a.epoch, reason: parsed === null ? 'provider' : 'schema' }, ctx.facts);
      const repair = r.actions.some((x) => x.kind === 'await_model');
      await applyActionsInTx(env, { state: r.state, actions: r.actions.filter((x) => x.kind !== 'await_model') });
      if (repair && m.repairAllowed && parsed !== null) {
        await sql`UPDATE ai_isa_turns SET attempt = attempt + 1 WHERE tenant_id = app.tenant_id() AND id = ${pre.turnId}`.execute(tx);
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
