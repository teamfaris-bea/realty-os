// Competing listings for a seller: each feed's own attribution and disclaimer, and the channel (ISA-3 scope 7; R-ISA-17,
// R-ISA-18, R-MLS-2; E536, E537; batch 13 audit F4, F5). Real Postgres through the API harness; fakes only; nothing is
// sent (AI_ISA_LIVE_SENDS, TELEPHONY_LIVE_REQUESTS and MLS_LIVE_CALLS stay false).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { cmaPack, feedLastSyncedAt, localSales, mlsSale, saleReso, syncSales } from '../../cma/testing.js';
import { TEST_ATTRIBUTION, TEST_DISCLAIMER } from '../../mls/testing.js';
import { buildCompsInTx } from './comps.js';
import { smsFits } from './competition.js';
import { sellerFactsCurrentInTx, sellerRerenderInTx } from './index.js';
import { PRINTABLE_STATEMENTS, asSystem, confirm, nowInstant, policyChannels, queueFactsAs, secondFeed, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

const messageOf = async (id: string) => (await h.su.query<{ channel: string; body: string }>('SELECT channel, body FROM messages WHERE id = $1', [id])).rows[0]!;
const factsOf = async (id: string) => (await h.su.query<{ mls_connection_id: string }>('SELECT mls_connection_id FROM ai_isa_shared_facts WHERE message_id = $1', [id])).rows;

describe('E536 R-MLS-2 (ISA-3 audit F4): competition from two feeds', () => {
  it('E536 R-MLS-2: a competitor from a second MLS feed carries that feed\'s own attribution and disclaimer, each once', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    const second = { attribution: 'Listing information from the second test MLS (test attribution).', disclaimer: 'Second feed: information deemed reliable (test disclaimer).' };
    const mls2 = await secondFeed(h, w, second);
    await mlsSale({ h, tenantId: w.tenantId, mls: w.mls }, { status: 'active', line1: '320 Rival St', beds: 3, sqft: 1500, listPriceCents: 52_000_000 });
    await mlsSale({ h, tenantId: w.tenantId, mls: mls2 }, { status: 'active', line1: '321 Rival St', beds: 3, sqft: 1500, listPriceCents: 53_000_000 });
    expect((await confirm(w, l)).status).toBe(200);
    const id = await queueFactsAs(h, w, l, ['C1', 'C2'], 'email');
    expect(id).not.toBeNull();
    expect(new Set((await factsOf(id!)).map((f) => f.mls_connection_id))).toEqual(new Set([w.mls, mls2]));
    const m = await messageOf(id!);
    for (const t of [TEST_ATTRIBUTION, TEST_DISCLAIMER, second.attribution, second.disclaimer]) expect(m.body.split(t).length - 1).toBe(1);
  });
});

describe('E536 R-ISA-18 (ISA-3 audit F4): comps from two feeds', () => {
  it('E536 R-ISA-18: a comp set from two MLS feeds carries each feed\'s attribution and disclaimer once, each fact its own feed\'s as-of, and the earlier sync as the email\'s', async () => {
    // the first feed may be 72 hours old; it synced two days before the second
    const w = await sellerWorld(h, { pack: cmaPack({ valuation: { ai_isa_comps: true }, maxStalenessHours: 72 }) });
    const second = { attribution: 'Sales information from the second test MLS (test attribution).', disclaimer: 'Second feed: sales deemed reliable (test disclaimer).' };
    const mls2 = await secondFeed(h, w, second);
    const l = await sellerLead(h, w, { comps: 4 });
    await localSales({ h, tenantId: w.tenantId, mls: mls2 }, 4);
    const earlier = new Date(Date.now() - 2 * 86_400_000);
    await feedLastSyncedAt({ h, mls: w.mls }, earlier);
    expect((await confirm(w, l)).status).toBe(200);
    const r = await withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ok = r as Extract<typeof r, { ok: true }>;
    expect(new Set(ok.pendingFacts.map((f) => f.connectionId))).toEqual(new Set([w.mls, mls2]));
    for (const t of [TEST_ATTRIBUTION, TEST_DISCLAIMER, second.attribution, second.disclaimer]) expect(ok.body.split(t).length - 1).toBe(1);
    const synced = new Map((await h.su.query<{ id: string; t: Date }>('SELECT id, last_synced_at AS t FROM integration_connections WHERE id = ANY ($1::uuid[])', [[w.mls, mls2]])).rows.map((x) => [x.id, x.t.getTime()]));
    for (const f of ok.pendingFacts) expect(f.asOf).toBe(synced.get(f.connectionId));
    const label = (t: Date) => t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(ok.body).toContain(`, as of ${label(earlier)}.`);
  });
});

