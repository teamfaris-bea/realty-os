// Lane perf-misses, miss #4 (TC deal visibility): the contact-children and timeline policies now read through
// app.contact_detail_row(...), an inlinable twin of app.contact_detail_visible, so the TC's deal-contact set is
// built once per statement instead of once per child row. These tests prove WHO-SEES-WHAT is unchanged.
//
// Method: for every member (Owner, Admin, Team Lead, Agent, ISA, TC) and the system actor, one transaction
// as app_user under the API's set_config context reads every row of each rewritten table through the CURRENT
// policies; then (same transaction, as the superuser) the policies are put back to their pre-change text
// (written out below, never imported from a migration file), the same reads run again through RLS as app_user,
// and the transaction is rolled back. Both reads go through the real RLS stack (tenant RESTRICTIVE policy,
// contacts_select inside the helpers, every permissive policy), so equal row sets mean equal visibility.
//
// Fixture: the generated tenant (owned, offered, team pond, unassigned, closed, collaborated, on a deal) plus
// deal-visibility variants built on contacts that have messages, calls, notes and contact points:
//   on a TC deal only through deal_contacts; only through deals.primary_contact_id; on a deal the TC left
//   (member row removed); in a pond / offered and on the TC's deal; soft-deleted and on the TC's deal; moved by
//   the caller's current ownership command; and a deal membership of the TC in ANOTHER tenant.
import pg from 'pg';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const SLUG = 'load-big';
const T = loadUuid(SLUG, 'tenant');
const CMD = loadUuid(SLUG, 'ownership-command:load');

const CHILDREN = ['contact_points', 'contact_addresses', 'contact_attributes', 'lead_inquiries', 'conversations', 'behavior_events',
  'saved_searches', 'playbook_enrollments', 'home_valuations', 'listing_contacts'] as const;

/** The USING clauses as they stood before the change (0001; loe_select as 0016 wrote it). */
const OLD_USING: { table: string; policy: string; using: string }[] = [
  ...CHILDREN.map((t) => ({ table: t, policy: 'contact_detail', using: 'app.contact_detail_visible(tenant_id, contact_id)' })),
  { table: 'messages', policy: 'messages_select', using: 'app.contact_detail_visible(tenant_id, contact_id)' },
  { table: 'calls', policy: 'calls_select', using: 'app.contact_detail_visible(tenant_id, contact_id)' },
  { table: 'notes', policy: 'notes_select', using: `
      (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id))
      OR (contact_id IS NULL AND deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))` },
  { table: 'appointments', policy: 'appointments_all', using: `
      (SELECT app.is_tenant_wide()) OR user_id = (SELECT app.user_id())
      OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id))
      OR (deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))` },
  { table: 'lead_ownership_events', policy: 'loe_select', using: `
      (SELECT app.is_tenant_wide())
      OR CASE WHEN (SELECT app.my_role()) = 'team_lead' THEN
             owner_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
          OR prev_owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
          OR offered_to_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
          OR actor_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
          OR contact_id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
          OR contact_id = ANY ((SELECT app.my_deal_contact_ids())::uuid[])
          OR app.contact_owned_by_my_team(tenant_id, contact_id)
         ELSE app.contact_detail_visible(tenant_id, contact_id) END` },
];
const TABLES = OLD_USING.map((p) => p.table);

/** contact_detail_visible as 0020 wrote it (the function is unchanged; this pins it). */
const OLD_DETAIL = `CREATE FUNCTION pg_temp.old_detail(p_tenant uuid, p_contact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact
     AND (c.ownership_state NOT IN ('in_pond','offered') OR app.sees_all_detail()
          OR c.id = ANY (app.my_collab_contact_ids()) OR c.id = ANY (app.my_deal_contact_ids())))
$$`;

type Actor = { label: string; userId: string; kind: 'user' | 'system' };
let db: TestDb;
let actors: Actor[] = [];
/** variant name -> contact id (tenant T) */
const v: Record<string, string> = {};
let tcUser = '';

