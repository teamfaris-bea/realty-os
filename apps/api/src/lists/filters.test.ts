// Lane people-filters: exclusions ("is not") and the filter builder's catalogs, against real Postgres as
// app_user under FORCE RLS (E194-E200). The SQL run of every definition below equals the plain in-memory
// reference evaluator (core lists/testing/evaluate.ts) over the people the viewer may see in detail, for
// every role, including NULL values, a merged-away and an erased contact, team and personal lists.
import { randomUUID } from 'node:crypto';
import { type RefPerson, refEvaluate } from '@realty/core/parity/lists/testing';
import { type ListPredicate, SmartListDefinitionSchema } from '@realty/core/parity/lists';
import { withTenantTx } from '@realty/db';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, type TestClient } from '../auth/testHarness.js';
import { predicateSql } from './repos/people.js';
import { call, createContact, freshReauth, listsWorld, type ListsWorld, makeTag, runAll, tagContact } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let other: ListsWorld;
let zillow: string;
let website: string;
let dnc: { id: string };
let buyer: { id: string };
let merged: string;
let erased: string;

async function source(tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, $3, 'portal')`, [tenantId, id, name]);
  return id;
}

/** The people the viewer may see in detail (app.contact_detail_visible, live), as reference rows read by the superuser. */
async function visibleRows(c: TestClient): Promise<RefPerson[]> {
  const ids = await withTenantTx(c.actor(), async (tx) => {
    const r = await sql<{ id: string }>`SELECT c.id FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL
      AND c.merged_into_contact_id IS NULL AND app.contact_detail_visible(c.tenant_id, c.id) ORDER BY c.id`.execute(tx);
    return r.rows.map((x) => x.id);
  }, { db: h.database });
  const r = await h.su.query<{ id: string; display_name: string; stage: string; intent: string | null; contact_type: string; source: string | null; owner: string | null; tags: string[]; act: Date | null; created_at: Date }>(
    `SELECT c.id, c.display_name, c.stage, c.intent, c.contact_type, c.original_lead_source_id AS source, c.owner_user_id AS owner,
            COALESCE((SELECT array_agg(ct.tag_id::text) FROM contact_tags ct WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id), '{}') AS tags,
            GREATEST(c.last_human_touch_at, c.last_inbound_at) AS act, c.created_at
       FROM contacts c WHERE c.id = ANY ($1::uuid[]) ORDER BY c.id`, [ids]);
  return r.rows.map((x) => ({ id: x.id, displayName: x.display_name, stage: x.stage, intent: x.intent, contactType: x.contact_type, sourceId: x.source, ownerId: x.owner, tagIds: x.tags, lastActivityMs: x.act ? x.act.getTime() : null, createdMs: x.created_at.getTime() }));
}

const DEFS = (): { name: string; def: unknown }[] => [
  { name: 'everyone except closed and lost', def: { v: 1, all: [{ kind: 'stage', not_in: ['closed', 'lost'] }] } },
  { name: 'source is not Zillow', def: { v: 1, all: [{ kind: 'source', not_in: [zillow] }] } },
  { name: 'source is Zillow', def: { v: 1, all: [{ kind: 'source', in: [zillow] }] } },
  { name: 'owner is not agent A', def: { v: 1, all: [{ kind: 'owner', not_in: [w.agentA.userId] }] } },
  { name: 'owner is not A or B', def: { v: 1, all: [{ kind: 'owner', not_in: [w.agentA.userId, w.agentB.userId] }] } },
  { name: 'intent is not buyer', def: { v: 1, all: [{ kind: 'intent', not_in: ['buyer'] }] } },
  { name: 'contact type is not sphere', def: { v: 1, all: [{ kind: 'contact_type', not_in: ['sphere'] }] } },
  { name: 'tags none of DNC and stage active, nurture', def: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [dnc.id] }, { kind: 'stage', in: ['active', 'nurture'] }] } },
  { name: 'three filters', def: { v: 1, all: [{ kind: 'stage', not_in: ['lost'] }, { kind: 'source', not_in: [website] }, { kind: 'tag', op: 'none', tagIds: [dnc.id] }] } },
  { name: 'match any of: exclusion or tag', def: { v: 1, all: [{ kind: 'contact_type', not_in: ['vendor'] }], any: [{ kind: 'source', not_in: [zillow, website] }, { kind: 'tag', op: 'any', tagIds: [buyer.id] }] } },
  { name: 'name search inside exclusions (personal)', def: { v: 1, all: [{ kind: 'name', contains: 'able' }, { kind: 'stage', not_in: ['new'] }] } },
  { name: 'new Zillow leads nobody has called', def: { v: 1, all: [{ kind: 'source', in: [zillow] }, { kind: 'last_activity', op: 'never' }, { kind: 'created', op: 'within_days', days: 7 }] } },
];

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 6 });
  other = await listsWorld(h, { perAgent: 1 });
  zillow = await source(w.tenantId, 'Zillow');
  website = await source(w.tenantId, 'Website');
  dnc = await makeTag(w.agentA, 'DNC');
  buyer = await makeTag(w.agentA, 'Buyer');
  const [a0, a1, a2, a3, a4, a5] = w.aContacts as [string, string, string, string, string, string];
  const [b0, b1, b2] = w.bContacts as [string, string, string];
  const set = (id: string, cols: string, values: unknown[]) => h.su.query(`UPDATE contacts SET ${cols} WHERE id = $1`, [id, ...values]);
  await set(a0, `stage = 'active', original_lead_source_id = $2, intent = 'buyer'`, [zillow]);
  await set(a1, `stage = 'closed', original_lead_source_id = $2, intent = 'seller', contact_type = 'sphere'`, [website]);
  await set(a2, `stage = 'nurture', original_lead_source_id = NULL, intent = NULL`, []);
  await set(a3, `stage = 'lost', original_lead_source_id = $2, contact_type = 'vendor'`, [zillow]);
  await set(a4, `stage = 'active', intent = 'investor', last_human_touch_at = now() - interval '2 days'`, []);
  await set(a5, `stage = 'nurture', original_lead_source_id = $2`, [website]);
  await set(b0, `stage = 'active', original_lead_source_id = $2, intent = 'buyer'`, [zillow]);
  await set(b1, `stage = 'lost', contact_type = 'sphere'`, []);
  await set(b2, `stage = 'nurture', original_lead_source_id = $2`, [website]);
  // the pond lead: no owner, and the intake's own source (Owner, Admin and the Team Lead see its detail; agents see only its card)
  for (const id of [a0, a4]) await tagContact(w.agentA, id, [dnc.id]);
  for (const id of [a2, a5]) await tagContact(w.agentA, id, [buyer.id]);
  await tagContact(w.agentB, b2, [dnc.id]);
  await tagContact(w.owner, w.pondContact, [buyer.id]);
  // a merged-away and an erased person of agent A that would match every exclusion
  merged = await createContact(w.agentA, 'Alice Able Merged');
  erased = await createContact(w.agentA, 'Alice Able Erased');
  await set(merged, `merged_into_contact_id = $2, stage = 'active'`, [a0]);
  await set(erased, `stage = 'active'`, []);
  await freshReauth(h, w.owner);
  const er = await call(w.owner, 'POST', `/contacts/${erased}/erase`, { reason: 'PRIVACY_REQUEST' });
  if (er.status !== 200) throw new Error(`erase: ${er.status} ${JSON.stringify(er.body)}`);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('exclusions run under the viewer\'s RLS (lane people-filters)', () => {
  it('E194 E195 E196 E197 R-PAR-28: every definition equals the reference evaluator over the people each role may see in detail (NULLs kept by "is not"; merged and erased never)', async () => {
    const roles = [w.owner, w.admin, w.lead, w.agentA, w.agentB, w.isa, w.tc];
    const ctxNow = Date.now();
    for (const c of roles) {
      const rows = await visibleRows(c);
      for (const d of DEFS()) {
        const def = SmartListDefinitionSchema.parse(d.def);
        const got = (await runAll(c, d.def)).sort();
        const want = refEvaluate(def, rows, { meId: c.userId!, nowMs: ctxNow }).sort();
        expect(got, `${c.role} · ${d.name}`).toEqual(want);
        expect(got).not.toContain(merged);
        expect(got).not.toContain(erased);
        const n = await call<{ count: number }>(c, 'POST', '/people/count', { definition: d.def });
        expect(n.body.count, `${c.role} · ${d.name} count`).toBe(want.length);
      }
    }
  });

  it('E195: "source is not Zillow" includes people with no source; E197: "owner is not agent A" includes the unassigned pond lead for the Owner', async () => {
    const [a0, , a2, a3] = w.aContacts;
    const notZ = await runAll(w.agentA, { v: 1, all: [{ kind: 'source', not_in: [zillow] }] });
    expect(notZ).toContain(a2); // no source
    expect(notZ).not.toContain(a0);
    expect(notZ).not.toContain(a3);
    const notA = await runAll(w.owner, { v: 1, all: [{ kind: 'owner', not_in: [w.agentA.userId] }] });
    expect(notA).toContain(w.pondContact);
    expect(notA).toEqual(expect.arrayContaining(w.bContacts));
    expect(notA.filter((x) => w.aContacts.includes(x))).toEqual([]);
  });

  it('E194: "is" and "is not" partition what a viewer sees (SQL), for each exclusion kind', async () => {
    const pairs: [unknown, unknown][] = [
      [{ kind: 'stage', in: ['lost', 'closed'] }, { kind: 'stage', not_in: ['lost', 'closed'] }],
      [{ kind: 'source', in: [zillow] }, { kind: 'source', not_in: [zillow] }],
      [{ kind: 'owner', in: [w.agentB.userId] }, { kind: 'owner', not_in: [w.agentB.userId] }],
      [{ kind: 'intent', in: ['buyer', 'investor'] }, { kind: 'intent', not_in: ['buyer', 'investor'] }],
      [{ kind: 'contact_type', in: ['sphere'] }, { kind: 'contact_type', not_in: ['sphere'] }],
    ];
    for (const c of [w.owner, w.lead, w.agentA]) {
      const everyone = (await runAll(c, { v: 1 })).sort();
      for (const [pos, neg] of pairs) {
        const p = await runAll(c, { v: 1, all: [pos] });
        const n = await runAll(c, { v: 1, all: [neg] });
        expect([...p, ...n].sort(), JSON.stringify(neg)).toEqual(everyone);
      }
    }
  });

  it('E199 R-PAR-28: an agent never sees a person outside their visibility through any filter; counts of another agent\'s book read 0', async () => {
    const book = new Set(await runAll(w.agentA, { v: 1 }));
    for (const d of DEFS()) for (const id of await runAll(w.agentA, d.def)) expect(book.has(id), d.name).toBe(true);
    // "Owner is B", "Owner is not me", "source is Zillow": B's people and the pond lead stay invisible
    for (const def of [
      { v: 1, all: [{ kind: 'owner', in: [w.agentB.userId] }] },
      { v: 1, all: [{ kind: 'owner', not_in: [w.agentA.userId] }] },
      { v: 1, all: [{ kind: 'source', in: [zillow] }, { kind: 'owner', not_in: [w.agentA.userId] }] },
    ]) {
      expect(await runAll(w.agentA, def), JSON.stringify(def)).toEqual([]);
      expect((await call<{ count: number }>(w.agentA, 'POST', '/people/count', { definition: def })).body.count).toBe(0);
    }
  });

  it('E199: ids of another tenant in a definition match nobody there and leak nothing (cross-tenant)', async () => {
    const foreignSource = await source(other.tenantId, 'Zillow');
    const mine = (await runAll(w.owner, { v: 1 })).sort();
    expect(await runAll(w.owner, { v: 1, all: [{ kind: 'source', in: [foreignSource] }] })).toEqual([]);
    expect(await runAll(w.owner, { v: 1, all: [{ kind: 'owner', in: [other.owner.userId] }] })).toEqual([]);
    // an exclusion of a foreign id excludes nobody (every person here is "not" that source / owner) and never adds a foreign row
    expect((await runAll(w.owner, { v: 1, all: [{ kind: 'source', not_in: [foreignSource] }] })).sort()).toEqual(mine);
    expect((await runAll(w.owner, { v: 1, all: [{ kind: 'owner', not_in: [other.owner.userId] }] })).sort()).toEqual(mine);
    for (const id of await runAll(other.owner, { v: 1, all: [{ kind: 'source', not_in: [zillow] }] })) expect(mine).not.toContain(id);
  });

  it('E200 R-PAR-27: a saved team list of exclusions runs per viewer; a team list holding a name search is refused in plain words; personal is allowed', async () => {
    const def = { v: 1, all: [{ kind: 'stage', not_in: ['closed', 'lost'] }, { kind: 'tag', op: 'none', tagIds: [dnc.id] }] };
    const team = await call<{ list: { id: string; definition: unknown } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Everyone open, no DNC', definition: def });
    expect(team.status).toBe(201);
    const viaList = async (c: TestClient) => {
      const out: string[] = [];
      let cursor: string | null = null;
      do {
        const r: { body: { people: { id: string }[]; nextCursor: string | null } } = await call(c, 'GET', `/people?list=${team.body.list.id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        out.push(...r.body.people.map((p) => p.id));
        cursor = r.body.nextCursor;
      } while (cursor);
      return out.sort();
    };
    for (const c of [w.owner, w.lead, w.agentA, w.agentB, w.isa]) expect(await viaList(c), c.role!).toEqual((await runAll(c, def)).sort());
    const withText = { v: 1, all: [{ kind: 'name', contains: 'jane' }, { kind: 'stage', in: ['active', 'nurture'] }] };
    const refused = await call(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Jane buyers', definition: withText });
    expect(refused.status).toBe(422);
    expect(refused.code).toBe('LIST_FREE_TEXT_IN_TEAM_LIST');
    // PATCH of a team list's filters is held to the same rule
    const patched = await call(w.lead, 'PATCH', `/smart-lists/${team.body.list.id}`, { definition: withText });
    expect(patched.code).toBe('LIST_FREE_TEXT_IN_TEAM_LIST');
    const ok = await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Jane buyers', definition: withText });
    expect(ok.status).toBe(201);
    // "Edit filters" of a personal list: PATCH the definition, the list runs the new one
    const edited = await call(w.agentA, 'PATCH', `/smart-lists/${ok.body.list.id}`, { definition: { v: 1, all: [{ kind: 'stage', not_in: ['lost'] }] } });
    expect(edited.status).toBe(200);
    // an agent may not create or edit a team list at all
    expect((await call(w.agentA, 'POST', '/smart-lists', { scope: 'team', name: 'x', definition: def })).status).toBe(404);
    expect((await call(w.agentA, 'PATCH', `/smart-lists/${team.body.list.id}`, { definition: def })).status).toBe(404);
  });

  it('E198: an invalid or too-large filter is a 4xx with a code, never a 500', async () => {
    const bad: unknown[] = [
      { v: 1, all: [{ kind: 'stage', in: ['new'], not_in: ['lost'] }] },
      { v: 1, all: [{ kind: 'source', not_in: ['zillow'] }] },
      { v: 1, all: [{ kind: 'owner', not_in: [] }] },
      { v: 1, all: Array(21).fill({ kind: 'stage', not_in: ['lost'] }) },
      { v: 1, all: Array.from({ length: 20 }, () => ({ kind: 'source', not_in: Array.from({ length: 50 }, () => randomUUID()) })) },
    ];
    for (const def of bad) {
      for (const path of ['/people/query', '/people/count']) {
        const r = await call(w.agentA, 'POST', path, { definition: def });
        expect(r.status, `${path} ${JSON.stringify(def).slice(0, 80)}`).toBe(422);
        expect(['LIST_DEFINITION_INVALID', 'LIST_DEFINITION_TOO_LARGE']).toContain(r.code);
      }
    }
  });

  it('E199: the filter options are the tenant\'s own sources and members, names only, for every role; never another tenant\'s', async () => {
    for (const c of [w.owner, w.lead, w.agentA, w.isa, w.tc]) {
      const r = await call<{ sources: { id: string; name: string }[]; members: { userId: string; name: string }[] }>(c, 'GET', '/people/filter-options');
      expect(r.status, c.role!).toBe(200);
      expect(r.body.sources.map((s) => s.id)).toEqual(expect.arrayContaining([zillow, website]));
      expect(r.body.members.map((m) => m.userId)).toEqual(expect.arrayContaining([w.owner.userId, w.agentA.userId, w.agentB.userId]));
      expect(r.body.members.map((m) => m.userId)).not.toContain(other.owner.userId);
      expect(JSON.stringify(r.body)).not.toMatch(/token|hash|@|\+1/);
    }
  });
});

// compile-only Kysely (never connects)
const compileOnly = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: { connect: () => Promise.reject(new Error('no db')), end: async () => {} } as never }) });

describe('exclusion SQL is whitelisted (lane people-filters)', () => {
  it('E198: input values only ever reach the SQL as bound parameters', () => {
    const evil = "00000000-0000-4000-8000-000000000001'; DROP TABLE contacts; --";
    for (const n of [
      { p: 'stage_not_in', stages: [evil] },
      { p: 'source_not_in', sourceIds: [evil] },
      { p: 'owner_not_in', userIds: [evil] },
      { p: 'intent_not_in', intents: [evil] },
      { p: 'contact_type_not_in', types: [evil] },
    ] satisfies ListPredicate[]) {
      const q = predicateSql(n).compile(compileOnly);
      expect(q.sql).not.toContain('DROP');
      expect(q.parameters).toContainEqual([evil]);
    }
  });
});
