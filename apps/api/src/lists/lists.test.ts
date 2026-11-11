// api/lists: saved smart lists and list runs under the viewer's own RLS (R-PAR-20, R-PAR-27..29;
// E176, E181, E182), and resolveSelection for module 63 (R-PAR-8, E189).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { mapListsDbError, limitListStatement } from './common.js';
import { resolveSelection } from './selection.js';
import { auditRows, call, createContact, listsWorld, type ListsWorld, makeTag, run, runAll, tagContact } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let buyer: { id: string };
let va: { id: string };
let birthday: string;

/** What app.contact_detail_visible says the caller sees (the oracle for the inline list predicate). */
async function oracle(c: ListsWorld['owner']): Promise<string[]> {
  return withTenantTx(c.actor(), async (tx) => {
    const r = await sql<{ id: string }>`SELECT c.id FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL
      AND c.merged_into_contact_id IS NULL AND app.contact_detail_visible(c.tenant_id, c.id) ORDER BY c.id`.execute(tx);
    return r.rows.map((x) => x.id);
  }, { db: h.database });
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 4 });
  buyer = await makeTag(w.agentA, 'Buyer');
  va = await makeTag(w.agentA, 'VA buyer');
  await tagContact(w.agentA, w.aContacts[0]!, [buyer.id]);
  await tagContact(w.agentA, w.aContacts[1]!, [buyer.id, va.id]);
  await tagContact(w.agentB, w.bContacts[0]!, [buyer.id]);
  await tagContact(w.owner, w.pondContact, [buyer.id]);
  const f = await call<{ field: { id: string } }>(w.admin, 'POST', '/custom-fields', { label: 'Birthday', fieldType: 'date', annual: true });
  birthday = f.body.field.id;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('list runs under the viewer\'s own RLS (R-PAR-28)', () => {
  it('R-PAR-28: every role gets exactly the live people whose detail it sees (the inline predicate equals app.contact_detail_visible)', async () => {
    for (const c of [w.owner, w.admin, w.lead, w.agentA, w.agentB, w.isa, w.tc]) {
      expect((await runAll(c, { v: 1, all: [] })).sort(), c.role!).toEqual(await oracle(c));
    }
    expect(await runAll(w.agentA, { v: 1 })).toEqual(expect.arrayContaining(w.aContacts));
    expect(await runAll(w.agentA, { v: 1 })).not.toContain(w.bContacts[0]);
    expect(await runAll(w.owner, { v: 1 })).toContain(w.pondContact);
  });

  it('R-PAR-28 E182: a pond card is never returned, even when its tags (set by someone who sees it) would match', async () => {
    const def = { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] };
    expect((await runAll(w.agentA, def)).sort()).toEqual([w.aContacts[0], w.aContacts[1]].sort());
    expect(await runAll(w.isa, def)).toEqual([]);
    expect(await runAll(w.owner, def)).toContain(w.pondContact);
    const page = await run(w.agentA, def);
    expect(page.body.scope).toBe('people_you_can_see');
    expect(page.body.people.find((p) => p.id === w.aContacts[1])?.tags.map((t) => t.id).sort()).toEqual([buyer.id, va.id].sort());
  });

  it('R-PAR-29: keyset pages of 50 cover every person exactly once, for every sort; a cursor for another sort is refused', async () => {
    for (let i = 0; i < 56; i++) await createContact(w.agentB, `Page Person ${String(i).padStart(2, '0')}`);
    const everyone = await oracle(w.agentB);
    for (const sort of ['last_activity_desc', 'created_desc', 'name_asc', 'next_task_asc', 'stage_entered_desc']) {
      const ids = await runAll(w.agentB, { v: 1 }, sort);
      expect(ids.length, sort).toBe(everyone.length);
      expect(new Set(ids).size, sort).toBe(ids.length);
    }
    const p1 = await run(w.agentB, { v: 1 }, { sort: 'name_asc' });
    expect(p1.body.people).toHaveLength(50);
    expect(p1.body.people.map((p) => p.displayName.toLowerCase())).toEqual([...p1.body.people.map((p) => p.displayName.toLowerCase())].sort());
    expect((await run(w.agentB, { v: 1 }, { sort: 'created_desc', cursor: p1.body.nextCursor! })).code).toBe('LIST_CURSOR_INVALID');
    expect((await run(w.agentB, { v: 1 }, { cursor: 'garbage' })).code).toBe('LIST_CURSOR_INVALID');
    const count = await call<{ count: number; capped: boolean }>(w.agentB, 'POST', '/people/count', { definition: { v: 1 } });
    expect(count.body).toEqual({ count: everyone.length, capped: false });
  });

  it('R-PAR-29: the run is bounded to 3 s and a statement past its timeout is LIST_TOO_SLOW (503)', async () => {
    await withTenantTx(w.agentA.actor(), async (tx) => {
      await limitListStatement(tx);
      const r = await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(tx);
      expect(r.rows[0]!.t).toBe('3s');
    }, { db: h.database });
    const err = await withTenantTx(w.agentA.actor(), async (tx) => {
      await limitListStatement(tx, 50);
      await sql`SELECT pg_sleep(0.5)`.execute(tx);
    }, { db: h.database }).catch((e: unknown) => e);
    const mapped = mapListsDbError(err);
    expect([mapped?.code, mapped?.status]).toEqual(['LIST_TOO_SLOW', 503]);
    // the timeout is transaction-local: the next transaction on the pool is back to the default
    await withTenantTx(w.agentA.actor(), async (tx) => {
      const r = await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(tx);
      expect(r.rows[0]!.t).not.toBe('50ms');
    }, { db: h.database });
  });

  it('R-PAR-20 E176: "coming up in N days" on an annual date uses the tenant\'s local today and the month/day only', async () => {
    const z = (await h.su.query<{ z: string }>('SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.z;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const inTen = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 10 * 86_400_000));
    const setBday = (id: string, d: string) => call(w.agentA, 'PUT', `/contacts/${id}/fields/${birthday}`, { value: d });
    expect((await setBday(w.aContacts[0]!, `1984-${today.slice(5)}`)).status).toBe(200);
    expect((await setBday(w.aContacts[1]!, `1990-${inTen.slice(5)}`)).status).toBe(200);
    expect((await setBday(w.aContacts[2]!, '2001-01-01')).status).toBe(200);
    const soon = (days: number) => runAll(w.agentA, { v: 1, all: [{ kind: 'field', fieldId: birthday, op: 'coming_up', days }] });
    expect(await soon(0)).toEqual(today.slice(5) === '01-01' ? expect.arrayContaining([w.aContacts[0]]) : [w.aContacts[0]]);
    expect((await soon(14)).sort()).toEqual(expect.arrayContaining([w.aContacts[0], w.aContacts[1]].sort()));
    expect(await soon(3)).not.toContain(w.aContacts[1]);
  });
});

describe('saved smart lists (R-PAR-27)', () => {
  it('R-PAR-27: personal lists are their owner\'s alone; team lists are written by Owner/Admin/TL only and read by everyone (audited)', async () => {
    const mine = await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Jane search', definition: { v: 1, all: [{ kind: 'name', contains: 'alice' }] } });
    expect(mine.status).toBe(201);
    expect((await call<{ lists: { id: string }[] }>(w.owner, 'GET', '/smart-lists')).body.lists.map((l) => l.id)).not.toContain(mine.body.list.id);
    for (const c of [w.owner, w.agentB, w.lead]) {
      expect((await call(c, 'GET', `/people?list=${mine.body.list.id}`)).status).toBe(404);
      expect((await call(c, 'PATCH', `/smart-lists/${mine.body.list.id}`, { name: 'x' })).status).toBe(404);
      expect((await call(c, 'DELETE', `/smart-lists/${mine.body.list.id}`)).status).toBe(404);
    }
    for (const c of [w.agentA, w.isa, w.tc]) expect((await call(c, 'POST', '/smart-lists', { scope: 'team', name: 'Nope', definition: { v: 1 } })).status, c.role!).toBe(404);
    const team = await call<{ list: { id: string; scope: string } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Buyers', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } });
    expect([team.status, team.body.list.scope]).toEqual([201, 'team']);
    expect((await call<{ lists: { id: string }[] }>(w.tc, 'GET', '/smart-lists')).body.lists.map((l) => l.id)).toContain(team.body.list.id);
    expect((await call(w.agentA, 'PATCH', `/smart-lists/${team.body.list.id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await call(w.admin, 'PATCH', `/smart-lists/${team.body.list.id}`, { name: 'Buyers (all)' })).status).toBe(200);
    expect((await auditRows(h, w.tenantId, 'smart_list.team_changed')).length).toBe(2);
  });

  it('R-PAR-27: team lists carry no free-text clauses (create or edit); unknown references are refused at save', async () => {
    expect((await call(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Janes', definition: { v: 1, all: [{ kind: 'name', contains: 'Jane' }] } })).code).toBe('LIST_FREE_TEXT_IN_TEAM_LIST');
    const t = await call<{ list: { id: string } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'New ones', definition: { v: 1, all: [{ kind: 'stage', in: ['new'] }] } });
    expect((await call(w.lead, 'PATCH', `/smart-lists/${t.body.list.id}`, { definition: { v: 1, any: [{ kind: 'stage', in: ['new'] }, { kind: 'name', contains: 'x' }] } })).code).toBe('LIST_FREE_TEXT_IN_TEAM_LIST');
    expect((await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Ghost tag', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [randomUUID()] }] } })).code).toBe('LIST_TAG_UNKNOWN');
    expect((await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Bad op', definition: { v: 1, all: [{ kind: 'field', fieldId: birthday, op: 'num_gt', value: 1 }] } })).code).toBe('LIST_FIELD_OP_INVALID');
    expect((await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Bad', definition: { v: 1, all: [{ kind: 'sql', where: '1=1' }] } })).code).toBe('LIST_DEFINITION_INVALID');
    expect((await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: ' ', definition: { v: 1 } })).code).toBe('VALIDATION_FAILED');
  });

  it("R-PAR-28 E181: an agent running the TL's team list gets only their own people", async () => {
    const team = await call<{ list: { id: string } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Everyone tagged buyer', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } });
    const asLead = await call<{ people: { id: string }[]; list: { name: string } }>(w.lead, 'GET', `/people?list=${team.body.list.id}`);
    expect(asLead.body.people.map((p) => p.id).sort()).toEqual([w.aContacts[0], w.aContacts[1], w.bContacts[0], w.pondContact].sort());
    const asA = await call<{ people: { id: string }[]; scope: string; list: { name: string } }>(w.agentA, 'GET', `/people?list=${team.body.list.id}`);
    expect(asA.body.people.map((p) => p.id).sort()).toEqual([w.aContacts[0], w.aContacts[1]].sort());
    expect(asA.body.scope).toBe('people_you_can_see');
    const asB = await call<{ count: number }>(w.agentB, 'GET', `/people/count?list=${team.body.list.id}`);
    expect(asB.body.count).toBe(1);
  });
});

describe('resolveSelection (PARITY_PLAN §4.2, for module 63)', () => {
  it('R-PAR-28: { contactIds } keeps only live people whose detail the caller sees, in the given order', async () => {
    const ids = [w.bContacts[0]!, w.aContacts[1]!, w.pondContact, randomUUID(), w.aContacts[0]!, w.aContacts[1]!];
    const got = await withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { contactIds: ids }), { db: h.database });
    expect(got).toEqual([w.aContacts[1], w.aContacts[0]]);
  });

  it('R-PAR-28: { listId } and { definition } run as the caller; a list the caller cannot read is NOT_FOUND', async () => {
    const mine = await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Sel', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } });
    const viaList = await withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { listId: mine.body.list.id }), { db: h.database });
    expect(viaList.sort()).toEqual([w.aContacts[0], w.aContacts[1]].sort());
    const viaDef = await withTenantTx(w.lead.actor(), (tx) => resolveSelection(tx, { definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } }), { db: h.database });
    expect(viaDef).toHaveLength(4);
    await expect(withTenantTx(w.agentB.actor(), (tx) => resolveSelection(tx, { listId: mine.body.list.id }), { db: h.database })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('R-PAR-8 E189: a list audience using the protected tag "VA buyer" is refused for a send (AUDIENCE_PROTECTED_PROXY, no override); viewing and editing still work', async () => {
    const def = { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [va.id] }] };
    await expect(withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { definition: def }, { audience: 'send' }), { db: h.database })).rejects.toMatchObject({ code: 'AUDIENCE_PROTECTED_PROXY' });
    const none = { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [va.id] }] };
    await expect(withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { definition: none }, { audience: 'send' }), { db: h.database })).rejects.toMatchObject({ code: 'AUDIENCE_PROTECTED_PROXY' });
    expect(await withTenantTx(w.agentA.actor(), (tx) => resolveSelection(tx, { definition: def }, { audience: 'edit' }), { db: h.database })).toEqual([w.aContacts[1]]);
    const view = await run(w.agentA, def);
    expect([view.status, view.body.audienceProtected]).toEqual([200, true]);
  });

  it('R-PAR-29: more people than the cap is SELECTION_TOO_LARGE, never a silent truncation', async () => {
    await expect(withTenantTx(w.agentB.actor(), (tx) => resolveSelection(tx, { definition: { v: 1 } }, { cap: 5 }), { db: h.database })).rejects.toMatchObject({ code: 'SELECTION_TOO_LARGE', details: { cap: 5 } });
    await expect(withTenantTx(w.agentB.actor(), (tx) => resolveSelection(tx, { contactIds: w.bContacts.concat(w.aContacts) }, { cap: 5 }), { db: h.database })).rejects.toMatchObject({ code: 'SELECTION_TOO_LARGE' });
  });
});
