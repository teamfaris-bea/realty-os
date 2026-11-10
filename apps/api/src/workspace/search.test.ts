// Search over real Postgres as app_user (BUILD_PLAN module 14: phone-digit matching and RLS, pond cards not
// searchable by phone; R-PERM-4, R-PERM-6; ARCHITECTURE §14).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { maskedName, phoneSuffix, prefixTsQuery } from './search.js';
import { call, command, contactOf, randomEmail, randomPhone, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: false });
});
afterAll(async () => {
  await h?.close();
});

interface Result {
  contacts: { id: string; name: string; view: string; matchedOn: string }[];
  listings: { id: string }[];
  deals: { id: string }[];
  notes: { id: string; snippet: string }[];
  messages: { id: string }[];
  incomplete: string[];
}
const find = async (c: WorkspaceWorld['owner'], q: string) => {
  const r = await call<Result>(c, 'GET', `/search?q=${encodeURIComponent(q)}`);
  expect(r.status).toBe(200);
  return r.body;
};

describe('search', () => {
  it('finds a contact by name prefix, by phone digits in any format, and by email', async () => {
    const a = w.agents[0]!;
    const phone = randomPhone(); // +1415xxxxxxx
    const email = randomEmail();
    const c = await contactOf(a, { firstName: 'Quinlan', phone, email });
    const local = phone.slice(2); // 10 digits
    const formatted = `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
    expect((await find(a, 'quinl')).contacts.find((x) => x.id === c.id)).toMatchObject({ name: 'Quinlan Doe', view: 'full', matchedOn: 'name' });
    expect((await find(a, formatted)).contacts.find((x) => x.id === c.id)?.matchedOn).toBe('phone');
    expect((await find(a, local.slice(3))).contacts.find((x) => x.id === c.id)?.matchedOn).toBe('phone'); // last 7 digits
    expect((await find(a, `+1 ${local}`)).contacts.map((x) => x.id)).toContain(c.id);
    expect((await find(a, email.slice(0, 12) + email.slice(12))).contacts.find((x) => x.id === c.id)?.matchedOn).toBe('email');
    // fewer than 7 digits is not a phone search
    expect((await find(a, local.slice(6))).contacts.some((x) => x.id === c.id && x.matchedOn === 'phone')).toBe(false);
  });

  it('R-PERM-4: another agent’s contact is not found by name, phone or email', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const phone = randomPhone();
    const email = randomEmail();
    const c = await contactOf(b, { firstName: 'Zebulon', phone, email });
    for (const q of ['Zebulon', phone.slice(2), email]) expect((await find(a, q)).contacts.map((x) => x.id)).not.toContain(c.id);
    expect((await find(w.owner, 'Zebulon')).contacts.map((x) => x.id)).toContain(c.id); // tenant-wide
  });

  it('R-PERM-6: a pond lead is found by its name only, as a masked card; never by its phone or email', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const phone = randomPhone();
    const email = randomEmail();
    const c = await contactOf(a, { firstName: 'Philippa', phone, email });
    const rel = await command(a, c.id, 'release', { reason: 'not_a_fit' });
    expect(rel.status).toBe(200);
    const byName = (await find(b, 'Philippa')).contacts.find((x) => x.id === c.id);
    expect(byName).toEqual({ id: c.id, name: 'Philippa D.', view: 'card', ownershipState: 'in_pond', matchedOn: 'name' });
    expect((await find(b, phone.slice(2))).contacts.map((x) => x.id)).not.toContain(c.id);
    expect((await find(b, email)).contacts.map((x) => x.id)).not.toContain(c.id);
  });

  it('finds listings, deals and notes the caller can see, at most 10 per group, with nothing marked incomplete', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const l = await call<{ listing: { id: string } }>(a, 'POST', '/listings', { addressLine1: '88 Marigold Way', city: 'Eugene', region: 'OR', postalCode: '97401', status: 'active' });
    expect((await find(b, 'marigold')).listings.map((x) => x.id)).toContain(l.body.listing.id); // team inventory: every member
    const c = await contactOf(a, { firstName: 'Delia' });
    const d = await call<{ deal: { id: string } }>(a, 'POST', '/deals', { primaryContactId: c.id, side: 'buy', name: 'Delia Rosewood purchase' });
    expect((await find(a, 'rosewood')).deals.map((x) => x.id)).toContain(d.body.deal.id);
    expect((await find(b, 'rosewood')).deals.map((x) => x.id)).not.toContain(d.body.deal.id);
    const noteId = randomUUID();
    await h.su.query("INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES ($1,$2,$3,$4,'Wants a detached garage for the boat')", [w.tenantId, noteId, c.id, a.userId]);
    const r = await find(a, 'garage boat');
    expect(r.notes.find((x) => x.id === noteId)?.snippet).toBe('Wants a detached garage for the boat');
    expect((await find(b, 'garage boat')).notes.map((x) => x.id)).not.toContain(noteId);
    for (let i = 0; i < 12; i++) await contactOf(a, { firstName: `Manyname${i}` });
    const many = await find(a, 'manyname');
    expect(many.contacts.length).toBe(10);
    expect(many.incomplete).toEqual([]);
  });

  it('finds messages of visible conversations only', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const c = await contactOf(a);
    const conv = randomUUID();
    const msg = randomUUID();
    await h.su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3)', [w.tenantId, conv, c.id]);
    await h.su.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
       VALUES ($1,$2,$3,$4,'sms','inbound','+14155550000','+14155550001','Is the bungalow on Alder still available?','received','client', now())`,
      [w.tenantId, msg, conv, c.id],
    );
    expect((await find(a, 'bungalow alder')).messages.map((x) => x.id)).toEqual([msg]);
    expect((await find(b, 'bungalow alder')).messages).toEqual([]);
  });

  it('query helpers: prefix tsquery is injection-safe, phone digits use the last 7–10, pond names mask the last name', () => {
    expect(prefixTsQuery("jane o'neil & | ! :*")).toBe('jane:* & o:* & neil:*');
    expect(prefixTsQuery('***')).toBeNull();
    expect(phoneSuffix('+1 (415) 555-0123')).toBe('4155550123');
    expect(phoneSuffix('555-0123')).toBe('5550123');
    expect(phoneSuffix('12345')).toBeNull();
    expect(maskedName('Jane', 'doe', 'Jane Doe')).toBe('Jane D.');
    expect(maskedName(null, null, 'Pat Q Lead')).toBe('Pat L.');
  });

  it('a query shorter than 2 characters, or with a tenant id, is refused', async () => {
    const a = w.agents[0]!;
    expect((await call(a, 'GET', '/search?q=a')).code).toBe('VALIDATION_FAILED');
    expect((await call(a, 'GET', `/search?q=abc&tenant_id=${w.tenantId}`)).code).toBe('VALIDATION_FAILED');
  });
});
