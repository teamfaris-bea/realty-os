// Generated per-table fixture rows for the isolation test (BUILD_PLAN module 7: "seed tenant B rows
// through the definer and system paths ... new tables are covered automatically").
//
// The test first seeds tenant B through real application paths (provisioning definer, invites,
// system-actor ownership commands, consent, jobs). Tables those paths do not reach yet (their
// writers belong to later modules) get ONE generated row: the superuser inserts it with triggers off
// (session_replication_role = replica, so FKs and guards are skipped; NOT NULL and CHECKs still
// hold). Values come from the column type, the first value of an `IN (...)` CHECK, and a short
// override list for CHECKs no generic value satisfies. A table the generator cannot fill fails the
// test loudly, so a new table can never silently escape the isolation check.
import type pg from 'pg';

interface Col {
  column_name: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  is_generated: string;
  identity_generation: string | null;
}

/** Column overrides (SQL expressions) for CHECKs a generic value cannot satisfy. `$T` = tenant id. */
const OVERRIDES: Record<string, Record<string, string>> = {
  '*': {
    tenant_id: '$T',
    address_hmac: "digest(gen_random_uuid()::text, 'sha256')",
    phone_hmac: "digest(gen_random_uuid()::text, 'sha256')",
    token_hash: "digest(gen_random_uuid()::text, 'sha256')",
    endpoint_hash: "digest(gen_random_uuid()::text, 'sha256')",
    reply_token_hash: 'NULL',
    content_sha256: "repeat('ab', 32)",
    sha256: "repeat('ab', 32)",
    body_sha256: "encode(digest('fixture body', 'sha256'), 'hex')",
    body: "'fixture body'",
    email: "'fixture-' || gen_random_uuid() || '@example.test'",
    reason_code: "'FIXTURE'",
    code: "'FIXTURE'",
    command_kind: "'claim'",
    action: "'fixture.created'",
    kind: "NULL",
  },
  contacts: { ownership_state: "'unassigned'", ownership_seq: '1', display_name: "'Fixture'" },
  contact_points: { kind: "'email'", address: "'fixture-' || gen_random_uuid() || '@example.test'" },
  contact_attributes: { key: "'fixture_key'" },
  phone_numbers: { e164: "'+1555' || lpad((floor(random() * 9999999))::text, 7, '0')", released_at: 'NULL', quarantine_until: 'NULL', assigned_user_id: 'NULL', purpose: "'team_main'" },
  stored_objects: { storage_key: "'tenants/' || $T || '/fixture/' || gen_random_uuid()", dek_wrapped: "'\\x01'::bytea", sha256: "digest('x', 'sha256')" },
  consent_events: { consent_level: "'express'", source: "'web_form'", event_type: "'grant'", channel: "'sms'", address_kind: "'phone'", purpose: "'informational'", actor_kind: "'system'", imported: 'false' },
  consent_disclosures: { channel_scope: "'{sms}'", purpose_scope: "'{informational}'" },
  notes: { contact_id: 'gen_random_uuid()', source: "'manual'", imported: 'false', author_user_id: 'gen_random_uuid()' },
  webhook_events: { signature_valid: 'true', status: "'received'" },
  consent_state: { status: "'none'", consent_level: "'none'", ledger_event_count: '1' },
  suppressions: { channel: "'sms'", address_kind: "'phone'", reason: "'admin_block'" },
  dnc_checks: { valid_until: "now() + interval '31 days'", registry: "'us_national'" },
  gate_decisions: { outcome: "'deny'", reason_codes: "'{CONSENT_REVOKED}'", phase: "'send'", initiator: "'human'", inputs_sha256: "repeat('ab', 32)", recipient_kind: "'contact'", recipient_user_id: 'NULL' },
  messages: { direction: "'inbound'", initiator: "'client'", status: "'received'", channel: "'sms'" },
  calls: { direction: "'inbound'", initiator: "'client'", status: "'completed'", handled_by: "'human'" },
  assistant_actions: { kind: "'next_step'", action_category: "'internal'", autonomy: "'internal'", status: "'proposed'", explanation: "'fixture'" },
  assistant_claims: { needs_review: 'true', text: "'fixture'" },
  evidence_refs: { verbatim_verified: 'false', source_available: 'false', locator: '\'{"kind":"field"}\'' },
  playbooks: { kind: "'nurture'", scope: "'team'" },
  playbook_versions: { status: "'draft'", steps: "'[]'" },
  playbook_enrollments: { state: "'active'", enrolled_by: "'new_lead'" },
  playbook_step_runs: { status: "'scheduled'", enrollment_id: 'gen_random_uuid()' }, // 0018: enrollment XOR trigger_key
  priority_feed_items: { reasons: "'[\"FIXTURE\"]'", state: "'open'" },
  exception_items: { evidence: "'[{\"k\":\"fixture\"}]'" },
  exception_events: { action: "'reopened'" },
  listings: { source: "'team'", listing_agent_user_id: 'gen_random_uuid()' }, // 0018: an mls row needs its feed connection
  deals: { stage: "'prospect'", primary_contact_id: 'gen_random_uuid()' }, // 0016: primary_contact_id became nullable, so the generator would skip it
  deal_dates: { kind: "'inspection'" },
  tasks: { status: "'open'", created_by_kind: "'system'", due_at: 'NULL' },
  appointments: { status: "'scheduled'", starts_at: 'now()', ends_at: "now() + interval '1 hour'", outcome: 'NULL' },
  notification_deliveries: { status: "'failed'", channel: "'in_app'" },
  notification_preferences: { kind: "'task_due'", channels: "'{in_app}'" },
  import_batches: { status: "'connection_test'" },
  import_stages: { status: "'pending'", seq: '1', category: "'contacts'" },
  import_records: { outcome: "'will_import'", raw_enc: "'\\x01'::bytea" },
  import_user_mappings: { target_kind: "'unassigned'" },
  provider_credentials: { status: "'active'", secret_enc: "'\\x01'::bytea" },
  tenant_keys: { purpose: "'field'", key_version: '2', wrapped_key: "'\\x01'::bytea" },
  invites: { expires_at: "now() + interval '1 day'" },
  routing_rules: { strategy: "'round_robin'", position: '1000' },
  support_access_grants: { expires_at: "now() + interval '1 hour'" },
  compliance_policy_versions: { version_no: '1000' },
  recordings: { status: "'pending_copy'", source: "'provider'", consent_basis: "'announced_all_parties'" },
  transcripts: { status: "'pending'" },
  recording_stream_tokens: { created_at: 'now()', expires_at: "now() + interval '30 seconds'", purpose: "'play'" },
  saved_searches: { status: "'proposed'" },
  showings: { starts_at: 'now()', ends_at: "now() + interval '1 hour'" },
  showing_feedback: { rating: '3' },
  home_valuations: { value_cents: '1' }, // 0018: an 'ok' estimate carries its value
  sessions: {},
  agent_goals: {},
  ownership_command_rejections: { observed_seq: '1', actor_kind: "'system'" },
  lead_ownership_events: { to_state: "'unassigned'", from_state: 'NULL', seq: '1', actor_kind: "'system'" },
  behavior_events: { reliability: "'fact'", event_type: "'listing_saved'" },
  contact_duplicate_candidates: { contact_a_id: "'00000000-0000-7000-8000-000000000001'", contact_b_id: "'00000000-0000-7000-8000-000000000002'" },
  sending_domains: { domain: "'fixture-' || gen_random_uuid() || '.test'" },
  email_identities: { from_address: "'fixture-' || gen_random_uuid() || '@example.test'" },
  audit_log: { actor_kind: "'system'" },
  jobs: { kind: "'fixture.job'" },
  sender_registrations: {},
  lead_inquiries: { fingerprint: "'fp'", outcome: "'new_contact'" },
  // 0018 (Phase 2-3 schema)
  webchat_sessions: { purge_after: 'now()' },
  lead_source_costs: { month: "date_trunc('month', now())::date", origin: "'ads_sync'" },
  call_scores: { rubric_version: "'rubric/1'" },
  contact_predictions: { band: "'none'", inputs_sha256: "repeat('ab', 32)" },
  ad_budget_caps: { attestation: "'fixture attestation text'" },
  ad_allocation_events: { event_kind: "'failed'" },
  documents: { contact_id: 'gen_random_uuid()' },
  portal_grants: { deal_id: 'gen_random_uuid()' },
  portal_items: { published_by_kind: "'system'", kind: "'milestone'" },
  portal_accounts: { status: "'invited'" },
  portal_login_tokens: { created_at: 'now()', expires_at: "now() + interval '15 minutes'" },
  portal_sessions: { created_at: 'now()', last_seen_at: 'now()', idle_expires_at: "now() + interval '1 hour'", absolute_expires_at: "now() + interval '1 day'", revoked_reason: 'NULL' },
  portal_stream_tokens: { created_at: 'now()', expires_at: "now() + interval '30 seconds'" },
  user_calendar_links: { status: "'pending_review'" },
  // FUB parity schema
  bulk_actions: { kind: "'tag'", source: "'selection'", idempotency_key: "'fixture-' || gen_random_uuid()" },
  contact_tags: { added_by_kind: "'migrated'" },
  tags: { created_by_kind: "'import'" },
  contact_field_values: { value_text: "'fixture'", updated_by_kind: "'import'", import_batch_id: 'gen_random_uuid()' },
  contact_stage_events: { actor_kind: "'system'" },
  contact_relationships: { kind: "'spouse_partner'" },
  message_templates: { scope: "'team'", channel: "'sms'" },
  // incremental feed (lane perf-misses)
  feed_dirty: { group_key: "'c:' || gen_random_uuid()" },
  feed_groups: { group_key: "'c:' || gen_random_uuid()" },
  smart_lists: { scope: "'team'" },
  // parity module 67: a recorded skip (the generic row; a start needs an enrollment)
  stage_automation_decisions: { outcome: "'skipped'", reason: "'not_visible'", playbook_id: 'NULL', enrollment_id: 'NULL' },
  // D2 migration (Gmail inbox sync): a revoked link holds no token, so the generic row is a revoked one
  user_mail_links: {
    status: "'revoked'", revoked_at: 'now()', revoke_reason: "'USER_DISCONNECTED'", purge_after: 'now()',
    scopes: "ARRAY['https://www.googleapis.com/auth/gmail.readonly']", disclosure_sha256: "repeat('ab', 32)",
    mailbox_address: "'fixture-' || gen_random_uuid() || '@example.test'",
  },
};