async function setContext(c: pg.Client, a: Actor): Promise<void> {
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true),
                        set_config('app.principal_type', 'staff', true), set_config('app.ownership_command', $4, true)`, [T, a.userId, a.kind, CMD]);
}

/** Row keys (tableoid:ctid) of every row of each table the caller sees, read as app_user. */
async function visibleRows(c: pg.Client): Promise<Map<string, Set<string>>> {
  await c.query('SET LOCAL ROLE app_user');
  const out = new Map<string, Set<string>>();
  for (const t of TABLES) {
    const rows = (await c.query<{ k: string }>(`SELECT tableoid::text || ':' || ctid::text AS k FROM public.${t}`)).rows;
    out.set(t, new Set(rows.map((r) => r.k)));
  }
  await c.query('RESET ROLE');
  return out;
}

/** Rows (tableoid:ctid) of `table` that belong to `contactId`, read as the superuser. */
async function rowsOf(c: pg.Client, table: string, contactId: string): Promise<string[]> {
  return (await c.query<{ k: string }>(`SELECT tableoid::text || ':' || ctid::text AS k FROM public.${table} WHERE tenant_id = $1 AND contact_id = $2`, [T, contactId])).rows.map((r) => r.k);
}

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(2_000, PH);
  spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 2_000 : 200 }));
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  const su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  try {
    const ms = (await su.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY role, user_id`, [T])).rows;
    // two members per role (the per-row old policies are slow; every role is covered) plus the system actor
    // and the agent on most deals as a co-agent (the deal branch for an agent)
    const coAgent = (await su.query<{ user_id: string }>(`SELECT dm.user_id FROM deal_members dm JOIN memberships m ON m.tenant_id = dm.tenant_id AND m.user_id = dm.user_id
                                                            WHERE dm.tenant_id = $1 AND m.role = 'agent' GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`, [T])).rows[0]!.user_id;
    const sample = ms.filter((m, i) => ms.findIndex((x) => x.role === m.role) === i || ms.findLastIndex((x) => x.role === m.role) === i || m.user_id === coAgent);
    actors = [...sample.map((m, i) => ({ label: `${m.role}#${i}`, userId: m.user_id, kind: 'user' as const })), { label: 'system', userId: '', kind: 'system' }];
    tcUser = ms.find((m) => m.role === 'tc')!.user_id;
    const agent = ms.find((m) => m.role === 'agent')!.user_id;

    // the variants are written directly (triggers and FK checks off): they are visibility shapes, not workflows
    await su.query('BEGIN');
    await su.query(`SET LOCAL session_replication_role = replica`);
    // contacts with messages and contact points (calls and notes where the generator wrote some; the
    // variant test requires each of the four tables to be covered by at least one variant)
    const rich = `EXISTS (SELECT 1 FROM messages x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id)
              AND EXISTS (SELECT 1 FROM contact_points x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id)`;
    const richer = `(EXISTS (SELECT 1 FROM calls x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id)
               OR EXISTS (SELECT 1 FROM notes x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id))`;
    const tcSet = `(SELECT dc.contact_id FROM deal_contacts dc JOIN deal_members dm ON dm.tenant_id = dc.tenant_id AND dm.deal_id = dc.deal_id
                     WHERE dc.tenant_id = $1 AND dm.user_id = $2
                    UNION SELECT d.primary_contact_id FROM deals d JOIN deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
                     WHERE d.tenant_id = $1 AND dm.user_id = $2
                    UNION SELECT k.contact_id FROM contact_collaborators k WHERE k.tenant_id = $1 AND k.user_id = $2)`;
    const pick = async (where: string, n: number, needRich = true): Promise<string[]> =>
      (await su.query<{ id: string }>(`SELECT c.id FROM contacts c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND ${needRich ? rich : 'true'}
                                          AND c.id NOT IN ${tcSet} AND ${where} ORDER BY ${richer} DESC, c.id LIMIT ${n}`, [T, tcUser])).rows.map((r) => r.id);
    // TC deals whose primary contact is on no other TC deal and has rich children
    const deals = (await su.query<{ id: string; primary_contact_id: string }>(`
      SELECT d.id, d.primary_contact_id FROM deals d JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id
       WHERE d.tenant_id = $1 AND c.deleted_at IS NULL AND c.ownership_state = 'owned' AND ${rich}
         AND EXISTS (SELECT 1 FROM deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id AND dm.user_id = $2)
         AND (SELECT count(*) FROM deals d2 JOIN deal_members m2 ON m2.tenant_id = d2.tenant_id AND m2.deal_id = d2.id AND m2.user_id = $2
               WHERE d2.tenant_id = d.tenant_id AND d2.primary_contact_id = d.primary_contact_id) = 1
         AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.contact_id = d.primary_contact_id AND dc.deal_id <> d.id)
         AND NOT EXISTS (SELECT 1 FROM contact_collaborators k WHERE k.tenant_id = d.tenant_id AND k.contact_id = d.primary_contact_id AND k.user_id = $2)
       ORDER BY ${richer} DESC, d.id LIMIT 4`, [T, tcUser])).rows;
    if (deals.length < 4) throw new Error(`fixture: only ${deals.length} usable TC deals`);
    const [d1, d2, d3, d4] = deals as [typeof deals[0], typeof deals[0], typeof deals[0], typeof deals[0]];
    v.primaryOnTcDeal = d1.primary_contact_id;
    // on the TC's deal only through deals.primary_contact_id (its deal_contacts row removed)
    await su.query(`DELETE FROM deal_contacts WHERE tenant_id = $1 AND deal_id = $2 AND contact_id = $3`, [T, d2.id, d2.primary_contact_id]);
    v.primaryOnly = d2.primary_contact_id;
    // a deal the TC left
    await su.query(`DELETE FROM deal_members WHERE tenant_id = $1 AND deal_id = $2 AND user_id = $3`, [T, d3.id, tcUser]);
    v.leftDeal = d3.primary_contact_id;
    // soft-deleted contact on the TC's deal
    await su.query(`UPDATE contacts SET ownership_state = 'closed', closed_reason = 'deleted', owner_user_id = NULL, owned_at = NULL,
                           first_touch_due_at = NULL, first_touch_at = NULL, first_touch_breached_at = NULL, release_due_at = NULL,
                           inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = NULL,
                           deleted_at = now(), purge_after = now() + interval '30 days'
                     WHERE tenant_id = $1 AND id = $2`, [T, d4.primary_contact_id]);
    v.deletedOnTcDeal = d4.primary_contact_id;
    // on the TC's deal only through deal_contacts (not the primary), in every ownership state that matters
    for (const [name, where] of [['dealContactsOnly', `c.ownership_state = 'owned'`], ['pondOnTcDeal', `c.ownership_state = 'in_pond'`],
      ['offeredOnTcDeal', `c.ownership_state = 'offered'`], ['closedOnTcDeal', `c.ownership_state = 'closed'`]] as const) {
      // closed contacts may have no children in the generated data: compared by visibility only
      const [id] = await pick(where, 1, name !== 'closedOnTcDeal');
      if (!id) throw new Error(`fixture: no ${name} candidate`);
      await su.query(`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES ($1, $2, $3, 'other')`, [T, d1.id, id]);
      v[name] = id;
    }
    // a pond contact NOT on any TC deal (card-only for pond members, invisible to the TC)
    v.pondNotOnDeal = (await pick(`c.ownership_state = 'in_pond'`, 2))[1]!;
    // moved by the caller's current ownership command (TC, and an agent), not otherwise visible to them
    const [movedTc, movedAgent] = await pick(`c.ownership_state = 'owned' AND c.owner_user_id <> '${agent}'`, 2);
    await su.query(`UPDATE contacts SET ownership_actor_user_id = $2, ownership_command_id = $3 WHERE tenant_id = $1 AND id = $4`, [T, tcUser, CMD, movedTc]);
    await su.query(`UPDATE contacts SET ownership_actor_user_id = $2, ownership_command_id = $3 WHERE tenant_id = $1 AND id = $4`, [T, agent, CMD, movedAgent]);
    v.movedByTc = movedTc!;
    v.movedByAgent = movedAgent!;
    // every variant gets a call and a note (copies of a generated row, re-pointed), so each child table is
    // checked on visible and hidden variants alike
    for (const id of Object.values(v)) {
      await su.query(`INSERT INTO calls SELECT (jsonb_populate_record(NULL::calls, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(),
                        'contact_id', $2::uuid, 'provider_call_ref', NULL))).* FROM (SELECT * FROM calls WHERE tenant_id = $1 ORDER BY id LIMIT 1) x`, [T, id]);
      await su.query(`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, pinned, source, created_at, updated_at)
                        SELECT tenant_id, gen_random_uuid(), $2, author_user_id, body, pinned, source, created_at, updated_at
                          FROM notes WHERE tenant_id = $1 AND contact_id IS NOT NULL ORDER BY id LIMIT 1`, [T, id]);
    }
    // the TC as a member of a deal in ANOTHER tenant (must never widen what the TC sees in this tenant)
    const other = (await su.query<{ tenant_id: string; id: string }>(`SELECT tenant_id, id FROM deals WHERE tenant_id <> $1 ORDER BY id LIMIT 3`, [T])).rows;
    for (const d of other) await su.query(`INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES ($1, $2, $3, 'tc') ON CONFLICT DO NOTHING`, [d.tenant_id, d.id, tcUser]);
    await su.query('COMMIT');
  } finally {
    await su.end();
  }
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

