// GET /ai-isa/handoffs/:id: the full handoff package for the web's handoff card (module 76, ISA-4; R-ISA-14; Q1).
// Read-only: no write, no audit, no new SQL privilege. It reads ai_isa_handoffs under its own RLS (0080's isa_select: tenant-wide
// roles, or whoever may see the contact's details; 0081 adds the record's root survivor's detail audience) and is authorized as `ai_isa.view` with the facts of the handoff's
// contact, exactly as the ack route finds them (isa/routes.ts:188-192). An invisible handoff, another tenant's, a forged
// id or a role without the grant (tc) is 404 (R-PERM-5).
//
// The package is the frozen jsonb of handoff.ts:56-73, re-shaped for the web: instants become ISO strings; the
// conversation keeps seq, status and messageId only (a turn's decision and denied codes stay on the turns route);
// any confidence, score or probability key and any tenant key are dropped wherever they appear (R-AST-13, R-TEN-3).
// Keys ISA-2b adds pass through (z.looseObject). canAcknowledge says whether the ack route would authorize this viewer
// (core can('ai_isa.handoff') on the merge root's facts; batch 13 isa-4 F14) AND its UPDATE would match a row (0080's
// isa_update: the recipient or a tenant-wide role; V8), so the web never offers a button that 404s.
// Batch 13 merge: 0081's sla_class 'none' (no human touch can clear it, so no deadline) is a class here too and is never
// overdue, and a handoff the system closed (closed_reason, 0081) is done, never overdue, as on the panel (isa/routes.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { can } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { detailFacts } from '../people/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { actorOf, platformOf } from '../workspace/common.js';
import { HANDOFF_CLOSE_REASONS, IdParams, SLA_CLASSES } from '../isa/schemas.js';

const Iso = z.string();

export const HandoffPackage = z.looseObject({
  v: z.number().int().optional(),
  reason: z.string().optional(),
  escalation: z.string().nullable().optional(),
  priority: z.string().optional(),
  basis: z.object({ rule: z.string(), ruleVersion: z.string(), claimIds: z.array(z.string()) }).nullable().optional(),
  appointment: z.looseObject({ appointmentId: z.string(), kind: z.string(), confirmationQueued: z.boolean() }).nullable().optional(),
  openOffer: z.looseObject({ offerId: z.string(), slots: z.array(z.looseObject({ startsAt: Iso, endsAt: Iso })), deliveredAt: Iso.nullable(), expiresAt: Iso.nullable() }).nullable().optional(),
  commitments: z.array(z.string()).optional(),
  claims: z.array(z.looseObject({ claimId: z.string(), field: z.string(), value: z.unknown(), quote: z.string(), messageId: z.string() })).optional(),
  conversation: z.array(z.strictObject({ seq: z.number().int(), status: z.string(), messageId: z.string().nullable() })).optional(),
  factsSent: z.array(z.looseObject({ factKind: z.string(), listingId: z.string().nullable(), messageId: z.string().nullable() })).optional(),
  unansweredInbound: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  startedAt: Iso.optional(),
  epoch: z.number().int().optional(),
  // ISA-2b's keys (isa/handoff.ts, isa/booking/book.ts appointmentDetail), typed so the web's fixtures are checked
  // against them (batch 13 isa-4 F6); each optional and nullable, so an older package still reads
  appointmentDetail: z.looseObject({ kind: z.string().optional(), startsAt: Iso.nullable().optional(), endsAt: Iso.nullable().optional(), organizerUserId: z.string().nullable().optional(),
    acceptedMessageId: z.string().nullable().optional(), acceptedQuote: z.string().nullable().optional(), zones: z.array(z.string()).optional() }).nullable().optional(),
  inactivityReleaseAt: Iso.nullable().optional(),
  savedSearch: z.looseObject({ id: z.string(), status: z.string() }).nullable().optional(),
  recipientUserId: z.string().nullable().optional(),
  endedByUserId: z.string().nullable().optional(),
});

export const HandoffView = z.object({
  id: z.uuid(),
  assignmentId: z.uuid(),
  contactId: z.uuid(),
  reason: z.string(),
  slaClass: z.enum(SLA_CLASSES),
  slaDueAt: Iso,
  slaMetAt: Iso.nullable(),
  overdue: z.boolean(),
  closedReason: z.enum(HANDOFF_CLOSE_REASONS).nullable(),
  createdAt: Iso,
  acknowledgedAt: Iso.nullable(),
  acknowledgedByUserId: z.uuid().nullable(),
  recipientUserId: z.uuid().nullable(),
  canAcknowledge: z.boolean(),
  confirmationStatus: z.string(),
  pendingMessage: z.object({ id: z.uuid(), kind: z.enum(['confirmation', 'holding_line']), channel: z.string(), status: z.string(), scheduledFor: Iso.nullable() }).nullable(),
  package: HandoffPackage,
});

const INSTANT_KEYS = new Set(['startedAt', 'deliveredAt', 'expiresAt', 'startsAt', 'endsAt', 'at', 'since', 'createdAt', 'bookedAt', 'inactivityReleaseAt']);
/** Keys that never leave this route, at any depth (R-AST-13 no scores; R-TEN-3 no tenant). */
export const DROPPED_KEY = /confidence|score|probabilit|^tenant/i;

