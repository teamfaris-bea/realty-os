// b7 interaction review, group "merges, sends and listings": ownership-data/F1 (a seller merged away, a listing that
// lost every seller) and ownership-data/F2 (a listing whose agent was removed) on the seller-update side.
// Real Postgres as app_user through the real server; the reconcile pass runs as the worker's system actor; the
// superuser only reads state back (and, in F1's second test, removes the seller link: there is no API that unlinks one).
// R-SELL-1, R-OWN-24, R-OWN-22.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, ownedContact } from '../assistant/testing.js';
import { command, freshReauth, leadsWorker } from '../leads/testing.js';
import { type UpdateT, call, draftsOf, reconcile, sellerListing } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: (process.env.SU_LOG as never) ?? undefined });
  w = await assistantWorld(h, { agents: 2 });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;

type FeedRow = { id: string; user_id: string; state: string; resolved_by: string | null; reasons: { code: string; label: string }[]; dedupe_key: string; assistant_action_id: string | null };
const listingCards = async (listingId: string): Promise<FeedRow[]> =>
  (await h.su.query("SELECT id, user_id, state, resolved_by, reasons, dedupe_key, assistant_action_id FROM priority_feed_items WHERE item_type = 'seller_update' AND subject_type = 'listing' AND subject_id = $1 ORDER BY created_at, id", [listingId])).rows;
const dueAt = async (listingId: string): Promise<Date | null> => (await h.su.query<{ d: Date | null }>('SELECT seller_update_next_due_at AS d FROM listings WHERE id = $1', [listingId])).rows[0]!.d;
const sellersOf = async (listingId: string) => (await h.su.query<{ contact_id: string; role: string }>('SELECT contact_id, role FROM listing_contacts WHERE listing_id = $1 ORDER BY contact_id', [listingId])).rows;