describe('R-ISA-17 E536 (ISA-3 audit F5): the channel of a seller facts message', () => {
  const aiMessages = async (contactId: string) => (await h.su.query<{ channel: string }>(`SELECT channel FROM messages WHERE contact_id = $1 AND initiator = 'assistant'`, [contactId])).rows;
  const rivals = async (w: Awaited<ReturnType<typeof sellerWorld>>, n: number, from = 330) => {
    for (let k = 0; k < n; k++) await mlsSale({ h, tenantId: w.tenantId, mls: w.mls }, { status: 'active', line1: `${from + k} Rival St`, beds: 3, sqft: 1500, listPriceCents: 52_000_000 + k * 100_000 });
  };

  it('R-ISA-17: three competitors are judged on the whole message (intro, lines, footer, sign-off): over three segments it goes by email', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    await rivals(w, 3);
    expect((await confirm(w, l)).status).toBe(200);
    const id = await queueFactsAs(h, w, l, ['C1', 'C2', 'C3'], 'sms');
    expect(id).not.toBeNull();
    const m = await messageOf(id!);
    expect(m.channel).toBe('email');
    expect(m.body.match(/asking price, not a sale price/g)).toHaveLength(3);
    expect(smsFits(m.body)).toBe(false);
  });

  it('R-ISA-17 E536: an SMS-only lead whose competition does not fit three segments gets nothing, never a long SMS', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w, { channels: ['sms'] });
    await rivals(w, 1, 340);
    expect((await confirm(w, l)).status).toBe(200);
    expect(await queueFactsAs(h, w, l, ['C1'], 'sms')).toBeNull();
    expect(await aiMessages(l.id)).toEqual([]);
  });

  it('R-ISA-17 R-ISA-18: a channel the policy does not allow is never used, for competition or comps (explicit opt-in at every level)', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    await rivals(w, 1, 350);
    expect((await confirm(w, l)).status).toBe(200);
    await policyChannels(h, w, ['sms']);
    expect(await queueFactsAs(h, w, l, ['C1'], 'email')).toBeNull();
    const comps = await withSellerPacksCleared(h, async () => {
      const { SELLER_RUNTIME } = await import('./index.js');
      const was = SELLER_RUNTIME.deps;
      SELLER_RUNTIME.deps = PRINTABLE_STATEMENTS;
      try {
        return await queueFactsAs(h, w, l, ['comps'], 'email');
      } finally {
        SELLER_RUNTIME.deps = was;
      }
    });
    expect(comps).toBeNull();
    expect(await aiMessages(l.id)).toEqual([]);
    // the same lead with email allowed again: both build (the refusal above was the policy's)
    await policyChannels(h, w, ['sms', 'email']);
    expect(await queueFactsAs(h, w, l, ['C1'], 'email')).not.toBeNull();
  });
});

