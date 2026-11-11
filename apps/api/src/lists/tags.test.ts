// api/lists: the tag catalog and a person's tags (R-PAR-6..10; E165, E166, E167, E182).
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import * as catalog from './repos/catalog.js';
import { auditRows, call, listsWorld, type ListsWorld, makeTag, run, tagContact } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('tag catalog (R-PAR-6, R-PAR-9)', () => {
  it('R-PAR-6 E165: an agent typing "buyer" while "Buyer" exists gets the existing tag; display stays "Buyer"', async () => {
    const first = await call<{ tag: { id: string; name: string }; created: boolean }>(w.agentA, 'POST', '/tags', { name: '  Buyer ' });
    expect([first.status, first.body.created, first.body.tag.name]).toEqual([201, true, 'Buyer']);
    for (const typed of ['buyer', 'BUYER', 'Ｂｕｙｅｒ']) {
      const again = await call<{ tag: { id: string; name: string }; created: boolean }>(w.agentB, 'POST', '/tags', { name: typed });
      expect([again.status, again.body.created, again.body.tag.id, again.body.tag.name], typed).toEqual([200, false, first.body.tag.id, 'Buyer']);
    }
    const all = await call<{ tags: { name: string }[] }>(w.agentA, 'GET', '/tags');
    expect(all.body.tags.filter((t) => t.name.toLowerCase() === 'buyer')).toHaveLength(1);
    expect((await call(w.agentA, 'POST', '/tags', { name: '   ' })).code).toBe('TAG_NAME_EMPTY');
    expect((await call(w.agentA, 'POST', '/tags', { name: 'x'.repeat(65) })).code).toBe('TAG_NAME_TOO_LONG');
  });

  it('R-PAR-9: members other than TCs create tags by typing; only Owner/Admin rename, recolor, protect, merge or delete (audited)', async () => {
    const t = await makeTag(w.agentA, 'Warm');
    expect((await call(w.tc, 'POST', '/tags', { name: 'TC tag' })).status).toBe(404);
    for (const c of [w.agentA, w.lead, w.isa, w.tc]) {
      expect((await call(c, 'PATCH', `/tags/${t.id}`, { name: 'Warmer' })).status).toBe(404);
      expect((await call(c, 'DELETE', `/tags/${t.id}`)).status).toBe(404);
      expect((await call(c, 'POST', `/tags/${t.id}/protect`, { protected: true })).status).toBe(404);
    }
    const renamed = await call<{ tag: { name: string; color: string | null } }>(w.admin, 'PATCH', `/tags/${t.id}`, { name: 'Warm lead', color: 'amber' });
    expect([renamed.status, renamed.body.tag.name, renamed.body.tag.color]).toEqual([200, 'Warm lead', 'amber']);
    const rows = await auditRows(h, w.tenantId, 'tag.rename');
    expect(rows.at(-1)).toMatchObject({ entity_id: t.id, actor_role: 'admin', changes: { name: { changed: true } } });
    // a rename onto another tag's name is refused (merge instead)
    expect((await call(w.admin, 'PATCH', `/tags/${t.id}`, { name: 'BUYER' })).code).toBe('TAG_NAME_TAKEN');
  });

  it('R-PAR-8: a lexicon name is protected on creation; protection tightens freely but only the Owner lifts it (audited)', async () => {
    const va = await call<{ tag: { id: string; protected: boolean } }>(w.agentA, 'POST', '/tags', { name: 'VA buyer' });
    expect(va.body.tag.protected).toBe(true);
    const plain = await makeTag(w.agentA, 'Golf');
    expect(plain.protected).toBe(false);
    expect((await call<{ tag: { protected: boolean } }>(w.admin, 'POST', `/tags/${plain.id}/protect`, { protected: true })).body.tag.protected).toBe(true);
    expect((await call(w.admin, 'POST', `/tags/${plain.id}/protect`, { protected: false })).code).toBe('TAG_PROTECTION_OWNER_ONLY');
    expect((await call<{ tag: { protected: boolean } }>(w.owner, 'POST', `/tags/${plain.id}/protect`, { protected: false })).body.tag.protected).toBe(false);
    const rows = await auditRows(h, w.tenantId, 'tag.protect');
    expect(rows.slice(-2).map((r) => [r.actor_role, r.changes])).toEqual([
      ['admin', { is_protected: { from: false, to: true } }],
      ['owner', { is_protected: { from: true, to: false } }],
    ]);
    // the database refuses an Admin lifting it even past the API (trigger)
    await expect(withTenantTx(w.admin.actor(), (tx) => catalog.updateTag(tx, va.body.tag.id, { protectedProxy: false }), { db: h.database })).rejects.toThrow(/TAG_PROTECTION_OWNER_ONLY/);
  });

  it('R-PAR-9: a merge moves the links (one per person), rewrites every list naming the source (personal ones too), takes the stricter protection and deletes the source; audited with counts', async () => {
    const hot = await makeTag(w.agentA, 'Hot');
    const aLead = await makeTag(w.agentA, 'A-Lead');
    await call(w.admin, 'POST', `/tags/${hot.id}/protect`, { protected: true });
    await tagContact(w.agentA, w.aContacts[0]!, [hot.id]);
    await tagContact(w.agentA, w.aContacts[1]!, [hot.id, aLead.id]);
    await tagContact(w.agentB, w.bContacts[0]!, [hot.id]);
    const personal = await call<{ list: { id: string } }>(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'My hot ones', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [hot.id.toUpperCase()] }] } });
    expect(personal.status).toBe(201);
    const team = await call<{ list: { id: string } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Team hot', definition: { v: 1, all: [{ kind: 'tag', op: 'none', tagIds: [hot.id] }] } });
    expect(team.status).toBe(201);
    const m = await call<{ tag: { id: string; protected: boolean }; moved: number; alreadyTagged: number; listsRewritten: number }>(w.admin, 'POST', `/tags/${hot.id}/merge`, { intoTagId: aLead.id });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ tag: { id: aLead.id, protected: true }, moved: 3, alreadyTagged: 1, listsRewritten: 2 });
    const links = await h.su.query<{ contact_id: string; tag_id: string }>('SELECT contact_id, tag_id FROM contact_tags WHERE tenant_id = $1 AND tag_id = ANY ($2::uuid[])', [w.tenantId, [hot.id, aLead.id]]);
    expect(links.rows.every((r) => r.tag_id === aLead.id)).toBe(true);
    expect(new Set(links.rows.map((r) => r.contact_id))).toEqual(new Set([w.aContacts[0], w.aContacts[1], w.bContacts[0]]));
    expect((await h.su.query('SELECT 1 FROM tags WHERE id = $1', [hot.id])).rowCount).toBe(0);
    const defs = await h.su.query<{ definition: { all: { tagIds: string[] }[] } }>('SELECT definition FROM smart_lists WHERE id = ANY ($1::uuid[]) ORDER BY scope', [[personal.body.list.id, team.body.list.id]]);
    for (const d of defs.rows) expect(d.definition.all[0]!.tagIds).toEqual([aLead.id]);
    // the agent's rewritten personal list still finds their people
    const mine = await call<{ people: { id: string }[] }>(w.agentA, 'GET', `/people?list=${personal.body.list.id}`);
    expect(mine.body.people.map((p) => p.id).sort()).toEqual([w.aContacts[0], w.aContacts[1]].sort());
    const a = await auditRows(h, w.tenantId, 'tag.merge');
    expect(a.at(-1)).toMatchObject({ entity_id: aLead.id, changes: { moved_count: { from: null, to: 3 }, added_count: { from: null, to: 2 }, lists_rewritten_count: { from: null, to: 2 }, is_protected: { from: false, to: true } } });
    expect((await call(w.admin, 'POST', `/tags/${aLead.id}/merge`, { intoTagId: aLead.id })).code).toBe('TAG_MERGE_INVALID');
  });

  it('R-PAR-9: a person with 100 tags including the source can still be merged (no transient limit hit)', async () => {
    const src = await makeTag(w.admin, 'Src100');
    const dst = await makeTag(w.admin, 'Dst100');
    const ids: string[] = [src.id];
    for (let i = 0; i < 99; i++) ids.push((await makeTag(w.admin, `Bulk tag ${i}`)).id);
    for (let i = 0; i < ids.length; i += 20) expect((await tagContact(w.agentA, w.aContacts[2]!, ids.slice(i, i + 20))).status).toBe(200);
    expect((await tagContact(w.agentA, w.aContacts[2]!, [dst.id])).code).toBe('CONTACT_TAG_LIMIT');
    const m = await call<{ moved: number }>(w.admin, 'POST', `/tags/${src.id}/merge`, { intoTagId: dst.id });
    expect([m.status, m.body.moved]).toEqual([200, 1]);
    const tags = await call<{ tags: { id: string }[] }>(w.agentA, 'GET', `/contacts/${w.aContacts[2]}/tags`);
    expect(tags.body.tags).toHaveLength(100);
    expect(tags.body.tags.map((t) => t.id)).toContain(dst.id);
    for (let i = 1; i < ids.length; i += 20) await Promise.all(ids.slice(i, i + 20).map((id) => call(w.agentA, 'DELETE', `/contacts/${w.aContacts[2]}/tags/${id}`)));
  });

  it('R-PAR-9 E166: an agent tagging someone "Hot" while an Admin merges "Hot" into "A-Lead" waits, then fails cleanly on the deleted tag; the retry with the target succeeds', async () => {
    const hot = await makeTag(w.admin, 'Hot again');
    const target = await makeTag(w.admin, 'A-Lead again');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let merged!: () => void;
    const mergedHeld = new Promise<void>((r) => (merged = r));
    const merge = withTenantTx(
      w.admin.actor(),
      async (tx) => {
        await catalog.getTag(tx, hot.id, { lock: true });
        await catalog.retargetLists(tx, hot.id, target.id);
        await catalog.moveTagLinks(tx, hot.id, target.id, w.admin.userId!);
        await catalog.deleteTag(tx, hot.id);
        merged();
        await gate; // hold the merge transaction open
      },
      { db: h.database },
    );
    await mergedHeld;
    const t0 = Date.now();
    const agentCall = tagContact(w.agentA, w.aContacts[0]!, [hot.id]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await merge;
    const r = await agentCall;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // it waited for the merge
    expect(r.status).toBe(404); // the tag is gone
    expect((await tagContact(w.agentA, w.aContacts[0]!, [target.id])).status).toBe(200);
  });

  it('R-PAR-9: deleting a tag removes its links (audited with the count); lists naming it then match nobody', async () => {
    const t = await makeTag(w.agentA, 'Temp');
    await tagContact(w.agentA, w.aContacts[0]!, [t.id]);
    const d = await call<{ removedLinks: number }>(w.admin, 'DELETE', `/tags/${t.id}`);
    expect([d.status, d.body.removedLinks]).toEqual([200, 1]);
    expect((await auditRows(h, w.tenantId, 'tag.delete')).at(-1)).toMatchObject({ entity_id: t.id, changes: { link_count: { from: 1, to: null } } });
    const r = await run(w.agentA, { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [t.id] }] });
    expect(r.body.people).toEqual([]);
  });
});

