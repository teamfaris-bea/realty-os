// Routing rules (BUILD_PLAN module 10; R-OWN-10 rule shape, R-AUDIT-5 routing changes, R-PERM-1).
//
//   GET    /routing-rules                 live rules in position order, with members      Owner/Admin
//   POST   /routing-rules                 create (appended after the last rule)             Owner/Admin
//   PATCH  /routing-rules/:id             { ..., version }  optimistic                     Owner/Admin
//   DELETE /routing-rules/:id             archive (a rule that routed leads is cited by them) Owner/Admin
//   PUT    /routing-rules/order           { ruleIds }  every live rule, new order, ONE tx  Owner/Admin
//   PUT    /routing-rules/:id/members     [{ userId, weight }]  replace the candidate set   Owner/Admin
//
// R-OWN-10 shape, enforced here before the DB CHECKs: match is the core schema (sources, lead_types,
// zips, price band; unknown keys rejected); direct ⇔ directUserId; pond ⇔ targetPondId; only
// round_robin / weighted carry members; ponds must be live; every candidate (members, the direct
// user) must be an active member in a role that can be offered leads (agent, team_lead, isa:
// R-OWN-11 #2, so never a TC, R-PERM-15). Routing itself (first enabled rule by position, the
// strategies, the cursor) stays in core/db and runs only as the system actor.
//
// The reorder is atomic: positions are rewritten in one transaction and the UNIQUE (tenant_id,
// position) is DEFERRABLE INITIALLY DEFERRED, so a swap never trips it midway and a reader sees the
// old order or the new one, never a mix. Rule writes take one per-tenant admin lock, so concurrent
// creates/reorders serialize instead of racing on positions. Archived rules keep positions after
// the live ones.
import { routingMatchSchema } from '@realty/core/ownership';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { Tx } from '@realty/db';
import { adminLock, adminTx, platformOf } from './common.js';
import * as repo from './repos/routing.js';
import { Label, OkResponse, RoutingRuleResponse, RoutingRulesResponse, RuleMember } from './schemas.js';

const OFFERABLE_ROLES = new Set(['agent', 'team_lead', 'isa']);
const StrategyEnum = z.enum(['round_robin', 'weighted', 'direct', 'pond']);
const Members = z.array(RuleMember.strict()).max(200);

const RuleFields = {
  name: Label,
  match: z.record(z.string(), z.unknown()),
  strategy: StrategyEnum,
  directUserId: z.uuid().nullable(),
  targetPondId: z.uuid().nullable(),
  fallbackPondId: z.uuid().nullable(),
  offerWindowSeconds: z.number().int().min(30).max(86_400).nullable(),
  maxOffers: z.number().int().min(1).max(10).nullable(),
  enabled: z.boolean(),
};

const CreateBody = z
  .object({
    name: RuleFields.name,
    match: RuleFields.match.default({}),
    strategy: RuleFields.strategy,
    directUserId: RuleFields.directUserId.optional(),
    targetPondId: RuleFields.targetPondId.optional(),
    fallbackPondId: RuleFields.fallbackPondId.optional(),
    offerWindowSeconds: RuleFields.offerWindowSeconds.optional(),
    maxOffers: RuleFields.maxOffers.optional(),
    enabled: RuleFields.enabled.optional(),
    members: Members.optional(),
  })
  .strict();

const PatchBody = z
  .object({
    name: RuleFields.name.optional(),
    match: RuleFields.match.optional(),
    strategy: RuleFields.strategy.optional(),
    directUserId: RuleFields.directUserId.optional(),
    targetPondId: RuleFields.targetPondId.optional(),
    fallbackPondId: RuleFields.fallbackPondId.optional(),
    offerWindowSeconds: RuleFields.offerWindowSeconds.optional(),
    maxOffers: RuleFields.maxOffers.optional(),
    enabled: RuleFields.enabled.optional(),
    version: z.number().int().min(1),
  })
  .strict();

type MemberInput = z.infer<typeof Members>;

