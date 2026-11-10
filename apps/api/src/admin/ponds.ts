// Ponds (BUILD_PLAN module 10; R-AUDIT-5 pond changes, R-PERM-1).
//
//   GET    /ponds                 live ponds, members, leads waiting                Owner/Admin
//   POST   /ponds                 create                                             Owner/Admin
//   PATCH  /ponds/:id             settings; isDefault: true moves the default here   Owner/Admin
//   DELETE /ponds/:id             archive                                            Owner/Admin
//   PUT    /ponds/:id/members     { userIds }  who may claim when not open to all    Owner/Admin
//
// Archiving refuses the default pond (DEFAULT_POND_PROTECTED; DB CHECK backs it), a pond a live
// routing rule still sends leads to (POND_IN_USE: change the rule first), and a pond with leads
// waiting (POND_NOT_EMPTY: those leads move only through ownership commands, never as a side effect
// of an admin edit, R-OWN-21). Claim limits apply to claims made after the change; nothing already
// owned moves. Pond members must be active members in a role that may claim (TCs never claim,
// R-PERM-15).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Tx } from '@realty/db';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { adminLock, adminTx, platformOf } from './common.js';
import * as repo from './repos/ponds.js';
import { memberFacts } from './repos/routing.js';
import { Label, OkResponse, PondResponse, PondRole, PondsResponse } from './schemas.js';

const Fields = {
  name: Label,
  openToAll: z.boolean(),
  eligibleRoles: z.array(PondRole).min(1).max(3),
  claimsPerDay: z.number().int().min(0).max(50),
  claimCooldownHours: z.number().int().min(0).max(720),
  reinquiry: z.enum(['reroute', 'stay']),
};

const CreateBody = z
  .object({
    name: Fields.name,
    openToAll: Fields.openToAll.optional(),
    eligibleRoles: Fields.eligibleRoles.optional(),
    claimsPerDay: Fields.claimsPerDay.optional(),
    claimCooldownHours: Fields.claimCooldownHours.optional(),
    reinquiry: Fields.reinquiry.optional(),
  })
  .strict();

const PatchBody = z
  .object({
    name: Fields.name.optional(),
    openToAll: Fields.openToAll.optional(),
    eligibleRoles: Fields.eligibleRoles.optional(),
    claimsPerDay: Fields.claimsPerDay.optional(),
    claimCooldownHours: Fields.claimCooldownHours.optional(),
    reinquiry: Fields.reinquiry.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict();

function writeOf(p: repo.PondRow): repo.PondWrite {
  return { name: p.name, openToAll: p.open_to_all, eligibleRoles: p.eligible_roles, claimsPerDay: p.claims_per_day, claimCooldownHours: p.claim_cooldown_hours, reinquiry: p.reinquiry };
}

function auditShape(w: repo.PondWrite, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: w.name,
    open_to_all: w.openToAll,
    eligible_roles: [...w.eligibleRoles].sort(),
    claims_per_day: w.claimsPerDay,
    claim_cooldown_hours: w.claimCooldownHours,
    reinquiry: w.reinquiry,
    ...extra,
  };
}

async function views(tx: Tx, ponds: readonly repo.PondRow[]) {
  const ids = ponds.map((p) => p.id);
  const members = await repo.pondMembers(tx, ids);
  const waiting = await repo.waitingCounts(tx, ids);
  return ponds.map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: p.is_default,
    openToAll: p.open_to_all,
    eligibleRoles: p.eligible_roles,
    claimsPerDay: p.claims_per_day,
    claimCooldownHours: p.claim_cooldown_hours,
    reinquiry: p.reinquiry,
    archived: p.archived_at !== null,
    memberUserIds: members.filter((m) => m.pond_id === p.id).map((m) => m.user_id),
    waitingLeads: waiting.get(p.id) ?? 0,
  }));
}