describe('E537 (ISA-3 audit F6): the model-free re-render after a fact changed between build and send', () => {
  const rerenderJobs = async (tenantId: string) => (await h.su.query<{ payload: { assignmentId: string; messageId: string } }>(`SELECT payload FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.seller_rerender' ORDER BY created_at`, [tenantId])).rows;

  it('E537 R-ISA-17: a competitor gone pending is re-rendered once from the message\'s own facts, as competition ("Now pending (not yet sold)"), never as a comps email', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    const rec = saleReso({ status: 'active', line1: '360 Rival St', beds: 3, sqft: 1500, listPriceCents: 51_000_000 });
    const [listingId] = await syncSales({ h, tenantId: w.tenantId, mls: w.mls }, [rec]);
    expect((await confirm(w, l)).status).toBe(200);
    const id = (await queueFactsAs(h, w, l, ['C1'], 'email'))!;
    await syncSales({ h, tenantId: w.tenantId, mls: w.mls }, [{ ...rec, StandardStatus: 'Pending', ModificationTimestamp: new Date().toISOString() }]);
    expect((await asSystem(h, w, l, (tx, _a, actor) => sellerFactsCurrentInTx(tx, actor, id, nowInstant()))).codes).toEqual(['FACT_CHANGED']);
    const jobs = await rerenderJobs(w.tenantId);
    expect(jobs.map((j) => j.payload)).toEqual([{ assignmentId: l.assignmentId, messageId: id }]);
    const r = await asSystem(h, w, l, (tx, a, actor) => sellerRerenderInTx(tx, actor, a, id, nowInstant()));
    expect([r.kind, r.codes, r.dropped, r.delivered]).toEqual(['competition', [], [], false]); // delivered: false until ISA-2 builds queueFactsMessageInTx
    expect(r.facts).toMatchObject({ ok: true, channel: 'email' });
    const f = r.facts as Extract<typeof r.facts, { ok: true }>;
    expect(f.body).toContain('Now pending (not yet sold)');
    expect(f.body).not.toContain('recent sales');
    expect(f.pendingFacts.map((x) => [x.factKind, x.listingId, x.statusAtBuild, x.priceKind])).toEqual([['competitor', listingId, 'pending', 'asking']]);
  });

  it('E537 R-ISA-17: a fact no longer shown is dropped (sent without it); with none left the re-render is data_unavailable; a re-render\'s own change never re-renders again', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    const recs = [saleReso({ status: 'active', line1: '370 Rival St', beds: 3, sqft: 1500 }), saleReso({ status: 'active', line1: '371 Rival St', beds: 3, sqft: 1500 })];
    const ids = await syncSales({ h, tenantId: w.tenantId, mls: w.mls }, recs);
    expect((await confirm(w, l)).status).toBe(200);
    const id = (await queueFactsAs(h, w, l, ['C1', 'C2'], 'email'))!;
    await h.su.query(`UPDATE listings SET display_allowed = false WHERE id = $1`, [ids[0]]);
    let r = await asSystem(h, w, l, (tx, a, actor) => sellerRerenderInTx(tx, actor, a, id, nowInstant()));
    expect([r.kind, r.codes, r.dropped]).toEqual(['competition', [], [ids[0]]]);
    expect((r.facts as Extract<typeof r.facts, { ok: true }>).pendingFacts.map((x) => x.listingId)).toEqual([ids[1]]);
    await h.su.query(`UPDATE listings SET display_allowed = false WHERE id = $1`, [ids[1]]);
    r = await asSystem(h, w, l, (tx, a, actor) => sellerRerenderInTx(tx, actor, a, id, nowInstant()));
    expect([r.kind, r.codes, r.delivered]).toEqual(['competition', ['DATA_UNAVAILABLE'], false]);
    // a message that is itself a re-render (ISA-2's queueFactsMessageInTx marks it rerenderOf) and changes again is
    // refused with no second re-render: it never loops
    await h.su.query(`UPDATE assistant_actions SET payload = payload || jsonb_build_object('rerenderOf', $2::text) WHERE id = (SELECT assistant_action_id FROM messages WHERE id = $1)`, [id, id]);
    expect((await asSystem(h, w, l, (tx, _a, actor) => sellerFactsCurrentInTx(tx, actor, id, nowInstant()))).codes).toEqual(['DATA_UNAVAILABLE', 'FACT_CHANGED']);
    expect(await rerenderJobs(w.tenantId)).toEqual([]);
  });
});
