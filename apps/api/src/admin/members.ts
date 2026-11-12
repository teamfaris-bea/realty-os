// Members and invites (BUILD_PLAN module 10; R-PERM-1, R-PERM-2, R-PERM-13, R-PERM-14, R-AUDIT-5).
//
//   GET    /members                 members + pending invites                 Owner/Admin
//   POST   /invites                 { email, role }                           Owner/Admin 🔒 (Admin: never the Owner role)
//   DELETE /invites/:id                                                       Owner/Admin 🔒 (Admin: not an Owner invite)
//   PATCH  /members/:userId         { role?, status?, version }               Owner/Admin 🔒 (Admin: never an Owner, never to Owner)
//
// - Invites: a 32-byte token, only its sha256 is stored, valid 7 days, one pending per email. The link
//   goes to the user's account email through the AccountMailer (not a contact communication, so not
//   the outbound gate). The invite never re-roles an existing member: auth.accept_invite upserts the
//   membership as a definer (bypassing memberships_guard), so inviting a current member is refused
//   (MEMBER_EXISTS) and role changes go through PATCH /members, where the guard applies.
// - PATCH /members: role and status changes are guarded twice: core.can() on facts read under the
//   row lock (Owner-role changes need an Owner; Admins never act on an Owner) and the
//   memberships_guard trigger (R-PERM-2, incl. "a tenant always keeps one active Owner").
//   status: 'active' ⇄ 'suspended', or 'removed' once the member holds no leads. A member who still
//   owns or is offered leads is moved off them by the staged deactivation (R-OWN-22, api/leads
//   POST /members/:userId/deactivate), never by a status flip here (MEMBER_HAS_LEADS).
//   Becoming a TC also needs zero held leads (R-PERM-15) and turns accepting_leads off.
// - Session rotation on privilege change: a role change, suspension or removal ends the member's
//   sessions in this tenant (app.revoke_member_sessions). The caller's own session is kept when they
//   change themselves (roles are resolved live from the membership on every request anyway).
// - Every change writes its audit row in the same transaction (member.invited, member.invite_revoked,
//   member.role_changed, member.suspended, member.reactivated, member.removed) with a redacted diff.
import type { Action, Role } from '@realty/core/foundation';
import { normalizeEmail } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { newOpaqueToken } from '../auth/tokens.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { actorOf, adminTx, iso, platformOf, recheck } from './common.js';
import * as repo from './repos/members.js';
import { InviteCreatedResponse, MemberResponse, MembersResponse, OkResponse, RoleEnum } from './schemas.js';

export const INVITE_VALID_DAYS = 7;

const MemberStatusInput = z.enum(['active', 'suspended', 'removed']);

function memberView(m: repo.MemberRow) {
  return {
    userId: m.user_id,
    displayName: m.display_name,
    email: m.email,
    role: m.role,
    status: m.status,
    acceptingLeads: m.accepting_leads,
    mfaEnabled: m.mfa_enabled,
    joinedAt: iso(m.joined_at),
    version: m.version,
  };
}

function inviteView(i: repo.InviteRow) {
  return { id: i.id, email: i.email, role: i.role, invitedByUserId: i.invited_by_user_id, createdAt: iso(i.created_at)!, expiresAt: iso(i.expires_at)! };
}

