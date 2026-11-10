// Ponds and pond members (RLS: members read, Owner/Admin write). Ponds are archived, never deleted.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface PondRow {
  id: string;
  name: string;
  is_default: boolean;
  open_to_all: boolean;
  eligible_roles: ('agent' | 'team_lead' | 'isa')[];
  claims_per_day: number;
  claim_cooldown_hours: number;
  reinquiry: 'reroute' | 'stay';
  archived_at: Date | null;
}

const COLS = sql`id, name, is_default, open_to_all, eligible_roles, claims_per_day, claim_cooldown_hours, reinquiry, archived_at`;

export async function listPonds(tx: Tx): Promise<PondRow[]> {
  return (await sql<PondRow>`SELECT ${COLS} FROM ponds WHERE tenant_id = app.tenant_id() AND archived_at IS NULL ORDER BY is_default DESC, name, id`.execute(tx)).rows;
}

export async function getPond(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<PondRow | null> {
  const lock = opts.forUpdate ? sql`FOR NO KEY UPDATE` : sql``;
  return (await sql<PondRow>`SELECT ${COLS} FROM ponds WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND archived_at IS NULL ${lock}`.execute(tx)).rows[0] ?? null;
}

export async function pondMembers(tx: Tx, pondIds: readonly string[]): Promise<{ pond_id: string; user_id: string }[]> {
  if (pondIds.length === 0) return [];
  return (
    await sql<{ pond_id: string; user_id: string }>`SELECT pond_id, user_id FROM pond_members
                                                    WHERE tenant_id = app.tenant_id() AND pond_id = ANY (${[...pondIds]}::uuid[]) ORDER BY pond_id, user_id`.execute(tx)
  ).rows;
}

/** Leads waiting in each pond (Owner/Admin see every contact, so these are true totals). */
export async function waitingCounts(tx: Tx, pondIds: readonly string[]): Promise<Map<string, number>> {
  if (pondIds.length === 0) return new Map();
  const r = await sql<{ pond_id: string; n: number }>`
    SELECT pond_id, count(*)::int AS n FROM contacts
     WHERE tenant_id = app.tenant_id() AND ownership_state = 'in_pond' AND pond_id = ANY (${[...pondIds]}::uuid[])
     GROUP BY pond_id`.execute(tx);
  return new Map(r.rows.map((x) => [x.pond_id, x.n]));
}

export interface PondWrite {
  name: string;
  openToAll: boolean;
  eligibleRoles: readonly string[];
  claimsPerDay: number;
  claimCooldownHours: number;
  reinquiry: 'reroute' | 'stay';
}

export async function insertPond(tx: Tx, id: string, w: PondWrite): Promise<void> {
  await sql`INSERT INTO ponds (tenant_id, id, name, open_to_all, eligible_roles, claims_per_day, claim_cooldown_hours, reinquiry)
            VALUES (app.tenant_id(), ${id}::uuid, ${w.name}, ${w.openToAll}, ${[...w.eligibleRoles]}::text[], ${w.claimsPerDay},
                    ${w.claimCooldownHours}, ${w.reinquiry})`.execute(tx);
}

export async function updatePond(tx: Tx, id: string, w: PondWrite): Promise<void> {
  await sql`UPDATE ponds SET name = ${w.name}, open_to_all = ${w.openToAll}, eligible_roles = ${[...w.eligibleRoles]}::text[],
                             claims_per_day = ${w.claimsPerDay}, claim_cooldown_hours = ${w.claimCooldownHours}, reinquiry = ${w.reinquiry}
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** The default pond moves: the old default is cleared first (one default per tenant, unique index). */
export async function makeDefault(tx: Tx, id: string): Promise<string | null> {
  const old = await sql<{ id: string }>`UPDATE ponds SET is_default = false WHERE tenant_id = app.tenant_id() AND is_default AND id <> ${id}::uuid RETURNING id`.execute(tx);
  await sql`UPDATE ponds SET is_default = true WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return old.rows[0]?.id ?? null;
}

export async function archivePond(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE ponds SET archived_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND archived_at IS NULL`.execute(tx);
}

/** Live routing rules that send leads to the pond (target or fallback). */
export async function rulesUsingPond(tx: Tx, id: string): Promise<string[]> {
  return (
    await sql<{ id: string }>`SELECT id FROM routing_rules WHERE tenant_id = app.tenant_id() AND archived_at IS NULL
                               AND (target_pond_id = ${id}::uuid OR fallback_pond_id = ${id}::uuid) ORDER BY position`.execute(tx)
  ).rows.map((x) => x.id);
}

export async function replacePondMembers(tx: Tx, pondId: string, userIds: readonly string[]): Promise<void> {
  await sql`DELETE FROM pond_members WHERE tenant_id = app.tenant_id() AND pond_id = ${pondId}::uuid`.execute(tx);
  for (const u of userIds) await sql`INSERT INTO pond_members (tenant_id, pond_id, user_id) VALUES (app.tenant_id(), ${pondId}::uuid, ${u}::uuid)`.execute(tx);
}