describe("a person's tags (R-PAR-7, R-PAR-10)", () => {
  it('R-PAR-7 E167: tagging someone "DNC" saves the tag and flags it for the real do-not-contact offer; nothing about reaching them changes, and removing it lifts nothing', async () => {
    const before = await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [w.aContacts[1]]);
    const consentBefore = (await h.su.query('SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1', [w.tenantId])).rows[0].n;
    const r = await call<{ added: string[]; optOutLike: string[]; tags: { id: string; name: string }[] }>(w.agentA, 'POST', `/contacts/${w.aContacts[1]}/tags`, { names: ['DNC'] });
    expect(r.status).toBe(200);
    expect(r.body.optOutLike).toEqual(r.body.added);
    expect(r.body.tags.map((t) => t.name)).toContain('DNC');
    const after = await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [w.aContacts[1]]);
    expect(after.rows).toEqual(before.rows);
    expect((await h.su.query('SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(consentBefore);
    const dnc = r.body.tags.find((t) => t.name === 'DNC')!;
    expect((await call(w.agentA, 'DELETE', `/contacts/${w.aContacts[1]}/tags/${dnc.id}`)).status).toBe(200);
    expect((await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [w.aContacts[1]])).rows).toEqual(before.rows);
  });

  it("R-PAR-7 E182: a person's tags are visible and writable exactly when their detail is: never on a pond card, never by a TC, never another agent's book", async () => {
    const t = await makeTag(w.owner, 'Pondish');
    expect((await tagContact(w.owner, w.pondContact, [t.id])).status).toBe(200); // the Owner sees all detail
    expect((await call(w.agentA, 'GET', `/contacts/${w.pondContact}/tags`)).status).toBe(404);
    expect((await tagContact(w.agentA, w.pondContact, [t.id])).status).toBe(404);
    expect((await call(w.agentA, 'DELETE', `/contacts/${w.pondContact}/tags/${t.id}`)).status).toBe(404);
    expect((await tagContact(w.agentA, w.bContacts[0]!, [t.id])).status).toBe(404);
    expect((await tagContact(w.tc, w.aContacts[0]!, [t.id])).status).toBe(404);
    expect((await tagContact(w.lead, w.aContacts[0]!, [t.id])).status).toBe(200); // TL: team
    // a pond card's tag never makes it findable by a viewer who cannot see its detail
    const r = await run(w.agentA, { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [t.id] }] });
    expect(r.body.people.map((p) => p.id)).toEqual([w.aContacts[0]]);
    // and the card itself carries no tags (R-PAR-8: never shown on a pond card)
    const card = await call<{ contact: Record<string, unknown> }>(w.agentA, 'GET', `/contacts/${w.pondContact}`);
    expect(card.body.contact.view).toBe('card');
    expect(card.body.contact.tags).toBeUndefined();
  });

  it('R-PAR-10: the contact record reads its tags from contact_tags (detail view only)', async () => {
    const t = await makeTag(w.agentB, 'Investor list');
    await tagContact(w.agentB, w.bContacts[1]!, [t.id]);
    const full = await call<{ contact: { view: string; tags: string[] } }>(w.agentB, 'GET', `/contacts/${w.bContacts[1]}`);
    expect(full.body.contact.view).toBe('full');
    expect(full.body.contact.tags).toContain('Investor list');
    // a stale contacts.tags value is never read
    await h.su.query("UPDATE contacts SET tags = '{legacy-only}' WHERE id = $1", [w.bContacts[1]]);
    expect((await call<{ contact: { tags: string[] } }>(w.agentB, 'GET', `/contacts/${w.bContacts[1]}`)).body.contact.tags).not.toContain('legacy-only');
  });

  it('R-PAR-6: a person holds at most 100 tags (CONTACT_TAG_LIMIT); typed names are capped at 20 per call', async () => {
    const r = await call(w.agentA, 'POST', `/contacts/${w.aContacts[0]}/tags`, { names: Array.from({ length: 21 }, (_, i) => `n${i}`) });
    expect(r.status).toBe(422);
  });
});
