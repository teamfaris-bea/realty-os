// Routes of module 75 (docs/AI_ISA.md §9.1; D12 proposed). Every route sits under a MATRIX row; an invisible contact
// is 404 (R-PERM-5); no response carries a confidence or score (R-AST-13). Controls return what may still reach the
// person ("1 message was already on its way at …", the E22 pattern).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { detailFacts, liveDetailFacts } from '../people/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { systemActor } from '../worker/systemActor.js';
import { actorOf, platformOf } from '../workspace/common.js';
import { continueCare, liftBlock, sharedAddressAsSystem, pauseAll, pauseCare, resumeCare, startCare, startRefusal, undoControl } from './controls.js';
import { chainEnvOf, contextFor, type IsaDeps } from './effects.js';
import { closeHandoffInTx, type HandoffCloseReason } from './handoff.js';
import { activeBlock, assignmentById, evaluateChain, latestAssignmentOf } from './repo.js';
import { resolveEscalation } from './resolve.js';
import * as S from './schemas.js';
import { adminLoosening, adminPut, adminView, meView, optIn, optInLoosening, reattest, revokeOptIn } from './settings.js';
import type { TurnDeps } from './turn.js';
import { STATE_SENTENCES, chipOf, startRefusalSentence } from './sentences.js';
import { liveOfferOf } from './booking/rows.js';

function depsOf(req: FastifyRequest): TurnDeps {
  return depsFromPlatform(platformOf(req)) as TurnDeps;
}
const idOfParam = (req: FastifyRequest) => (req.params as { id: string }).id;

