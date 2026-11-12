// F15 R-CMA-8 after the batch 10 review: an open draft stays honest when its contact's address is deleted and put back
// (db-public/F3, ownership-data/F3), and when its contact is merged away (db-public/F1, db-public/F2, ownership-data/F4):
// the view never offers an edit that must fail, and one person never holds two open drafts of one creator for one home.
// Fakes only: MLS rows are RESO fixtures stored through V1-A's sync; nothing is sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  await localSales(w, 8);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

let n = 0;
/** A seller contact of `agent` with a property address whose earlier sale is in the MLS. */
async function seller(agent = w.agents[0]!) {
  n += 1;
  const c = await contact(agent);
  const line1 = `${1600 + n} Sample Avenue`;
  const addr = await address(h, w.tenantId, c, { kind: 'property', line1 });
  await mlsSale(w, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
  return { c, addr, line1 };
}

type View = CmaBody['cma'] & { canEdit: boolean; subject: CmaBody['cma']['subject'] & { contactAddressId: string | null } };
const get = (client: typeof w.owner, id: string) => call<{ cma: View }>(client, 'GET', `/cma/${id}`);
const patch = (client: typeof w.owner, id: string, body: Record<string, unknown>) => call<{ cma: View }>(client, 'PATCH', `/cma/${id}`, body);
const openDrafts = async (c: string) => (await h.su.query<{ id: string; contact_address_id: string | null }>("SELECT id, contact_address_id FROM cma_reports WHERE contact_id = $1 AND status = 'draft' ORDER BY created_at", [c])).rows;
const statusOf = async (id: string) => (await h.su.query<{ status: string; contact_address_id: string | null }>('SELECT status, contact_address_id FROM cma_reports WHERE id = $1', [id])).rows[0]!;

async function deleteAddress(c: string, addr: string): Promise<string> {
  const r = await call<{ ok: true; restoreToken: string }>(w.agents[0]!, 'DELETE', `/contacts/${c}/addresses/${addr}`);
  expect(r.status).toBe(200);
  return r.body.restoreToken;
}
async function undo(c: string, addr: string, token: string): Promise<void> {
  const r = await call(w.agents[0]!, 'POST', `/contacts/${c}/addresses/${addr}/restore`, { restoreToken: token });
  expect(r.status).toBe(201);
}

describe('F15: a draft whose address is deleted, and the Undo (db-public/F3, ownership-data/F3)', () => {
  it('F15 R-CMA-8: once its address is deleted the draft S0 keeps open is read-only in the view, and PATCH says why (CMA_SUBJECT_ADDRESS_GONE), never a bare 404', async () => {
    const { c, addr } = await seller();
    const d1 = await oneTap(w.agents[0]!, c);
    expect(d1.status).toBe(201);
    await deleteAddress(c, addr);
    expect(await statusOf(d1.body.cma.id)).toEqual({ status: 'draft', contact_address_id: null });
    const v = await get(w.agents[0]!, d1.body.cma.id);
    expect(v.status).toBe(200);
    expect([v.body.cma.status, v.body.cma.subject.contactAddressId, v.body.cma.canEdit]).toEqual(['draft', null, false]);
    const p = await patch(w.agents[0]!, d1.body.cma.id, { notes: 'after the delete' });
    expect([p.status, p.code]).toEqual([409, 'CMA_SUBJECT_ADDRESS_GONE']);
    expect((p.body as unknown as { error: { details: { sentence: string } } }).error.details.sentence).toBe('The home’s address was deleted from this contact, so this CMA can’t be re-run. Prepare a new CMA for the home.');
  });

  it('F15: after the Undo the same draft is editable again and the next one-tap returns it, linked to its address again: one open draft for the home', async () => {
    const { c, addr } = await seller();
    const d1 = await oneTap(w.agents[0]!, c);
    await undo(c, addr, await deleteAddress(c, addr));
    expect((await get(w.agents[0]!, d1.body.cma.id)).body.cma.canEdit).toBe(true);
    const again = await oneTap(w.agents[0]!, c);
    expect([again.status, again.body.cma.id]).toEqual([200, d1.body.cma.id]);
    expect(await openDrafts(c)).toEqual([{ id: d1.body.cma.id, contact_address_id: addr }]);
  });

  it('F15: after the Undo, a one-tap on changed data supersedes the address-less draft, an explicit prepare does too, and a PATCH re-links the draft it edits', async () => {
    const tapped = await seller();
    const d1 = await oneTap(w.agents[0]!, tapped.c);
    await undo(tapped.c, tapped.addr, await deleteAddress(tapped.c, tapped.addr));
    await mlsSale(w, { closeDate: daysAgo(1), sqft: 1500, closePriceCents: 51_000_000 }); // the data changed since
    const d2 = await oneTap(w.agents[0]!, tapped.c);
    expect(d2.status).toBe(201);
    expect((await statusOf(d1.body.cma.id)).status).toBe('superseded');
    expect(await openDrafts(tapped.c)).toEqual([{ id: d2.body.cma.id, contact_address_id: tapped.addr }]);

    const prepared = await seller();
    const d3 = await oneTap(w.agents[0]!, prepared.c);
    await undo(prepared.c, prepared.addr, await deleteAddress(prepared.c, prepared.addr));
    const d4 = await call<CmaBody>(w.agents[0]!, 'POST', '/cma', { purpose: 'listing_price', contactId: prepared.c, subject: { kind: 'contact_address', contactAddressId: prepared.addr } });
    expect(d4.status).toBe(201);
    expect((await statusOf(d3.body.cma.id)).status).toBe('superseded');
    expect(await openDrafts(prepared.c)).toEqual([{ id: d4.body.cma.id, contact_address_id: prepared.addr }]);

    const patched = await seller();
    const d5 = await oneTap(w.agents[0]!, patched.c);
    await undo(patched.c, patched.addr, await deleteAddress(patched.c, patched.addr));
    const p = await patch(w.agents[0]!, d5.body.cma.id, { notes: 'after the Undo' });
    expect(p.status).toBe(200);
    expect(await statusOf(d5.body.cma.id)).toEqual({ status: 'draft', contact_address_id: patched.addr });
    expect((await oneTap(w.agents[0]!, patched.c)).body.cma.id).toBe(d5.body.cma.id);
    expect(await openDrafts(patched.c)).toHaveLength(1);
  });
});
