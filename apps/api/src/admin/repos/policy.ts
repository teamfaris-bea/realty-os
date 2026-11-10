// compliance_policy_versions [append-only] and the jurisdiction packs in force (RLS: members read;
// insert Owner/Admin, an attested (loosened) version only by the Owner: compliance_policy_guard).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface PolicyRow {
  id: string;
  version_no: number;
  contact_window_start: string;
  contact_window_end: string;
  human_reply_window_minutes: number;
  email_quiet_hours: boolean;
  auto_sms_per_24h: number;
  auto_sms_per_7d: number;
  auto_email_per_24h: number;
  auto_email_per_7d: number;
  auto_cross_channel_per_24h: number;
  manual_sms_confirm_after_24h: number;
  call_attempts_per_24h: number;
  max_deferrals: number;
  autonomous_categories: string[];
  opt_out_confirmation_sender: 'provider' | 'platform';
  recording_enabled: boolean;
  recording_mode: 'announce_all' | 'one_party_where_permitted';
  loosening_attestation: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

const COLS = sql`id, version_no, contact_window_start::text AS contact_window_start, contact_window_end::text AS contact_window_end,
  human_reply_window_minutes, email_quiet_hours, auto_sms_per_24h, auto_sms_per_7d, auto_email_per_24h, auto_email_per_7d,
  auto_cross_channel_per_24h, manual_sms_confirm_after_24h, call_attempts_per_24h, max_deferrals, autonomous_categories,
  opt_out_confirmation_sender, recording_enabled, recording_mode, loosening_attestation, created_by_user_id, created_at`;

export async function listVersions(tx: Tx): Promise<PolicyRow[]> {
  return (await sql<PolicyRow>`SELECT ${COLS} FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() ORDER BY version_no DESC`.execute(tx)).rows;
}

export async function getVersion(tx: Tx, id: string): Promise<PolicyRow | null> {
  return (await sql<PolicyRow>`SELECT ${COLS} FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx)).rows[0] ?? null;
}

/** The active version, read with the settings row locked (serializes proposals and activations). */
export async function activeVersionLocked(tx: Tx): Promise<{ settingsVersion: number; policy: PolicyRow } | null> {
  const s = await sql<{ active_policy_id: string; version: number }>`
    SELECT active_policy_id, version FROM tenant_settings WHERE tenant_id = app.tenant_id() FOR NO KEY UPDATE`.execute(tx);
  const row = s.rows[0];
  if (!row) return null;
  const policy = await getVersion(tx, row.active_policy_id);
  return policy ? { settingsVersion: row.version, policy } : null;
}

export async function nextVersionNo(tx: Tx): Promise<number> {
  const r = await sql<{ n: number }>`SELECT COALESCE(max(version_no), 0)::int + 1 AS n FROM compliance_policy_versions WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.n ?? 1;
}

export type PolicyColumns = Omit<PolicyRow, 'id' | 'version_no' | 'created_by_user_id' | 'created_at'>;

export async function insertVersion(tx: Tx, id: string, versionNo: number, v: PolicyColumns): Promise<void> {
  await sql`INSERT INTO compliance_policy_versions (tenant_id, id, version_no, contact_window_start, contact_window_end,
              human_reply_window_minutes, email_quiet_hours, auto_sms_per_24h, auto_sms_per_7d, auto_email_per_24h, auto_email_per_7d,
              auto_cross_channel_per_24h, manual_sms_confirm_after_24h, call_attempts_per_24h, max_deferrals, autonomous_categories,
              opt_out_confirmation_sender, recording_enabled, recording_mode, loosening_attestation, created_by_user_id)
            VALUES (app.tenant_id(), ${id}::uuid, ${versionNo}, ${v.contact_window_start}::time, ${v.contact_window_end}::time,
              ${v.human_reply_window_minutes}, ${v.email_quiet_hours}, ${v.auto_sms_per_24h}, ${v.auto_sms_per_7d}, ${v.auto_email_per_24h},
              ${v.auto_email_per_7d}, ${v.auto_cross_channel_per_24h}, ${v.manual_sms_confirm_after_24h}, ${v.call_attempts_per_24h},
              ${v.max_deferrals}, ${v.autonomous_categories}::text[], ${v.opt_out_confirmation_sender}, ${v.recording_enabled},
              ${v.recording_mode}, ${v.loosening_attestation}, app.user_id())`.execute(tx);
}

export interface PackRow {
  key: string;
  version: string;
  reviewed_by_counsel_at: Date | null;
}

/** Published jurisdiction packs for the tenant's operating jurisdictions (plus the US base pack). */
export async function packsInForce(tx: Tx): Promise<PackRow[]> {
  return (
    await sql<PackRow>`
      SELECT p.key, p.version, p.reviewed_by_counsel_at FROM jurisdiction_packs p
       WHERE p.status = 'published'
         AND (p.key = 'US' OR p.key = ANY ((SELECT operating_jurisdictions FROM tenant_settings WHERE tenant_id = app.tenant_id())::text[]))
       ORDER BY p.key`.execute(tx)
  ).rows;
}