/** Instants (epoch ms) become ISO strings; dropped keys go; everything else passes as stored. */
export function webPackage(raw: unknown): unknown {
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (DROPPED_KEY.test(k)) continue;
        out[k] = walk(x, k);
      }
      return out;
    }
    if (key !== null && INSTANT_KEYS.has(key) && typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
    return v;
  };
  const p = walk(raw, null) as Record<string, unknown>;
  if (Array.isArray(p.conversation)) {
    p.conversation = (p.conversation as Record<string, unknown>[]).map((t) => ({ seq: t.seq, status: t.status, messageId: t.messageId ?? null }));
  }
  return p;
}

const CATEGORY_KIND: Record<string, 'confirmation' | 'holding_line'> = { ai_isa_confirmation: 'confirmation', ai_isa_holding_line: 'holding_line' };

/**
 * Whether POST /ai-isa/handoffs/:id/ack would authorize this actor: core can('ai_isa.handoff') on the facts of the record
 * the handoff's merge chain ends at, exactly as the ack route's preHandler decides (a re-auth prompt is no refusal).
 */
async function mayAcknowledge(req: FastifyRequest, handoffId: string): Promise<boolean> {
  const actor = req.actor;
  const state = req.authState;
  if (!actor || !state) return false;
  const p = platformOf(req);
  const root = await withTenantTx(actorOf(req), (tx) => sql<{ c: string }>`SELECT app.contact_merge_root(tenant_id, contact_id) AS c FROM ai_isa_handoffs
    WHERE tenant_id = app.tenant_id() AND id = ${handoffId}`.execute(tx), { db: p.db });
  const facts = root.rows[0] ? await detailFacts(req, () => root.rows[0]!.c) : null;
  if (facts === null) return false;
  const r = can(actor, 'ai_isa.handoff', { ...facts, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } });
  return r.ok || r.code === 'REAUTH_REQUIRED';
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const handoffFacts = async (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    const p = platformOf(req);
    const c = await withTenantTx(actorOf(req), (tx) => sql<{ c: string }>`SELECT contact_id AS c FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx), { db: p.db });
    return c.rows[0] ? detailFacts(req, () => c.rows[0]!.c) : null;
  };
  r.get('/ai-isa/handoffs/:id', { config: { auth: 'ai_isa.view' }, preHandler: authorize('ai_isa.view', handoffFacts), schema: { params: IdParams, response: { 200: HandoffView } } }, async (req) => {
    const actor = actorOf(req);
    // batch 13 isa-4 F14: the ack route's own authorization (ai_isa.handoff on the merge root's facts, as isa/routes.ts
    // decides it) AND its UPDATE's RLS (the recipient or a tenant-wide role, below), so "Got it" never 404s
    const ackOk = await mayAcknowledge(req, req.params.id);
    return withTenantTx(actor, async (tx, now) => {
      const h = await sql<{ id: string; assignment_id: string; contact_id: string; reason: string; sla_class: (typeof SLA_CLASSES)[number]; sla_due_at: Date; sla_met_at: Date | null; closed_reason: (typeof HANDOFF_CLOSE_REASONS)[number] | null;
        created_at: Date; acknowledged_at: Date | null; acknowledged_by_user_id: string | null; recipient_user_id: string | null; confirmation_status: string; package: unknown; pending_message_id: string | null }>`
        SELECT id, assignment_id, contact_id, reason, sla_class, sla_due_at, sla_met_at, created_at, acknowledged_at, acknowledged_by_user_id, recipient_user_id,
               confirmation_status, package, pending_message_id, closed_reason
          FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND id = ${req.params.id}`.execute(tx);
      const row = h.rows[0];
      if (!row) throw new AppError('NOT_FOUND');
      let pendingMessage = null;
      if (row.pending_message_id) {
        const m = await sql<{ id: string; action_category: string | null; channel: string; status: string; scheduled_for: Date | null }>`
          SELECT id, action_category, channel, status, scheduled_for FROM messages WHERE tenant_id = app.tenant_id() AND id = ${row.pending_message_id}`.execute(tx);
        const msg = m.rows[0];
        if (msg) pendingMessage = { id: msg.id, kind: CATEGORY_KIND[msg.action_category ?? ''] ?? 'holding_line', channel: msg.channel, status: msg.status, scheduledFor: msg.scheduled_for?.toISOString() ?? null };
      }
      const tenantWide = actor.role === 'owner' || actor.role === 'admin';
      return {
        id: row.id, assignmentId: row.assignment_id, contactId: row.contact_id, reason: row.reason, slaClass: row.sla_class,
        slaDueAt: row.sla_due_at.toISOString(), slaMetAt: row.sla_met_at?.toISOString() ?? null, overdue: row.sla_class !== 'none' && row.sla_met_at === null && row.closed_reason === null && row.sla_due_at.getTime() < now,
        closedReason: row.closed_reason,
        createdAt: row.created_at.toISOString(), acknowledgedAt: row.acknowledged_at?.toISOString() ?? null, acknowledgedByUserId: row.acknowledged_by_user_id,
        recipientUserId: row.recipient_user_id,
        canAcknowledge: ackOk && (tenantWide || (row.recipient_user_id !== null && row.recipient_user_id === actor.userId)),
        confirmationStatus: row.confirmation_status,
        pendingMessage,
        package: webPackage(row.package) as z.infer<typeof HandoffPackage>,
      };
    }, { db: platformOf(req).db });
  });
}

export const isaWebRoutes: RouteModule = { name: 'ai-isa-web', register };
