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

describe('R-CMA-8: a merged-away record\'s CMAs (db-public/F1, db-public/F2, ownership-data/F4)', () => {
  /** `by` (the Owner unless said) merges `loser` into `survivor`, the agent keeping the person (the agent's own duplicate). */
  async function merge(survivor: string, loser: string, by = w.owner): Promise<void> {
    const { command } = await import('../leads/testing.js');
    const m = await command(by, survivor, 'merge', { loserId: loser, ownerChoice: w.agents[0]!.userId });
    expect(m.status).toBe(200);
  }
  /** A second record of the same person with the same home address (a duplicate of agents[0]). */
  async function duplicate(line1: string): Promise<string> {
    const s = await contact(w.agents[0]!, 'Pat Survivor');
    await address(h, w.tenantId, s, { kind: 'property', line1 });
    return s;
  }
  type Summary = { id: string; contactId: string; status: string; fromMergedRecord: boolean; canEdit: boolean };
  const list = (client: typeof w.owner, c: string) => call<{ cmas: Summary[] }>(client, 'GET', `/contacts/${c}/cmas`);
  const mergedInto = (r: { body: unknown }) => (r.body as { error: { details?: { mergedInto?: string } } }).error.details?.mergedInto;

  it('R-CMA-8 R-PERM-5: after a merge the creator still lists and opens their CMA of the merged-away record (read-only), and a PATCH is CONTACT_MERGED for them and for the Owner', async () => {
    const { c: loser, line1 } = await seller();
    const survivor = await duplicate(line1);
    const d = await oneTap(w.agents[0]!, loser);
    expect(d.status).toBe(201);
    await merge(survivor, loser);
    // contacts RLS now hides the closed, unowned loser from its former agent
    expect((await call(w.agents[0]!, 'GET', `/contacts/${loser}`)).status).toBe(404);
    const mine = await list(w.agents[0]!, survivor);
    expect(mine.status).toBe(200);
    expect(mine.body.cmas.find((x) => x.id === d.body.cma.id)).toMatchObject({ contactId: loser, fromMergedRecord: true, status: 'draft', canEdit: false });
    const v = await get(w.agents[0]!, d.body.cma.id);
    expect([v.status, v.body.cma.canEdit]).toEqual([200, false]);
    for (const client of [w.agents[0]!, w.owner]) {
      const p = await patch(client, d.body.cma.id, { notes: 'after the merge' });
      expect([client.role, p.status, p.code, mergedInto(p)]).toEqual([client.role, 409, 'CONTACT_MERGED', survivor]);
    }
    expect((await h.su.query('SELECT contact_id, status, agent_notes FROM cma_reports WHERE id = $1', [d.body.cma.id])).rows[0]).toEqual({ contact_id: loser, status: 'draft', agent_notes: null });
    // the Owner lists it too, and nobody else reaches it through the survivor
    expect((await list(w.owner, survivor)).body.cmas.find((x) => x.id === d.body.cma.id)).toMatchObject({ fromMergedRecord: true, canEdit: false });
    expect((await get(w.agents[1]!, d.body.cma.id)).status).toBe(404);
  });

  it('F15 R-CMA-8: one creator never holds two open drafts for one home across the person: a tap on the survivor supersedes their merged-away draft, and a merge supersedes one that collides; another person\'s draft is untouched', async () => {
    const a = await seller();
    const aSurvivor = await duplicate(a.line1);
    const onLoser = await oneTap(w.agents[0]!, a.c);
    const teamLeads = await oneTap(w.teamLead, a.c);
    await merge(aSurvivor, a.c);
    expect((await statusOf(onLoser.body.cma.id)).status).toBe('draft'); // nothing collided: the merge moves nothing
    const onSurvivor = await oneTap(w.agents[0]!, aSurvivor);
    expect(onSurvivor.status).toBe(201);
    expect((await statusOf(onLoser.body.cma.id)).status).toBe('superseded');
    expect((await statusOf(teamLeads.body.cma.id)).status).toBe('draft');
    expect((await list(w.agents[0]!, aSurvivor)).body.cmas.filter((x) => x.status === 'draft').map((x) => x.id)).toEqual([onSurvivor.body.cma.id]);

    const b = await seller();
    const bSurvivor = await duplicate(b.line1);
    const bLoser = await oneTap(w.agents[0]!, b.c);
    const bKept = await oneTap(w.agents[0]!, bSurvivor);
    await merge(bSurvivor, b.c);
    expect((await statusOf(bLoser.body.cma.id)).status).toBe('superseded');
    expect((await statusOf(bKept.body.cma.id)).status).toBe('draft');
    expect((await list(w.agents[0]!, bSurvivor)).body.cmas.filter((x) => x.status === 'draft').map((x) => x.id)).toEqual([bKept.body.cma.id]);

    // a Team Lead's merge: the move (and this rule with it) runs in the ownership follow-up, as the system
    const t = await seller();
    const tSurvivor = await duplicate(t.line1);
    const tLoser = await oneTap(w.agents[0]!, t.c);
    const tKept = await oneTap(w.agents[0]!, tSurvivor);
    await merge(tSurvivor, t.c, w.teamLead);
    expect((await statusOf(tLoser.body.cma.id)).status).toBe('draft'); // not yet: the follow-up has not run
    const { leadsWorker } = await import('../leads/testing.js');
    await leadsWorker(h).drain();
    expect([(await statusOf(tLoser.body.cma.id)).status, (await statusOf(tKept.body.cma.id)).status]).toEqual(['superseded', 'draft']);
  });

  /** The open drafts of `creator` for the home on any of `records` (the person's records), oldest first. */
  const creatorsOpen = async (creator: string, records: string[]) =>
    (await h.su.query<{ id: string }>("SELECT id FROM cma_reports WHERE contact_id = ANY ($1::uuid[]) AND created_by_user_id = $2 AND status = 'draft' ORDER BY created_at, id", [records, creator])).rows.map((x) => x.id);

  it('F15 R-CMA-8: across two merges (A into B, then B into C) a tap on C supersedes the creator\'s draft of A, which their own RLS cannot trace past the closed B, and the person lists one open draft of theirs for the home (re-review ownership-data/F4)', async () => {
    const a = await seller();
    const b = await duplicate(a.line1);
    const c = await duplicate(a.line1);
    const dA = await oneTap(w.agents[0]!, a.c);
    expect(dA.status).toBe(201);
    await merge(b, a.c);
    await merge(c, b);
    expect((await statusOf(dA.body.cma.id)).status).toBe('draft'); // nothing collided: the merges move nothing
    // the agent's own list stops at B (db-public/F1's residual): their draft of A is not in it
    expect((await list(w.agents[0]!, c)).body.cmas.map((x) => x.id)).not.toContain(dA.body.cma.id);
    const dC = await oneTap(w.agents[0]!, c);
    expect(dC.status).toBe(201);
    expect((await statusOf(dA.body.cma.id)).status).toBe('superseded');
    expect(await creatorsOpen(w.agents[0]!.userId!, [a.c, b, c])).toEqual([dC.body.cma.id]);
    const owners = await list(w.owner, c);
    expect(owners.body.cmas.filter((x) => x.status === 'draft').map((x) => x.id)).toEqual([dC.body.cma.id]);
    expect(owners.body.cmas.find((x) => x.id === dA.body.cma.id)).toMatchObject({ status: 'superseded', fromMergedRecord: true, canEdit: false });
  });

  it('F15 R-CMA-8: a merge supersedes an open draft on a record merged into the loser earlier when its creator holds one for the home on the survivor; a draft of that record no one else holds stays (re-review ownership-data/F4)', async () => {
    const a = await seller();
    const b = await duplicate(a.line1);
    const c = await duplicate(a.line1);
    const dA = await oneTap(w.agents[0]!, a.c);
    const dC = await oneTap(w.agents[0]!, c);
    const teamLeads = await oneTap(w.teamLead, a.c);
    await merge(b, a.c);
    expect((await statusOf(dA.body.cma.id)).status).toBe('draft'); // B holds no draft of theirs: nothing collided
    await merge(c, b);
    expect([(await statusOf(dA.body.cma.id)).status, (await statusOf(dC.body.cma.id)).status, (await statusOf(teamLeads.body.cma.id)).status]).toEqual(['superseded', 'draft', 'draft']);
    expect(await creatorsOpen(w.agents[0]!.userId!, [a.c, b, c])).toEqual([dC.body.cma.id]);
    expect((await list(w.owner, c)).body.cmas.filter((x) => x.status === 'draft').map((x) => x.id).sort()).toEqual([dC.body.cma.id, teamLeads.body.cma.id].sort());
  });
});
