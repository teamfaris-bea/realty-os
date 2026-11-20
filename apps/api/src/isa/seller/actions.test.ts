// The seller panel says which of its own actions the server would accept from THIS viewer right now (R-ISA-35; E1007,
// E1008): the web draws a control only when `actions.<name>.available` is true, and each route still decides for itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { mlsSale } from '../../cma/testing.js';
import { call, isaLead } from '../testing.js';
import { onEscalationInTx } from './index.js';
import { type SellerWorld, asSystem, confirm, sellerLead, sellerWorld } from './testing.js';

let h: ApiHarness;
let w: SellerWorld;
const fw = () => ({ h, tenantId: w.tenantId, mls: w.mls });

interface Action { available: boolean; reason: string | null }
interface Actions { confirmSubject: Action; subjectDisputed: Action; nearMatchDifferent: Action & { listingIds: string[] }; resumeComps: Action }
const actions = async (c: Parameters<typeof call>[0], contactId: string) => (await call<{ actions: Actions }>(c, 'GET', `/contacts/${contactId}/ai-isa/seller`)).body.actions;
const on = (a: Actions) => Object.entries(a).filter(([, v]) => v.available).map(([k]) => k).sort();

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-35 the seller panel offers only what its routes would accept', () => {
  it('E1007: an unconfirmed home: the owner may confirm it; nobody may dispute or resume what is not there; a Team Lead may do none of it', async () => {
    const l = await sellerLead(h, w);
    const mine = await actions(w.agents[0]!, l.id);
    expect(on(mine)).toEqual(['confirmSubject']);
    expect(mine.subjectDisputed.reason).toBe('The owner has not confirmed the home yet.');
    expect(mine.resumeComps.reason).toBe('Recent sales are not paused.');
    expect(mine.nearMatchDifferent).toEqual({ available: false, reason: 'No live listing may be this home.', listingIds: [] });
    const lead = await actions(w.teamLead!, l.id);
    expect(on(lead)).toEqual([]);
    expect(lead.confirmSubject.reason).toBe('Only the lead’s owner confirms the home.');
    // the routes agree with the panel
    expect((await call(w.teamLead!, 'POST', `/contacts/${l.id}/ai-isa/seller/resume-comps`, {})).status).toBeGreaterThanOrEqual(400);
    expect((await confirm(w, l)).status).toBe(200);
  });

  it('E1007: once confirmed, Confirm is gone and anyone who may pause may say "that is not their home"; after that the owner confirms again', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    expect(on(await actions(w.agents[0]!, l.id))).toEqual(['subjectDisputed']);
    expect((await actions(w.agents[0]!, l.id)).confirmSubject.reason).toBe('The home is confirmed.');
    expect(on(await actions(w.teamLead!, l.id))).toEqual(['subjectDisputed']);
    expect((await call(w.teamLead!, 'POST', `/contacts/${l.id}/ai-isa/seller/subject-disputed`, {})).status).toBe(200);
    const after = await actions(w.agents[0]!, l.id);
    expect(on(after)).toEqual(['confirmSubject']);
    expect(after.subjectDisputed.reason).toBe('The home is already marked as not theirs.');
    expect((await confirm(w, l)).status).toBe(200);
    expect(on(await actions(w.agents[0]!, l.id))).toEqual(['subjectDisputed']);
  });

  it('E1008: a live listing that may be this home: the owner (only) may say it is a different home, with the listing ids the route accepts', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const near = await mlsSale(fw(), { status: 'active', line1: l.line1, line2: 'Unit 2', beds: 3, sqft: 1500 });
    const mine = await actions(w.agents[0]!, l.id);
    expect(mine.nearMatchDifferent).toEqual({ available: true, reason: null, listingIds: [near] });
    expect((await actions(w.teamLead!, l.id)).nearMatchDifferent).toMatchObject({ available: false, reason: 'Only the lead’s owner can say it is a different home.' });
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/near-match-different`, { listingIds: mine.nearMatchDifferent.listingIds })).status).toBe(200);
    expect((await actions(w.agents[0]!, l.id)).nearMatchDifferent.available).toBe(false);
  });

  it('E1008: recent sales paused by a price question: the owner (only) may let the assistant keep sharing; after the tap the control is gone', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    await asSystem(h, w, l, (tx, a, actor) => onEscalationInTx(tx, a, 'pricing_negotiation', actor));
    expect((await actions(w.agents[0]!, l.id)).resumeComps).toEqual({ available: true, reason: null });
    expect((await actions(w.teamLead!, l.id)).resumeComps).toEqual({ available: false, reason: 'Only the lead’s owner can let the assistant keep sharing recent sales.' });
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/resume-comps`, {})).status).toBe(200);
    expect((await actions(w.agents[0]!, l.id)).resumeComps.available).toBe(false);
  });

  it('a lead who is not under seller care offers nothing, and says why once', async () => {
    const l = await isaLead(h, w.agents[0]!);
    const a = await actions(w.agents[0]!, l.id);
    expect(on(a)).toEqual([]);
    for (const v of Object.values(a)) expect(v.reason).toBe('This lead is not under seller AI care.');
  });
});
