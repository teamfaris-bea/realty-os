// Deterministic synthetic load data (lane scale-250k). One large tenant plus a few small ones, bulk
// loaded as the owner role for speed with every trigger and constraint ON (the ownership ledger guard,
// the dispatch guards, the consent projection guard, append-only ledgers ...), then ANALYZE.
//
// Determinism: every id, name, number, count and time offset is a pure function of (tenant slug, row
// number, salt) through Postgres' hashint8extended, so two runs with the same sizes produce the same rows.
// Times are offsets from ONE anchor instant read at the start of a run (the DB clock), so relative ages
// ("3 days ago", "due in 2 hours") are identical between runs; absolute timestamps follow the anchor.
// Random-looking bytes that must be secret in production (tenant keys) are derived from the slug too:
// this is synthetic data on a throwaway database, never real tenants.
//
// Opt-outs are real: the address HMACs are computed with the tenant's own HMAC key (the same
// HMAC-SHA256 the API uses), so canContact and the 0013/0014 dispatch guards see every STOP, email
// unsubscribe, do-not-contact and suppression exactly as they would for real data.
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Kek } from '../crypto/kek.js';
import { wrapTenantKeys } from '../crypto/envelope.js';
import { CITIES, FIRST_NAMES, LAST_NAMES, STREETS } from './names.js';

export interface TenantSpec {
  /** 0 = the large tenant */
  index: number;
  slug: string;
  name: string;
  contacts: number;
  agents: number;
  teamLeads: number;
}

export interface LoadSpec {
  tenants: TenantSpec[];
  /** argon2 hash every load user gets (so a person can log in to look around) */
  passwordHash: string;
}

export const LOAD_PASSWORD = 'load-test-password-only';

/** The default layout for `--contacts N`: one large tenant and three small ones (N/50 each, at least 500). */
export function defaultSpec(contacts: number, passwordHash: string): LoadSpec {
  const small = Math.max(500, Math.round(contacts / 50));
  const agentsFor = (n: number) => Math.max(5, Math.min(50, Math.round(n / 5000)));
  return {
    passwordHash,
    tenants: [
      { index: 0, slug: 'load-big', name: 'Harbor Load Team', contacts, agents: agentsFor(contacts), teamLeads: 3 },
      { index: 1, slug: 'load-small-1', name: 'Bayside Load Team', contacts: small, agents: 5, teamLeads: 1 },
      { index: 2, slug: 'load-small-2', name: 'Ridge Load Team', contacts: small, agents: 5, teamLeads: 1 },
      { index: 3, slug: 'load-small-3', name: 'Valley Load Team', contacts: small, agents: 5, teamLeads: 1 },
    ],
  };
}

/** A stable uuid for (slug, kind, n). */
export function loadUuid(slug: string, key: string): string {
  return uuidOfHex(createHash('md5').update(`${slug}:${key}`).digest('hex'));
}

/** An RFC 9562 version-4-shaped uuid from 32 hex digits (the API's z.uuid() checks version and variant). */
function uuidOfHex(h: string): string {
  const variant = '89ab'[parseInt(h[16]!, 16) % 4]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function loadEmail(slug: string, role: string, n: number): string {
  return `${role}${String(n).padStart(2, '0')}@${slug}.load.test`;
}

/** Deterministic tenant keys (synthetic data only). */
function tenantKeys(slug: string) {
  const k = (p: string) => new Uint8Array(createHash('sha256').update(`realty-os-load:${slug}:${p}`).digest());
  return { field: k('field'), object: k('object'), hmac: k('hmac') };
}

type Log = (msg: string) => void;

export interface GenerateResult {
  anchor: Date;
  rows: Record<string, number>;
  seconds: number;
}

const HELPERS = `
CREATE OR REPLACE FUNCTION pg_temp.r(g bigint, salt bigint) RETURNS double precision LANGUAGE sql IMMUTABLE AS
  $$ SELECT ((hashint8extended(g, salt) & 2147483647)::double precision) / 2147483648.0 $$;
CREATE OR REPLACE FUNCTION pg_temp.ri(g bigint, salt bigint, n bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS
  $$ SELECT ((hashint8extended(g, salt) & 2147483647) % n) $$;
CREATE OR REPLACE FUNCTION pg_temp.uid(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT (substr(h, 1, 12) || '4' || substr(h, 14, 3) || substr('89ab', ('x' || substr(h, 17, 1))::bit(4)::int % 4 + 1, 1) || substr(h, 18))::uuid
       FROM md5(s) AS h $$;
`;

/** Loads `spec` into the (migrated, empty) database at `ownerUrl`. */
export async function generateLoad(ownerUrl: string, kek: Kek, spec: LoadSpec, log: Log = () => {}): Promise<GenerateResult> {
  const started = Date.now();
  const c = new pg.Client({ connectionString: ownerUrl, application_name: 'load-generate' });
  await c.connect();
  try {
    await c.query(`SET synchronous_commit = off; SET maintenance_work_mem = '512MB'; SET work_mem = '128MB'; SET jit = off; SET plan_cache_mode = force_custom_plan`);
    await c.query(HELPERS);
    const anchor = (await c.query<{ t: Date }>(`SELECT date_trunc('second', now()) AS t`)).rows[0]!.t;
    await c.query(`CREATE OR REPLACE FUNCTION pg_temp.t0() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT '${anchor.toISOString()}'::timestamptz $$`);
    await c.query(`CREATE TEMP TABLE ld_first (i int PRIMARY KEY, v text); CREATE TEMP TABLE ld_last (i int PRIMARY KEY, v text);
                   CREATE TEMP TABLE ld_city (i int PRIMARY KEY, city text, region text, zip3 text); CREATE TEMP TABLE ld_street (i int PRIMARY KEY, v text)`);
    await c.query(`INSERT INTO ld_first SELECT ordinality - 1, v FROM unnest($1::text[]) WITH ORDINALITY v`, [FIRST_NAMES]);
    await c.query(`INSERT INTO ld_last SELECT ordinality - 1, v FROM unnest($1::text[]) WITH ORDINALITY v`, [LAST_NAMES]);
    for (const [i, [city, region, zip3]] of CITIES.entries()) await c.query(`INSERT INTO ld_city VALUES ($1, $2, $3, $4)`, [i, city, region, zip3]);
    await c.query(`INSERT INTO ld_street SELECT ordinality - 1, v FROM unnest($1::text[]) WITH ORDINALITY v`, [STREETS]);
    for (const t of spec.tenants) await seedTenant(c, kek, spec, t, log);
    log('ANALYZE');
    await c.query('ANALYZE');
    const rows: Record<string, number> = {};
    for (const table of COUNTED) rows[table] = Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n);
    return { anchor, rows, seconds: (Date.now() - started) / 1000 };
  } finally {
    await c.end();
  }
}

