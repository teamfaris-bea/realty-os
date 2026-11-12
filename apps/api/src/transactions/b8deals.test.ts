// b8 deals review fixes over real Postgres: K1 (sends/F1, db-public/F1, ownership-data/F1-K1, ui/F1-K1) and the
// merge findings (sends/F5, ownership-data/F3, ownership-data/F5). Fakes only (the harness's fake email provider).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { reconcileAndRun } from '../nurture/testing.js';
import { type TxnWorld, approveUpdates, call, confirmDueSoon, deal, dealContact, enterDate, localDay, mailTo, milestones, reconcile, runsOfDate, txnWorld } from './testing.js';

let h: ApiHarness;
let w: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await txnWorld(h);
  expect((await approveUpdates(w.owner)).versionId).toBeDefined(); // the built-in step: buyer, seller, co_buyer, co_seller
});
afterAll(async () => {
  await h?.close();
});

async function dueDate(d: { dealId: string }, kind = 'closing'): Promise<string> {
  const e = await enterDate(w.agents[0]!, d.dealId, kind, localDay(w.zone, 20));
  expect(e.status).toBe(201);
  expect((await confirmDueSoon(w.tc, e.body.date.id, w.zone)).status).toBe(200);
  return e.body.date.id;
}

const updatesOf = async (dealId: string, dateId: string) => (await milestones(w.tc, dealId)).body.dates.find((x) => x.id === dateId)!.updates;

describe('b8 deals sends/F1 db-public/F1 ownership-data/F1-K1 ui/F1-K1 R-TXN-4: milestone updates go only to the team\'s side', () => {
  it('K1 sell deal: the seller gets the update, a buyer-role contact (the other side) gets nothing, and the deal screen says why', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'sell' });
    const otherBuyer = await dealContact(w.agents[0]!, d.dealId, 'buyer', { firstName: 'Morgan' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id)).toEqual([d.contactId]);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(1);
    expect(mailTo(h, otherBuyer.email)).toHaveLength(0);
    const u = (await updatesOf(d.dealId, id)).find((x) => x.contactId === otherBuyer.id)!;
    expect(u.status).toBe('not_planned');
    expect(u.text).toMatch(/not this team's client on a sell deal/);
  });

  it('K1 buy deal: a seller-role contact (the listing side\'s client) gets nothing', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const otherSeller = await dealContact(w.agents[0]!, d.dealId, 'seller', { firstName: 'Jordan' });
    const coBuyer = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Casey' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, coBuyer.id].sort());
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, otherSeller.email)).toHaveLength(0);
    expect(mailTo(h, coBuyer.email)).toHaveLength(1);
  });

  it('K1 dual deal: both sides are the team\'s clients and both get the update', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'dual' });
    const seller = await dealContact(w.agents[0]!, d.dealId, 'seller', { firstName: 'Riley' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, seller.id].sort());
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(1);
    expect(mailTo(h, seller.email)).toHaveLength(1);
  });

  it('K1 lease deal: no automatic milestone update to anyone, and the deal screen says so', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'lease' });
    const buyer = await dealContact(w.agents[0]!, d.dealId, 'buyer', { firstName: 'Drew' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, id)).toEqual([]);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, buyer.email)).toHaveLength(0);
    expect(mailTo(h, d.email)).toHaveLength(0);
    const u = (await updatesOf(d.dealId, id)).find((x) => x.contactId === buyer.id)!;
    expect(u.text).toMatch(/lease deals get no automatic milestone updates/);
  });

  it('K1 send time: a planned recipient re-added later in the other side\'s client role gets nothing (NOT_OUR_CLIENT, re-read live)', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const co = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Sam' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, id)).toHaveLength(2);
    // the TC corrects the role: this person is the seller (the other side), through the real route
    expect((await call(w.agents[0]!, 'POST', `/deals/${d.dealId}/contacts`, { contactId: co.id, role: 'seller' })).status).toBe(200);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, co.email)).toHaveLength(0);
    const r = (await runsOfDate(h, id)).find((x) => x.contact_id === co.id)!;
    expect(r.status).toBe('skipped_ineligible');
    expect((r.trigger_ref['skip'] as { reason: string }).reason).toBe('NOT_OUR_CLIENT');
  });

  it('K1 the deal screen lists only the roles this side can reach', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'sell' });
    const m = await milestones(w.tc, d.dealId);
    expect((m.body.updates as unknown as { teamRoles: string[] }).teamRoles).toEqual(['seller', 'co_seller']);
  });
});
