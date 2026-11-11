// Lane perf-misses-2 (migration helper_plan_cache): twelve RLS helpers moved from LANGUAGE sql to LANGUAGE
// plpgsql with the same query, so their plans are cached for the session instead of re-planned in every
// statement. This proves every helper returns exactly what its previous SQL body returns:
//   * the previous bodies are written out below (never imported from a migration) as temporary SQL functions,
//     their nested helper calls pointing at the other previous bodies, definer ones as SECURITY DEFINER with
//     the same pinned search_path (owned by the superuser, which like app_definer bypasses RLS), invoker ones
//     as invokers;
//   * every request context: each role (two members where the tenant has two), the system actor, support
//     without and with a live grant, a client (portal) principal, and an agent whose current ownership command
//     moved a contact (contacts_select's command branch);
//   * the per-contact helpers on every contact of the tenant (every ownership state, collaborated, on deals,
//     soft-deleted, moved by the command) and on contacts of another tenant, deal_visible on every deal;
//   * all contexts interleaved on ONE connection for several rounds, so the plpgsql plan cache is reused
//     across tenants' users, roles and actor kinds, past its switch from custom to generic plans (after five
//     executions; the per-contact calls run thousands of times per statement).
import pg from 'pg';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EqActor, enterAs, equivalenceActors, leave } from './equivalenceActors.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant');
const CMD = loadUuid(SLUG, 'ownership-command:helper-eq');
const ROUNDS = 6;

const DEF = 'LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public';
const INV = 'LANGUAGE sql STABLE';
/** The SQL bodies as they stood before the change (0001/0020/0021), nested calls to the old twins. */
const OLD: { name: string; args: string; returns: string; lang: string; body: string }[] = [
  { name: 'my_role', args: '', returns: 'text', lang: DEF, body: `
  SELECT m.role FROM public.memberships m
   WHERE m.tenant_id = app.tenant_id() AND m.user_id = app.user_id()
     AND m.status = 'active' AND app.actor_kind() = 'user'
     AND app.principal_type() = 'staff'` },
  { name: 'is_tenant_wide', args: '', returns: 'boolean', lang: DEF, body: `
  SELECT COALESCE(
    app.principal_type() = 'staff' AND app.tenant_id() IS NOT NULL AND (
         app.actor_kind() = 'system'
      OR pg_temp.old_my_role() IN ('owner','admin')
      OR (app.actor_kind() = 'support' AND EXISTS (
            SELECT 1 FROM public.support_access_grants g
             WHERE g.tenant_id = app.tenant_id() AND g.support_user_id = app.user_id()
               AND g.revoked_at IS NULL AND g.expires_at > now()))),
    false)` },
  { name: 'is_member', args: '', returns: 'boolean', lang: DEF, body: `SELECT pg_temp.old_my_role() IS NOT NULL OR pg_temp.old_is_tenant_wide()` },
  { name: 'sees_all_detail', args: '', returns: 'boolean', lang: DEF, body: `SELECT pg_temp.old_is_tenant_wide() OR COALESCE(pg_temp.old_my_role() = 'team_lead', false)` },
  { name: 'my_team_member_ids', args: '', returns: 'uuid[]', lang: DEF, body: `
  SELECT COALESCE(array_agg(DISTINCT tm.user_id), '{}')
    FROM public.team_members lead
    JOIN public.team_members tm ON tm.tenant_id = lead.tenant_id AND tm.team_id = lead.team_id
   WHERE lead.tenant_id = app.tenant_id() AND lead.user_id = app.user_id() AND lead.is_lead
     AND pg_temp.old_my_role() = 'team_lead'` },
  { name: 'my_pond_ids', args: '', returns: 'uuid[]', lang: DEF, body: `
  SELECT COALESCE(array_agg(p.id), '{}') FROM public.ponds p
   WHERE p.tenant_id = app.tenant_id() AND p.archived_at IS NULL
     AND pg_temp.old_my_role() = ANY (p.eligible_roles)
     AND (p.open_to_all OR EXISTS (SELECT 1 FROM public.pond_members pm
           WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id AND pm.user_id = app.user_id()))` },
  { name: 'my_deal_contact_ids', args: '', returns: 'uuid[]', lang: DEF, body: `
  SELECT COALESCE(array_agg(DISTINCT x.contact_id), '{}') FROM (
    SELECT dc.contact_id FROM public.deal_contacts dc
      JOIN public.deal_members dm ON dm.tenant_id = dc.tenant_id AND dm.deal_id = dc.deal_id
     WHERE dc.tenant_id = app.tenant_id() AND dm.user_id = app.user_id()
    UNION ALL
    SELECT d.primary_contact_id FROM public.deals d
      JOIN public.deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
     WHERE d.tenant_id = app.tenant_id() AND dm.user_id = app.user_id()) x
   WHERE pg_temp.old_my_role() IS NOT NULL` },
  { name: 'my_collab_contact_ids', args: '', returns: 'uuid[]', lang: DEF, body: `
  SELECT COALESCE(array_agg(k.contact_id), '{}') FROM public.contact_collaborators k
   WHERE k.tenant_id = app.tenant_id() AND k.user_id = app.user_id()
     AND k.removed_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND pg_temp.old_my_role() IS NOT NULL` },
  { name: 'contact_exists', args: 'p_tenant uuid, p_contact uuid', returns: 'boolean', lang: DEF, body: `
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.tenant_id = p_tenant AND c.id = p_contact AND p_tenant = app.tenant_id())` },
  // the invokers read through the caller's RLS; contacts_select itself calls the CURRENT helpers, which the
  // scalar comparison above proves equal to the old ones in the same context
  { name: 'contact_visible', args: 'p_tenant uuid, p_contact uuid', returns: 'boolean', lang: INV, body: `
  SELECT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact)` },
  { name: 'contact_detail_visible', args: 'p_tenant uuid, p_contact uuid', returns: 'boolean', lang: INV, body: `
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.tenant_id = p_tenant AND c.id = p_contact
       AND (c.ownership_state NOT IN ('in_pond','offered')
            OR pg_temp.old_sees_all_detail()
            OR c.id = ANY (pg_temp.old_my_collab_contact_ids())
            OR c.id = ANY (pg_temp.old_my_deal_contact_ids())))` },
  { name: 'deal_visible', args: 'p_tenant uuid, p_deal uuid', returns: 'boolean', lang: INV, body: `
  SELECT EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = p_tenant AND d.id = p_deal)` },
  { name: 'contact_owned_by_my_team', args: 'p_tenant uuid, p_contact uuid', returns: 'boolean', lang: INV, body: `
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.tenant_id = p_tenant AND c.id = p_contact
                    AND c.owner_user_id = ANY (pg_temp.old_my_team_member_ids()))` },
];
const SCALAR = ['my_role', 'is_tenant_wide', 'is_member', 'sees_all_detail'];
const ARRAYS = ['my_team_member_ids', 'my_pond_ids', 'my_deal_contact_ids', 'my_collab_contact_ids'];
const PER_CONTACT = ['contact_exists', 'contact_visible', 'contact_detail_visible', 'contact_owned_by_my_team'];