export const COUNTED = [
  'tenants', 'memberships', 'contacts', 'contact_points', 'lead_ownership_events', 'conversations', 'messages', 'calls', 'notes', 'tasks',
  'appointments', 'deals', 'deal_members', 'listings', 'consent_events', 'consent_state', 'suppressions', 'behavior_events', 'lead_inquiries',
  'ponds', 'contact_collaborators',
] as const;

async function step(c: pg.Client, log: Log, label: string, text: string, values: unknown[] = []): Promise<number> {
  const t0 = Date.now();
  const r = await c.query(text, values);
  const n = r.rowCount ?? 0;
  // Fresh statistics after every bulk step: the guard triggers' cached plans were made while the tables
  // were empty (a sequential scan per row would make the next step quadratic).
  const table = /^\s*(?:INSERT INTO|UPDATE)\s+([a-z_]+)/i.exec(text)?.[1];
  if (table && !table.startsWith('ld_')) await c.query(`ANALYZE ${table}`);
  log(`  ${label}: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return n;
}

async function seedTenant(c: pg.Client, kek: Kek, spec: LoadSpec, t: TenantSpec, log: Log): Promise<void> {
  const S = t.slug;
  const T = loadUuid(S, 'tenant');
  const N = t.contacts;
  log(`tenant ${S}: ${N} contacts, ${t.agents} agents`);
  const keys = tenantKeys(S);
  const wrapped = await wrapTenantKeys(kek, T, keys);
  const hmacKey = Buffer.from(keys.hmac);
  const owner = loadUuid(S, 'user:owner');
  const salt = (n: number) => t.index * 1000 + n; // per-tenant salts keep tenants different but deterministic

  await c.query('BEGIN');
  // ---- tenant, people, teams, ponds, numbers (the provisioning definer, as signup does) -------------------
  await c.query(`INSERT INTO users (id, email, display_name, password_hash, password_changed_at) VALUES ($1, $2, 'Olivia Owner', $3, pg_temp.t0())`,
    [owner, loadEmail(S, 'owner', 1), spec.passwordHash]);
  await c.query(`SELECT set_config('app.user_id', $1, true)`, [owner]);
  await c.query(`SELECT app.provision_tenant($1::uuid, $2::citext, $3, 'America/Los_Angeles', $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11, $12)`, [
    T, S, t.name, `${t.name} Realty LLC`, owner, loadUuid(S, 'policy'), loadUuid(S, 'team:default'), loadUuid(S, 'pond:default'),
    Buffer.from(wrapped.field), Buffer.from(wrapped.object), Buffer.from(wrapped.hmac), kek.ref,
  ]);
  await c.query(`SELECT set_config('app.user_id', '', true)`);
  // ponds: generous claim limits so the claim benchmark measures the database, not the per-day cap
  await c.query(`UPDATE ponds SET claims_per_day = 50, claim_cooldown_hours = 0 WHERE tenant_id = $1`, [T]);
  // members: admin, team leads, agents, one ISA, one TC
  const people: [string, string, number][] = [['admin', 'admin', 1], ['lead', 'team_lead', t.teamLeads], ['agent', 'agent', t.agents], ['isa', 'isa', 1], ['tc', 'tc', 1]];
  await c.query(`CREATE TEMP TABLE ld_people (k int, role text, user_id uuid, team_id uuid, phone_id uuid, phone text) ON COMMIT DROP`);
  for (const [tag, role, n] of people) {
    for (let i = 1; i <= n; i++) {
      const id = loadUuid(S, `user:${tag}:${i}`);
      const display = `${FIRST_NAMES[(i * 7 + tag.length) % FIRST_NAMES.length]} ${tag === 'agent' ? 'Agent' : tag === 'lead' ? 'Lead' : tag.toUpperCase()} ${i}`;
      await c.query(`INSERT INTO users (id, email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, $4, pg_temp.t0())`, [id, loadEmail(S, tag, i), display, spec.passwordHash]);
      await c.query(`INSERT INTO memberships (tenant_id, user_id, role, status, accepting_leads, joined_at, invited_by_user_id) VALUES ($1, $2, $3, 'active', $4, pg_temp.t0() - interval '400 days', $5)`,
        [T, id, role, role !== 'tc', owner]);
      await c.query(`INSERT INTO ld_people (k, role, user_id) VALUES ($1, $2, $3)`, [role === 'agent' ? i - 1 : -1, role, id]);
    }
  }
  // Owner/Admin need MFA enabled (mfa_required_roles). The benchmark mints MFA-verified sessions through
  // issueSessionTx; the placeholder secret below cannot produce TOTP codes, so these two cannot log in by
  // hand on a load database (agents, leads, ISA and TC can, with LOAD_PASSWORD).
  await c.query(`UPDATE users SET mfa_totp_secret_enc = '\\x00'::bytea, mfa_enabled_at = pg_temp.t0() WHERE id IN ($1, $2)`, [owner, loadUuid(S, 'user:admin:1')]);
  // teams: one per team lead; agents round-robin; the default team keeps everyone not in a sub-team
  for (let i = 1; i <= t.teamLeads; i++) {
    const team = loadUuid(S, `team:${i}`);
    await c.query(`INSERT INTO teams (tenant_id, id, name) VALUES ($1, $2, $3)`, [T, team, `Team ${i}`]);
    await c.query(`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES ($1, $2, $3, true)`, [T, team, loadUuid(S, `user:lead:${i}`)]);
    await c.query(`UPDATE ld_people SET team_id = $1 WHERE role = 'agent' AND k % $2 = $3`, [team, t.teamLeads, i - 1]);
  }
  await c.query(`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) SELECT $1, team_id, user_id, false FROM ld_people WHERE team_id IS NOT NULL`, [T]);
  await c.query(`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) SELECT $1, $2, user_id, false FROM ld_people WHERE role IN ('admin','isa','tc') OR (role = 'agent' AND team_id IS NULL)`,
    [T, loadUuid(S, 'team:default')]);
  // extra ponds (one per team) with members; the default pond is open to all
  for (let i = 1; i <= t.teamLeads; i++) {
    const pond = loadUuid(S, `pond:${i}`);
    await c.query(`INSERT INTO ponds (tenant_id, id, name, open_to_all, claims_per_day, claim_cooldown_hours) VALUES ($1, $2, $3, false, 50, 0)`, [T, pond, `Team ${i} pond`]);
    await c.query(`INSERT INTO pond_members (tenant_id, pond_id, user_id) SELECT $1, $2, user_id FROM ld_people WHERE team_id = $3 OR user_id = $4`,
      [T, pond, loadUuid(S, `team:${i}`), loadUuid(S, `user:lead:${i}`)]);
  }
  // numbers: one agent_direct number per agent plus a team main line
  const area = 510 + t.index;
  await c.query(`UPDATE ld_people SET phone_id = pg_temp.uid($1 || ':phone:' || user_id), phone = '+1${area}20' || lpad(k::text, 5, '0') WHERE role = 'agent'`, [S]);
  await c.query(`INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, assigned_user_id, sms_capable, voice_capable, inbound_route, acquired_at)
                 SELECT $1, phone_id, phone, 'fake', 'PN' || md5(phone), 'local', 'agent_direct', user_id, true, true, 'contact_owner', pg_temp.t0() - interval '400 days' FROM ld_people WHERE role = 'agent'`, [T]);
  await c.query(`INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, inbound_route, acquired_at)
                 VALUES ($1, $2, '+1${area}2999999', 'fake', 'PNmain${t.index}', 'local', 'team_main', true, true, 'team_ring', pg_temp.t0() - interval '400 days')`, [T, loadUuid(S, 'phone:main')]);
  const sources = ['Zillow', 'Realtor.com', 'Website', 'Referral', 'Open house', 'Facebook ads'];
  const kinds = ['portal', 'portal', 'website', 'referral', 'open_house', 'ads'];
  for (const [i, name] of sources.entries()) {
    await c.query(`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, $3, $4)`, [T, loadUuid(S, `source:${i}`), name, kinds[i]]);
  }
  await c.query(`CREATE TEMP TABLE ld_sources ON COMMIT DROP AS SELECT row_number() OVER (ORDER BY name) - 1 AS k, id FROM lead_sources WHERE tenant_id = $1`, [T]);
  await c.query(`CREATE TEMP TABLE ld_agents ON COMMIT DROP AS SELECT k, user_id, team_id, phone_id, phone FROM ld_people WHERE role = 'agent'`);
  await c.query(`CREATE UNIQUE INDEX ON ld_agents (k)`);
  await c.query(`CREATE TEMP TABLE ld_ponds ON COMMIT DROP AS SELECT row_number() OVER (ORDER BY is_default DESC, name) - 1 AS k, id FROM ponds WHERE tenant_id = $1`, [T]);
  const A = t.agents;
  const P = t.teamLeads + 1;

  // ---- contact plan: one row per contact with every derived attribute --------------------------------------
  // state mix: 85.5% owned, 10% in a pond, 0.5% offered (live offers), 2% unassigned, 2% closed.
  // owners are skewed (pow 1.6): the busiest agents hold several times the median book.
  await step(c, log, 'plan', `
    CREATE TEMP TABLE ld_c ON COMMIT DROP AS
    SELECT g, pg_temp.uid($1 || ':contact:' || g) AS id,
           (SELECT v FROM ld_first WHERE i = pg_temp.ri(g, ${salt(1)}, ${FIRST_NAMES.length})) AS first_name,
           (SELECT v FROM ld_last WHERE i = pg_temp.ri(g, ${salt(2)}, ${LAST_NAMES.length})) AS last_name,
           pg_temp.r(g, ${salt(3)}) AS rs,
           CASE WHEN pg_temp.r(g, ${salt(3)}) < 0.855 THEN 'owned' WHEN pg_temp.r(g, ${salt(3)}) < 0.955 THEN 'in_pond'
                WHEN pg_temp.r(g, ${salt(3)}) < 0.96 THEN 'offered' WHEN pg_temp.r(g, ${salt(3)}) < 0.98 THEN 'unassigned' ELSE 'closed' END AS state,
           floor(power(pg_temp.r(g, ${salt(4)}), 1.6) * ${A})::int AS ak,
           pg_temp.ri(g, ${salt(5)}, ${P}) AS pk,
           pg_temp.ri(g, ${salt(6)}, 6) AS sk,
           -- created 0..720 days ago, skewed to recent
           pg_temp.t0() - (power(pg_temp.r(g, ${salt(7)}), 1.7) * 720 * 86400 + 3600) * interval '1 second' AS created_at,
           pg_temp.r(g, ${salt(8)}) < 0.92 AS has_phone,
           pg_temp.r(g, ${salt(9)}) < 0.80 AS has_email,
           pg_temp.r(g, ${salt(10)}) < 0.10 AS has_phone2,
           -- message count: exponential with mean ~8.6, capped at 150 (a few very chatty clients)
           LEAST(150, floor(-ln(1 - pg_temp.r(g, ${salt(11)})) * 8.6))::int AS n_msg,
           LEAST(30, floor(-ln(1 - pg_temp.r(g, ${salt(12)})) * 1.55))::int AS n_call,
           LEAST(20, floor(-ln(1 - pg_temp.r(g, ${salt(13)})) * 1.0))::int AS n_note,
           pg_temp.r(g, ${salt(14)}) AS r_touch,
           pg_temp.r(g, ${salt(15)}) AS r_opt,
           pg_temp.r(g, ${salt(16)}) AS r_misc,
           -- most recent activity 0..300 days ago, strongly skewed to recent (a live book)
           power(pg_temp.r(g, ${salt(17)}), 3) * 300 * 86400 AS recency_s,
           (3600 + pg_temp.r(g, ${salt(18)}) * 4 * 86400) AS gap_s
      FROM generate_series(1, ${N}) g`, [S]);
  await c.query(`ALTER TABLE ld_c ADD PRIMARY KEY (g); ANALYZE ld_c`);
  await c.query(`ALTER TABLE ld_c ADD COLUMN owner uuid, ADD COLUMN team_phone_id uuid, ADD COLUMN team_phone text, ADD COLUMN pond_id uuid, ADD COLUMN source_id uuid,
                   ADD COLUMN owned_at timestamptz, ADD COLUMN touched boolean`);
  await c.query(`UPDATE ld_c SET team_phone_id = a.phone_id, team_phone = a.phone, owner = CASE WHEN state = 'owned' THEN a.user_id END,
                        owned_at = CASE WHEN state = 'owned' THEN created_at + interval '2 minutes' END,
                        -- 98.5% of owned leads got a first touch; recent untouched ones become untouched_lead exceptions
                        touched = state = 'owned' AND (r_touch < 0.985 OR created_at < pg_temp.t0() - interval '45 days')
                   FROM ld_agents a WHERE a.k = ld_c.ak`);
  await c.query(`UPDATE ld_c SET pond_id = p.id FROM ld_ponds p WHERE p.k = ld_c.pk AND state = 'in_pond'`);
  await c.query(`UPDATE ld_c SET source_id = s.id FROM ld_sources s WHERE s.k = ld_c.sk`);

  // ---- ownership ledger (through the ledger guard: one ownership command for the whole load) -----------
  const cmd = loadUuid(S, 'ownership-command:load');
  await c.query(`SELECT set_config('app.ownership_command', $1, true)`, [cmd]);
  await step(c, log, 'ledger seq 1 (created)', `
    INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, actor_kind, reason_code, command_id, occurred_at)
    SELECT $1, id, 1, pg_temp.uid($2 || ':loe1:' || g), 'created', NULL, CASE WHEN state = 'closed' THEN 'unassigned' WHEN state IN ('owned','offered','in_pond') THEN 'unassigned' ELSE state END,
           'system', 'LEAD_INTAKE', $3, created_at FROM ld_c`, [T, S, cmd]);
  await step(c, log, 'ledger seq 2 (assigned / offered / pond / closed)', `
    INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, pond_id, offer_id, offered_to_user_id,
                                       deadline_at, actor_kind, reason_code, command_id, occurred_at)
    SELECT $1, c.id, 2, pg_temp.uid($2 || ':loe2:' || g),
           CASE state WHEN 'owned' THEN 'assigned' WHEN 'offered' THEN 'offered' WHEN 'in_pond' THEN 'sent_to_pond' ELSE 'closed' END,
           'unassigned', state, c.owner, c.pond_id,
           CASE WHEN state = 'offered' THEN pg_temp.uid($2 || ':offer:' || g) END,
           CASE WHEN state = 'offered' THEN a.user_id END,
           CASE WHEN state = 'owned' THEN c.owned_at + interval '15 minutes' WHEN state = 'offered' THEN pg_temp.t0() + interval '6 hours' END,
           'system', CASE state WHEN 'owned' THEN 'ROUTING_RULE' WHEN 'offered' THEN 'ROUTING_RULE' WHEN 'in_pond' THEN 'NO_ONE_ACCEPTED' ELSE 'SPAM' END,
           $3, c.created_at + interval '2 minutes'
      FROM ld_c c JOIN ld_agents a ON a.k = c.ak WHERE state <> 'unassigned'`, [T, S, cmd]);
  await step(c, log, 'ledger seq 3 (first touch)', `
    INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
    SELECT $1, id, 3, pg_temp.uid($2 || ':loe3:' || g), 'first_touch_recorded', 'owned', 'owned', owner, 'system', NULL, 'FIRST_TOUCH', $3,
           owned_at + (60 + r_touch * 600) * interval '1 second'
      FROM ld_c WHERE touched`, [T, S, cmd]);
  await step(c, log, 'contacts', `
    INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, contact_type, intent, stage, timezone, timezone_source, ownership_state,
                          owner_user_id, pond_id, offer_id, offered_to_user_id, offer_expires_at, offer_round, owned_at, first_touch_due_at, first_touch_at,
                          release_due_at, ownership_period_seq, closed_reason, ownership_seq, ownership_command_id, original_lead_source_id, tags,
                          created_at, updated_at)
    SELECT $1, c.id, c.first_name, c.last_name, c.first_name || ' ' || c.last_name,
           CASE WHEN c.r_misc < 0.85 THEN 'lead' WHEN c.r_misc < 0.95 THEN 'sphere' ELSE 'past_client' END,
           (ARRAY['buyer','seller','buyer_seller','buyer','buyer','investor'])[1 + pg_temp.ri(c.g, ${salt(20)}, 6)],
           CASE WHEN c.state = 'closed' THEN 'lost' WHEN c.state <> 'owned' THEN 'new'
                ELSE (ARRAY['attempting','connected','nurture','nurture','nurture','active','active','under_contract','closed','lost'])[1 + pg_temp.ri(c.g, ${salt(21)}, 10)] END,
           'America/Los_Angeles', 'tenant_default', c.state,
           c.owner, c.pond_id,
           CASE WHEN c.state = 'offered' THEN pg_temp.uid($2 || ':offer:' || c.g) END,
           CASE WHEN c.state = 'offered' THEN a.user_id END,
           CASE WHEN c.state = 'offered' THEN pg_temp.t0() + interval '6 hours' END,
           CASE WHEN c.state = 'offered' THEN 1 ELSE 0 END,
           c.owned_at,
           CASE WHEN c.state = 'owned' AND NOT c.touched THEN c.owned_at + interval '15 minutes' END,
           CASE WHEN c.touched THEN c.owned_at + (60 + c.r_touch * 600) * interval '1 second' END,
           NULL,
           CASE WHEN c.state = 'owned' THEN 2 END,
           CASE WHEN c.state = 'closed' THEN 'spam' END,
           CASE WHEN c.touched THEN 3 WHEN c.state = 'unassigned' THEN 1 ELSE 2 END, $3, c.source_id,
           CASE WHEN c.r_misc < 0.05 THEN ARRAY['vip'] WHEN c.r_misc > 0.97 THEN ARRAY['investor','cash'] ELSE '{}' END,
           c.created_at, c.created_at
      FROM ld_c c JOIN ld_agents a ON a.k = c.ak`, [T, S, cmd]);
  await c.query(`SELECT set_config('app.ownership_command', '', true)`);

  // ---- contact points: phones (with HMACs under the tenant key), second phones, emails ------------------
  await step(c, log, 'contact points', `
    INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, line_type, status, is_primary, created_at)
    SELECT $1, pg_temp.uid($2 || ':cp:' || kind || ':' || g), id, CASE WHEN kind = 'email' THEN 'email' ELSE 'phone' END, address,
           hmac(convert_to(address, 'UTF8'), $3::bytea, 'sha256'), label, line_type, 'active', kind <> 'phone2', created_at
      FROM (
        SELECT g, id, created_at, 'phone' AS kind, 'mobile' AS label, 'mobile' AS line_type,
               '+1' || (201 + pg_temp.ri(g, ${salt(30)}, 798))::text || lpad(pg_temp.ri(g, ${salt(31)}, 10000000)::text, 7, '0') AS address
          FROM ld_c WHERE has_phone
        UNION ALL
        SELECT g, id, created_at, 'phone2', 'home', 'landline',
               '+1' || (201 + pg_temp.ri(g, ${salt(32)}, 798))::text || lpad(pg_temp.ri(g, ${salt(33)}, 10000000)::text, 7, '0')
          FROM ld_c WHERE has_phone2
        UNION ALL
        SELECT g, id, created_at, 'email', 'other', 'unknown',
               lower(regexp_replace(first_name, '[^A-Za-z]', '', 'g') || '.' || regexp_replace(last_name, '[^A-Za-z]', '', 'g') || g || '@'
                     || (ARRAY['gmail.com','yahoo.com','outlook.com','icloud.com','hotmail.com','aol.com','comcast.net'])[1 + pg_temp.ri(g, ${salt(34)}, 7)])
          FROM ld_c WHERE has_email) x`, [T, S, hmacKey]);
  await c.query(`ALTER TABLE ld_c ADD COLUMN phone text, ADD COLUMN email text`);
  await c.query(`UPDATE ld_c SET phone = p.address FROM contact_points p WHERE p.tenant_id = $1 AND p.contact_id = ld_c.id AND p.kind = 'phone' AND p.is_primary`, [T]);
  await c.query(`UPDATE ld_c SET email = p.address FROM contact_points p WHERE p.tenant_id = $1 AND p.contact_id = ld_c.id AND p.kind = 'email'`, [T]);
  await step(c, log, 'contact addresses', `
    INSERT INTO contact_addresses (tenant_id, id, contact_id, line1, city, region, postal_code, kind, country, jurisdiction, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':addr:' || g), id, (100 + pg_temp.ri(g, ${salt(35)}, 9800))::text || ' ' || s.v || ' St', ci.city, ci.region,
           ci.zip3 || lpad(pg_temp.ri(g, ${salt(36)}, 100)::text, 2, '0'), 'home', 'US', 'US-CA', created_at, created_at
      FROM ld_c JOIN ld_street s ON s.i = pg_temp.ri(g, ${salt(37)}, ${STREETS.length}) JOIN ld_city ci ON ci.i = pg_temp.ri(g, ${salt(38)}, ${CITIES.length})
     WHERE r_misc < 0.45`, [T, S]);

  // ---- conversations and messages ------------------------------------------------------------------------
  await step(c, log, 'conversations', `
    INSERT INTO conversations (tenant_id, id, contact_id, sticky_phone_number_id, created_at)
    SELECT $1, pg_temp.uid($2 || ':conv:' || g), id, CASE WHEN has_phone THEN team_phone_id END, created_at FROM ld_c WHERE has_phone OR has_email`, [T, S]);
  // message j of contact g happens at  t0 - recency - (n - j) * gap ; odd j inbound (the client writes first)
  await step(c, log, 'messages', `
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, status_reason,
                          initiator, initiated_by_user_id, purpose, dispatched_at, provider, provider_message_ref, occurred_at, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':msg:' || c.g || ':' || j), pg_temp.uid($2 || ':conv:' || c.g), c.id,
           CASE WHEN c.has_phone THEN 'sms' ELSE 'email' END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN 'inbound' ELSE 'outbound' END,
           CASE WHEN c.has_phone THEN c.team_phone_id END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN coalesce(c.phone, c.email) ELSE c.team_phone END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN coalesce(c.team_phone, 'team@${S}.load.test') ELSE c.phone END,
           (ARRAY['Hi, is this still available?', 'We are looking in Rockridge, 3 bed, under 1.2M.', 'Can we see it Saturday morning?',
                  'Thanks! Talk soon.', 'What are the HOA dues?', 'Sounds good, send me the disclosures.', 'Are they open to offers below asking?',
                  'Got it, I will check with my lender.', 'Here is the pre-approval letter.', 'Can you call me after 5?'])[1 + pg_temp.ri(c.g * 1000 + j, ${salt(40)}, 10)],
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN 'received'
                WHEN pg_temp.r(c.g * 1000 + j, ${salt(41)}) < 0.015 THEN 'failed'
                WHEN pg_temp.r(c.g * 1000 + j, ${salt(41)}) < 0.025 THEN 'undelivered' ELSE 'delivered' END,
           NULL,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN 'client' ELSE 'human' END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN NULL ELSE a.user_id END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN NULL ELSE 'informational' END,
           CASE WHEN j % 2 = 1 OR NOT c.has_phone THEN NULL ELSE ts END,
           'fake', 'SM' || md5($2 || c.g || ':' || j),
           ts, ts, ts
      FROM ld_c c JOIN ld_agents a ON a.k = c.ak
      CROSS JOIN LATERAL generate_series(1, c.n_msg) j
      CROSS JOIN LATERAL (SELECT pg_temp.t0() - (c.recency_s + (c.n_msg - j) * c.gap_s) * interval '1 second' AS ts) t
     WHERE (c.has_phone OR c.has_email) AND c.state <> 'closed'`, [T, S]);
  await step(c, log, 'conversation stamps', `
    UPDATE conversations v SET last_inbound_at = m.li, last_outbound_at = m.lo, inbound_seq = m.n
      FROM (SELECT conversation_id, max(occurred_at) FILTER (WHERE direction = 'inbound') AS li, max(occurred_at) FILTER (WHERE direction = 'outbound') AS lo,
                   count(*) FILTER (WHERE direction = 'inbound') AS n
              FROM messages WHERE tenant_id = $1 GROUP BY 1) m
     WHERE v.tenant_id = $1 AND v.id = m.conversation_id`, [T]);
  await step(c, log, 'contact stamps', `
    UPDATE contacts k SET last_inbound_at = m.li, last_human_touch_at = m.lo
      FROM (SELECT contact_id, max(occurred_at) FILTER (WHERE direction = 'inbound') AS li, max(occurred_at) FILTER (WHERE direction = 'outbound') AS lo
              FROM messages WHERE tenant_id = $1 GROUP BY 1) m
     WHERE k.tenant_id = $1 AND k.id = m.contact_id`, [T]);

  // ---- calls (outbound by the owner or the offeree, inbound from the client); most outcomes logged -------
  await step(c, log, 'calls', `
    INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status,
                       started_at, answered_at, ended_at, duration_s, recording_mode, recording_decision, outcome, outcome_logged_by_user_id, outcome_logged_at,
                       provider_call_ref, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':call:' || c.g || ':' || j), pg_temp.uid($2 || ':conv:' || c.g), c.id,
           dir, c.team_phone_id, a.user_id, c.phone, CASE WHEN dir = 'outbound' THEN 'human' ELSE 'client' END,
           CASE WHEN ans THEN 'completed' ELSE 'no_answer' END,
           ts, CASE WHEN ans THEN ts + interval '8 seconds' END, ts + (CASE WHEN ans THEN 60 + dur ELSE 25 END) * interval '1 second', CASE WHEN ans THEN 60 + dur ELSE 0 END,
           'off', '{"mode":"off"}'::jsonb,
           CASE WHEN logged THEN CASE WHEN ans THEN 'connected' ELSE 'no_answer' END END,
           CASE WHEN logged THEN a.user_id END, CASE WHEN logged THEN ts + interval '10 minutes' END,
           'CA' || md5($2 || c.g || ':' || j), ts, ts
      FROM ld_c c JOIN ld_agents a ON a.k = c.ak
      CROSS JOIN LATERAL generate_series(1, c.n_call) j
      CROSS JOIN LATERAL (SELECT pg_temp.t0() - (c.recency_s + 3600 + j * 2 * c.gap_s) * interval '1 second' AS ts,
                                 CASE WHEN pg_temp.r(c.g * 100 + j, ${salt(50)}) < 0.8 THEN 'outbound' ELSE 'inbound' END AS dir,
                                 pg_temp.r(c.g * 100 + j, ${salt(51)}) < 0.55 AS ans,
                                 pg_temp.r(c.g * 100 + j, ${salt(52)}) < 0.95 AS logged,
                                 pg_temp.ri(c.g * 100 + j, ${salt(53)}, 900) AS dur) x
     WHERE c.has_phone AND c.state <> 'closed'`, [T, S]);

  // ---- notes ------------------------------------------------------------------------------------------
  await step(c, log, 'notes', `
    INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, pinned, source, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':note:' || c.g || ':' || j), c.id, a.user_id,
           (ARRAY['Pre-approved with First Bay Credit up to $1.1M.', 'Prefers texts over calls; works nights.', 'Selling their condo first; contingent buyer.',
                  'Relocating from Austin in the spring.', 'Wants a yard for the dog. No HOA if possible.', 'Spoke with spouse, both want to see 12 Oak St.',
                  'Asked about school districts near Montclair.', 'VA loan eligible.', 'Cash buyer, investor, looking for duplexes.', 'Follow up after the holidays.'])
             [1 + pg_temp.ri(c.g * 100 + j, ${salt(60)}, 10)],
           j = 1 AND c.r_misc < 0.1, 'manual', ts, ts
      FROM ld_c c JOIN ld_agents a ON a.k = c.ak
      CROSS JOIN LATERAL generate_series(1, c.n_note) j
      CROSS JOIN LATERAL (SELECT pg_temp.t0() - (c.recency_s + j * 3 * c.gap_s) * interval '1 second' AS ts) x`, [T, S]);

  // ---- tasks (callbacks, follow-ups and promises; some promises overdue = overdue_promise material) -------
  await step(c, log, 'tasks', `
    INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, status, completed_at, completed_by_user_id, created_by_kind, created_by_user_id,
                       created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':task:' || g), owner, id, kind,
           CASE kind WHEN 'callback' THEN 'Call back ' || first_name WHEN 'promise' THEN 'Send ' || first_name || ' the comps I promised'
                     ELSE 'Follow up with ' || first_name END,
           due, CASE WHEN done THEN 'done' ELSE 'open' END, CASE WHEN done THEN due - interval '1 hour' END, CASE WHEN done THEN owner END,
           'user', owner, due - interval '3 days', due - interval '3 days'
      FROM (SELECT *, (ARRAY['callback','follow_up','follow_up','promise'])[1 + pg_temp.ri(g, ${salt(70)}, 4)] AS kind,
                   pg_temp.t0() + (pg_temp.r(g, ${salt(71)}) * 60 - 40) * interval '1 day' AS due,
                   pg_temp.r(g, ${salt(72)}) < 0.6 AS done
              FROM ld_c WHERE state = 'owned' AND pg_temp.r(g, ${salt(73)}) < 0.28) x
     WHERE NOT (done AND due > pg_temp.t0())`, [T, S]);

  // ---- appointments (some past ones without an outcome = missing_outcome material) -----------------------
  await step(c, log, 'appointments', `
    INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, status, outcome, outcome_logged_at, outcome_logged_by_user_id,
                              created_by_kind, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':appt:' || g), id, owner, owner, (ARRAY['buyer_consult','listing_appointment','consult'])[1 + pg_temp.ri(g, ${salt(80)}, 3)],
           st, st + interval '1 hour', CASE WHEN st > pg_temp.t0() THEN 'scheduled' ELSE 'held' END,
           CASE WHEN logged THEN 'follow_up' END, CASE WHEN logged THEN st + interval '2 hours' END, CASE WHEN logged THEN owner END,
           'user', st - interval '5 days', st - interval '5 days'
      FROM (SELECT *, pg_temp.t0() + (pg_temp.r(g, ${salt(81)}) * 50 - 40) * interval '1 day' AS st,
                   pg_temp.r(g, ${salt(82)}) < 0.85 AS logged0
              FROM ld_c WHERE state = 'owned' AND pg_temp.r(g, ${salt(83)}) < 0.025) x
      CROSS JOIN LATERAL (SELECT logged0 AND st < pg_temp.t0() - interval '3 hours' AS logged) l`, [T, S]);

  // ---- listings, deals, deal members (a TC on every listing-side deal, co-agents on some) ---------------
  const nListings = Math.max(20, Math.round(N / 500));
  await step(c, log, 'listings', `
    INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                          property_type, listing_agent_user_id, list_date, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':listing:' || g), 'team', 'ML' || (81000000 + g), (ARRAY['active','active','pending','sold','coming_soon','withdrawn'])[1 + pg_temp.ri(g, ${salt(90)}, 6)],
           (100 + pg_temp.ri(g, ${salt(91)}, 9800))::text || ' ' || s.v || ' Ave', ci.city, ci.region, ci.zip3 || lpad(pg_temp.ri(g, ${salt(92)}, 100)::text, 2, '0'),
           (450000 + pg_temp.ri(g, ${salt(93)}, 2500000)) * 100, 1 + pg_temp.ri(g, ${salt(94)}, 5), 10 + 5 * pg_temp.ri(g, ${salt(95)}, 6), 700 + pg_temp.ri(g, ${salt(96)}, 3500),
           (ARRAY['single_family','condo','townhouse','multi_family'])[1 + pg_temp.ri(g, ${salt(97)}, 4)], a.user_id,
           (pg_temp.t0() - (pg_temp.ri(g, ${salt(98)}, 300)) * interval '1 day')::date, pg_temp.t0() - interval '300 days', pg_temp.t0() - interval '300 days'
      FROM generate_series(1, ${nListings}) g JOIN ld_agents a ON a.k = pg_temp.ri(g, ${salt(99)}, ${A})
      JOIN ld_street s ON s.i = pg_temp.ri(g, ${salt(100)}, ${STREETS.length}) JOIN ld_city ci ON ci.i = pg_temp.ri(g, ${salt(101)}, ${CITIES.length})`, [T, S]);
  await step(c, log, 'deals', `
    INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, listing_id, price_cents, expected_close_date,
                       closed_at, lost_reason, lead_source_id, created_by_user_id, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':deal:' || g), first_name || ' ' || last_name || CASE WHEN side = 'sell' THEN ' listing' ELSE ' purchase' END, side, stage,
           pg_temp.t0() - interval '10 days', id, owner, CASE WHEN side = 'sell' THEN pg_temp.uid($2 || ':listing:' || (1 + pg_temp.ri(g, ${salt(110)}, ${nListings}))) END,
           (500000 + pg_temp.ri(g, ${salt(111)}, 1500000)) * 100, (pg_temp.t0() + (pg_temp.ri(g, ${salt(112)}, 120) - 30) * interval '1 day')::date,
           CASE WHEN stage = 'closed' THEN pg_temp.t0() - (pg_temp.ri(g, ${salt(113)}, 200)) * interval '1 day' END,
           CASE WHEN stage = 'lost' THEN 'went_with_other_agent' END, source_id, owner, created_at + interval '20 days', created_at + interval '20 days'
      FROM (SELECT *, CASE WHEN pg_temp.r(g, ${salt(114)}) < 0.3 THEN 'sell' ELSE 'buy' END AS side,
                   (ARRAY['prospect','agreement_signed','active','active','under_contract','under_contract','closed','closed','closed','lost'])[1 + pg_temp.ri(g, ${salt(115)}, 10)] AS stage
              FROM ld_c WHERE state = 'owned' AND pg_temp.r(g, ${salt(116)}) < 0.014) x`, [T, S]);
  await step(c, log, 'deal contacts', `INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role)
    SELECT tenant_id, id, primary_contact_id, CASE WHEN side = 'sell' THEN 'seller' ELSE 'buyer' END FROM deals WHERE tenant_id = $1`, [T]);
  await step(c, log, 'deal members (TC on most deals, co-agents on some)', `
    INSERT INTO deal_members (tenant_id, deal_id, user_id, role)
    SELECT d.tenant_id, d.id, p.user_id, 'tc' FROM deals d CROSS JOIN ld_people p WHERE d.tenant_id = $1 AND p.role = 'tc' AND d.stage NOT IN ('prospect','lost')
    UNION ALL
    SELECT d.tenant_id, d.id, a.user_id, 'co_agent' FROM deals d JOIN ld_agents a ON a.k = (pg_temp.ri(hashtext(d.id::text), ${salt(117)}, ${A}))
     WHERE d.tenant_id = $1 AND pg_temp.r(hashtext(d.id::text), ${salt(118)}) < 0.15 AND a.user_id <> d.owner_user_id`, [T]);
  // ISA collaborating on 1% of owned leads
  await step(c, log, 'contact collaborators (ISA)', `
    INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id, created_at)
    SELECT $1, c.id, p.user_id, 'isa', c.owner, c.owned_at FROM ld_c c CROSS JOIN ld_people p WHERE p.role = 'isa' AND c.state = 'owned' AND pg_temp.r(c.g, ${salt(119)}) < 0.01`, [T]);

  // ---- attribution: one inquiry per contact ------------------------------------------------------------
  await step(c, log, 'lead inquiries', `
    INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, external_id, received_at, inquiry_type, message, postal_code, fingerprint, outcome, created_at)
    SELECT $1, pg_temp.uid($2 || ':inq:' || g), id, source_id, 'EXT' || g, created_at, (ARRAY['buy','buy','sell','value','general'])[1 + pg_temp.ri(g, ${salt(120)}, 5)],
           'I am interested in this home.', '946' || lpad(pg_temp.ri(g, ${salt(121)}, 100)::text, 2, '0'), md5($2 || ':fp:' || g), 'new_contact', created_at
      FROM ld_c`, [T, S]);

  // ---- behaviour events (30% of contacts browse the site) ----------------------------------------------
  await step(c, log, 'behavior events', `
    INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, listing_id, source, occurred_at, received_at, dedupe_key, payload)
    SELECT $1, pg_temp.uid($2 || ':be:' || c.g || ':' || j), c.id, et, CASE WHEN et IN ('email_opened','search_alert_opened') THEN 'signal' ELSE 'fact' END,
           CASE WHEN et IN ('listing_saved','listing_viewed') THEN pg_temp.uid($2 || ':listing:' || (1 + pg_temp.ri(c.g * 50 + j, ${salt(130)}, ${nListings}))) END,
           'idx_website', ts, ts, 'load:' || c.g || ':' || j, '{}'::jsonb
      FROM ld_c c CROSS JOIN LATERAL generate_series(1, 1 + pg_temp.ri(c.g, ${salt(131)}, 6)) j
      CROSS JOIN LATERAL (SELECT (ARRAY['listing_viewed','listing_viewed','listing_saved','website_visit','email_opened','email_clicked','search_alert_clicked'])
                                   [1 + pg_temp.ri(c.g * 50 + j, ${salt(132)}, 7)] AS et,
                                 pg_temp.t0() - (c.recency_s + j * 7200) * interval '1 second' AS ts) x
     WHERE pg_temp.r(c.g, ${salt(133)}) < 0.30`, [T, S]);

  // ---- consent: grants on a third of phones, then the opt-outs (D1: only opt-outs block) ------------------
  // Ledger first, projection second (the consent_state guard recounts the ledger per row).
  await step(c, log, 'consent grants (web form, sms informational)', `
    INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level, source, occurred_at, recorded_at,
                                contact_id, actor_kind, evidence)
    SELECT $1, pg_temp.uid($2 || ':cg:' || g), 'phone', hmac(convert_to(phone, 'UTF8'), $3::bytea, 'sha256'), '•••' || right(phone, 4), 'sms', 'informational', 'grant', 'express', 'web_form',
           created_at, created_at, id, 'system', '{"form":"load"}'::jsonb
      FROM ld_c WHERE has_phone AND pg_temp.r(g, ${salt(140)}) < 0.33`, [T, S, hmacKey]);
  // opt-outs: 2% of phones texted STOP (plus the inbound STOP message), 1% of emails unsubscribed,
  // 0.3% agent-recorded do-not-contact (sms + voice + email)
  await c.query(`ALTER TABLE ld_c ADD COLUMN stop boolean, ADD COLUMN unsub boolean, ADD COLUMN dnc boolean`);
  await c.query(`UPDATE ld_c SET stop = has_phone AND r_opt < 0.02, unsub = has_email AND r_opt >= 0.02 AND r_opt < 0.03, dnc = r_opt >= 0.03 AND r_opt < 0.033 AND owner IS NOT NULL`);
  await step(c, log, 'STOP messages', `
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator, opt_out_keyword,
                          provider, provider_message_ref, occurred_at, created_at, updated_at)
    SELECT $1, pg_temp.uid($2 || ':stop:' || g), pg_temp.uid($2 || ':conv:' || g), id, 'sms', 'inbound', team_phone_id, phone, team_phone, 'STOP', 'received', 'client', 'STOP',
           'fake', 'SMSTOP' || md5($2 || g), pg_temp.t0() - (recency_s - 60) * interval '1 second', pg_temp.t0() - (recency_s - 60) * interval '1 second',
           pg_temp.t0() - (recency_s - 60) * interval '1 second'
      FROM ld_c WHERE stop AND state <> 'closed'`, [T, S]);
  await step(c, log, 'opt-out ledger', `
    INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level, source, occurred_at, recorded_at,
                                contact_id, actor_kind, actor_user_id, evidence_message_id, evidence)
    SELECT $1, pg_temp.uid($2 || ':co:' || kind || ':' || g), CASE WHEN ch = 'email' THEN 'email' ELSE 'phone' END, hmac(convert_to(addr, 'UTF8'), $3::bytea, 'sha256'), '•••' || right(addr, 4),
           ch, 'all', 'revoke', 'none', src, ts, ts, id, CASE WHEN src = 'agent_revoke' THEN 'user' ELSE 'system' END, CASE WHEN src = 'agent_revoke' THEN owner END,
           CASE WHEN src = 'inbound_keyword' AND state <> 'closed' THEN pg_temp.uid($2 || ':stop:' || g) END,
           CASE WHEN src = 'agent_revoke' THEN '{"entered_by":"staff"}'::jsonb ELSE '{}'::jsonb END
      FROM (SELECT g, id, owner, state, phone AS addr, 'sms' AS ch, 'stop' AS kind, 'inbound_keyword' AS src, pg_temp.t0() - (recency_s - 60) * interval '1 second' AS ts FROM ld_c WHERE stop
            UNION ALL SELECT g, id, owner, state, email, 'email', 'unsub', 'web_form', pg_temp.t0() - (recency_s - 120) * interval '1 second' FROM ld_c WHERE unsub
            UNION ALL SELECT g, id, owner, state, phone, 'sms', 'dnc-sms', 'agent_revoke', pg_temp.t0() - interval '2 days' FROM ld_c WHERE dnc AND has_phone
            UNION ALL SELECT g, id, owner, state, phone, 'voice', 'dnc-voice', 'agent_revoke', pg_temp.t0() - interval '2 days' FROM ld_c WHERE dnc AND has_phone
            UNION ALL SELECT g, id, owner, state, email, 'email', 'dnc-email', 'agent_revoke', pg_temp.t0() - interval '2 days' FROM ld_c WHERE dnc AND has_email) x`, [T, S, hmacKey]);
  // projection: one row per (channel, purpose, address) with any ledger event; revoked wins when the
  // latest event for that purpose (or 'all') is a revoke
  await step(c, log, 'consent state', `
    INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count, computed_at)
    SELECT $1, e.channel, p.purpose, e.address_hmac,
           CASE WHEN (array_agg(e.event_type ORDER BY e.occurred_at DESC, e.id DESC))[1] = 'revoke' THEN 'revoked' ELSE 'granted' END,
           CASE WHEN (array_agg(e.event_type ORDER BY e.occurred_at DESC, e.id DESC))[1] = 'revoke' THEN 'none' ELSE 'express' END,
           (array_agg(e.id ORDER BY e.occurred_at DESC, e.id DESC))[1], count(*), pg_temp.t0()
      FROM consent_events e CROSS JOIN (VALUES ('marketing'), ('informational')) p(purpose)
     WHERE e.tenant_id = $1 AND e.purpose IN (p.purpose, 'all')
     GROUP BY e.channel, p.purpose, e.address_hmac`, [T]);
  // suppressions: hard bounces / spam complaints on emails, landlines that cannot take SMS
  await step(c, log, 'suppressions', `
    INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref, created_at)
    SELECT $1, pg_temp.uid($2 || ':sup:' || kind || ':' || g), ak, hmac(convert_to(addr, 'UTF8'), $3::bytea, 'sha256'), '•••' || right(addr, 4), ch, reason, '{}'::jsonb, pg_temp.t0() - interval '20 days'
      FROM (SELECT g, 'b' AS kind, 'email' AS ak, email AS addr, 'email' AS ch, 'hard_bounce' AS reason FROM ld_c WHERE has_email AND pg_temp.r(g, ${salt(150)}) < 0.005
            UNION ALL SELECT g, 's', 'email', email, 'email', 'spam_complaint' FROM ld_c WHERE has_email AND pg_temp.r(g, ${salt(150)}) BETWEEN 0.005 AND 0.006
            UNION ALL SELECT c.g, 'l', 'phone', p.address, 'sms', 'landline_no_sms' FROM ld_c c JOIN contact_points p ON p.tenant_id = $1 AND p.contact_id = c.id AND p.line_type = 'landline'
                       WHERE pg_temp.r(c.g, ${salt(151)}) < 0.3) x`, [T, S, hmacKey]);
  await c.query('COMMIT');
}
