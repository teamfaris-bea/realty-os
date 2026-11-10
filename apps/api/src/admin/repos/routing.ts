// Routing rules, their members, and the facts their validation needs (RLS: Owner/Admin write).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export type Strategy = 'round_robin' | 'weighted' | 'direct' | 'pond';

export interface RuleRow {
  id: string;
  position: number;
  name: string;
  match: Record<string, unknown>;
  strategy: Strategy;
  direct_user_id: string | null;
  target_pond_id: string | null;
  fallback_pond_id: string | null;
  offer_window_seconds: number | null;
  max_offers: number | null;
  enabled: boolean;
  archived_at: Date | null;
  version: number;
}

export interface RuleMemberRow {
  rule_id: string;
  user_id: string;
  weight: number;
}

const COLS = sql`id, position, name, match, strategy, direct_user_id, target_pond_id, fallback_pond_id, offer_window_seconds,
  max_offers, enabled, archived_at, version`;

export async function listRules(tx: Tx, opts: { includeArchived?: boolean } = {}): Promise<RuleRow[]> {
  const filter = opts.includeArchived ? sql`` : sql`AND archived_at IS NULL`;
  return (await sql<RuleRow>`SELECT ${COLS} FROM routing_rules WHERE tenant_id = app.tenant_id() ${filter} ORDER BY position, id`.execute(tx)).rows;
}

export async function getRule(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<RuleRow | null> {
  const lock = opts.forUpdate ? sql`FOR UPDATE` : sql``;
  return (
    (await sql<RuleRow>`SELECT ${COLS} FROM routing_rules WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND archived_at IS NULL ${lock}`.execute(tx))
      .rows[0] ?? null
  );
}

export async function listRuleMembers(tx: Tx, ruleIds: readonly string[]): Promise<RuleMemberRow[]> {
  if (ruleIds.length === 0) return [];
  return (
    await sql<RuleMemberRow>`SELECT rule_id, user_id, weight FROM routing_rule_members
                              WHERE tenant_id = app.tenant_id() AND rule_id = ANY (${[...ruleIds]}::uuid[]) ORDER BY rule_id, user_id`.execute(tx)
  ).rows;
}

export async function nextPosition(tx: Tx): Promise<number> {
  const r = await sql<{ p: number }>`SELECT COALESCE(max(position), 0)::int + 1 AS p FROM routing_rules WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.p ?? 1;
}

export interface RuleWrite {
  name: string;
  match: Record<string, unknown>;
  strategy: Strategy;
  directUserId: string | null;
  targetPondId: string | null;
  fallbackPondId: string | null;
  offerWindowSeconds: number | null;
  maxOffers: number | null;
  enabled: boolean;
}

export async function insertRule(tx: Tx, id: string, position: number, w: RuleWrite): Promise<void> {
  await sql`INSERT INTO routing_rules (tenant_id, id, position, name, match, strategy, direct_user_id, target_pond_id, fallback_pond_id,
                                       offer_window_seconds, max_offers, enabled)
            VALUES (app.tenant_id(), ${id}::uuid, ${position}, ${w.name}, ${JSON.stringify(w.match)}::jsonb, ${w.strategy}, ${w.directUserId}::uuid,
                    ${w.targetPondId}::uuid, ${w.fallbackPondId}::uuid, ${w.offerWindowSeconds}, ${w.maxOffers}, ${w.enabled})`.execute(tx);
}

export async function updateRule(tx: Tx, id: string, w: RuleWrite): Promise<void> {
  await sql`UPDATE routing_rules
               SET name = ${w.name}, match = ${JSON.stringify(w.match)}::jsonb, strategy = ${w.strategy}, direct_user_id = ${w.directUserId}::uuid,
                   target_pond_id = ${w.targetPondId}::uuid, fallback_pond_id = ${w.fallbackPondId}::uuid,
                   offer_window_seconds = ${w.offerWindowSeconds}, max_offers = ${w.maxOffers}, enabled = ${w.enabled},
                   version = version + 1
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function archiveRule(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE routing_rules SET enabled = false, archived_at = now(), version = version + 1
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND archived_at IS NULL`.execute(tx);
  await sql`DELETE FROM routing_rule_members WHERE tenant_id = app.tenant_id() AND rule_id = ${id}::uuid`.execute(tx);
}

export async function replaceRuleMembers(tx: Tx, ruleId: string, members: readonly { userId: string; weight: number }[]): Promise<void> {
  await sql`DELETE FROM routing_rule_members WHERE tenant_id = app.tenant_id() AND rule_id = ${ruleId}::uuid`.execute(tx);
  for (const m of members) {
    await sql`INSERT INTO routing_rule_members (tenant_id, rule_id, user_id, weight)
              VALUES (app.tenant_id(), ${ruleId}::uuid, ${m.userId}::uuid, ${m.weight})`.execute(tx);
  }
}

export async function bumpRuleVersion(tx: Tx, ruleId: string): Promise<void> {
  await sql`UPDATE routing_rules SET version = version + 1 WHERE tenant_id = app.tenant_id() AND id = ${ruleId}::uuid`.execute(tx);
}

/** Positions for every rule in one transaction; the UNIQUE (tenant_id, position) is checked at commit (deferred). */
export async function setPositions(tx: Tx, orderedIds: readonly string[]): Promise<void> {
  for (const [i, id] of orderedIds.entries()) {
    await sql`UPDATE routing_rules SET position = ${i + 1} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND position <> ${i + 1}`.execute(tx);
  }
}

/** Locks every rule row in id order (no lock cycles between concurrent reorders and edits). */
export async function lockAllRules(tx: Tx): Promise<void> {
  await sql`SELECT id FROM routing_rules WHERE tenant_id = app.tenant_id() ORDER BY id FOR UPDATE`.execute(tx);
}

export interface MemberFacts {
  user_id: string;
  role: string;
  status: string;
}

export async function memberFacts(tx: Tx, userIds: readonly string[]): Promise<MemberFacts[]> {
  if (userIds.length === 0) return [];
  return (
    await sql<MemberFacts>`SELECT user_id, role, status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ANY (${[...userIds]}::uuid[])`.execute(tx)
  ).rows;
}

export async function pondState(tx: Tx, pondId: string): Promise<{ id: string; archived: boolean } | null> {
  return (
    (await sql<{ id: string; archived: boolean }>`SELECT id, archived_at IS NOT NULL AS archived FROM ponds WHERE tenant_id = app.tenant_id() AND id = ${pondId}::uuid`.execute(tx))
      .rows[0] ?? null
  );
}
