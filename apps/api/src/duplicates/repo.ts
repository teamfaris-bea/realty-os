// api/duplicates repository (PARITY_PLAN module 66). Every query runs as the session actor under RLS:
// contact_duplicate_candidates is visible only when the caller sees BOTH people's detail (0001 policy
// dup_candidates), so a pair with one hidden side never appears and never reveals that it exists.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface CandidateRow {
  id: string;
  contact_a_id: string;
  contact_b_id: string;
  match_reason: string;
  status: 'open' | 'merged' | 'dismissed';
  created_at: Date;
  created_at_text: string;
}

/** Open pairs whose two people are both live (not merged away, not deleted), newest first. */
export async function listOpen(tx: Tx, limit: number, before: { at: string; id: string } | null): Promise<CandidateRow[]> {
  const r = await sql<CandidateRow>`
    SELECT d.id, d.contact_a_id, d.contact_b_id, d.match_reason, d.status, d.created_at, d.created_at::text AS created_at_text
      FROM contact_duplicate_candidates d
      JOIN contacts a ON a.tenant_id = d.tenant_id AND a.id = d.contact_a_id
      JOIN contacts b ON b.tenant_id = d.tenant_id AND b.id = d.contact_b_id
     WHERE d.tenant_id = app.tenant_id() AND d.status = 'open'
       AND a.deleted_at IS NULL AND a.merged_into_contact_id IS NULL
       AND b.deleted_at IS NULL AND b.merged_into_contact_id IS NULL
       AND app.contact_detail_visible(d.tenant_id, d.contact_a_id) AND app.contact_detail_visible(d.tenant_id, d.contact_b_id)
       AND (${before === null} OR (d.created_at, d.id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${limit}`.execute(tx);
  return r.rows;
}

export async function getCandidate(tx: Tx, id: string): Promise<CandidateRow | null> {
  const r = await sql<CandidateRow>`
    SELECT d.id, d.contact_a_id, d.contact_b_id, d.match_reason, d.status, d.created_at, d.created_at::text AS created_at_text
      FROM contact_duplicate_candidates d
     WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}::uuid
       AND app.contact_detail_visible(d.tenant_id, d.contact_a_id) AND app.contact_detail_visible(d.tenant_id, d.contact_b_id)`.execute(tx);
  return r.rows[0] ?? null;
}

export interface SideRow {
  id: string;
  display_name: string;
  stage: string;
  ownership_state: string;
  owner_user_id: string | null;
  owner_display_name: string | null;
  owned_at: Date | null;
  created_at: Date;
  closed_reason: string | null;
  merged_into_contact_id: string | null;
  deleted_at: Date | null;
  do_not_contact: boolean;
  source_name: string | null;
  notes: number;
  tags: number;
  field_values: number;
  relationships: number;
}

/** One person of a pair, with the counts the merge would move (all under the caller's RLS). */
export async function sides(tx: Tx, ids: readonly string[]): Promise<Map<string, SideRow>> {
  const r = await sql<SideRow>`
    SELECT c.id, c.display_name, c.stage, c.ownership_state, c.owner_user_id, u.display_name AS owner_display_name, c.owned_at,
           c.created_at, c.closed_reason, c.merged_into_contact_id, c.deleted_at, (c.do_not_contact_at IS NOT NULL) AS do_not_contact,
           s.name AS source_name,
           (SELECT count(*)::int FROM notes n WHERE n.tenant_id = c.tenant_id AND n.contact_id = c.id) AS notes,
           (SELECT count(*)::int FROM contact_tags t WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id) AS tags,
           (SELECT count(*)::int FROM contact_field_values v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id) AS field_values,
           (SELECT count(*)::int FROM contact_relationships x WHERE x.tenant_id = c.tenant_id AND c.id IN (x.contact_id, x.related_contact_id)) AS relationships
      FROM contacts c
      LEFT JOIN users u ON u.id = c.owner_user_id
      LEFT JOIN lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${[...ids]}::uuid[]) AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  return new Map(r.rows.map((x) => [x.id, x]));
}

export interface SidePointRow {
  contact_id: string;
  kind: string;
  address: string;
  label: string;
  removed: boolean;
}

/** Live phones and emails of the people (RLS: detail visible). Removed points are not shown, but they still move. */
export async function points(tx: Tx, ids: readonly string[]): Promise<SidePointRow[]> {
  const r = await sql<SidePointRow>`
    SELECT contact_id, kind, address, label, removed_at IS NOT NULL AS removed FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[]) AND kind IN ('phone', 'email') AND removed_at IS NULL
     ORDER BY contact_id, kind, is_primary DESC, created_at, id`.execute(tx);
  return r.rows;
}

/** Marks an open pair dismissed ("not the same person"). Returns false when it was not open. */
export async function setDecision(tx: Tx, id: string, to: 'dismissed' | 'open'): Promise<boolean> {
  const from = to === 'dismissed' ? 'open' : 'dismissed';
  const r = await sql<{ id: string }>`
    UPDATE contact_duplicate_candidates
       SET status = ${to},
           decided_at = CASE WHEN ${to} = 'open' THEN NULL ELSE now() END,
           decided_by_user_id = CASE WHEN ${to} = 'open' THEN NULL ELSE app.user_id() END
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = ${from}
     RETURNING id`.execute(tx);
  return r.rows.length === 1;
}