let db: TestDb;
let su: pg.Client;
let actors: EqActor[] = [];
let movedBy = '';

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(1_500, PH);
  spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 1_500 : 200 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  actors = await equivalenceActors(su, T);
  // an agent whose current ownership command moved a contact it does not own (contacts_select's command branch)
  const agent = actors.find((a) => a.label.startsWith('agent:'))!;
  // visibility shapes, not workflows: written with triggers off (as deal_visibility_equivalence.test.ts does)
  await su.query('BEGIN');
  await su.query('SET LOCAL session_replication_role = replica');
  movedBy = (await su.query<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'owned' AND owner_user_id <> $2 ORDER BY id LIMIT 1`, [T, agent.userId])).rows[0]!.id;
  await su.query(`UPDATE contacts SET ownership_actor_user_id = $2, ownership_command_id = $3 WHERE tenant_id = $1 AND id = $4`, [T, agent.userId, CMD, movedBy]);
  actors.push({ ...agent, label: `${agent.label} in its ownership command` });
  // a soft-deleted contact (the shape deal_visibility_equivalence.test.ts writes)
  await su.query(`UPDATE contacts SET ownership_state = 'closed', closed_reason = 'deleted', owner_user_id = NULL, owned_at = NULL,
                         first_touch_due_at = NULL, first_touch_at = NULL, first_touch_breached_at = NULL, release_due_at = NULL,
                         inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = NULL,
                         deleted_at = now(), purge_after = now() + interval '30 days'
                   WHERE tenant_id = $1 AND id = (SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'owned' AND id <> $2 ORDER BY id DESC LIMIT 1)`, [T, movedBy]);
  // pond and offered contacts on the TC's deal (the detail rule's deal branch), and an ISA collaborating on a pond
  // lead (its collaborator branch): the generated data has neither shape
  const tc = actors.find((a) => a.label.startsWith('tc:'))!;
  const isa = actors.find((a) => a.label.startsWith('isa:'))!;
  const tcDeal = (await su.query<{ id: string }>(`SELECT deal_id AS id FROM deal_members WHERE tenant_id = $1 AND user_id = $2 ORDER BY deal_id LIMIT 1`, [T, tc.userId])).rows[0]!.id;
  for (const st of ['in_pond', 'offered']) {
    const ids = (await su.query<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = $2 ORDER BY id LIMIT 3`, [T, st])).rows.map((r) => r.id);
    for (const id of ids) await su.query(`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES ($1, $2, $3, 'other') ON CONFLICT DO NOTHING`, [T, tcDeal, id]);
  }
  const pondLead = (await su.query<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'in_pond' ORDER BY id DESC LIMIT 1`, [T])).rows[0]!.id;
  await su.query(`INSERT INTO contact_collaborators SELECT (jsonb_populate_record(NULL::contact_collaborators, to_jsonb(k) || jsonb_build_object('contact_id', $2::uuid, 'user_id', $3::uuid,
                    'removed_at', NULL, 'expires_at', NULL))).* FROM (SELECT * FROM contact_collaborators WHERE tenant_id = $1 ORDER BY contact_id LIMIT 1) k ON CONFLICT DO NOTHING`, [T, pondLead, isa.userId]);
  await su.query('COMMIT');
  // the previous bodies, once for the session (pg_temp lives as long as the connection)
  for (const f of OLD) await su.query(`CREATE FUNCTION pg_temp.old_${f.name}(${f.args}) RETURNS ${f.returns} ${f.lang} AS $body$${f.body}$body$`);
}, 300_000);
afterAll(async () => {
  await su?.end();
  await db?.drop();
});

describe('RLS helpers in PL/pgSQL return what their SQL bodies returned (lane perf-misses-2)', () => {
  it('the helpers are plpgsql now; the fixture spans every context kind', async () => {
    const langs = (await su.query<{ proname: string; lanname: string }>(`SELECT p.proname, l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY ($1::text[])`, [OLD.map((f) => f.name)])).rows;
    expect(langs.length).toBe(OLD.length);
    for (const l of langs) expect(`${l.proname}:${l.lanname}`).toBe(`${l.proname}:plpgsql`);
    expect(actors.map((a) => a.label)).toEqual(expect.arrayContaining(['system', 'support (no grant)', 'support (grant)', 'client principal']));
  });

  it('every helper, every context, interleaved on one connection: zero differences', async () => {
    const contacts = (await su.query<{ t: string; id: string }>(
      `(SELECT tenant_id AS t, id FROM contacts WHERE tenant_id = $1) UNION ALL (SELECT tenant_id, id FROM contacts WHERE tenant_id <> $1 ORDER BY id LIMIT 50)`, [T])).rows;
    const deals = (await su.query<{ t: string; id: string }>(`SELECT tenant_id AS t, id FROM deals ORDER BY tenant_id = $1 DESC, id LIMIT 400`, [T])).rows;
    const diffs: string[] = [];
    const distinct = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      for (const a of actors) {
        await su.query('BEGIN');
        try {
          await enterAs(su, a, a.label.endsWith('ownership command') ? CMD : '');
          const scalar = (await su.query<Record<string, boolean>>(`SELECT ${[
            ...SCALAR.map((n) => `app.${n}() IS NOT DISTINCT FROM pg_temp.old_${n}() AS ${n}`),
            ...ARRAYS.map((n) => `(SELECT array_agg(x ORDER BY x) FROM unnest(app.${n}()) x) IS NOT DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(pg_temp.old_${n}()) x) AS ${n}`),
          ].join(', ')}`)).rows[0]!;
          for (const [k, ok] of Object.entries(scalar)) if (!ok) diffs.push(`${a.label} round ${round}: ${k}`);
          const r = (await su.query<Record<string, number>>(`SELECT ${PER_CONTACT.map((n) => `count(*) FILTER (WHERE app.${n}(x.t, x.id) IS DISTINCT FROM pg_temp.old_${n}(x.t, x.id))::int AS ${n}`).join(', ')},
                     string_agg(app.contact_detail_visible(x.t, x.id)::int::text, '') AS sig
                FROM unnest($1::uuid[], $2::uuid[]) AS x(t, id)`, [contacts.map((c) => c.t), contacts.map((c) => c.id)])).rows[0]!;
          for (const n of PER_CONTACT) if (r[n] !== 0) diffs.push(`${a.label} round ${round}: ${n} differs on ${r[n]} contacts`);
          distinct.add(String(r.sig));
          const d = (await su.query<{ n: number }>(`SELECT count(*) FILTER (WHERE app.deal_visible(x.t, x.id) IS DISTINCT FROM pg_temp.old_deal_visible(x.t, x.id))::int AS n
                FROM unnest($1::uuid[], $2::uuid[]) AS x(t, id)`, [deals.map((c) => c.t), deals.map((c) => c.id)])).rows[0]!.n;
          if (d !== 0) diffs.push(`${a.label} round ${round}: deal_visible differs on ${d} deals`);
          await leave(su);
        } finally {
          await su.query('ROLLBACK');
        }
      }
    }
    expect(diffs).toEqual([]);
    // the contexts see different contact sets (the comparison is not vacuous)
    expect(distinct.size).toBeGreaterThan(5);
  }, 900_000);
});
