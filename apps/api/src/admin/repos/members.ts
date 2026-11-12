// Members and invites: the SQL (RLS-bound, as the session actor). memberships: read by members,
// update by Owner/Admin with memberships_guard (R-PERM-2); invites: Owner/Admin only (admin_all).
import type { Role } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { OPEN_LISTING_STATUSES } from '../../workspace/listingAgent.js';

export interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  role: Role;
  status: 'invited' | 'active' | 'suspended' | 'deactivating' | 'removed';
  accepting_leads: boolean;
  mfa_enabled: boolean;
  joined_at: Date | null;
  version: number;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  invited_by_user_id: string;
  created_at: Date;
  expires_at: Date;
}

const MEMBER_COLS = sql`m.user_id, u.display_name, u.email::text AS email, m.role, m.status, m.accepting_leads,
  (u.mfa_enabled_at IS NOT NULL) AS mfa_enabled, m.joined_at, m.version`;

export async function listMembers(tx: Tx): Promise<MemberRow[]> {
  return (
    await sql<MemberRow>`SELECT ${MEMBER_COLS} FROM memberships m JOIN users u ON u.id = m.user_id
                          WHERE m.tenant_id = app.tenant_id() AND m.status <> 'removed'
                          ORDER BY u.display_name, m.user_id`.execute(tx)
  ).rows;
}

export async function getMember(tx: Tx, userId: string, opts: { forUpdate?: boolean } = {}): Promise<MemberRow | null> {
  const lock = opts.forUpdate ? sql`FOR NO KEY UPDATE OF m` : sql``;
  return (
    (
      await sql<MemberRow>`SELECT ${MEMBER_COLS} FROM memberships m JOIN users u ON u.id = m.user_id
                            WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId}::uuid ${lock}`.execute(tx)
    ).rows[0] ?? null
  );
}

/** A current (not removed) member of this tenant with this email, if any. */
export async function memberByEmail(tx: Tx, email: string): Promise<{ user_id: string; status: string } | null> {
  return (
    (
      await sql<{ user_id: string; status: string }>`
        SELECT m.user_id, m.status FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = app.tenant_id() AND u.email = ${email}::citext AND m.status <> 'removed'`.execute(tx)
    ).rows[0] ?? null
  );
}

export async function listPendingInvites(tx: Tx): Promise<InviteRow[]> {
  return (
    await sql<InviteRow>`SELECT id, email::text AS email, role, invited_by_user_id, created_at, expires_at FROM invites
                          WHERE tenant_id = app.tenant_id() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
                          ORDER BY created_at DESC, id`.execute(tx)
  ).rows;
}

export async function getPendingInvite(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<InviteRow | null> {
  const lock = opts.forUpdate ? sql`FOR UPDATE` : sql``;
  return (
    (
      await sql<InviteRow>`SELECT id, email::text AS email, role, invited_by_user_id, created_at, expires_at FROM invites
                            WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL
                              AND expires_at > now() ${lock}`.execute(tx)
    ).rows[0] ?? null
  );
}

/** Expired, never-accepted invites still hold the one-pending-per-email slot: close them first. */
export async function expireStaleInvites(tx: Tx, email: string): Promise<void> {
  await sql`UPDATE invites SET revoked_at = now()
             WHERE tenant_id = app.tenant_id() AND email = ${email}::citext AND accepted_at IS NULL AND revoked_at IS NULL
               AND expires_at <= now()`.execute(tx);
}

export async function insertInvite(tx: Tx, i: { id: string; email: string; role: Role; tokenHash: Uint8Array; days: number }): Promise<InviteRow> {
  const r = await sql<InviteRow>`
    INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
    VALUES (app.tenant_id(), ${i.id}::uuid, ${i.email}::citext, ${i.role}, ${Buffer.from(i.tokenHash)}, app.user_id(),
            now() + make_interval(days => ${i.days}::int))
    RETURNING id, email::text AS email, role, invited_by_user_id, created_at, expires_at`.execute(tx);
  return r.rows[0]!;
}

export async function revokeInvite(tx: Tx, id: string): Promise<boolean> {
  const r = await sql`UPDATE invites SET revoked_at = now()
                       WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL`.execute(tx);
  return Number(r.numAffectedRows ?? 0) === 1;
}

/** Leads the member holds right now: owned, or an open offer to them. */
export async function heldLeads(tx: Tx, userId: string): Promise<{ owned: number; offered: number }> {
  const r = await sql<{ owned: number; offered: number }>`
    SELECT count(*) FILTER (WHERE ownership_state = 'owned' AND owner_user_id = ${userId}::uuid)::int AS owned,
           count(*) FILTER (WHERE ownership_state = 'offered' AND offered_to_user_id = ${userId}::uuid)::int AS offered
      FROM contacts
     WHERE tenant_id = app.tenant_id()
       AND (owner_user_id = ${userId}::uuid OR offered_to_user_id = ${userId}::uuid)`.execute(tx);
  return r.rows[0] ?? { owned: 0, offered: 0 };
}

/** Open team listings (OPEN_LISTING_STATUSES, the deactivation's own definition) with the member as listing agent (R-OWN-22, R-PERM-15). */
export async function openListings(tx: Tx, userId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM listings
     WHERE tenant_id = app.tenant_id() AND source = 'team' AND listing_agent_user_id = ${userId}::uuid AND status IN ${OPEN_LISTING_STATUSES}`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export interface MemberUpdate {
  role: Role;
  status: MemberRow['status'];
  acceptingLeads: boolean;
}

export async function updateMember(tx: Tx, userId: string, u: MemberUpdate): Promise<void> {
  await sql`UPDATE memberships
               SET role = ${u.role}, status = ${u.status}, accepting_leads = ${u.acceptingLeads},
                   removed_at = CASE WHEN ${u.status} = 'removed' THEN COALESCE(removed_at, now()) ELSE NULL END,
                   version = version + 1
             WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
}

/** A non-lead role leads no team (app.my_team_member_ids needs role team_lead): clear stale flags. */
export async function clearLeadFlags(tx: Tx, userId: string): Promise<number> {
  const r = await sql`UPDATE team_members SET is_lead = false
                       WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND is_lead`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** A removed member leaves every routing rule, pond and team list. */
export async function removeFromLists(tx: Tx, userId: string): Promise<{ rules: number; ponds: number; teams: number }> {
  const rules = await sql`DELETE FROM routing_rule_members WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  const ponds = await sql`DELETE FROM pond_members WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  const teams = await sql`DELETE FROM team_members WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  return { rules: Number(rules.numAffectedRows ?? 0), ponds: Number(ponds.numAffectedRows ?? 0), teams: Number(teams.numAffectedRows ?? 0) };
}

/** Session rotation on privilege change: the member's sessions in this tenant end (definer, tenant-wide only). */
export async function revokeMemberSessions(tx: Tx, userId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app.revoke_member_sessions(${userId}::uuid, clock_timestamp()) AS n`.execute(tx);
  return r.rows[0]?.n ?? 0;
}
