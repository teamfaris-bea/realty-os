// Teams (BUILD_PLAN module 10; R-AUDIT-5, R-PERM-1). A team gives its Team Lead their scope ("T" in
// DATA_MODEL §3: own + team members'); Owners/Admins are tenant-wide regardless.
//
//   GET    /teams                    teams and members                              Owner/Admin
//   POST   /teams                    { name }                                       Owner/Admin
//   PATCH  /teams/:id                { name?, isDefault?: true }                    Owner/Admin
//   DELETE /teams/:id                not the default team (DB trigger backs it)     Owner/Admin
//   PUT    /teams/:id/members        { members: [{ userId, isLead }] }              Owner/Admin
//
// A lead flag is only accepted for a member whose role can lead (team_lead; Owner/Admin may carry it
// as provisioning gives the Owner): an agent marked "lead" would get no scope (app.my_team_member_ids
// requires the team_lead role), and an honest screen does not show a lead who is not one.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Tx } from '@realty/db';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { adminLock, adminTx, platformOf } from './common.js';
import { memberFacts } from './repos/routing.js';
import * as repo from './repos/teams.js';
import { Label, OkResponse, TeamResponse, TeamsResponse } from './schemas.js';

const LEAD_ROLES = new Set(['team_lead', 'owner', 'admin']);

async function views(tx: Tx, teams: readonly repo.TeamRow[]) {
  const members = await repo.teamMembers(tx, teams.map((t) => t.id));
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    isDefault: t.is_default,
    members: members.filter((m) => m.team_id === t.id).map((m) => ({ userId: m.user_id, isLead: m.is_lead })),
  }));
}

async function viewOne(tx: Tx, id: string) {
  const t = await repo.getTeam(tx, id);
  if (!t) throw new AppError('NOT_FOUND');
  return (await views(tx, [t]))[0]!;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };

  r.get('/teams', { ...auth, schema: { response: { 200: TeamsResponse } } }, async (req) =>
    adminTx(req, async (tx) => ({ teams: await views(tx, await repo.listTeams(tx)) })),
  );

  r.post('/teams', { ...auth, schema: { body: z.object({ name: Label }).strict(), response: { 201: TeamResponse } } }, async (req, reply) => {
    const p = platformOf(req);
    const view = await adminTx(req, async (tx, _now, actor) => {
      const id = p.ids.next<'TeamId'>();
      await repo.insertTeam(tx, id, req.body.name);
      await audit(tx, actor, { action: 'team.changed', entity: { type: 'team', id }, changes: redactSnapshot({ name: req.body.name }, { entity: 'team' }), reason: 'CREATED' });
      return viewOne(tx, id);
    });
    reply.status(201);
    return { team: view };
  });

  r.patch(
    '/teams/:id',
    {
      ...auth,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z
          .object({ name: Label.optional(), isDefault: z.literal(true).optional() })
          .strict()
          .refine((b) => b.name !== undefined || b.isDefault !== undefined, { message: 'nothing to change' }),
        response: { 200: TeamResponse },
      },
    },
    async (req) => {
      const view = await adminTx(req, async (tx, _now, actor) => {
        if (req.body.isDefault) await adminLock(tx, 'teams');
        const cur = await repo.getTeam(tx, req.params.id, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const name = req.body.name ?? cur.name;
        if (name !== cur.name) await repo.renameTeam(tx, cur.id, name);
        let previousDefault: string | null = null;
        if (req.body.isDefault && !cur.is_default) previousDefault = await repo.makeDefault(tx, cur.id);
        await audit(tx, actor, {
          action: 'team.changed',
          entity: { type: 'team', id: cur.id },
          changes: redactDiff(
            { name: cur.name, is_default: cur.is_default, previous_default_team_id: null },
            { name, is_default: cur.is_default || req.body.isDefault === true, previous_default_team_id: previousDefault },
            { entity: 'team' },
          ),
          reason: 'UPDATED',
        });
        return viewOne(tx, cur.id);
      });
      return { team: view };
    },
  );

  r.put(
    '/teams/:id/members',
    {
      ...auth,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ members: z.array(z.object({ userId: z.uuid(), isLead: z.boolean() }).strict()).max(500) }).strict(),
        response: { 200: TeamResponse },
      },
    },
    async (req) => {
      const view = await adminTx(req, async (tx, _now, actor) => {
        const cur = await repo.getTeam(tx, req.params.id, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const members = [...req.body.members].sort((a, b) => (a.userId < b.userId ? -1 : 1));
        if (new Set(members.map((m) => m.userId)).size !== members.length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/members', code: 'duplicate_user' }] });
        const facts = new Map((await memberFacts(tx, members.map((m) => m.userId))).map((m) => [m.user_id, m]));
        for (const m of members) {
          const f = facts.get(m.userId);
          if (!f || f.status === 'removed') throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: m.userId, reason: 'not_a_member' });
          if (m.isLead && !LEAD_ROLES.has(f.role)) throw new AppError('MEMBER_NOT_ELIGIBLE', { userId: m.userId, reason: 'role_cannot_lead' });
        }
        const before = await repo.teamMembers(tx, [cur.id]);
        await repo.replaceTeamMembers(tx, cur.id, members);
        await audit(tx, actor, {
          action: 'team.changed',
          entity: { type: 'team', id: cur.id },
          changes: redactDiff(
            { member_user_ids: before.map((m) => m.user_id), lead_user_ids: before.filter((m) => m.is_lead).map((m) => m.user_id) },
            { member_user_ids: members.map((m) => m.userId), lead_user_ids: members.filter((m) => m.isLead).map((m) => m.userId) },
            { entity: 'team' },
          ),
          reason: 'MEMBERS_SET',
        });
        return viewOne(tx, cur.id);
      });
      return { team: view };
    },
  );

  r.delete('/teams/:id', { ...auth, schema: { params: z.object({ id: z.uuid() }), response: { 200: OkResponse } } }, async (req) => {
    await adminTx(req, async (tx, _now, actor) => {
      const cur = await repo.getTeam(tx, req.params.id, { forUpdate: true });
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.is_default) throw new AppError('DEFAULT_TEAM_PROTECTED');
      const members = await repo.teamMembers(tx, [cur.id]);
      await repo.deleteTeam(tx, cur.id);
      await audit(tx, actor, {
        action: 'team.changed',
        entity: { type: 'team', id: cur.id },
        changes: redactDiff({ name: cur.name, member_user_ids: members.map((m) => m.user_id) }, { name: null, member_user_ids: [] }, { entity: 'team' }),
        reason: 'DELETED',
      });
    });
    return { ok: true as const };
  });
}

export async function registerTeamRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