describe('deal visibility once per statement: contact-children and timeline policies keep visibility identical', () => {
  it('the fixture covers every role, every ownership state and every deal variant', async () => {
    expect(new Set(actors.map((a) => a.label.split('#')[0]))).toEqual(new Set(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc', 'system']));
    expect(Object.keys(v).sort()).toEqual(['closedOnTcDeal', 'dealContactsOnly', 'deletedOnTcDeal', 'leftDeal', 'movedByAgent', 'movedByTc',
      'offeredOnTcDeal', 'pondNotOnDeal', 'pondOnTcDeal', 'primaryOnTcDeal', 'primaryOnly'].sort());
    const su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
    try {
      const states = (await su.query<{ s: string }>(`SELECT DISTINCT ownership_state AS s FROM contacts WHERE tenant_id = $1`, [T])).rows.map((r) => r.s);
      expect(new Set(states)).toEqual(new Set(['owned', 'in_pond', 'offered', 'unassigned', 'closed']));
      // the rewritten policies are exactly the listed ones, each reading through the helper
      const pol = (await su.query<{ tablename: string; policyname: string; qual: string; with_check: string | null }>(
        `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND qual LIKE '%contact_detail_row%'`)).rows;
      expect(pol.map((p) => `${p.tablename}.${p.policyname}`).sort()).toEqual(OLD_USING.map((p) => `${p.table}.${p.policy}`).sort());
      for (const p of pol) expect(p.qual, p.policyname).not.toContain('contact_detail_visible');
      // every table in the comparison has rows in this tenant for the non-vacuous ones
      for (const t of ['messages', 'calls', 'notes', 'contact_points', 'lead_ownership_events', 'appointments', 'behavior_events', 'lead_inquiries']) {
        const n = (await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [T])).rows[0]!.n;
        expect(n, t).toBeGreaterThan(0);
      }
    } finally {
      await su.end();
    }
  });

  it('every actor sees exactly the same rows of every rewritten table through the old and the new policies', async () => {
    const seen = new Set<number>();
    for (const a of actors) {
      const su = new pg.Client({ connectionString: db.ownerUrl });
      await su.connect();
      try {
        await su.query('BEGIN');
        await setContext(su, a);
        const now = await visibleRows(su);
        for (const p of OLD_USING) await su.query(`ALTER POLICY ${p.policy} ON public.${p.table} USING (${p.using})`);
        const before = await visibleRows(su);
        let total = 0;
        for (const t of TABLES) {
          const n = now.get(t)!;
          const o = before.get(t)!;
          const onlyNew = [...n].filter((k) => !o.has(k));
          const onlyOld = [...o].filter((k) => !n.has(k));
          expect({ actor: a.label, table: t, onlyNew: onlyNew.length, onlyOld: onlyOld.length }).toEqual({ actor: a.label, table: t, onlyNew: 0, onlyOld: 0 });
          total += n.size;
        }
        seen.add(total);
      } finally {
        await su.query('ROLLBACK').catch(() => undefined);
        await su.end();
      }
    }
    // the actors see different amounts (the comparison is not vacuous)
    expect(seen.size).toBeGreaterThan(3);
  }, 1_200_000);

  it('the TC sees the children of its deal contacts, and only those, in every variant', async () => {
    const expected: Record<string, boolean> = {
      primaryOnTcDeal: true, primaryOnly: true, dealContactsOnly: true, pondOnTcDeal: true, offeredOnTcDeal: true, closedOnTcDeal: true,
      movedByTc: true, leftDeal: false, deletedOnTcDeal: false, pondNotOnDeal: false, movedByAgent: false,
    };
    const su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
    try {
      await su.query('BEGIN');
      await setContext(su, { label: 'tc', userId: tcUser, kind: 'user' });
      const vis = await visibleRows(su);
      const covered = new Map<string, Set<boolean>>();
      for (const [name, want] of Object.entries(expected)) {
        for (const t of ['messages', 'calls', 'notes', 'contact_points']) {
          const rows = await rowsOf(su, t, v[name]!);
          if ((t === 'messages' || t === 'contact_points') && name !== 'closedOnTcDeal') expect(rows.length, `${name} ${t}`).toBeGreaterThan(0);
          if (rows.length > 0) covered.set(t, (covered.get(t) ?? new Set()).add(want));
          expect({ name, t, visible: rows.filter((k) => vis.get(t)!.has(k)).length }).toEqual({ name, t, visible: want ? rows.length : 0 });
        }
      }
      // each child table is checked on at least one visible and one hidden deal variant
      for (const t of ['messages', 'calls', 'notes', 'contact_points']) expect([...(covered.get(t) ?? [])].sort(), t).toEqual([false, true]);
      // nothing of another tenant, although the TC is a member of deals there
      await su.query('SET LOCAL ROLE app_user');
      const foreign = (await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE tenant_id <> $1`, [T])).rows[0]!.n;
      expect(foreign).toBe(0);
    } finally {
      await su.query('ROLLBACK').catch(() => undefined);
      await su.end();
    }
  }, 120_000);

  it('EXISTS over app.contact_detail_row equals app.contact_detail_visible (and the 0020 body) for every actor and contact', async () => {
    const su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
    const ids = (await su.query<{ t: string; id: string }>(
      `(SELECT tenant_id AS t, id FROM contacts WHERE tenant_id = $1) UNION ALL (SELECT tenant_id, id FROM contacts WHERE tenant_id <> $1 ORDER BY id LIMIT 50)`, [T])).rows;
    await su.end();
    for (const a of actors) {
      const c = new pg.Client({ connectionString: db.appUserUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await setContext(c, a);
        await c.query(OLD_DETAIL);
        const r = (await c.query<{ n: number; differ: number; differ_old: number }>(`
          SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.contact_detail_row(x.t, x.id)) IS DISTINCT FROM app.contact_detail_visible(x.t, x.id))::int AS differ,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.contact_detail_row(x.t, x.id)) IS DISTINCT FROM pg_temp.old_detail(x.t, x.id))::int AS differ_old
            FROM unnest($1::uuid[], $2::uuid[]) AS x(t, id)`, [ids.map((i) => i.t), ids.map((i) => i.id)])).rows[0]!;
        expect(r.n).toBe(ids.length);
        expect({ actor: a.label, differ: r.differ, differOld: r.differ_old }).toEqual({ actor: a.label, differ: 0, differOld: 0 });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    }
  }, 300_000);
});
