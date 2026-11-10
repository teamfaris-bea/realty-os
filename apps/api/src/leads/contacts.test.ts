// Contact views (R-PERM-4…7): card vs full record, masked pond cards, the timeline, 404 for invisible
// ids (E52).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { normalize } from '../admin/testing.js';
import { maskLastName } from './views.js';
import { type LeadsWorld, call, command, contactState, intake, leadsWorld, randomPhone } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let pondWorld: LeadsWorld & { others: TestClient[] };

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  pondWorld = await leadsWorld(h, { agents: 2, rule: false, teamLead: true });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const PII = /\+1415|@example\.test|Ramirez|555/;

describe('cards and full records (R-PERM-4, R-PERM-6)', () => {
  it('R-PERM-6: an offer card shows name, intent, source, age and summary — no phones, emails, inquiries or history — until accepted, then the full record', async () => {
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Lucia Ramirez', phones: [phone], emails: ['lucia.r@example.test'], postalCode: '02134', message: 'Looking for a 3 bed' });
    const st = await contactState(h, r.contactId);
    const offeree = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    const card = await call<{ contact: Record<string, unknown> }>(offeree, 'GET', `/contacts/${r.contactId}`);
    expect(card.status).toBe(200);
    expect(card.body.contact).toMatchObject({ view: 'card', displayName: 'Lucia Ramirez', intent: 'buyer', pondSummary: 'Buying · 02134', ownership: { state: 'offered', offeredToMe: true, offerId: st.offer_id } });
    expect(Object.keys(card.body.contact).sort()).toEqual(['createdAt', 'displayName', 'id', 'intent', 'ownership', 'pondSummary', 'source', 'view']);
    expect(JSON.stringify(card.body)).not.toContain(phone.slice(2));
    expect(JSON.stringify(card.body)).not.toContain('example.test');
    // the timeline (history) is detail: refused for the offer card
    expect((await call(offeree, 'GET', `/contacts/${r.contactId}/timeline`)).status).toBe(404);
    await command(offeree, r.contactId, 'accept', { offerId: st.offer_id });
    const full = await call<{ contact: { view: string; phones: { address: string }[]; emails: { address: string }[]; inquiries: { message: string }[]; ownership: { ownedByMe: boolean } } }>(offeree, 'GET', `/contacts/${r.contactId}`);
    expect(full.body.contact.view).toBe('full');
    expect(full.body.contact.phones.map((p) => p.address)).toEqual([phone]);
    expect(full.body.contact.emails.map((p) => p.address)).toEqual(['lucia.r@example.test']);
    expect(full.body.contact.inquiries[0]!.message).toBe('Looking for a 3 bed');
    expect(full.body.contact.ownership.ownedByMe).toBe(true);
  });

  it('R-PERM-6: pond cards never serialize contact points, inquiry text or the full last name (response snapshot); a TL who sees pond detail still gets masked cards here', async () => {
    const r = await intake(h, pondWorld, { fullName: 'Marisol Ramirez', phones: [randomPhone()], emails: ['marisol@example.test'], postalCode: '02139', priceMinCents: 50_000_000, priceMaxCents: 60_000_000, message: 'Call 555 0100' });
    expect((await contactState(h, r.contactId)).ownership_state).toBe('in_pond');
    for (const viewer of [pondWorld.agents[0]!, pondWorld.teamLead!, pondWorld.owner]) {
      const res = await call<{ cards: { id: string; displayName: string }[] }>(viewer, 'GET', `/ponds/${pondWorld.defaultPondId}/cards`);
      expect(res.status).toBe(200);
      const card = res.body.cards.find((c) => c.id === r.contactId)!;
      expect(card.displayName).toBe('Marisol R.');
      expect(JSON.stringify(res.body)).not.toMatch(PII);
    }
    const one = await call<{ cards: unknown[]; pond: unknown }>(pondWorld.agents[0]!, 'GET', `/ponds/${pondWorld.defaultPondId}/cards?limit=1`);
    expect(normalize({ pond: one.body.pond, card: one.body.cards[0] })).toMatchSnapshot();
    // an agent opening it directly also gets the masked card (not detail)
    const direct = await call<{ contact: { view: string; displayName: string } }>(pondWorld.agents[0]!, 'GET', `/contacts/${r.contactId}`);
    expect([direct.body.contact.view, direct.body.contact.displayName]).toEqual(['card', 'Marisol R.']);
    // a TL sees pond detail (§3 "T + pond") when opening the contact
    const tl = await call<{ contact: { view: string } }>(pondWorld.teamLead!, 'GET', `/contacts/${r.contactId}`);
    expect(tl.body.contact.view).toBe('full');
    expect(maskLastName({ first_name: null, last_name: null, display_name: 'Ana María de la Cruz' })).toBe('Ana María de la C.');
  });

  it('R-OWN-16: a pond the caller may not claim from is 404; cards paginate by cursor', async () => {
    for (let i = 0; i < 3; i++) await intake(h, pondWorld, { fullName: `Page ${i}` });
    const first = await call<{ cards: { id: string }[]; nextCursor: string | null }>(pondWorld.agents[1]!, 'GET', `/ponds/${pondWorld.defaultPondId}/cards?limit=2`);
    expect(first.body.cards).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call<{ cards: { id: string }[] }>(pondWorld.agents[1]!, 'GET', `/ponds/${pondWorld.defaultPondId}/cards?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.cards.length).toBeGreaterThan(0);
    expect(second.body.cards.map((c) => c.id)).not.toContain(first.body.cards[0]!.id);
    const pond = await call<{ pond: { id: string } }>(pondWorld.owner, 'POST', '/ponds', { name: 'Members only', openToAll: false });
    expect((await call(pondWorld.agents[1]!, 'GET', `/ponds/${pond.body.pond.id}/cards`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'GET', `/ponds/${pondWorld.defaultPondId}/cards`)).status).toBe(404); // another tenant's pond
  });

  it('R-PERM-4 R-PERM-5 E52: invisible ids (another agent\'s contact, another tenant\'s, random) are 404; a TL sees team members\' contacts; a TC sees none without a deal', async () => {
    const a = w.agents[0]!;
    const b = w.agents[1]!;
    const mine = await call<{ contact: { id: string } }>(a, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Private One', phones: [randomPhone()] });
    const id = mine.body.contact.id;
    expect((await call(b, 'GET', `/contacts/${id}`)).status).toBe(404);
    expect((await call(b, 'GET', `/contacts/${randomUUID()}`)).status).toBe(404);
    expect((await call(pondWorld.agents[0]!, 'GET', `/contacts/${id}`)).status).toBe(404);
    expect((await call(w.others[0]!, 'GET', `/contacts/${id}`)).status).toBe(404);
    const tl = await call<{ contact: { view: string } }>(w.teamLead!, 'GET', `/contacts/${id}`);
    expect([tl.status, tl.body.contact.view]).toEqual([200, 'full']);
    expect((await call(b, 'GET', `/contacts/${id}/timeline`)).status).toBe(404);
    expect((await command(b, id, 'release', { reason: 'not_a_fit' })).status).toBe(404);
  });
});

describe('timeline', () => {
  it('BUILD_PLAN 11 acceptance: every ownership change is on the timeline with its reason and actor, newest first, cursor-paginated', async () => {
    const r = await intake(h, w);
    const st = await contactState(h, r.contactId);
    const offeree = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    await command(offeree, r.contactId, 'accept', { offerId: st.offer_id });
    await command(w.teamLead!, r.contactId, 'reassign', { toUserId: w.agents.find((a) => a !== offeree)!.userId, note: 'Spanish speaker' });
    const all = await call<{ items: { type: string; detail: string; preview: string; note: string | null; actor: { userId: string } | null }[]; nextCursor: string | null }>(w.owner, 'GET', `/contacts/${r.contactId}/timeline`);
    expect(all.body.items.map((i) => [i.detail, i.preview])).toEqual([
      ['reassigned', 'MANUAL_REASSIGN'],
      ['offer_accepted', 'OFFER_ACCEPTED'],
      ['offered', 'ROUND_ROBIN'],
      ['created', 'INTAKE'],
    ]);
    expect(all.body.items[0]).toMatchObject({ note: 'Spanish speaker', actor: { userId: w.teamLead!.userId } });
    expect(all.body.items[1]!.actor).toMatchObject({ userId: offeree.userId });
    const p1 = await call<{ items: { detail: string }[]; nextCursor: string }>(w.owner, 'GET', `/contacts/${r.contactId}/timeline?limit=3`);
    const p2 = await call<{ items: { detail: string }[]; nextCursor: string | null }>(w.owner, 'GET', `/contacts/${r.contactId}/timeline?limit=3&cursor=${p1.body.nextCursor}`);
    expect([...p1.body.items, ...p2.body.items].map((i) => i.detail)).toEqual(['reassigned', 'offer_accepted', 'offered', 'created']);
    expect(p2.body.nextCursor).toBeNull();
    expect((await call(w.owner, 'GET', `/contacts/${r.contactId}/timeline?cursor=garbage`)).status).toBe(422);
  });
});
