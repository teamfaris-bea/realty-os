// secreview: R-PAR-8 a tag whose name matches the fair-housing proxy lexicon is protected_proxy. A rename
// (PATCH /tags/:id) never re-classifies, so an Admin can turn an unprotected, bulk-applied tag into a
// lexicon-named proxy tag that stays unprotected (bulk audience, bulk apply, pond card, assistant input).
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, listsWorld, type ListsWorld, makeTag, run } from '../lists/testing.js';
import { addContactTags } from '../lists/writers.js';

let h: ApiHarness;
let w: ListsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview: tag rename and protected proxies (R-PAR-8)', () => {
  it('R-PAR-8 renaming a tag to a lexicon name makes it protected (as creating it does), so it is never applied in bulk afterwards', async () => {
    // control: the same name typed fresh is protected
    expect((await makeTag(w.agentA, 'Veteran buyers')).protected).toBe(true);
    const hot = await makeTag(w.agentA, 'Spring list');
    expect(hot.protected).toBe(false);
    // bulk-applied while innocuous
    await withTenantTx(w.agentA.actor(), (tx) => addContactTags(tx, w.aContacts[0]!, [hot.id], { kind: 'bulk', userId: w.agentA.userId! }), { db: h.database });
    const ren = await call<{ tag: { name: string; protected: boolean } }>(w.admin, 'PATCH', `/tags/${hot.id}`, { name: 'VA buyer' });
    expect(ren.status).toBe(200);
    expect(ren.body.tag.name).toBe('VA buyer');
    expect(ren.body.tag.protected).toBe(true); // FAILS: false
    // and the lexicon-named tag can still be applied in bulk / define a bulk audience
    await expect(withTenantTx(w.agentA.actor(), (tx) => addContactTags(tx, w.aContacts[1]!, [hot.id], { kind: 'bulk', userId: w.agentA.userId! }), { db: h.database })).rejects.toThrow(/AUDIENCE_PROTECTED_PROXY/);
    const q = await run(w.owner, { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [hot.id] }] });
    expect(q.body.audienceProtected).toBe(true);
  });
});
