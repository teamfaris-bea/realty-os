// Adversarial tests for api/lists (module 60, critical): tenancy, opt-outs (a tag never changes who
// can be reached), protected tags in bulk, the import writers, support read-only, idempotency.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { uuidv7Generator, instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { addContactTags, ensureFieldDef, ensureTags, removeContactTags, setFieldValue } from './index.js';
import * as catalog from './repos/catalog.js';
import { call, listsWorld, type ListsWorld, makeTag, run, runAll, tagContact } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let other: ListsWorld;
const ids = uuidv7Generator({ now: () => instant(Date.now()) }, (n) => crypto.getRandomValues(new Uint8Array(n)));

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 2 });
  other = await listsWorld(h, { perAgent: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('adversarial: tenancy (R-TEN, R-PAR-28)', () => {
  it("R-PAR-28: another team's tags, fields, lists and people are invisible: every id is a 404 or matches nobody", async () => {
    const theirTag = await makeTag(other.owner, 'Theirs');
    await tagContact(other.agentA, other.aContacts[0]!, [theirTag.id]);
    const theirField = (await call<{ field: { id: string } }>(other.owner, 'POST', '/custom-fields', { label: 'Their field', fieldType: 'text' })).body.field.id;
    const theirList = (await call<{ list: { id: string } }>(other.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Their list', definition: { v: 1 } })).body.list.id;
    expect((await tagContact(w.agentA, w.aContacts[0]!, [theirTag.id])).status).toBe(404);
    expect((await call(w.owner, 'PATCH', `/tags/${theirTag.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await call(w.owner, 'DELETE', `/tags/${theirTag.id}`)).status).toBe(404);
    const myTag = await makeTag(w.owner, 'Mine to merge');
    expect((await call(w.owner, 'POST', `/tags/${myTag.id}/merge`, { intoTagId: theirTag.id })).status).toBe(404);
    expect((await call(w.owner, 'POST', `/tags/${theirTag.id}/merge`, { intoTagId: myTag.id })).status).toBe(404);
    expect((await call(w.agentA, 'PUT', `/contacts/${w.aContacts[0]}/fields/${theirField}`, { value: 'x' })).status).toBe(404);
    expect((await call(w.owner, 'GET', `/contacts/${other.aContacts[0]}/tags`)).status).toBe(404);
    expect((await call(w.owner, 'GET', `/people?list=${theirList}`)).status).toBe(404);
    expect((await call(w.owner, 'POST', '/smart-lists', { scope: 'personal', name: 'x', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [theirTag.id] }] } })).code).toBe('LIST_TAG_UNKNOWN');
    expect((await run(w.owner, { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [theirTag.id] }] })).body.people).toEqual([]);
    expect((await run(w.owner, { v: 1, all: [{ kind: 'field', fieldId: theirField, op: 'set' }] })).code).toBe('LIST_FIELD_UNKNOWN');
    const mine = await runAll(w.owner, { v: 1 });
    expect(mine.some((id) => other.aContacts.includes(id) || other.bContacts.includes(id))).toBe(false);
    // the merge definer only ever touches the caller's tenant (and refuses a foreign tag)
    await expect(withTenantTx(w.owner.actor(), (tx) => catalog.retargetLists(tx, myTag.id, theirTag.id), { db: h.database })).rejects.toThrow(/TAG_MERGE_INVALID/);
  });

  it('R-PAR-9: the list-rewrite definer refuses anyone but an Owner/Admin user actor', async () => {
    const a = await makeTag(w.owner, 'Def A');
    const b = await makeTag(w.owner, 'Def B');
    for (const c of [w.lead, w.agentA, w.isa, w.tc]) {
      await expect(withTenantTx(c.actor(), (tx) => catalog.retargetLists(tx, a.id, b.id), { db: h.database })).rejects.toThrow(/TAG_MANAGE_REQUIRED/);
    }
    const sys: Actor = { kind: 'system', tenantId: w.tenantId as TenantId, via: 'import' };
    await expect(withTenantTx(sys, (tx) => catalog.retargetLists(tx, a.id, b.id), { db: h.database })).rejects.toThrow(/TAG_MANAGE_REQUIRED/);
  });
});

describe('adversarial: opt-outs are never a tag (D1, R-PAR-7, R-PAR-12)', () => {
  const reach = async (id: string) => ({
    person: (await h.su.query('SELECT do_not_contact_at, do_not_contact_event_id FROM contacts WHERE id = $1', [id])).rows,
    consent: (await h.su.query('SELECT channel, address_hmac, state FROM consent_state WHERE contact_id = $1 ORDER BY 1, 2', [id]).catch(() => ({ rows: [] }))).rows,
    suppressions: (await h.su.query('SELECT count(*)::int AS n FROM suppressions WHERE tenant_id = $1', [w.tenantId])).rows,
  });

  it("R-PAR-7: adding or removing tags named STOP, Opted in or Unsubscribed changes nothing about who can be reached", async () => {
    const id = w.aContacts[1]!;
    const before = await reach(id);
    const r = await call<{ added: string[]; optOutLike: string[] }>(w.agentA, 'POST', `/contacts/${id}/tags`, { names: ['STOP', 'Opted in', 'Unsubscribed'] });
    expect(r.status).toBe(200);
    expect(r.body.optOutLike).toHaveLength(2); // STOP and Unsubscribed read like an opt-out; "Opted in" does not
    expect(await reach(id)).toEqual(before);
    for (const t of r.body.added) await call(w.agentA, 'DELETE', `/contacts/${id}/tags/${t}`);
    expect(await reach(id)).toEqual(before);
  });

  it('R-PAR-7 R-PAR-12: the send-time opt-out check (core compliance, comms gate and dispatch) never reads tags', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const roots = [resolve(import.meta.dirname, '../comms'), resolve(import.meta.dirname, '../../../../packages/core/src/compliance')];
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && /contact_tags|\btags\b|parity\/tags|\/lists\//.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe('adversarial: protected tags and bulk (R-PAR-8, S7)', () => {
  it('R-PAR-8: a protected tag is never applied in bulk (the DB refuses AUDIENCE_PROTECTED_PROXY), but works one person at a time', async () => {
    const va = await makeTag(w.agentA, 'Veteran buyers');
    expect(va.protected).toBe(true);
    const bulk = withTenantTx(w.agentA.actor(), (tx) => addContactTags(tx, w.aContacts[0]!, [va.id], { kind: 'bulk', userId: w.agentA.userId! }), { db: h.database });
    await expect(bulk).rejects.toThrow(/AUDIENCE_PROTECTED_PROXY/);
    expect((await tagContact(w.agentA, w.aContacts[0]!, [va.id])).status).toBe(200);
    // an unprotected tag in bulk is fine, and the provenance says bulk
    const plain = await makeTag(w.agentA, 'Spring open house');
    await withTenantTx(w.agentA.actor(), (tx) => addContactTags(tx, w.aContacts[0]!, [plain.id], { kind: 'bulk', userId: w.agentA.userId! }), { db: h.database });
    expect((await h.su.query('SELECT added_by_kind FROM contact_tags WHERE contact_id = $1 AND tag_id = $2', [w.aContacts[0], plain.id])).rows[0].added_by_kind).toBe('bulk');
  });

  it('R-PAR-8: a writer cannot sign a link as someone else, and a bulk/user write as a TC is refused by RLS', async () => {
    const t = await makeTag(w.agentA, 'Signed');
    await expect(withTenantTx(w.agentA.actor(), (tx) => addContactTags(tx, w.aContacts[0]!, [t.id], { kind: 'user', userId: w.agentB.userId! }), { db: h.database })).rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTx(w.tc.actor(), (tx) => addContactTags(tx, w.aContacts[0]!, [t.id], { kind: 'user', userId: w.tc.userId! }), { db: h.database })).rejects.toMatchObject({ code: '42501' });
  });
});

describe('adversarial: the import writers (for module 65)', () => {
  it('R-PAR-6 R-PAR-17 R-PAR-18: as the import system actor, tags upsert first-spelling-wins, links carry the batch, protected field names are refused, fill-empty never overwrites', async () => {
    const batch = randomUUID();
    await h.su.query(`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1, $2, 'csv', 'committing', $3, repeat('a', 64))`, [w.tenantId, batch, w.owner.userId]);
    const sys: Actor = { kind: 'system', tenantId: w.tenantId as TenantId, via: 'import' };
    const res = await withTenantTx(sys, async (tx) => {
      const t = await ensureTags(tx, ids, ['Buyer', 'buyer', 'VA loan', '  ', 'New import tag'], { kind: 'import' });
      const linked = await addContactTags(tx, w.aContacts[0]!, t.tags.map((x) => x.id), { kind: 'import', importBatchId: batch });
      const protectedField = await ensureFieldDef(tx, ids, { label: 'Religion', fieldType: 'text' }, 'csv_import', null);
      const field = await ensureFieldDef(tx, ids, { label: 'Price point', fieldType: 'number', key: 'price_point' }, 'csv_import', null);
      const again = await ensureFieldDef(tx, ids, { label: 'Price point', fieldType: 'number', key: 'price_point' }, 'csv_import', null);
      if (!field.ok) throw new Error(field.code);
      const first = await setFieldValue(tx, w.aContacts[0]!, field.def, 100, { kind: 'import', importBatchId: batch });
      const second = await setFieldValue(tx, w.aContacts[0]!, field.def, 200, { kind: 'import', importBatchId: batch }, { fillEmptyOnly: true });
      const bad = await setFieldValue(tx, w.aContacts[0]!, field.def, 'abc', { kind: 'import', importBatchId: batch });
      return { t, linked, protectedField, field, again, first, second, bad };
    }, { db: h.database });
    expect(res.t.issues).toEqual([{ asked: '  ', code: 'TAG_NAME_EMPTY' }]);
    const byAsked = Object.fromEntries(res.t.tags.map((x) => [x.asked, x]));
    expect(byAsked.Buyer!.id).toBe(byAsked.buyer!.id);
    expect(byAsked['VA loan']!.protectedProxy).toBe(true);
    expect(res.protectedField).toMatchObject({ ok: false, code: 'CUSTOM_FIELD_PROTECTED' });
    expect(res.again).toMatchObject({ ok: true, created: false });
    expect([res.first, res.second, res.bad]).toEqual([{ ok: true, changed: true }, { ok: true, changed: false, skipped: 'not_empty' }, { ok: false, code: 'CUSTOM_VALUE_TYPE' }]);
    const row = await h.su.query('SELECT value_number::int AS n, updated_by_kind, import_batch_id FROM contact_field_values WHERE contact_id = $1 AND field_id = $2', [w.aContacts[0], res.field.ok && res.field.def.id]);
    expect(row.rows[0]).toEqual({ n: 100, updated_by_kind: 'import', import_batch_id: batch });
    const links = await h.su.query("SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = $1 AND added_by_kind = 'import' AND import_batch_id = $2", [w.aContacts[0], batch]);
    expect(links.rows[0].n).toBe(res.linked.added.length);
    await withTenantTx(sys, (tx) => removeContactTags(tx, w.aContacts[0]!, [byAsked['New import tag']!.id]), { db: h.database });
  });

  it('R-PAR-6: TAG_LIMIT is reported per name at 1,000 tags, and the transaction stays usable', async () => {
    await h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind) SELECT $1, gen_random_uuid(), 'Filler ' || g, 'import' FROM generate_series(1, 1000 - (SELECT count(*) FROM tags WHERE tenant_id = $1)) g`, [other.tenantId]);
    const sys: Actor = { kind: 'system', tenantId: other.tenantId as TenantId, via: 'import' };
    const res = await withTenantTx(sys, async (tx) => {
      const r = await ensureTags(tx, ids, ['Filler 1', 'One too many'], { kind: 'import' });
      const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tags`.execute(tx);
      return { r, n: n.rows[0]!.n };
    }, { db: h.database });
    expect(res.r.issues).toEqual([{ asked: 'One too many', code: 'TAG_LIMIT' }]);
    expect(res.r.tags.map((t) => t.asked)).toEqual(['Filler 1']);
    expect(res.n).toBe(1000);
    expect((await call(other.agentA, 'POST', '/tags', { name: 'Typed at the limit' })).code).toBe('TAG_LIMIT');
  });
});

describe('adversarial: idempotency and support (R-PAR-6, R-PERM-11)', () => {
  it('R-PAR-6: two members typing the same new tag at once create exactly one', async () => {
    const name = `Race ${randomUUID().slice(0, 8)}`;
    const rs = await Promise.all([w.agentA, w.agentB, w.lead, w.isa].map((c) => call<{ tag: { id: string } }>(c, 'POST', '/tags', { name })));
    expect(new Set(rs.map((r) => r.body.tag.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('R-PERM-11: a support actor reads nothing it may not and writes nothing (DB refuses)', async () => {
    const t = await makeTag(w.owner, 'Support target');
    const support: Actor = { kind: 'support', userId: w.owner.userId!, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
    await expect(withTenantTx(support, (tx) => catalog.insertTag(tx, { id: randomUUID(), name: 'by support', color: null, protectedProxy: false, byUserId: w.owner.userId! }), { db: h.database })).rejects.toBeTruthy();
    await expect(withTenantTx(support, (tx) => catalog.updateTag(tx, t.id, { name: 'renamed by support' }), { db: h.database })).rejects.toBeTruthy();
    expect((await h.su.query('SELECT name FROM tags WHERE id = $1', [t.id])).rows[0].name).toBe('Support target');
  });
});