describe('b7 ownership-data/F1: listing sellers follow a merge; a listing with no seller left retires its draft', () => {
  it('R-SELL-1 R-OWN-24 b7 ownership-data/F1: a merged-away seller keeps getting seller updates', async () => {
    const l = await sellerListing(agent());
    const s = l.sellers[0]!;
    await reconcile(h, w.tenantId);
    const [draft] = await draftsOf(h, l.listingId);
    expect(draft).toMatchObject({ status: 'proposed', owner_user_id: agent().userId });
    expect((await listingCards(l.listingId)).filter((c) => c.state === 'open').map((c) => c.reasons[0]!.code)).toEqual(['SELLER_UPDATE_READY']);

    // a newer duplicate record of the same person (same owner); the older one (S, the seller) is merged into it
    const s2 = await ownedContact(agent(), { consent: false, firstName: 'Sam', confirmDistinct: true });
    // (the merge transaction runs app.contacts_merge_roles(); a refused privilege there is answered 404 by the leads
    // routes, so a 404 here means the trigger failed, not that the contacts are invisible)
    const m = await command(w.owner, s2.id, 'merge', { loserId: s.id });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await h.su.query('SELECT merged_into_contact_id FROM contacts WHERE id = $1', [s.id])).rows[0].merged_into_contact_id).toBe(s2.id);

    // the listing role moved in the merge transaction
    expect(await sellersOf(l.listingId)).toEqual([{ contact_id: s2.id, role: 'seller' }]);

    // the reconcile does not disarm the listing (it still has a seller) nor retire the draft
    const before = await dueAt(l.listingId);
    expect(before).not.toBeNull();
    await reconcile(h, w.tenantId);
    expect(await dueAt(l.listingId)).toEqual(before);
    expect((await draftsOf(h, l.listingId)).map((d) => [d.id, d.status])).toEqual([[draft!.id, 'proposed']]);

    // the agent's update now names the merged record as its recipient and can be sent
    const v = await call<{ update: UpdateT | null }>(agent(), 'GET', `/listings/${l.listingId}/seller-update`);
    expect(v.status).toBe(200);
    expect(v.body.update).not.toBeNull();
    expect(v.body.update!.id).toBe(draft!.id);
    expect(v.body.update!.recipients.map((x) => x.contactId)).toEqual([s2.id]);
    expect(v.body.update!.canSend).toBe(true);

    // the open card says what happened (one card, the draft's)
    const open = (await listingCards(l.listingId)).filter((c) => c.state === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!).toMatchObject({ user_id: agent().userId, assistant_action_id: draft!.id });
    expect(open[0]!.reasons.map((x) => x.code)).toEqual(['SELLER_UPDATE_SELLER_MERGED']);
  });

  it('R-SELL-1 b7 ownership-data/F1: a draft whose listing lost every seller is superseded, not left ready', async () => {
    const l = await sellerListing(agent());
    await reconcile(h, w.tenantId);
    const [draft] = await draftsOf(h, l.listingId);
    expect(draft!.status).toBe('proposed');
    expect((await listingCards(l.listingId)).filter((c) => c.state === 'open')).toHaveLength(1);

    // the seller link goes (no API unlinks a listing contact: the superuser removes the row)
    await h.su.query('DELETE FROM listing_contacts WHERE listing_id = $1', [l.listingId]);
    const r = await reconcile(h, w.tenantId);
    expect(r.retired).toBeGreaterThanOrEqual(1);

    const row = (await h.su.query<{ status: string; explanation: string }>('SELECT status, explanation FROM assistant_actions WHERE id = $1', [draft!.id])).rows[0]!;
    expect(row.status).toBe('superseded');
    expect(row.explanation.endsWith('Not sent: no seller is linked to this listing any more.')).toBe(true);
    expect(await dueAt(l.listingId)).toBeNull();
    const cards = await listingCards(l.listingId);
    expect(cards.filter((c) => c.state === 'open' || c.state === 'snoozed')).toHaveLength(0);
    expect(cards.find((c) => c.assistant_action_id === draft!.id)!.state).not.toBe('open');
    // a second pass changes nothing (no new draft for a listing with nobody to send to)
    await reconcile(h, w.tenantId);
    expect((await draftsOf(h, l.listingId)).map((d) => d.status)).toEqual(['superseded']);
  });
});