function ruleView(r: repo.RuleRow, members: readonly repo.RuleMemberRow[]) {
  return {
    id: r.id,
    position: r.position,
    name: r.name,
    match: r.match,
    strategy: r.strategy,
    directUserId: r.direct_user_id,
    targetPondId: r.target_pond_id,
    fallbackPondId: r.fallback_pond_id,
    offerWindowSeconds: r.offer_window_seconds,
    maxOffers: r.max_offers,
    enabled: r.enabled,
    archived: r.archived_at !== null,
    version: r.version,
    members: members.filter((m) => m.rule_id === r.id).map((m) => ({ userId: m.user_id, weight: m.weight })),
  };
}

/** The audited, PII-free snapshot of a rule (labels and ids only). */
function ruleAuditShape(r: repo.RuleWrite & { position?: number }, members?: readonly { userId: string; weight: number }[]) {
  const s: Record<string, unknown> = {
    name: r.name,
    match: r.match,
    strategy: r.strategy,
    direct_user_id: r.directUserId,
    target_pond_id: r.targetPondId,
    fallback_pond_id: r.fallbackPondId,
    offer_window_seconds: r.offerWindowSeconds,
    max_offers: r.maxOffers,
    enabled: r.enabled,
  };
  if (r.position !== undefined) s.position = r.position;
  if (members) {
    const sorted = [...members].sort((a, b) => (a.userId < b.userId ? -1 : 1));
    s.member_user_ids = sorted.map((m) => m.userId);
    s.member_weight_codes = sorted.map((m) => `${m.userId}=${m.weight}`);
  }
  return s;
}

function rowToWrite(r: repo.RuleRow): repo.RuleWrite {
  return {
    name: r.name,
    match: r.match,
    strategy: r.strategy,
    directUserId: r.direct_user_id,
    targetPondId: r.target_pond_id,
    fallbackPondId: r.fallback_pond_id,
    offerWindowSeconds: r.offer_window_seconds,
    maxOffers: r.max_offers,
    enabled: r.enabled,
  };
}

function invalid(field: string, reason: string): AppError {
  return new AppError('RULE_INVALID', { field, reason });
}

/** Validates match jsonb with the core schema and returns its canonical stored form. */
export function canonicalMatch(raw: unknown): Record<string, unknown> {
  const r = routingMatchSchema.safeParse(raw);
  if (!r.success) {
    throw new AppError('RULE_INVALID', { field: 'match', reason: 'invalid', issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.') || '(root)', code: i.code })) });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.data)) if (v !== undefined) out[k] = v;
  return out;
}

/** R-OWN-10 rule shape and candidate eligibility, checked against RLS-visible rows in this tx. */
export async function validateRule(tx: Tx, w: repo.RuleWrite, members: MemberInput | null): Promise<void> {
  if (w.strategy === 'direct') {
    if (!w.directUserId) throw invalid('directUserId', 'required_for_direct');
  } else if (w.directUserId) throw invalid('directUserId', 'only_for_direct');
  if (w.strategy === 'pond') {
    if (!w.targetPondId) throw invalid('targetPondId', 'required_for_pond');
  } else if (w.targetPondId) throw invalid('targetPondId', 'only_for_pond');
  if (members && members.length > 0 && (w.strategy === 'direct' || w.strategy === 'pond')) throw invalid('members', 'only_for_round_robin_or_weighted');
  if (members) {
    const ids = members.map((m) => m.userId);
    if (new Set(ids).size !== ids.length) throw invalid('members', 'duplicate_user');
  }
  for (const [field, pondId] of [['targetPondId', w.targetPondId], ['fallbackPondId', w.fallbackPondId]] as const) {
    if (!pondId) continue;
    const pond = await repo.pondState(tx, pondId);
    if (!pond) throw invalid(field, 'unknown_pond');
    if (pond.archived) throw invalid(field, 'archived_pond');
  }
  const candidateIds = [...(members ?? []).map((m) => m.userId), ...(w.directUserId ? [w.directUserId] : [])];
  const facts = new Map((await repo.memberFacts(tx, candidateIds)).map((m) => [m.user_id, m]));
  for (const id of candidateIds) {
    const m = facts.get(id);
    if (!m) throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'not_a_member' });
    if (m.status !== 'active') throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'not_active' });
    if (!OFFERABLE_ROLES.has(m.role)) throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'role_not_offered_leads' });
  }
}