async function viewOne(tx: Tx, id: string) {
  const p = await repo.getPond(tx, id);
  if (!p) throw new AppError('NOT_FOUND');
  return (await views(tx, [p]))[0]!;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };

  r.get('/ponds', { ...auth, schema: { response: { 200: PondsResponse } } }, async (req) =>
    adminTx(req, async (tx) => ({ ponds: await views(tx, await repo.listPonds(tx)) })),
  );

  r.post('/ponds', { ...auth, schema: { body: CreateBody, response: { 201: PondResponse } } }, async (req, reply) => {
    const p = platformOf(req);
    const b = req.body;
    const w: repo.PondWrite = {
      name: b.name,
      openToAll: b.openToAll ?? true,
      eligibleRoles: [...new Set(b.eligibleRoles ?? ['agent', 'team_lead', 'isa'])],
      claimsPerDay: b.claimsPerDay ?? 5,
      claimCooldownHours: b.claimCooldownHours ?? 72,
      reinquiry: b.reinquiry ?? 'reroute',
    };
    const view = await adminTx(req, async (tx, _now, actor) => {
      const id = p.ids.next<'PondId'>();
      await repo.insertPond(tx, id, w);
      await audit(tx, actor, { action: 'pond.changed', entity: { type: 'pond', id }, changes: redactSnapshot(auditShape(w), { entity: 'pond' }), reason: 'CREATED' });
      return viewOne(tx, id);
    });
    reply.status(201);
    return { pond: view };
  });

  r.patch('/ponds/:id', { ...auth, schema: { params: z.object({ id: z.uuid() }), body: PatchBody, response: { 200: PondResponse } } }, async (req) => {
    const b = req.body;
    const view = await adminTx(req, async (tx, _now, actor) => {
      if (b.isDefault) await adminLock(tx, 'ponds');
      const cur = await repo.getPond(tx, req.params.id, { forUpdate: true });
      if (!cur) throw new AppError('NOT_FOUND');
      const before = writeOf(cur);
      const next: repo.PondWrite = {
        name: b.name ?? cur.name,
        openToAll: b.openToAll ?? cur.open_to_all,
        eligibleRoles: b.eligibleRoles ? [...new Set(b.eligibleRoles)] : cur.eligible_roles,
        claimsPerDay: b.claimsPerDay ?? cur.claims_per_day,
        claimCooldownHours: b.claimCooldownHours ?? cur.claim_cooldown_hours,
        reinquiry: b.reinquiry ?? cur.reinquiry,
      };
      await repo.updatePond(tx, cur.id, next);
      let previousDefault: string | null = null;
      if (b.isDefault && !cur.is_default) previousDefault = await repo.makeDefault(tx, cur.id);
      await audit(tx, actor, {
        action: 'pond.changed',
        entity: { type: 'pond', id: cur.id },
        changes: redactDiff(
          auditShape(before, { is_default: cur.is_default, previous_default_pond_id: null }),
          auditShape(next, { is_default: cur.is_default || b.isDefault === true, previous_default_pond_id: previousDefault }),
          { entity: 'pond' },
        ),
        reason: 'UPDATED',
      });
      return viewOne(tx, cur.id);
    });
    return { pond: view };
  });

  r.put(
    '/ponds/:id/members',
    { ...auth, schema: { params: z.object({ id: z.uuid() }), body: z.object({ userIds: z.array(z.uuid()).max(500) }).strict(), response: { 200: PondResponse } } },
    async (req) => {
      const view = await adminTx(req, async (tx, _now, actor) => {
        const cur = await repo.getPond(tx, req.params.id, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const ids = [...new Set(req.body.userIds)].sort();
        const facts = new Map((await memberFacts(tx, ids)).map((m) => [m.user_id, m]));
        for (const id of ids) {
          const m = facts.get(id);
          if (!m) throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'not_a_member' });
          if (m.status !== 'active') throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'not_active' });
          if (m.role === 'tc') throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: id, reason: 'role_never_claims' });
        }
        const before = (await repo.pondMembers(tx, [cur.id])).map((m) => m.user_id);
        await repo.replacePondMembers(tx, cur.id, ids);
        await audit(tx, actor, {
          action: 'pond.changed',
          entity: { type: 'pond', id: cur.id },
          changes: redactDiff({ member_user_ids: before }, { member_user_ids: ids }, { entity: 'pond' }),
          reason: 'MEMBERS_SET',
        });
        return viewOne(tx, cur.id);
      });
      return { pond: view };
    },
  );

  r.delete('/ponds/:id', { ...auth, schema: { params: z.object({ id: z.uuid() }), response: { 200: OkResponse } } }, async (req) => {
    await adminTx(req, async (tx, now, actor) => {
      await adminLock(tx, 'routing_rules'); // a rule cannot start targeting the pond while it is archived
      const cur = await repo.getPond(tx, req.params.id, { forUpdate: true });
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.is_default) throw new AppError('DEFAULT_POND_PROTECTED');
      const rules = await repo.rulesUsingPond(tx, cur.id);
      if (rules.length > 0) throw new AppError('POND_IN_USE', { ruleIds: rules });
      const waiting = (await repo.waitingCounts(tx, [cur.id])).get(cur.id) ?? 0;
      if (waiting > 0) throw new AppError('POND_NOT_EMPTY', { waitingLeads: waiting });
      await repo.archivePond(tx, cur.id);
      await audit(tx, actor, {
        action: 'pond.changed',
        entity: { type: 'pond', id: cur.id },
        changes: redactDiff({ archived_at: null }, { archived_at: new Date(now) }, { entity: 'pond' }),
        reason: 'ARCHIVED',
      });
    });
    return { ok: true as const };
  });
}

export async function registerPondRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