describe('b7 ownership-data/F2: a removed listing agent', () => {
  it("R-SELL-1 R-OWN-22 b7 ownership-data/F2: a removed listing agent's listing is held and the Owner/Admins are told", async () => {
    const x = await assistantWorld(h, { agents: 2, others: ['admin'] });
    const [a, b] = x.agents as [TestClient, TestClient];
    const admin = x.others[0]!;
    const l = await sellerListing(a);
    await reconcile(h, x.tenantId);
    const [first] = await draftsOf(h, l.listingId);
    expect(first).toMatchObject({ status: 'proposed', owner_user_id: a.userId });

    // the agent is suspended (the hold applies to any listing agent who is not active: listingAgent.ts
    // LISTING_AGENT_ACTIVE); a suspension keeps the listing with them, unlike the staged deactivation (below)
    await freshReauth(h, x.owner);
    const v = (await h.su.query<{ version: number }>('SELECT version FROM memberships WHERE tenant_id = $1 AND user_id = $2', [x.tenantId, a.userId])).rows[0]!.version;
    const sus = await call(x.owner, 'PATCH', `/members/${a.userId}`, { status: 'suspended', version: v });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect((await h.su.query('SELECT listing_agent_user_id AS u FROM listings WHERE id = $1', [l.listingId])).rows[0].u).toBe(a.userId);

    const r1 = await reconcile(h, x.tenantId);
    expect(r1.held).toBeGreaterThanOrEqual(1);
    const after1 = await draftsOf(h, l.listingId);
    expect(after1.find((d) => d.id === first!.id)!.status).toBe('invalidated');
    expect(after1.filter((d) => d.status === 'proposed')).toHaveLength(0);
    expect(after1.filter((d) => d.id !== first!.id)).toHaveLength(0); // no new draft for the suspended member
    // the instant was not advanced past now (held, not skipped)
    expect((await dueAt(l.listingId))!.getTime()).toBeLessThanOrEqual(Date.now());

    const key = `seller_update:${l.listingId}:agent-inactive`;
    const inactiveCards = async () => (await listingCards(l.listingId)).filter((c) => c.dedupe_key === key);
    const open1 = (await inactiveCards()).filter((c) => c.state === 'open');
    expect(open1.map((c) => c.user_id).sort()).toEqual([x.owner.userId, admin.userId].sort());
    for (const c of open1) {
      expect(c.reasons.map((y) => y.code)).toEqual(['LISTING_AGENT_INACTIVE']);
      expect(c.reasons[0]!.label).toContain(l.address);
    }
    // nobody else (in particular not the suspended agent nor the other agent) got the card
    expect((await inactiveCards()).every((c) => c.user_id === x.owner.userId || c.user_id === admin.userId)).toBe(true);

    // a second pass holds again but does not duplicate the cards
    const r2 = await reconcile(h, x.tenantId);
    expect(r2.held).toBeGreaterThanOrEqual(1);
    const all2 = await inactiveCards();
    expect(all2).toHaveLength(2);
    expect(all2.map((c) => c.id).sort()).toEqual(open1.map((c) => c.id).sort());
    expect((await draftsOf(h, l.listingId)).filter((d) => d.status === 'proposed')).toHaveLength(0);

    // the Owner hands the listing to an active agent; the next pass drafts the period for them and closes the cards
    const p = await call<{ listing: { listingAgentUserId: string } }>(x.owner, 'PATCH', `/listings/${l.listingId}/agent`, { listingAgentUserId: b.userId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.listing.listingAgentUserId).toBe(b.userId);
    const r3 = await reconcile(h, x.tenantId);
    expect(r3.drafted).toBeGreaterThanOrEqual(1);
    const fresh = (await draftsOf(h, l.listingId)).filter((d) => d.status === 'proposed');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.owner_user_id).toBe(b.userId);
    expect(fresh[0]!.trigger_ref['period_key']).toBe(first!.trigger_ref['period_key']); // the same period, not skipped
    const closed = await inactiveCards();
    expect(closed).toHaveLength(2);
    for (const c of closed) expect([c.state, c.resolved_by]).toEqual(['done', 'condition']);
    // the new agent has the ready card; their update is sendable by them
    const ready = (await listingCards(l.listingId)).filter((c) => c.state === 'open');
    expect(ready.map((c) => [c.user_id, c.reasons[0]!.code])).toEqual([[b.userId, 'SELLER_UPDATE_READY']]);
    const v2 = await call<{ update: UpdateT | null }>(b, 'GET', `/listings/${l.listingId}/seller-update`);
    expect(v2.body.update!.canSend).toBe(true);
  });

  it('R-SELL-1 R-OWN-22 E540: the staged deactivation now moves an open listing, so no hold and no Owner/Admin card', async () => {
    const x = await assistantWorld(h, { agents: 1, others: ['admin'] });
    const a = x.agents[0]!;
    const l = await sellerListing(a);
    await reconcile(h, x.tenantId);
    await freshReauth(h, x.owner);
    const run = await call(x.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    await leadsWorker(h).drain();
    expect((await h.su.query('SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [x.tenantId, a.userId])).rows[0].status).toBe('removed');
    // no Team Lead: the Owner who ran it takes the listing
    expect((await h.su.query('SELECT listing_agent_user_id AS u FROM listings WHERE id = $1', [l.listingId])).rows[0].u).toBe(x.owner.userId);
    const r = await reconcile(h, x.tenantId);
    expect(r.held).toBe(0);
    expect((await listingCards(l.listingId)).filter((c) => c.dedupe_key === `seller_update:${l.listingId}:agent-inactive`)).toHaveLength(0);
  });
});
