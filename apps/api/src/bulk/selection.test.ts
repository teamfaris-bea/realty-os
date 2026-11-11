// Parity modules 60 + 63 wired together: a bulk action's target from a smart list (a saved list or an
// unsaved definition, the People page's "Select all") through module 60's real resolveSelection, end to
// end on real Postgres (R-PAR-28, R-PAR-33, R-PAR-34, R-PAR-35, R-PAR-8 E189, Q-PAR-7).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { call, listsWorld, type ListsWorld, makeTag, tagContact } from '../lists/testing.js';
import { runBulkAction } from './run.js';
import { resolveSelection } from './selection.js';
import { actionRow, confirm, draft, itemsOf } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let buyer: { id: string };
let va: { id: string };
let hotList: string;
let vaList: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 32 });
  buyer = await makeTag(w.agentA, 'Buyer');
  va = await makeTag(w.agentA, 'VA buyer'); // reads like military status: protected (R-PAR-8)
  for (const id of w.aContacts.slice(0, 30)) expect((await tagContact(w.agentA, id, [buyer.id])).status).toBe(200);
  expect((await tagContact(w.agentA, w.aContacts[31]!, [va.id])).status).toBe(200);
  // another agent's person and a pond card carry the tag too: neither is ever in agent A's target
  expect((await tagContact(w.agentB, w.bContacts[0]!, [buyer.id])).status).toBe(200);
  expect((await tagContact(w.owner, w.pondContact, [buyer.id])).status).toBe(200);
  hotList = (await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Hot buyers', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } })).body.list.id;
  vaList = (await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'VA', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [va.id] }] } })).body.list.id;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const run = (id: string) => runBulkAction(id, depsFromPlatform(h.app.platform), w.tenantId);
const tagged = async (tagId: string) => (await h.su.query<{ contact_id: string; added_by_kind: string; added_by_user_id: string }>('SELECT contact_id, added_by_kind, added_by_user_id FROM contact_tags WHERE tag_id = $1 ORDER BY contact_id', [tagId])).rows;

describe('bulk from a smart list (module 60 resolveSelection → module 63)', () => {
  it('R-PAR-34 R-PAR-35 R-PAR-28: bulk tag 30 from a saved smart list: the frozen target is exactly the list\'s people the creator sees, and Confirm tags all 30', async () => {
    const investor = await makeTag(w.agentA, `Investor ${randomUUID().slice(0, 4)}`);
    const d = await draft(w.agentA, { kind: 'tag', selection: { listId: hotList }, tagId: investor.id });
    expect(d.status).toBe(201);
    expect(d.body.action).toMatchObject({ kind: 'tag', status: 'draft', selected: 30, targetCount: 30, preflight: {} });
    const row = await actionRow(h, d.body.action.id);
    expect(row).toMatchObject({ target_count: 30 });
    expect((await h.su.query('SELECT source, smart_list_id FROM bulk_actions WHERE id = $1', [d.body.action.id])).rows[0]).toEqual({ source: 'smart_list', smart_list_id: hotList });
    const items = await itemsOf(h, d.body.action.id);
    expect(items.map((i) => i.contact_id).sort()).toEqual([...w.aContacts.slice(0, 30)].sort());
    expect(items.map((i) => i.contact_id)).not.toContain(w.bContacts[0]);
    expect(items.map((i) => i.contact_id)).not.toContain(w.pondContact);
    expect((await confirm(w.agentA, d.body.action.id)).body.action.status).toBe('confirmed');
    expect(await run(d.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    const links = await tagged(investor.id);
    expect(links.map((l) => l.contact_id).sort()).toEqual([...w.aContacts.slice(0, 30)].sort());
    expect(links.every((l) => l.added_by_kind === 'bulk' && l.added_by_user_id === w.agentA.userId)).toBe(true);
  });

  it('R-PAR-28 E182: an unsaved definition (the People page\'s tag chip, "Select all") resolves to the same people; another agent\'s run of it finds only their own', async () => {
    const def = { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] };
    const t = await makeTag(w.agentA, `Chip ${randomUUID().slice(0, 4)}`);
    const d = await draft(w.agentA, { kind: 'tag', selection: { definition: def }, tagId: t.id });
    expect(d.body.action).toMatchObject({ selected: 30, targetCount: 30 });
    expect((await h.su.query('SELECT source, smart_list_id FROM bulk_actions WHERE id = $1', [d.body.action.id])).rows[0]).toEqual({ source: 'selection', smart_list_id: null });
    const b = await draft(w.agentB, { kind: 'tag', selection: { definition: def }, tagId: t.id });
    expect(b.body.action).toMatchObject({ selected: 1, targetCount: 1 });
    expect((await itemsOf(h, b.body.action.id)).map((i) => i.contact_id)).toEqual([w.bContacts[0]]);
    // a saved personal list is its owner's alone: another agent cannot even name it
    expect((await draft(w.agentB, { kind: 'tag', selection: { listId: hotList }, tagId: t.id })).status).toBe(404);
    // the TC runs no bulk action at all
    expect((await draft(w.tc, { kind: 'tag', selection: { definition: def }, tagId: t.id })).status).toBe(404);
  });

  it('R-PAR-8 E189: a list built on a protected tag is never the audience of a bulk email, text or enrollment (no draft is written); the same list can still be tagged in bulk', async () => {
    const before = (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM bulk_actions WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    for (const kind of ['email', 'text'] as const) {
      const r = await draft(w.agentA, { kind, selection: { listId: vaList }, templateId: randomUUID() });
      expect([r.status, r.code], kind).toEqual([422, 'AUDIENCE_PROTECTED_PROXY']);
    }
    const e = await draft(w.agentA, { kind: 'enroll', selection: { definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [va.id] }] } }, playbookId: randomUUID() });
    expect([e.status, e.code]).toEqual([422, 'AUDIENCE_PROTECTED_PROXY']);
    expect((await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM bulk_actions WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(before);
    const t = await makeTag(w.agentA, `Follow up ${randomUUID().slice(0, 4)}`);
    const ok = await draft(w.agentA, { kind: 'tag', selection: { listId: vaList }, tagId: t.id });
    expect(ok.body.action).toMatchObject({ selected: 1, targetCount: 1 });
  });

  it('Q-PAR-7: a selection past the kind\'s cap is BULK_TOO_LARGE with the cap, never a silent truncation (lists\' SELECTION_TOO_LARGE)', async () => {
    const all = { definition: { v: 1 } };
    await expect(withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, all, { cap: 5 }), { db: h.database })).rejects.toMatchObject({ code: 'BULK_TOO_LARGE', details: { cap: 5 } });
    await expect(withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { contactIds: w.aContacts.slice(0, 6) }, { cap: 5 }), { db: h.database })).rejects.toMatchObject({ code: 'BULK_TOO_LARGE', details: { cap: 5 } });
    const ok = await withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { listId: hotList }, { cap: 30 }), { db: h.database });
    expect([...ok].sort()).toEqual([...w.aContacts.slice(0, 30)].sort());
  });
});