function firstInList(checks: string[], col: string): string | null {
  for (const def of checks) {
    // e.g. CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
    const re = new RegExp(`(?<![A-Za-z_])(?<![A-Za-z_]\\()\\(?${col}\\)? = ANY \\(\\(?ARRAY\\['([^']*)'`);
    const m = re.exec(def);
    if (m) return `'${m[1]}'`;
    const eq = new RegExp(`(?<![A-Za-z_])(?<![A-Za-z_]\\()\\(?${col}\\)? = '([^']*)'::text`).exec(def);
    if (eq && !def.includes(' OR ')) return `'${eq[1]}'`;
  }
  return null;
}

function typeDefault(c: Col): string {
  switch (c.udt_name) {
    case 'uuid':
      return 'gen_random_uuid()';
    case 'text':
    case 'varchar':
      return "'fixture'";
    case 'citext':
      return "'fixture-' || gen_random_uuid() || '@example.test'";
    case 'timestamptz':
      return 'now()';
    case 'date':
      return 'current_date';
    case 'time':
      return "'09:00'";
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return '1';
    case 'bool':
      return 'false';
    case 'jsonb':
      return "'{}'";
    case 'bytea':
      return "digest(gen_random_uuid()::text, 'sha256')";
    case '_text':
      return "'{}'";
    case '_uuid':
      return "'{}'";
    case 'inet':
      return "'127.0.0.1'";
    case 'tsvector':
      return "''";
    default:
      throw new Error(`isolationFixture: no value for type ${c.udt_name}`);
  }
}