async function loadView(tx: Tx, id: string) {
  const rule = await repo.getRule(tx, id);
  if (!rule) throw new AppError('NOT_FOUND');
  return ruleView(rule, await repo.listRuleMembers(tx, [rule.id]));
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };

  r.get('/routing-rules', { ...auth, schema: { response: { 200: RoutingRulesResponse } } }, async (req) =>
    adminTx(req, async (tx) => {
      const rules = await repo.listRules(tx);
      const members = await repo.listRuleMembers(tx, rules.map((x) => x.id));
      return { rules: rules.map((x) => ruleView(x, members)) };
    }),
  );

  r.post('/routing-rules', { ...auth, schema: { body: CreateBody, response: { 201: RoutingRuleResponse } } }, async (req, reply) => {
    const p = platformOf(req);
    const b = req.body;
    const w: repo.RuleWrite = {
      name: b.name,
      match: canonicalMatch(b.match),
      strategy: b.strategy,
      directUserId: b.directUserId ?? null,
      targetPondId: b.targetPondId ?? null,
      fallbackPondId: b.fallbackPondId ?? null,
      offerWindowSeconds: b.offerWindowSeconds ?? null,
      maxOffers: b.maxOffers ?? null,
      enabled: b.enabled ?? true,
    };
    const members = b.members ?? [];
    const view = await adminTx(req, async (tx, _now, actor) => {
      await adminLock(tx, 'routing_rules');
      await validateRule(tx, w, members);
      const id = p.ids.next<'RoutingRuleId'>();
      const position = await repo.nextPosition(tx);
      await repo.insertRule(tx, id, position, w);
      await repo.replaceRuleMembers(tx, id, members);
      await audit(tx, actor, {
        action: 'routing.changed',
        entity: { type: 'routing_rule', id },
        changes: redactSnapshot(ruleAuditShape({ ...w, position }, members), { entity: 'routing_rule' }),
        reason: 'CREATED',
      });
      return loadView(tx, id);
    });
    reply.status(201);
    return { rule: view };
  });

  r.put(
    '/routing-rules/order',
    { ...auth, schema: { body: z.object({ ruleIds: z.array(z.uuid()).max(500) }).strict(), response: { 200: RoutingRulesResponse } } },
    async (req) =>
      adminTx(req, async (tx, _now, actor) => {
        await adminLock(tx, 'routing_rules');
        await repo.lockAllRules(tx);
        const all = await repo.listRules(tx, { includeArchived: true });
        const live = all.filter((x) => x.archived_at === null);
        const want = req.body.ruleIds;
        const liveIds = new Set(live.map((x) => x.id));
        if (want.length !== live.length || new Set(want).size !== want.length || !want.every((id) => liveIds.has(id))) {
          throw new AppError('VERSION_CONFLICT', { ruleIds: live.map((x) => x.id) });
        }
        const archived = all.filter((x) => x.archived_at !== null).map((x) => x.id);
        const unchanged = want.every((id, i) => live[i]!.id === id);
        await repo.setPositions(tx, [...want, ...archived]);
        if (!unchanged) await audit(tx, actor, {
          action: 'routing.changed',
          entity: { type: 'routing_rule', id: null },
          changes: redactDiff({ rule_ids: live.map((x) => x.id) }, { rule_ids: want }, { entity: 'routing_rule' }),
          reason: 'REORDERED',
        });
        const rules = await repo.listRules(tx);
        const members = await repo.listRuleMembers(tx, rules.map((x) => x.id));
        return { rules: rules.map((x) => ruleView(x, members)) };
      }),
  );

  r.patch(
    '/routing-rules/:id',
    { ...auth, schema: { params: z.object({ id: z.uuid() }), body: PatchBody, response: { 200: RoutingRuleResponse } } },
    async (req) => {
      const b = req.body;
      const view = await adminTx(req, async (tx, _now, actor) => {
        await adminLock(tx, 'routing_rules');
        const cur = await repo.getRule(tx, req.params.id, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const curMembers = await repo.listRuleMembers(tx, [cur.id]);
        if (cur.version !== b.version) throw new AppError('VERSION_CONFLICT', { rule: ruleView(cur, curMembers) });
        const before = rowToWrite(cur);
        const strategy = b.strategy ?? cur.strategy;
        const next: repo.RuleWrite = {
          name: b.name ?? cur.name,
          match: b.match !== undefined ? canonicalMatch(b.match) : cur.match,
          strategy,
          // a strategy change clears the other strategy's target unless the body sets it
          directUserId: b.directUserId !== undefined ? b.directUserId : strategy === 'direct' ? cur.direct_user_id : null,
          targetPondId: b.targetPondId !== undefined ? b.targetPondId : strategy === 'pond' ? cur.target_pond_id : null,
          fallbackPondId: b.fallbackPondId !== undefined ? b.fallbackPondId : cur.fallback_pond_id,
          offerWindowSeconds: b.offerWindowSeconds !== undefined ? b.offerWindowSeconds : cur.offer_window_seconds,
          maxOffers: b.maxOffers !== undefined ? b.maxOffers : cur.max_offers,
          enabled: b.enabled ?? cur.enabled,
        };
        const keepsMembers = strategy === 'round_robin' || strategy === 'weighted';
        const members = curMembers.map((m) => ({ userId: m.user_id, weight: m.weight }));
        await validateRule(tx, next, keepsMembers ? null : []);
        await repo.updateRule(tx, cur.id, next);
        if (!keepsMembers && members.length > 0) await repo.replaceRuleMembers(tx, cur.id, []);
        await audit(tx, actor, {
          action: 'routing.changed',
          entity: { type: 'routing_rule', id: cur.id },
          changes: redactDiff(ruleAuditShape(before, members), ruleAuditShape(next, keepsMembers ? members : []), { entity: 'routing_rule' }),
          reason: 'UPDATED',
        });
        return loadView(tx, cur.id);
      });
      return { rule: view };
    },
  );

  r.put(
    '/routing-rules/:id/members',
    { ...auth, schema: { params: z.object({ id: z.uuid() }), body: Members, response: { 200: RoutingRuleResponse } } },
    async (req) => {
      const view = await adminTx(req, async (tx, _now, actor) => {
        await adminLock(tx, 'routing_rules');
        const cur = await repo.getRule(tx, req.params.id, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const before = (await repo.listRuleMembers(tx, [cur.id])).map((m) => ({ userId: m.user_id, weight: m.weight }));
        await validateRule(tx, rowToWrite(cur), req.body);
        await repo.replaceRuleMembers(tx, cur.id, req.body);
        await repo.bumpRuleVersion(tx, cur.id);
        await audit(tx, actor, {
          action: 'routing.changed',
          entity: { type: 'routing_rule', id: cur.id },
          changes: redactDiff(ruleAuditShape(rowToWrite(cur), before), ruleAuditShape(rowToWrite(cur), req.body), { entity: 'routing_rule' }),
          reason: 'MEMBERS_SET',
        });
        return loadView(tx, cur.id);
      });
      return { rule: view };
    },
  );

  r.delete('/routing-rules/:id', { ...auth, schema: { params: z.object({ id: z.uuid() }), response: { 200: OkResponse } } }, async (req) => {
    await adminTx(req, async (tx, now, actor) => {
      await adminLock(tx, 'routing_rules');
      const cur = await repo.getRule(tx, req.params.id, { forUpdate: true });
      if (!cur) throw new AppError('NOT_FOUND');
      await repo.archiveRule(tx, cur.id);
      await audit(tx, actor, {
        action: 'routing.changed',
        entity: { type: 'routing_rule', id: cur.id },
        changes: redactDiff({ enabled: cur.enabled, archived_at: null }, { enabled: false, archived_at: new Date(now) }, { entity: 'routing_rule' }),
        reason: 'ARCHIVED',
      });
    });
    return { ok: true as const };
  });
}

export async function registerRoutingRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
