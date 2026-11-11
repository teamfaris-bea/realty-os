// Migration 0016 (lane scale-250k) reorders the contacts SELECT policy and app.contact_detail_visible for
// speed. These tests prove WHO-SEES-WHAT is unchanged: for every kind of member (Owner, Admin, Team Lead,
// Agent, ISA, TC) and the system actor, over every contact of a generated tenant (owned, offered, in a
// team pond, unassigned, closed, collaborated on, on a deal) and two variants of each row (soft-deleted;
// moved by the caller's current ownership command), the pre-0016 expressions and the 0016 ones agree.
import pg from 'pg';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant');
const CMD = loadUuid(SLUG, 'ownership-command:load');

/** contacts_select as 0001 wrote it (r.* stands for the row). */
const OLD_POLICY = `(
  (SELECT app.is_tenant_wide())
  OR (r.ownership_actor_user_id = (SELECT app.user_id()) AND r.ownership_command_id = (SELECT app.ownership_command()))
  OR (r.deleted_at IS NULL AND (SELECT app.my_role()) IS NOT NULL AND (
         r.owner_user_id = (SELECT app.user_id())
      OR r.offered_to_user_id = (SELECT app.user_id())
      OR r.id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR (r.ownership_state = 'in_pond' AND r.pond_id = ANY ((SELECT app.my_pond_ids())::uuid[]))
      OR r.owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR r.offered_to_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR (r.ownership_state = 'in_pond' AND (SELECT app.my_role()) = 'team_lead')
      OR r.id = ANY ((SELECT app.my_deal_contact_ids())::uuid[]))))`;

/** contact_detail_visible as 0001 wrote it. */
const OLD_DETAIL = `CREATE FUNCTION pg_temp.old_detail(p_tenant uuid, p_contact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact
     AND (app.sees_all_detail() OR c.ownership_state NOT IN ('in_pond','offered')
          OR c.id = ANY (app.my_collab_contact_ids()) OR c.id = ANY (app.my_deal_contact_ids())))
$$`;

let db: TestDb;
let actors: { label: string; userId: string; kind: 'user' | 'system' }[] = [];

async function inContext<R>(url: string, a: (typeof actors)[number], fn: (c: pg.Client) => Promise<R>): Promise<R> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true),
                          set_config('app.principal_type', 'staff', true), set_config('app.ownership_command', $4, true)`, [T, a.userId, a.kind, CMD]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(2_000, PH);
  spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 2_000 : 200 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  const su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  const ms = (await su.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY role, user_id`, [T])).rows;
  await su.end();
  actors = [...ms.map((m, i) => ({ label: `${m.role}#${i}`, userId: m.user_id, kind: 'user' as const })), { label: 'system', userId: '', kind: 'system' }];
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

describe('0016 keeps contact visibility identical', () => {
  it('the fixture covers every role and every ownership state', async () => {
    expect(new Set(actors.map((a) => a.label.split('#')[0]))).toEqual(new Set(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc', 'system']));
    const su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
    const states = (await su.query<{ s: string }>(`SELECT DISTINCT ownership_state AS s FROM contacts WHERE tenant_id = $1`, [T])).rows.map((r) => r.s);
    const extras = (await su.query<{ collab: number; deal: number }>(`SELECT (SELECT count(*)::int FROM contact_collaborators WHERE tenant_id = $1) AS collab,
                                                                              (SELECT count(*)::int FROM deal_members WHERE tenant_id = $1) AS deal`, [T])).rows[0]!;
    await su.end();
    expect(new Set(states)).toEqual(new Set(['owned', 'in_pond', 'offered', 'unassigned', 'closed']));
    expect(extras.collab).toBeGreaterThan(0);
    expect(extras.deal).toBeGreaterThan(0);
  });

  it('R-PERM-6: the contacts SELECT policy admits exactly the rows the 0001 policy admitted, for every actor and row variant', async () => {
    const newPolicy = await (async () => {
      const su = new pg.Client({ connectionString: db.ownerUrl });
      await su.connect();
      const q = (await su.query<{ qual: string }>(`SELECT qual FROM pg_policies WHERE tablename = 'contacts' AND policyname = 'contacts_select'`)).rows[0]!.qual;
      await su.end();
      // qualify the policy's bare column names with the row alias
      return q.replace(/\b(deleted_at|owner_user_id|offered_to_user_id|ownership_actor_user_id|ownership_command_id|ownership_state|pond_id)\b/g, 'r.$1').replace(/\(id = ANY/g, '(r.id = ANY');
    })();
    expect(newPolicy).toContain('r.id = ANY');
    for (const a of actors) {
      const r = await inContext(db.ownerUrl, a, async (c) =>
        (await c.query<{ rows: number; differ: number; visible: number }>(`
          WITH r AS (
            SELECT c.id, c.ownership_state, c.owner_user_id, c.offered_to_user_id, c.pond_id, c.ownership_command_id,
                   CASE WHEN v.del THEN now() END AS deleted_at,
                   CASE WHEN v.act THEN NULLIF(current_setting('app.user_id', true), '')::uuid ELSE c.ownership_actor_user_id END AS ownership_actor_user_id
              FROM contacts c CROSS JOIN (VALUES (false, false), (true, false), (false, true), (true, true)) v(del, act)
             WHERE c.tenant_id = $1)
          SELECT count(*)::int AS rows,
                 count(*) FILTER (WHERE (${OLD_POLICY}) IS DISTINCT FROM (${newPolicy}))::int AS differ,
                 count(*) FILTER (WHERE ${newPolicy})::int AS visible
            FROM r`, [T])).rows[0]!);
      expect(r.rows, a.label).toBe(8_000);
      expect(r.differ, a.label).toBe(0);
      if (a.kind === 'user' && /^(owner|admin)/.test(a.label)) expect(r.visible, a.label).toBe(8_000);
    }
  }, 120_000);

  it('R-PERM-6: app.contact_detail_visible answers exactly as the 0001 body, through RLS as the app role', async () => {
    const seen = new Set<number>();
    for (const a of actors) {
      const r = await inContext(db.appUserUrl, a, async (c) => {
        await c.query(OLD_DETAIL);
        // every contact of the tenant (read as ids from a policy-free source) plus some of another tenant
        return (await c.query<{ n: number; differ: number; yes: number }>(`
          SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE app.contact_detail_visible(x.t, x.id) IS DISTINCT FROM pg_temp.old_detail(x.t, x.id))::int AS differ,
                 count(*) FILTER (WHERE app.contact_detail_visible(x.t, x.id))::int AS yes
            FROM unnest($1::uuid[], $2::uuid[]) AS x(t, id)`, [ids.t, ids.id])).rows[0]!;
      });
      expect(r.differ, a.label).toBe(0);
      expect(r.n).toBe(ids.id.length);
      seen.add(r.yes);
    }
    // the actors see different amounts of detail (the comparison is not vacuous)
    expect(seen.size).toBeGreaterThan(3);
  }, 300_000);
});

const ids = { t: [] as string[], id: [] as string[] };
beforeAll(async () => {
  const su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  const rows = (await su.query<{ tenant_id: string; id: string }>(
    `(SELECT tenant_id, id FROM contacts WHERE tenant_id = $1) UNION ALL (SELECT tenant_id, id FROM contacts WHERE tenant_id <> $1 ORDER BY id LIMIT 50)`, [T])).rows;
  await su.end();
  ids.t = rows.map((r) => r.tenant_id);
  ids.id = rows.map((r) => r.id);
}, 60_000);