async function panel(req: FastifyRequest, contactId: string) {
  const actor = actorOf(req);
  const deps = depsOf(req);
  const sharedAddress = await sharedAddressAsSystem(deps, actor.tenantId, contactId);
  return withTenantTx(actor, async (tx, now) => {
    const a = await latestAssignmentOf(tx, contactId);
    const refusal = a !== null && a.endedAt === null ? null : await startRefusal(tx, actor, contactId, { sharedAddress });
    const block = await activeBlock(tx, contactId);
    const c = await sql<{ release: Date | null }>`SELECT inactivity_release_at AS release FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
    const base = {
      contactId,
      canStart: refusal?.code === 'OK',
      startRefusal: refusal && refusal.code !== 'OK' ? { code: refusal.code, sentence: startRefusalSentence(refusal.code) } : null,
      block: block ? { reason: block.reason, since: new Date(block.createdAt).toISOString(), sentence: 'This person declined or stopped AI care. A restart needs a new message from them and your attestation.' } : null,
      inactivityReleaseAt: c.rows[0]?.release?.toISOString() ?? null,
      inactivitySentence: c.rows[0]?.release ? "AI messages don't reset this." : null,
    };
    if (a === null) {
      return { ...base, assignment: null, canResume: false, chain: [], capabilities: [], consent: [], zones: { zones: [], source: 'union' as const, sentence: 'Not under AI care.' },
        nextAllowedSendAt: null, capsSentence: '', lastDecision: null, factsSent: [], openOffer: null, heldTopics: [], handoff: null };
    }
    // b12 review F6: the latest assignment can be a merged-away record's (ended by the merge): read-only history, its
    // turns, facts and handoff only (that record's own facts are not the survivor's, and its contact row stays hidden)
    const history = a.contactId !== contactId;
    const chain = history ? { links: [], effect: 'end' as const, worst: null } : await evaluateChain(tx, a, chainEnvOf(deps));
    const ctx = history ? null : await contextFor(tx, a, now);
    const opt = await sql<{ c: string[] }>`SELECT capabilities AS c FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND id = ${a.optinId}`.execute(tx);
    const turn = await sql<{ status: string; decision: Record<string, unknown>; denied: unknown[]; created_at: Date; not_before: Date | null }>`SELECT status, decision, denied, created_at, not_before
      FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} ORDER BY created_at DESC LIMIT 1`.execute(tx);
    const offerRow = await liveOfferOf(tx, a.id);
    const facts = await sql<{ fact_kind: string; listing_id: string | null; created_at: Date; source: string | null; as_of: Date | null }>`SELECT f.fact_kind, f.listing_id, f.created_at,
        ic.display_name AS source, f.as_of FROM ai_isa_shared_facts f LEFT JOIN integration_connections ic ON ic.tenant_id = f.tenant_id AND ic.id = f.mls_connection_id
      WHERE f.tenant_id = app.tenant_id() AND f.assignment_id = ${a.id} AND f.status = 'sent' ORDER BY f.created_at`.execute(tx);
    const sent = await sql<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND initiator = 'assistant'
      AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') AND status IN ('sent','delivered','dispatching') AND dispatched_at > now() - interval '24 hours'`.execute(tx);
    // b12 recheck R13, R21: a handoff the system closed (its stored close, 0081) is done: never overdue
    const h = await sql<{ id: string; reason: string; sla_class: string; sla_due_at: Date; sla_met_at: Date | null; confirmation_status: string; done: boolean; closed_reason: HandoffCloseReason | null }>`SELECT id, reason, sla_class, sla_due_at, sla_met_at, confirmation_status, closed_reason,
        closed_at IS NOT NULL AS done
      FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
    const last = turn.rows[0];
    const capsOn = new Set(opt.rows[0]?.c ?? []);
    const hd = h.rows[0];
    return {
      ...base,
      assignment: {
        id: a.id, side: a.side, state: (a.endedAt ? 'ended' : a.pausedAt ? 'paused' : a.machine.phase) as (typeof S.STATES)[number], chip: chipOf(a, last?.not_before ?? null),
        epoch: a.epoch, startedAt: new Date(a.startedAt).toISOString(), pausedAt: a.pausedAt ? new Date(a.pausedAt).toISOString() : null, pauseReason: a.pauseReason,
        pausedSentence: a.pausedAt ? STATE_SENTENCES.paused : null, endedAt: a.endedAt ? new Date(a.endedAt).toISOString() : null, endReason: a.endReason,
        undoUntil: a.finalizeAt ? new Date(a.finalizeAt).toISOString() : null, ownerUserId: a.ownerUserId,
      },
      canResume: !history && a.endedAt === null && a.pausedAt !== null && a.finalizeAt === null && actor.userId === a.ownerUserId && (chain.effect === 'ok' || chain.effect === 'hold'),
      chain: chain.links.map((l) => ({ link: l.link, name: l.name, effect: l.effect, code: l.code, sentence: l.sentence })),
      capabilities: ctx === null ? [] : (['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'] as const).map((cap) => {
        const allowed = ctx.content.capabilities.includes(cap) && capsOn.has(cap) && (cap === 'converse');
        return { capability: cap, allowed, sentence: allowed ? 'Allowed.' : cap === 'seller_sold_comps' ? 'Can share recent sales: no — not built in this version.' : cap === 'converse' ? 'Not in your opt-in.' : 'Not available yet on this deployment.' };
      }),
      consent: (ctx?.channels ?? []).map((ch) => ({ channel: ch, sentence: ch === 'sms'
        ? "Texts: OK for replies within 24 h of their text. Listings and follow-ups need written consent naming the team, from their own form, plus a fresh Do Not Call check."
        : 'Email: OK for replies within 24 h of their own verified email. Follow-ups need consent from their own form.' })),
      zones: ctx === null ? { zones: [], source: 'union' as const, sentence: 'AI care ended on a record merged into this one.' }
        : { zones: ctx.zones, source: ctx.zoneSource, sentence: ctx.zoneSource === 'explicit' ? 'Their time zone was set on the person.' : 'Every time zone they may be in (area code, addresses, the team zone and the continental US): effectively 12:00–20:00 Eastern.' },
      nextAllowedSendAt: last?.not_before?.toISOString() ?? null,
      capsSentence: ctx === null ? '' : `${sent.rows[0]!.n} of ${ctx.content.caps.ai24h} today`,
      lastDecision: last ? { status: last.status, codes: (last.denied as string[]).slice(0, 10), at: last.created_at.toISOString(), sentence: `Last turn: ${last.status.replace(/_/g, ' ')}.` } : null,
      factsSent: facts.rows.map((f) => ({ factKind: f.fact_kind, listingId: f.listing_id, sentAt: f.created_at.toISOString(), source: f.source, asOf: f.as_of?.toISOString() ?? null })),
      openOffer: offerRow ? { id: offerRow.id, status: offerRow.status, slots: offerRow.slots.map((x) => ({ startsAt: new Date(x.startsAt).toISOString(), endsAt: new Date(x.endsAt).toISOString() })), expiresAt: new Date(offerRow.expiresAt).toISOString() } : null,
      heldTopics: ctx === null ? [] : a.machine.held.map((x) => ({ class: x.class, since: new Date(x.since).toISOString(), sentence: `Waiting on ${ctx.who.agentFirstName}: ${x.class.replace(/_/g, ' ')}.` })),
      handoff: hd ? { id: hd.id, reason: hd.reason, slaClass: hd.sla_class as (typeof S.SLA_CLASSES)[number], slaDueAt: hd.sla_due_at.toISOString(), slaMetAt: hd.sla_met_at?.toISOString() ?? null, overdue: hd.sla_class !== 'none' && hd.sla_met_at === null && !hd.done && hd.sla_due_at.getTime() < now, confirmationStatus: hd.confirmation_status,
        closedReason: hd.closed_reason } : null,
    };
  }, { db: deps.db });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const contactFacts = (req: FastifyRequest) => detailFacts(req, idOfParam);
  const liveFacts = (req: FastifyRequest) => liveDetailFacts(req, idOfParam);
  const ctl = (action: 'ai_isa.pause' | 'ai_isa.control' | 'ai_isa.resume' | 'ai_isa.start', live = false) => ({ config: { auth: action }, preHandler: authorize(action, live ? liveFacts : contactFacts) });

  // ---- tenant ----
  r.get('/admin/ai-isa', { config: { auth: 'settings.ai_isa' }, preHandler: authorize('settings.ai_isa', () => ({ loosening: false })), schema: { response: { 200: S.AdminView } } }, async (req) => {
    const p = platformOf(req);
    return withTenantTx(actorOf(req), (tx) => adminView(tx, p.config.aiIsaLiveSends), { db: p.db });
  });
  r.put('/admin/ai-isa', {
    config: { auth: 'settings.ai_isa' },
    preHandler: authorize('settings.ai_isa', async (req) => {
      const b = req.body as { enabled: boolean; dailyCap: number; attestation?: string };
      const loosening = await withTenantTx(actorOf(req), (tx) => adminLoosening(tx, b), { db: platformOf(req).db });
      return { loosening, attested: typeof b.attestation === 'string' && b.attestation.trim().length >= 20 };
    }),
    schema: { body: S.AdminPutBody, response: { 200: S.AdminView } },
  }, async (req) => {
    const p = platformOf(req);
    await adminPut(actorOf(req), depsOf(req), req.body);
    return withTenantTx(actorOf(req), (tx) => adminView(tx, p.config.aiIsaLiveSends), { db: p.db });
  });

  // ---- the agent ----
  r.get('/me/ai-isa', { config: { auth: 'self' }, schema: { response: { 200: S.MeView } } }, async (req) => withTenantTx(actorOf(req), (tx) => meView(tx, actorOf(req)), { db: platformOf(req).db }));
  r.put('/me/ai-isa/opt-in', {
    config: { auth: 'ai_isa.optin' },
    preHandler: authorize('ai_isa.optin', async (req) => {
      const b = req.body as { capabilities: string[]; channels: ('sms' | 'email')[] };
      return { loosening: await withTenantTx(actorOf(req), (tx) => optInLoosening(tx, actorOf(req), b), { db: platformOf(req).db }) };
    }),
    schema: { body: S.OptInBody, response: { 200: S.OptInResult } },
  }, async (req) => optIn(actorOf(req), depsOf(req), req.body));
  r.post('/me/ai-isa/opt-in/revoke', { config: { auth: 'ai_isa.optin' }, preHandler: authorize('ai_isa.optin', () => ({ loosening: false })), schema: { body: S.EmptyBody, response: { 200: S.RevokeResult } } },
    async (req) => ({ ended: await revokeOptIn(actorOf(req), depsOf(req)) }));
  r.post('/me/ai-isa/pause-all', { config: { auth: 'ai_isa.optin' }, preHandler: authorize('ai_isa.optin', () => ({ loosening: false })), schema: { body: S.EmptyBody, response: { 200: S.PauseAllResult } } },
    async (req) => ({ paused: await pauseAll(actorOf(req), depsOf(req)) }));
  r.post('/me/ai-isa/re-attest', { config: { auth: 'ai_isa.optin' }, preHandler: authorize('ai_isa.optin', () => ({ loosening: true })), schema: { body: S.ReattestBody, response: { 200: S.ReattestResult } } },
    async (req) => reattest(actorOf(req), depsOf(req), req.body.versionId));

  // ---- leads ----
  r.get('/ai-isa/assignments', { config: { auth: 'ai_isa.view' }, preHandler: authorize('ai_isa.view', () => ({ own: true })), schema: { querystring: S.ListQuery, response: { 200: S.ListResponse } } }, async (req) => {
    const actor = actorOf(req);
    const p = platformOf(req);
    const q = req.query;
    return withTenantTx(actor, async (tx) => {
      const rows = await sql<{ id: string; contact_id: string; name: string | null; side: string; owner_user_id: string; owner_name: string | null; release: Date | null; overdue: boolean; next: Date | null; ended_at: Date | null }>`
        SELECT a.id, a.contact_id, c.display_name AS name, a.side, a.owner_user_id, u.display_name AS owner_name, c.inactivity_release_at AS release, a.next_follow_up_at AS next, a.ended_at,
               EXISTS (SELECT 1 FROM ai_isa_handoffs h WHERE h.tenant_id = a.tenant_id AND h.assignment_id = a.id AND h.sla_class <> 'none' AND h.sla_met_at IS NULL AND h.sla_due_at < now()
                         AND h.closed_at IS NULL) AS overdue
          FROM ai_isa_assignments a JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.tenant_id = app.tenant_id()
           ${q.scope === 'mine' ? sql`AND a.owner_user_id = ${actor.userId}` : sql``}
           ${q.state === 'live' ? sql`AND a.ended_at IS NULL AND a.paused_at IS NULL` : q.state === 'paused' ? sql`AND a.ended_at IS NULL AND a.paused_at IS NOT NULL` : q.state === 'ended' ? sql`AND a.ended_at IS NOT NULL` : sql``}
         ORDER BY a.started_at DESC LIMIT 200`.execute(tx);
      const out = [];
      for (const x of rows.rows) {
        const a = (await assignmentById(tx, x.id))!;
        out.push({ assignmentId: x.id, contactId: x.contact_id, name: x.name ?? 'Someone', side: x.side as 'buyer', chip: chipOf(a, null), lastAction: null,
          nextTouchAt: x.next?.toISOString() ?? null, capsSentence: '', inactivityReleaseAt: x.release?.toISOString() ?? null, ownerUserId: x.owner_user_id, ownerName: x.owner_name ?? '', handoffOverdue: x.overdue });
      }
      return { rows: out, holdSentence: p.config.aiIsaLiveSends ? null : 'AI assistant sending is off on this deployment.' };
    }, { db: p.db });
  });
  r.get('/contacts/:id/ai-isa', { config: { auth: 'ai_isa.view' }, preHandler: authorize('ai_isa.view', contactFacts), schema: { params: S.IdParams, response: { 200: S.PanelResponse } } },
    async (req) => panel(req, req.params.id));
  r.get('/contacts/:id/ai-isa/turns', { config: { auth: 'ai_isa.view' }, preHandler: authorize('ai_isa.view', contactFacts), schema: { params: S.IdParams, response: { 200: S.TurnsResponse } } }, async (req) => {
    return withTenantTx(actorOf(req), async (tx) => {
      const t = await sql<{ id: string; seq: number; epoch: number; attempt: number; trigger_kind: string; status: string; state_before: string; state_after: string | null; channel: 'sms' | 'email' | null;
        message_kind: 'reply' | 'initiated' | null; message_id: string | null; not_before: Date | null; zones: string[] | null; decision: Record<string, unknown>; denied: unknown[];
        rules_version: string; policy_version: string; prompt_version: string; created_at: Date }>`SELECT * FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND contact_id = ${req.params.id} ORDER BY created_at DESC LIMIT 100`.execute(tx);
      return { turns: t.rows.map((x) => ({ id: x.id, seq: x.seq, epoch: x.epoch, attempt: x.attempt, triggerKind: x.trigger_kind, status: x.status, stateBefore: x.state_before, stateAfter: x.state_after,
        channel: x.channel, messageKind: x.message_kind, messageId: x.message_id, notBefore: x.not_before?.toISOString() ?? null, zones: x.zones, decision: x.decision, denied: x.denied,
        versions: { rules: x.rules_version, policy: x.policy_version, prompt: x.prompt_version }, createdAt: x.created_at.toISOString() })) };
    }, { db: platformOf(req).db });
  });
  r.post('/contacts/:id/ai-isa/start', { ...ctl('ai_isa.start', true), schema: { params: S.IdParams, body: S.StartBody, response: { 200: S.StartResult } } },
    async (req) => startCare(actorOf(req), depsOf(req), req.params.id, req.body));
  r.post('/contacts/:id/ai-isa/pause', { ...ctl('ai_isa.pause'), schema: { params: S.IdParams, body: S.PauseBody, response: { 200: S.ControlResult } } },
    async (req) => pauseCare(actorOf(req), depsOf(req), req.params.id, 'pause'));
  r.post('/contacts/:id/ai-isa/resume', { ...ctl('ai_isa.resume', true), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.ControlResult } } },
    async (req) => resumeCare(actorOf(req), depsOf(req), req.params.id));
  r.post('/contacts/:id/ai-isa/take-over', { ...ctl('ai_isa.control'), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.ControlResult } } },
    async (req) => pauseCare(actorOf(req), depsOf(req), req.params.id, 'take_over'));
  r.post('/contacts/:id/ai-isa/end', { ...ctl('ai_isa.control'), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.ControlResult } } },
    async (req) => pauseCare(actorOf(req), depsOf(req), req.params.id, 'end'));
  r.post('/contacts/:id/ai-isa/undo', { ...ctl('ai_isa.control'), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.ControlResult } } },
    async (req) => undoControl(actorOf(req), depsOf(req), req.params.id));
  r.post('/contacts/:id/ai-isa/continue', { ...ctl('ai_isa.start', true), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.StartResult } } },
    async (req) => continueCare(actorOf(req), depsOf(req), req.params.id));
  r.post('/contacts/:id/ai-isa/lift-block', { ...ctl('ai_isa.start', true), schema: { params: S.IdParams, body: S.LiftBlockBody, response: { 200: S.LiftBlockResult } } },
    async (req) => ({ lifted: await liftBlock(actorOf(req), depsOf(req), req.params.id, req.body.inboundMessageId, req.body.attestation) }));

  // ---- handoffs and held topics ----
  const handoffFacts = async (req: FastifyRequest) => {
    const p = platformOf(req);
    // b12 review F2/F6: a handoff on a merged-away record is decided on the record its merge chain ends at (0081)
    const c = await withTenantTx(actorOf(req), (tx) => sql<{ c: string }>`SELECT app.contact_merge_root(tenant_id, contact_id) AS c FROM ai_isa_handoffs
      WHERE tenant_id = app.tenant_id() AND id = ${idOfParam(req)}`.execute(tx), { db: p.db });
    return c.rows[0] ? detailFacts(req, () => c.rows[0]!.c) : null;
  };
  r.post('/ai-isa/handoffs/:id/ack', { config: { auth: 'ai_isa.handoff' }, preHandler: authorize('ai_isa.handoff', handoffFacts), schema: { params: S.IdParams, body: S.EmptyBody, response: { 200: S.AckResult } } }, async (req) => {
    const actor = actorOf(req);
    const db = platformOf(req).db;
    const out = await withTenantTx(actor, async (tx, now) => {
      const u = await sql<{ id: string; at: Date; met: Date | null; cs: string; cls: string; action_id: string; closed: HandoffCloseReason | null }>`UPDATE ai_isa_handoffs SET acknowledged_at = COALESCE(acknowledged_at, ${new Date(now)}),
          acknowledged_by_user_id = COALESCE(acknowledged_by_user_id, ${actor.userId})
        WHERE tenant_id = app.tenant_id() AND id = ${req.params.id} RETURNING id, acknowledged_at AS at, sla_met_at AS met, confirmation_status AS cs, sla_class AS cls, assistant_action_id AS action_id, closed_reason AS closed`.execute(tx);
      const h = u.rows[0];
      if (!h) throw new AppError('NOT_FOUND');
      await audit(tx, actor, { action: 'ai_isa.handoff_acknowledged', entity: { type: 'ai_isa_handoff', id: h.id } });
      return { body: { handoffId: h.id, acknowledgedAt: h.at.toISOString(), slaMet: h.met !== null, confirmationStatus: h.cs, closedReason: h.closed },
        close: h.cls === 'none' && h.closed === null ? { id: h.id, actionId: h.action_id } : null };
    }, { db });
    // b12 recheck R13: a handoff no touch can ever meet (no deadline) is done once acknowledged: the system closes every
    // card of it (the Team Lead's and each Owner/Admin's too, which the caller's RLS would not reach) and executes its
    // action, right after the acknowledgement commits; a repeat "Got it" retries it. A handoff with a deadline stays open
    // until a human touch meets it (the sweep). b12 recheck R19: the result says why the handoff is closed, as stored.
    // b12 recheck R20: the acknowledgement has committed by then, so a failed close is no failed "Got it": the answer
    // stays 200 and says it is not closed yet (closedReason null), and the deadline sweep closes an acknowledged
    // no-deadline handoff that is still open (slaSweepInTx), so the cards never stay open for want of a retry.
    if (out.close !== null) {
      const sys = systemActor(actor.tenantId, 'assistant');
      try {
        out.body.closedReason = await withTenantTx(sys, async (tx, now) => {
          await closeHandoffInTx(tx, sys, out.close!, 'acknowledged', now);
          return (await sql<{ r: HandoffCloseReason | null }>`SELECT closed_reason AS r FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND id = ${out.close!.id}`.execute(tx)).rows[0]?.r ?? null;
        }, { db });
      } catch (err) {
        req.log.warn({ code: 'AI_ISA_HANDOFF_CLOSE_DEFERRED', err }, 'handoff close after the acknowledgement failed; the deadline sweep retries it');
      }
    }
    return out.body;
  });
  r.post('/ai-isa/escalations/:id/resolve', { config: { auth: 'ai_isa.handoff' }, preHandler: authorize('ai_isa.handoff', async (req) => {
    const p = platformOf(req);
    const c = await withTenantTx(actorOf(req), (tx) => sql<{ c: string }>`SELECT contact_id AS c FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND id = ${idOfParam(req)}`.execute(tx), { db: p.db });
    return c.rows[0] ? detailFacts(req, () => c.rows[0]!.c) : null;
  }), schema: { params: S.EscalationParams, body: S.ResolveBody, response: { 200: S.ResolveResult } } }, async (req) => {
    return resolveEscalation(actorOf(req), depsOf(req) as IsaDeps, req.params.id, req.body.class);
  });
}

export const isaRoutes: RouteModule = { name: 'ai-isa', register };
