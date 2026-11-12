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
  /** team listings with the member as listing agent, not yet sold/withdrawn/expired (the job moves them) */
  openListings: number;
  /** deals the member owns that are not closed or lost (counted, never moved: no deal-owner change exists) */
  openDeals: number;
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
  const o = await sql<{ listings: number; deals: number }>`
    SELECT (SELECT count(*)::int FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'team' AND l.listing_agent_user_id = ${userId}::uuid
               AND l.status IN ${OPEN_LISTING_STATUSES}) AS listings,
           (SELECT count(*)::int FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.owner_user_id = ${userId}::uuid AND d.stage NOT IN ('closed', 'lost')) AS deals`.execute(tx);
  return {
    owned: x?.owned ?? 0,
    offered: x?.offered ?? 0,
    ownedWithOpenDeal: x?.open_deal ?? 0,
    openListings: o.rows[0]?.listings ?? 0,
    openDeals: o.rows[0]?.deals ?? 0,
  };
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

/** A listing in these statuses is still on the market or under contract: the deactivation moves it (R-OWN-22). */
const OPEN_LISTING_STATUSES = sql`('coming_soon', 'active', 'pending')`;

/** The member's open team listings (they are the listing agent), ascending id. MLS rows are never ours to move. */
export async function openListingIds(tx: Tx, userId: string, limit: number): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT id FROM listings
     WHERE tenant_id = app.tenant_id() AND source = 'team' AND listing_agent_user_id = ${userId}::uuid AND status IN ${OPEN_LISTING_STATUSES}
     ORDER BY id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/**
 * Where the member's listing goes: the active Team Lead, else `fallbackUserId` (the Owner/Admin who ran the
 * deactivation) while that member is still active and may own leads, else the first active Owner/Admin (Owner first).
 * null when there is nobody at all.
 */
export async function listingDestination(tx: Tx, userId: string, fallbackUserId: string): Promise<string | null> {
  const tl = await teamLeadOf(tx, userId);
  if (tl) return tl.user_id;
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships
     WHERE tenant_id = app.tenant_id() AND status = 'active' AND user_id <> ${userId}::uuid
       AND (user_id = ${fallbackUserId}::uuid OR role IN ('owner', 'admin'))
       AND role <> 'tc' -- canOwnLeads (R-PERM-15)
     ORDER BY user_id = ${fallbackUserId}::uuid DESC, role = 'owner' DESC, user_id LIMIT 1`.execute(tx);
  return r.rows[0]?.user_id ?? null;
}

/** Stage 4: removed (with removed_at). Returns false when the membership is not deactivating any more. */
export async function finishDeactivation(tx: Tx, userId: string, nowIso: string): Promise<boolean> {
  const r = await sql<{ user_id: string }>`
    UPDATE memberships SET status = 'removed', removed_at = ${nowIso}::timestamptz, accepting_leads = false, version = version + 1
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status = 'deactivating'
    RETURNING user_id`.execute(tx);
  return r.rows.length > 0;
}
