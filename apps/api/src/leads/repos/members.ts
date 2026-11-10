// Staged member deactivation (R-OWN-22) queries. Stage 1 runs as the Owner/Admin request actor
// (tenant-wide); the later stages run as the system worker actor of the same tenant.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface DeactivationMemberRow {
  user_id: string;
  role: string;
  status: string;
  version: number;
  display_name: string | null;
}

/**
 * The membership row, locked FOR UPDATE when `lock`: that waits for routing holding it FOR SHARE and
 * for every open transaction that wrote a contact referencing it (FK KEY SHARE), so a deactivation
 * stage and a routing / assignment of this member serialize (E13).
 */
export async function memberRow(tx: Tx, userId: string, lock: boolean): Promise<DeactivationMemberRow | null> {
  const r = lock
    ? await sql<DeactivationMemberRow>`
        SELECT m.user_id, m.role, m.status, m.version, u.display_name
          FROM memberships m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId}::uuid
           FOR UPDATE OF m`.execute(tx)
    : await sql<DeactivationMemberRow>`
        SELECT m.user_id, m.role, m.status, m.version, u.display_name
          FROM memberships m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function memberRole(tx: Tx, userId: string): Promise<{ role: string; status: string } | null> {
  const r = await sql<{ role: string; status: string }>`
    SELECT role, status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export interface HeldCounts {
  owned: number;
  offered: number;
  ownedWithOpenDeal: number;
}

/** What the member holds right now (as a tenant-wide caller: every contact). */
export async function heldCounts(tx: Tx, userId: string): Promise<HeldCounts> {
  const r = await sql<{ owned: number; offered: number; open_deal: number }>`
    SELECT count(*) FILTER (WHERE c.ownership_state = 'owned' AND c.owner_user_id = ${userId}::uuid)::int AS owned,
           count(*) FILTER (WHERE c.ownership_state = 'offered' AND c.offered_to_user_id = ${userId}::uuid)::int AS offered,
           count(*) FILTER (WHERE c.ownership_state = 'owned' AND c.owner_user_id = ${userId}::uuid AND (
              EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id AND d.stage NOT IN ('closed', 'lost'))
              OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                          WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = c.id AND d.stage NOT IN ('closed', 'lost'))))::int AS open_deal
      FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND (c.owner_user_id = ${userId}::uuid OR c.offered_to_user_id = ${userId}::uuid)`.execute(tx);
  const x = r.rows[0];
  return { owned: x?.owned ?? 0, offered: x?.offered ?? 0, ownedWithOpenDeal: x?.open_deal ?? 0 };
}

/** The member's Team Lead (active, in a team the member belongs to; lowest user id; never the member). */
export async function teamLeadOf(tx: Tx, userId: string): Promise<{ user_id: string; display_name: string | null } | null> {
  const r = await sql<{ user_id: string; display_name: string | null }>`
    SELECT DISTINCT l.user_id, u.display_name
      FROM team_members tm
      JOIN team_members l ON l.tenant_id = tm.tenant_id AND l.team_id = tm.team_id AND l.is_lead
      JOIN memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active' AND m.role = 'team_lead'
      LEFT JOIN users u ON u.id = l.user_id
     WHERE tm.tenant_id = app.tenant_id() AND tm.user_id = ${userId}::uuid AND l.user_id <> ${userId}::uuid
     ORDER BY l.user_id LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

/** Stage 1: deactivating + ineligible, sessions and push subscriptions revoked (one transaction). */
export async function startDeactivation(tx: Tx, userId: string, nowIso: string): Promise<{ sessions: number; pushSubscriptions: number }> {
  await sql`
    UPDATE memberships SET status = 'deactivating', accepting_leads = false, version = version + 1
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  const s = await sql<{ n: number }>`SELECT app.revoke_member_sessions(${userId}::uuid, ${nowIso}::timestamptz) AS n`.execute(tx);
  const p = await sql<{ id: string }>`
    UPDATE push_subscriptions SET revoked_at = ${nowIso}::timestamptz
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND revoked_at IS NULL RETURNING id`.execute(tx);
  return { sessions: s.rows[0]?.n ?? 0, pushSubscriptions: p.rows.length };
}

/** Contacts still owned by / offered to the member (system actor), ascending id. */
export async function heldContactIds(tx: Tx, userId: string, limit: number): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT id FROM contacts
     WHERE tenant_id = app.tenant_id()
       AND ((ownership_state = 'owned' AND owner_user_id = ${userId}::uuid)
            OR (ownership_state = 'offered' AND offered_to_user_id = ${userId}::uuid))
     ORDER BY id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Stage 4: removed (with removed_at). Returns false when the membership is not deactivating any more. */
export async function finishDeactivation(tx: Tx, userId: string, nowIso: string): Promise<boolean> {
  const r = await sql<{ user_id: string }>`
    UPDATE memberships SET status = 'removed', removed_at = ${nowIso}::timestamptz, accepting_leads = false, version = version + 1
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status = 'deactivating'
    RETURNING user_id`.execute(tx);
  return r.rows.length > 0;
}