/** The INSERT for one generated row of `table` in tenant `tenantId`. */
export async function fixtureInsertSql(su: pg.Pool, table: string, tenantId: string): Promise<string> {
  const cols = await su.query<Col>(
    `SELECT column_name, udt_name, is_nullable, column_default, is_generated, identity_generation
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  const checks = (await su.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ('public.' || quote_ident($1))::regclass AND contype = 'c'`, [table])).rows.map((r) => r.def);
  const names: string[] = [];
  const values: string[] = [];
  for (const c of cols.rows) {
    if (c.is_generated === 'ALWAYS' || c.identity_generation === 'ALWAYS') continue;
    const o = OVERRIDES[table]?.[c.column_name] ?? OVERRIDES['*']![c.column_name];
    let v: string;
    if (o !== undefined && !(o === 'NULL' && c.is_nullable === 'NO')) v = o;
    else if (c.is_nullable === 'YES') continue;
    else if (c.column_default !== null) continue;
    else if (c.udt_name === 'jsonb') v = checks.some((d) => d.includes(`jsonb_typeof(${c.column_name}) = 'array'`)) ? "'[]'" : "'{}'";
    else v = firstInList(checks, c.column_name) ?? typeDefault(c);
    if (v === 'NULL' && c.is_nullable === 'NO') v = firstInList(checks, c.column_name) ?? typeDefault(c);
    names.push(`"${c.column_name}"`);
    values.push(v.replaceAll('$T', `'${tenantId}'::uuid`));
  }
  return `INSERT INTO public."${table}" (${names.join(', ')}) VALUES (${values.join(', ')})`;
}

/** Inserts one generated row (superuser, triggers off). Throws with the table name on failure. */
export async function insertFixtureRow(su: pg.Pool, table: string, tenantId: string): Promise<void> {
  const text = await fixtureInsertSql(su, table, tenantId);
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(text);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw new Error(`fixture row for ${table} failed: ${(e as Error).message}\n${text}`, { cause: e });
  } finally {
    c.release();
  }
}
