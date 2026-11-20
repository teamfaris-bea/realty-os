// Reads and the one write of a lead source's coverage (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11).
// Every statement runs in the caller's transaction: Owner and Admin are tenant-wide under row-level security, and the
// overview reads as the system actor of the caller's tenant (leads/sources.ts asSystem). The write is refused by the
// database for anyone else (app.lead_sources_coverage_guard, migration 0107).
import type { MembershipStatus } from '@realty/core/ownership';
import type { Role } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface CoverageRow {
  id: string;
  name: string;
  active: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  owner_status: MembershipStatus | null;
  backup_user_id: string | null;
  backup_name: string | null;
  backup_status: MembershipStatus | null;
  high_intent: boolean;
  covered: boolean;
  coverage_changed_at: Date | null;
}

/** Every lead source of the tenant with its coverage columns and the named members' names and statuses. */
export async function coverageRows(tx: Tx): Promise<CoverageRow[]> {
  const r = await sql<CoverageRow>`
    SELECT s.id, s.name, s.active, s.owner_user_id, ou.display_name AS owner_name, om.status AS owner_status,
           s.backup_user_id, bu.display_name AS backup_name, bm.status AS backup_status,
           s.high_intent, s.covered, s.coverage_changed_at
      FROM lead_sources s
      LEFT JOIN memberships om ON om.tenant_id = s.tenant_id AND om.user_id = s.owner_user_id
      LEFT JOIN users ou ON ou.id = s.owner_user_id
      LEFT JOIN memberships bm ON bm.tenant_id = s.tenant_id AND bm.user_id = s.backup_user_id
      LEFT JOIN users bu ON bu.id = s.backup_user_id
     WHERE s.tenant_id = app.tenant_id()
     ORDER BY s.name, s.id`.execute(tx);
  return r.rows;
}

export async function pondNames(tx: Tx): Promise<Map<string, string>> {
  const r = await sql<{ id: string; name: string }>`SELECT id, name FROM ponds WHERE tenant_id = app.tenant_id()`.execute(tx);
  return new Map(r.rows.map((p) => [p.id, p.name]));
}

/**
 * R-TEAMQ-21: who receives the leads of each enabled routing rule: its rotation members, or its one direct member.
 * By rule id (routing_rule_members' primary key; the tenant's rules are few).
 */
export async function ruleRotations(tx: Tx): Promise<Map<string, string[]>> {
  const r = await sql<{ rule_id: string; user_id: string }>`
    SELECT m.rule_id, m.user_id FROM routing_rule_members m
      JOIN routing_rules r ON r.tenant_id = m.tenant_id AND r.id = m.rule_id
     WHERE m.tenant_id = app.tenant_id() AND r.enabled AND r.strategy IN ('round_robin', 'weighted')
    UNION
    SELECT r.id, r.direct_user_id FROM routing_rules r
     WHERE r.tenant_id = app.tenant_id() AND r.enabled AND r.strategy = 'direct' AND r.direct_user_id IS NOT NULL`.execute(tx);
  const out = new Map<string, string[]>();
  for (const x of r.rows) out.set(x.rule_id, [...(out.get(x.rule_id) ?? []), x.user_id]);
  return out;
}

export interface StoredCoverage {
  owner_user_id: string | null;
  backup_user_id: string | null;
  high_intent: boolean;
  covered: boolean;
}

/**
 * The source's stored coverage, locked FOR NO KEY UPDATE (never FOR UPDATE: every lead insert's foreign-key check
 * on lead_sources would wait on it; the rule of leads/sources.ts). null: no such source for this tenant.
 */
export async function lockStoredCoverage(tx: Tx, sourceId: string): Promise<StoredCoverage | null> {
  const r = await sql<StoredCoverage>`
    SELECT owner_user_id, backup_user_id, high_intent, covered FROM lead_sources
     WHERE tenant_id = app.tenant_id() AND id = ${sourceId}::uuid FOR NO KEY UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

export async function memberOf(tx: Tx, userId: string): Promise<{ role: Role; status: MembershipStatus } | null> {
  const r = await sql<{ role: Role; status: MembershipStatus }>`
    SELECT role, status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function writeCoverage(tx: Tx, sourceId: string, c: StoredCoverage): Promise<void> {
  await sql`
    UPDATE lead_sources SET owner_user_id = ${c.owner_user_id}::uuid, backup_user_id = ${c.backup_user_id}::uuid, high_intent = ${c.high_intent},
           covered = ${c.covered}, coverage_changed_at = now(), updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${sourceId}::uuid`.execute(tx);
}