/** The member's current role (RLS-visible) as authorize() facts, or null (404). */
async function memberFacts(req: FastifyRequest, userId: string, newRole?: Role) {
  const p = platformOf(req);
  const m = await withTenantTx(actorOf(req), (tx) => repo.getMember(tx, userId), { db: p.db });
  if (!m || m.status === 'removed') return null;
  return { target: newRole ? { role: m.role, newRole } : { role: m.role } };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/members',
    {
      config: { auth: 'settings.routing' },
      preHandler: authorize('settings.routing', () => ({})),
      schema: { response: { 200: MembersResponse } },
    },
    async (req) =>
      adminTx(req, async (tx) => {
        const [members, invites] = [await repo.listMembers(tx), await repo.listPendingInvites(tx)];
        return { members: members.map(memberView), invites: invites.map(inviteView) };
      }),
  );

  r.post(
    '/invites',
    {
      config: { auth: 'member.invite' },
      schema: { body: z.object({ email: z.string().trim().min(3).max(320), role: RoleEnum }).strict(), response: { 201: InviteCreatedResponse } },
      preHandler: authorize('member.invite', (req) => {
        const role = (req.body as { role: Role }).role;
        return { target: { role, newRole: role } };
      }),
    },
    async (req, reply) => {
      const p = platformOf(req);
      const norm = normalizeEmail(req.body.email);
      if (!norm.ok) throw new AppError('EMAIL_INVALID');
      const email = norm.email;
      const role = req.body.role;
      const { token, hash } = newOpaqueToken();
      const invite = await adminTx(req, async (tx, _now, actor) => {
        recheck(req, 'member.invite', { target: { role, newRole: role } });
        if (await repo.memberByEmail(tx, email)) throw new AppError('MEMBER_EXISTS');
        await repo.expireStaleInvites(tx, email);
        const row = await repo.insertInvite(tx, { id: p.ids.next<'InviteId'>(), email, role, tokenHash: hash, days: INVITE_VALID_DAYS });
        await audit(tx, actor, {
          action: 'member.invited',
          entity: { type: 'invite', id: row.id },
          changes: redactSnapshot({ email, role, expires_at: row.expires_at }, { entity: 'invite' }),
        });
        return row;
      });
      // After commit: the link goes to the invitee's account email (never to the inviter).
      let emailSent = true;
      try {
        await p.providers.accountMail.deliverAccountEmail({
          to: email,
          kind: 'invite',
          link: `${p.config.webOrigins[0]}/invite#token=${token}`,
          expiresInMinutes: INVITE_VALID_DAYS * 24 * 60,
        });
      } catch (e) {
        emailSent = false;
        req.log.warn({ code: 'ACCOUNT_MAIL_FAILED', err: e }, 'invite email failed');
      }
      reply.status(201);
      return { invite: inviteView(invite), emailSent };
    },
  );

  r.delete(
    '/invites/:id',
    {
      config: { auth: 'member.invite' },
      schema: { params: z.object({ id: z.uuid() }), response: { 200: OkResponse } },
      preHandler: authorize('member.invite', async (req) => {
        const id = (req.params as { id: string }).id;
        const inv = await withTenantTx(actorOf(req), (tx) => repo.getPendingInvite(tx, id), { db: platformOf(req).db });
        return inv ? { target: { role: inv.role, newRole: inv.role } } : null;
      }),
    },
    async (req) => {
      await adminTx(req, async (tx, _now, actor) => {
        const inv = await repo.getPendingInvite(tx, req.params.id, { forUpdate: true });
        if (!inv) throw new AppError('NOT_FOUND');
        recheck(req, 'member.invite', { target: { role: inv.role, newRole: inv.role } });
        if (!(await repo.revokeInvite(tx, inv.id))) throw new AppError('NOT_FOUND');
        await audit(tx, actor, {
          action: 'member.invite_revoked',
          entity: { type: 'invite', id: inv.id },
          changes: redactDiff({ status: 'pending', role: inv.role }, { status: 'revoked', role: inv.role }, { entity: 'invite' }),
        });
      });
      return { ok: true as const };
    },
  );

  r.patch(
    '/members/:userId',
    {
      config: { auth: 'member.role' },
      schema: {
        params: z.object({ userId: z.uuid() }),
        body: z
          .object({ role: RoleEnum.optional(), status: MemberStatusInput.optional(), version: z.number().int().min(1) })
          .strict()
          .refine((b) => b.role !== undefined || b.status !== undefined, { message: 'role or status is required' }),
        response: { 200: MemberResponse },
      },
      preHandler: authorize('member.role', (req) => memberFacts(req, (req.params as { userId: string }).userId, (req.body as { role?: Role }).role)),
    },
    async (req) => {
      const { userId } = req.params;
      const updated = await adminTx(req, async (tx, _now, actor) => {
        const m = await repo.getMember(tx, userId, { forUpdate: true });
        if (!m || m.status === 'removed') throw new AppError('NOT_FOUND');
        const newRole = req.body.role ?? m.role;
        const newStatus = req.body.status ?? m.status;
        // re-authorize every implied action on the locked row's facts
        const facts = { target: { role: m.role, newRole } };
        const actions: Action[] = [];
        if (newRole !== m.role) actions.push('member.role');
        if (newStatus !== m.status) actions.push(newStatus === 'removed' ? 'member.remove' : 'member.suspend');
        for (const a of actions.length > 0 ? actions : (['member.role'] as Action[])) recheck(req, a, facts);
        if (m.version !== req.body.version) throw new AppError('VERSION_CONFLICT', { member: memberView(m) });
        if (m.status === 'deactivating') throw new AppError('VERSION_CONFLICT', { member: memberView(m) });
        if (newRole === m.role && newStatus === m.status) return m;

        if (newStatus === 'removed' || (newRole === 'tc' && m.role !== 'tc')) {
          const held = await repo.heldLeads(tx, userId);
          if (held.owned > 0 || held.offered > 0) throw new AppError('MEMBER_HAS_LEADS', held);
          // R-OWN-22 E542, R-PERM-15 E543: a listing agent of an open listing is moved by the staged deactivation, or changed by hand first
          const openListings = await repo.openListings(tx, userId);
          if (openListings > 0) throw new AppError('MEMBER_HAS_LISTINGS', { openListings });
        }
        const acceptingLeads = newRole === 'tc' ? false : m.role === 'tc' ? true : m.accepting_leads;
        await repo.updateMember(tx, userId, { role: newRole, status: newStatus, acceptingLeads });

        let leadFlagsCleared = 0;
        if (newRole !== m.role && !['team_lead', 'owner', 'admin'].includes(newRole)) leadFlagsCleared = await repo.clearLeadFlags(tx, userId);
        const removedFrom = newStatus === 'removed' ? await repo.removeFromLists(tx, userId) : null;
        if (userId !== actor.userId && (newRole !== m.role || newStatus !== 'active')) await repo.revokeMemberSessions(tx, userId);

        const entity = { type: 'membership', id: userId };
        if (newRole !== m.role) {
          await audit(tx, actor, {
            action: 'member.role_changed',
            entity,
            changes: redactDiff(
              { role: m.role, accepting_leads: m.accepting_leads, lead_flags_cleared_count: 0 },
              { role: newRole, accepting_leads: acceptingLeads, lead_flags_cleared_count: leadFlagsCleared },
              { entity: 'membership' },
            ),
          });
        }
        if (newStatus !== m.status) {
          const action = newStatus === 'removed' ? 'member.removed' : newStatus === 'suspended' ? 'member.suspended' : 'member.reactivated';
          const before: Record<string, unknown> = { status: m.status };
          const after: Record<string, unknown> = { status: newStatus };
          if (removedFrom) {
            before.routing_rule_count = removedFrom.rules;
            after.routing_rule_count = 0;
            before.pond_count = removedFrom.ponds;
            after.pond_count = 0;
            before.team_count = removedFrom.teams;
            after.team_count = 0;
          }
          await audit(tx, actor, { action, entity, changes: redactDiff(before, after, { entity: 'membership' }) });
        }
        const fresh = await repo.getMember(tx, userId);
        if (!fresh) throw new AppError('NOT_FOUND');
        return fresh;
      });
      return { member: memberView(updated) };
    },
  );
}

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
