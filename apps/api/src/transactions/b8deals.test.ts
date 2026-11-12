// b8 deals review fixes over real Postgres: K1 (sends/F1, db-public/F1, ownership-data/F1-K1, ui/F1-K1) and the
// merge findings (sends/F5, ownership-data/F3, ownership-data/F5). Fakes only (the harness's fake email provider).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth } from '../leads/testing.js';
import { reconcileAndRun } from '../nurture/testing.js';
import { ownedContact } from '../comms/testing.js';
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
  it('E344 K1 sell deal: the seller gets the update, a buyer-role contact (the other side) gets nothing, and the deal screen says why', async () => {
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

  it('E344 K1 buy deal: a seller-role contact (the listing side\'s client) gets nothing', async () => {
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

  it('E344 K1 dual deal: both sides are the team\'s clients and both get the update', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'dual' });
    const seller = await dealContact(w.agents[0]!, d.dealId, 'seller', { firstName: 'Riley' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, seller.id].sort());
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(1);
    expect(mailTo(h, seller.email)).toHaveLength(1);
  });

  it('E345 K1 lease deal: no automatic milestone update to anyone, and the deal screen says so', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'lease' });
    const buyer = await dealContact(w.agents[0]!, d.dealId, 'buyer', { firstName: 'Drew' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, id)).toEqual([]);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, buyer.email)).toHaveLength(0);
    expect(mailTo(h, d.email)).toHaveLength(0);
    const u = (await updatesOf(d.dealId, id)).find((x) => x.contactId === buyer.id)!;
    expect(u.text).toMatch(/lease deals get no automatic client updates/);
  });

  it('E346 K1 send time: a planned recipient re-added later in the other side\'s client role gets nothing (NOT_OUR_CLIENT, re-read live)', async () => {
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

const merge = async (survivorId: string, loserId: string) => {
  await freshReauth(h, w.owner);
  const r = await command(w.owner, survivorId, 'merge', { loserId });
  if (r.status !== 200) throw new Error(`merge: ${r.status} ${JSON.stringify(r.body)}`);
};
const roleOf = async (dealId: string, contactId: string) => (await h.su.query<{ role: string }>('SELECT role FROM deal_contacts WHERE deal_id = $1 AND contact_id = $2', [dealId, contactId])).rows[0]?.role ?? null;

describe('b8 deals sends/F5 ownership-data/F3 ownership-data/F5 R-OWN-24 R-TXN-4: a planned milestone update follows a merged person', () => {
  it('E350 ownership-data/F5 sends/F5(b): a merge keeps the stronger deal role (the loser\'s co_buyer beats the survivor\'s other), so the person still gets updates', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Lee' });
    const survivor = await dealContact(w.agents[0]!, d.dealId, 'other', { firstName: 'Lee' });
    await merge(survivor.id, loser.id);
    expect(await roleOf(d.dealId, survivor.id)).toBe('co_buyer');
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, survivor.id].sort());
  });

  it('E350 ownership-data/F5: the role rank follows the side: on a sell deal the loser\'s seller beats the survivor\'s (other-side) buyer, and a client role never yields to lender', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'sell' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_seller', { firstName: 'Kim' });
    const survivor = await dealContact(w.agents[0]!, d.dealId, 'buyer', { firstName: 'Kim' });
    await merge(survivor.id, loser.id);
    expect(await roleOf(d.dealId, survivor.id)).toBe('co_seller');
    const d2 = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const l2 = await dealContact(w.agents[0]!, d2.dealId, 'lender', { firstName: 'Ash' });
    const s2 = await dealContact(w.agents[0]!, d2.dealId, 'co_buyer', { firstName: 'Ash' });
    await merge(s2.id, l2.id);
    expect(await roleOf(d2.dealId, s2.id)).toBe('co_buyer');
  });

  it('E349 sends/F5(a) ownership-data/F3 M2: merged after planning, before sending: the update is planned again for the survivor and sent once; the deal screen says so', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Rowan' });
    const survivor = await ownedContact(w.agents[0]!, { consent: false, firstName: 'Rowan' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, loser.id].sort());
    await merge(survivor.id, loser.id);
    expect(await roleOf(d.dealId, survivor.id)).toBe('co_buyer');
    await reconcile(h, w.tenantId);
    const runs = await runsOfDate(h, id);
    expect(runs.find((r) => r.contact_id === loser.id)!.status).toBe('skipped_ineligible');
    expect(runs.filter((r) => r.contact_id === survivor.id)).toHaveLength(1);
    await reconcileAndRun(h, w.tenantId);
    await reconcile(h, w.tenantId); // a second pass plans nothing new
    await reconcileAndRun(h, w.tenantId);
    expect((await runsOfDate(h, id)).filter((r) => r.contact_id === survivor.id).map((r) => r.status)).toEqual(['sent']);
    expect(mailTo(h, survivor.email).length + mailTo(h, loser.email).length).toBe(1);
    const u = (await updatesOf(d.dealId, id)).find((x) => x.contactId === survivor.id)!;
    expect(u.status).toBe('sent');
  });

  it('E349 ownership-data/F3 M1: sent, then merged: nothing is sent again, and the deal screen says the update was sent (not "nothing planned")', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Blair' });
    const survivor = await ownedContact(w.agents[0]!, { consent: false, firstName: 'Blair' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, loser.email)).toHaveLength(1);
    await merge(survivor.id, loser.id);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect((await runsOfDate(h, id)).filter((r) => r.contact_id === survivor.id)).toEqual([]);
    expect(mailTo(h, survivor.email).length + mailTo(h, loser.email).length).toBe(1);
    const u = (await updatesOf(d.dealId, id)).find((x) => x.contactId === survivor.id)!;
    expect(u.status).toBe('sent');
    expect(u.text).toMatch(/merged into this one/);
  });

  it('E349 b8 review correctness: a merged record whose update is mid-dispatch (dispatch_unknown) counts as sent: nothing is planned again', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Noor' });
    const survivor = await ownedContact(w.agents[0]!, { consent: false, firstName: 'Noor' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    const run = (await runsOfDate(h, id)).find((r) => r.contact_id === loser.id)!;
    // fixture: the provider timed out in dispatch TX2, so the run was never written back and the message is unknown
    await h.su.query("UPDATE playbook_step_runs SET status = 'scheduled' WHERE id = $1", [run.id]);
    await h.su.query("UPDATE messages SET status = 'dispatch_unknown' WHERE playbook_step_run_id = $1", [run.id]);
    await merge(survivor.id, loser.id);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect((await runsOfDate(h, id)).filter((r) => r.contact_id === survivor.id)).toEqual([]);
    expect((await updatesOf(d.dealId, id)).find((x) => x.contactId === survivor.id)!.status).toBe('sent');
  });

  it('E349 b8 review correctness: a merged record\'s run still scheduled (the merge follow-up has not skipped it yet) does not stop the re-plan', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Ira' });
    const survivor = await ownedContact(w.agents[0]!, { consent: false, firstName: 'Ira' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    await merge(survivor.id, loser.id);
    const run = (await runsOfDate(h, id)).find((r) => r.contact_id === loser.id)!;
    await h.su.query("UPDATE playbook_step_runs SET status = 'scheduled', trigger_ref = trigger_ref - 'skip' WHERE id = $1", [run.id]); // fixture: a non-tenant-wide merge skips it later, in its follow-up job
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).filter((r) => r.contact_id === survivor.id)).toHaveLength(1);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, survivor.email).length + mailTo(h, loser.email).length).toBe(1);
  });

  it('E349 b8 review honest-copy: merged, then moved to the other side: the screen gives the real reason, never "planned again", and the pass notes it once', async () => {
    const d = await deal(h, w, w.agents[0]!, { side: 'buy' });
    const loser = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Tao' });
    const survivor = await ownedContact(w.agents[0]!, { consent: false, firstName: 'Tao' });
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    await merge(survivor.id, loser.id);
    expect((await call(w.agents[0]!, 'POST', `/deals/${d.dealId}/contacts`, { contactId: survivor.id, role: 'seller' })).status).toBe(200);
    await reconcile(h, w.tenantId);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).filter((r) => r.contact_id === survivor.id)).toEqual([]);
    const basis = (await h.su.query<{ b: Record<string, Record<string, { status: string }>> }>('SELECT basis AS b FROM deal_dates WHERE id = $1', [id])).rows[0]!.b;
    expect(Object.values(basis['mergedUpdates']!).map((x) => x.status)).toEqual(['not_planned']);
    for (const viewer of [w.owner, w.tc]) {
      const u = (await call<{ dates: { id: string; updates: { contactId: string; text: string }[] }[] }>(viewer, 'GET', `/deals/${d.dealId}/milestones`)).body.dates.find((x) => x.id === id)!.updates.find((x) => x.contactId === survivor.id)!;
      expect(u.text).toMatch(/not this team's client on a buy deal/);
    }
  });
});

