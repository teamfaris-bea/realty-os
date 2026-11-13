// The AI ISA seller part (ISA-3; R-ISA-18, R-ISA-19, R-ISA-20, R-ISA-26; E534-E538, E502). Real Postgres through the
// API harness; fakes only; packs are cleared only in this test's database, in try/finally (withSellerPacksCleared).
// Nothing is sent: TELEPHONY_LIVE_REQUESTS, AI_ISA_LIVE_SENDS and MLS_LIVE_CALLS stay false. The comps email needs
// V2-A's statement rules, a STUB that refuses every statement; tests that build a complete email inject the double
// PRINTABLE_STATEMENTS (SELLER_RUNTIME.deps inside try/finally).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { daysAgo, feedLastSyncedAt, mlsSale, saleReso, syncSales, teamListing } from '../../cma/testing.js';
import { depsFromPlatform } from '../../comms/runtime.js';
import { call } from '../testing.js';
import { compsForSubjectInTx } from './cmaSeam.js';
import { buildCompsInTx, serverTextBanned } from './comps.js';
import { COUNT_SHARE_ENABLED } from './counts.js';
import { SELLER_RUNTIME, factPlaceholdersInTx, onEscalationInTx, sellerBundleInTx, sellerFactsCurrentInTx, sellerStartRefusalInTx, COMPS_PLACEHOLDER } from './index.js';
import { type IsaDeps, contextFor, queueIsaMessageInTx } from './isa2Seam.js';
import { PRINTABLE_STATEMENTS, type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, panel, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';
import { runSellerWatchInTx } from './watch.js';

let h: ApiHarness;
let w: SellerWorld;
const fw = () => ({ h, tenantId: w.tenantId, mls: w.mls });

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const build = (l: SellerLead, via: 'assistant' | 'worker' = 'assistant') => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS), via);
const printable = async <T>(fn: () => Promise<T>): Promise<T> => {
  const was = SELLER_RUNTIME.deps;
  SELLER_RUNTIME.deps = PRINTABLE_STATEMENTS;
  try {
    return await fn();
  } finally {
    SELLER_RUNTIME.deps = was;
  }
};
const deps = (): IsaDeps => depsFromPlatform(h.app.platform) as unknown as IsaDeps;
/** ISA-2's TX-B queue path with a facts message (the H2 hook builds the body). Returns the message id or null. */
const queueFacts = (l: SellerLead, handles: string[], channel: 'sms' | 'email' = 'email') =>
  asSystem(h, w, l, async (tx, a, actor) => {
    const now = nowInstant();
    const ctx = await contextFor(tx, a, now);
    return queueIsaMessageInTx({ tx, deps: deps(), actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
      { kind: 'queue_message', messageKind: 'facts', purpose: 'marketing', channel, lines: [], text: null, handles, offerId: null, slotIndex: null, initiated: true }, a.machine);
  });
const factsOf = async (messageId: string) => (await h.su.query<{ fact_kind: string; price_kind: string; tier: string | null; status: string; comp_set_hash: string | null }>(
  'SELECT fact_kind, price_kind, tier, status, comp_set_hash FROM ai_isa_shared_facts WHERE message_id = $1 ORDER BY created_at', [messageId])).rows;
const messageOf = async (id: string) => (await h.su.query<{ channel: string; body: string; status: string }>('SELECT channel, body, status FROM messages WHERE id = $1', [id])).rows[0]!;

describe('E534 R-ISA-18: the seller packs and the licence', () => {
  it('E534 R-ISA-18: with the default packs no comps exist, the panel names both packs, and asking-price competition is still built', async () => {
    const l = await sellerLead(h, w);
    await mlsSale(fw(), { status: 'active', line1: '300 Rival St', beds: 3, sqft: 1500, listPriceCents: 52_000_000 });
    expect((await confirm(w, l)).status).toBe(200);
    expect(await build(l)).toEqual({ ok: false, codes: ['PLATFORM_NOT_CLEARED'] });
    const p = await panel(w.agents[0]!, l.id);
    expect((p.body as unknown as { capabilities: { comps: { sentence: string } } }).capabilities.comps.sentence).toBe('Can share recent sales: no — waiting for counsel review (platform:cma) and the seller-data pack.');
    expect(JSON.stringify(p.body)).toMatch(/platform:cma.*platform:ai_isa_seller_data/);
    const id = await queueFacts(l, ['C1'], 'sms');
    expect(id).not.toBeNull();
    const m = await messageOf(id!);
    expect(m.body).toMatch(/asking price, not a sale price/);
    expect(await factsOf(id!)).toEqual([expect.objectContaining({ fact_kind: 'competitor', price_kind: 'asking' })]);
  });

  it('E534 R-ISA-18: platform:avm recorded with platform:cma unreviewed gives no comps (D11 never opens them)', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const r = await withSellerPacksCleared(h, () => build(l), ['platform:avm', 'platform:ai_isa_seller_data']);
    expect(r).toEqual({ ok: false, codes: ['PLATFORM_NOT_CLEARED'] });
  });

  it('E534 R-ISA-18: a feed whose licence has automated_notes but not ai_isa_comps gives CLIENT_USE_NOT_ALLOWED (PACK_DOES_NOT_ALLOW)', async () => {
    await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,ai_isa_comps}', 'false') WHERE id = $1`, [w.mls]);
    try {
      const l = await sellerLead(h, w);
      await confirm(w, l);
      const r = await withSellerPacksCleared(h, () => build(l));
      expect(r.ok).toBe(false);
      expect((r as { codes: string[] }).codes).toEqual(expect.arrayContaining(['CLIENT_USE_NOT_ALLOWED']));
    } finally {
      await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,ai_isa_comps}', 'true') WHERE id = $1`, [w.mls]);
    }
  });

  it('E534 R-ISA-18: a review recorded on 2026.11.0 no longer clears anything: 2026.11.1 is the published, unreviewed version', async () => {
    const rows = (await h.su.query<{ version: string; status: string; reviewed: Date | null }>(`SELECT version, status, reviewed_by_counsel_at AS reviewed FROM jurisdiction_packs WHERE key = 'platform:ai_isa_seller_data' ORDER BY version`)).rows;
    expect(rows.map((r) => [r.version, r.status])).toEqual([['2026.11.0', 'retired'], ['2026.11.1', 'published']]);
    await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa_seller_data' AND version = '2026.11.0'`);
    try {
      const l = await sellerLead(h, w);
      await confirm(w, l);
      const r = await withSellerPacksCleared(h, () => build(l), ['platform:cma']);
      expect(r).toEqual({ ok: false, codes: ['PLATFORM_NOT_CLEARED'] });
    } finally {
      await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:ai_isa_seller_data'`);
    }
  });
});

describe('E536 R-ISA-18: the complete engine set or nothing, by email', () => {
  it('E536 R-ISA-18: with both packs, the licence and a printable statement the email holds result.comps exactly, in order, with the client lines verbatim and no value', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    // the email and the pipeline's own run, in one transaction (the pipeline is read-only)
    const { r, engine } = await withSellerPacksCleared(h, () => asSystem(h, w, l, async (tx, a, actor) => ({
      r: await buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS),
      engine: await compsForSubjectInTx(tx, actor, nowInstant(), { kind: 'contact_address', contactAddressId: l.addressId }, { contactId: l.id, onBehalfOf: { userId: a.ownerUserId } }),
    })));
    expect([r.ok, engine.ok]).toEqual([true, true]);
    const ok = r as Extract<typeof r, { ok: true }>;
    const res = (engine as Extract<typeof engine, { ok: true }>).result;
    expect(ok.channel).toBe('email');
    expect(ok.count).toBeGreaterThanOrEqual(3);
    // exactly result.comps, in the engine's order: one line per comp, numbered in order, each its own sale's price and date
    expect(ok.count).toBe(res.comps.length);
    const saleIds = res.comps.map((c) => res.listings[c.ref.identity]!.saleListingId);
    expect(ok.pendingFacts.map((f) => f.listingId)).toEqual(saleIds);
    const sales = new Map((await h.su.query<{ id: string; p: string; d: string }>(`SELECT id, close_price_cents::text AS p, to_char(close_date, 'YYYY-MM-DD') AS d FROM listings WHERE id = ANY ($1::uuid[])`, [saleIds])).rows.map((x) => [x.id, x]));
    const lines = ok.body.split('\n\n');
    const compLines = lines.filter((x) => /^\d+\. Sold for \$/.test(x));
    expect(compLines).toHaveLength(res.comps.length);
    const label = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    saleIds.forEach((id, k) => {
      const sale = sales.get(id)!;
      expect(compLines[k]!.startsWith(`${k + 1}. Sold for $${(Number(sale.p) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} on ${label(sale.d)} (sale price)`), compLines[k]).toBe(true);
    });
    for (const t of ['These are sales records, not an appraisal or a price for your home.', "Condition and updates aren't in the MLS record.", 'Prices are as recorded in the MLS and may include seller concessions.', 'Only sales the MLS allows us to show are included.']) expect(lines).toContain(t);
    // labels: sold vs asking, the source; never a value, weight, adjustment, valuation date or hidden count
    expect(ok.body).toMatch(/\(sale price\)/);
    expect(ok.body).toMatch(/Source: Test MLS feed via /);
    expect(ok.body).not.toMatch(/valuation date|% of the value|weighted|adjusted|estimate|\bworth\b|left out|records were/i);
    expect(ok.pendingFacts.every((f) => f.priceKind === 'sold' && f.factKind === 'sold_comp_set')).toBe(true);
  });

  it('E536: the shipped V2-A seam refuses every statement (CMA_STATEMENT_NOT_RENDERABLE); a 14 pt statement is EMAIL_TYPE_SIZE', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const stub = await withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant())));
    expect(stub).toEqual({ ok: false, codes: ['CMA_STATEMENT_NOT_RENDERABLE'] });
    await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,statements,CA,min_point_size}', '14') WHERE id = $1`, [w.mls]);
    try {
      expect(await withSellerPacksCleared(h, () => build(l))).toEqual({ ok: false, codes: ['EMAIL_TYPE_SIZE'] });
    } finally {
      await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,statements,CA,min_point_size}', '10') WHERE id = $1`, [w.mls]);
    }
  });

  it('E536: a pack-lines mismatch gives no comps (PACK_LINES_MISMATCH); a "not guaranteed" disclaimer still sends', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    await h.su.query(`UPDATE jurisdiction_packs SET rules = jsonb_set(rules, '{client_lines,0}', '"Changed line."') WHERE key = 'platform:ai_isa_seller_data' AND status = 'published'`);
    try {
      expect(await withSellerPacksCleared(h, () => build(l))).toEqual({ ok: false, codes: ['PACK_LINES_MISMATCH'] });
    } finally {
      await h.su.query(`UPDATE jurisdiction_packs SET rules = jsonb_set(rules, '{client_lines,0}', '"These are sales records, not an appraisal or a price for your home."') WHERE key = 'platform:ai_isa_seller_data' AND status = 'published'`);
    }
    const ok = await withSellerPacksCleared(h, () => build(l));
    expect(ok.ok).toBe(true);
    expect((ok as { body: string }).body).toMatch(/not guaranteed/);
    expect(serverTextBanned('Information deemed reliable but not guaranteed')).toBe(true); // the ban would refuse it: it runs on ISA and engine lines only
  });

  it('E536 R-ISA-18: fewer than 3 comparable sales gives no comps, never partial and no count', async () => {
    const w2 = await sellerWorld(h);
    const l = await sellerLead(h, w2, { comps: 2 });
    await confirm(w2, l);
    const r = await withSellerPacksCleared(h, () => asSystem(h, w2, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)));
    expect(r.ok).toBe(false);
    expect((r as { codes: string[] }).codes.some((c) => c === 'NO_VALUE' || c === 'COMPS_TOO_FEW')).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/\d+ (sales|comps)/);
  });

  it('E536: no bound email gives no comps and no SMS (H2 and the trigger)', async () => {
    const l = await sellerLead(h, w, { channels: ['sms'] });
    await confirm(w, l);
    const r = await withSellerPacksCleared(h, () => build(l));
    expect(r.ok).toBe(false);
    expect((r as { codes: string[] }).codes).toContain('NO_BOUND_EMAIL');
    const id = await withSellerPacksCleared(h, () => printable(() => queueFacts(l, ['comps'], 'sms')));
    expect(id).toBeNull();
  });

  it('E536 R-ISA-18: every subject state keeps comps off: unconfirmed, disputed, not in the MLS, changed, a new default address', async () => {
    const l = await sellerLead(h, w);
    expect((await build(l)).ok).toBe(false);
    expect((await panel(w.agents[0]!, l.id)).body.subject.state).toBe('ok');
    expect(((await build(l)) as { codes: string[] }).codes).toContain('SUBJECT_UNCONFIRMED');
    await confirm(w, l);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/subject-disputed`, {})).status).toBe(200);
    expect(((await build(l)) as { codes: string[] }).codes).toEqual(['SUBJECT_DISPUTED']);
    await confirm(w, l);
    // a newer record of the home: SUBJECT_CHANGED until confirmed again
    await mlsSale(fw(), { line1: l.line1, closeDate: daysAgo(30), beds: 4, sqft: 1500 });
    expect(((await withSellerPacksCleared(h, () => build(l))) as { codes: string[] }).codes).toEqual(['SUBJECT_CHANGED']);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/confirm-subject`, { contactAddressId: l.addressId, recordListingId: l.recordId, factsSha256: '0'.repeat(64) })).code).toBe('SUBJECT_CHANGED');
    // a home not in the MLS: no subject; the next step is a CMA
    const n = await sellerLead(h, w, { record: null, comps: 0 });
    const p = await panel(w.agents[0]!, n.id);
    expect([p.body.subject.state, (p.body.subject as unknown as { nextStep: string }).nextStep]).toEqual(['not_in_mls', 'Prepare a CMA (enter type and size)']);
    expect(((await build(n)) as { codes: string[] }).codes).toEqual(expect.arrayContaining(['SUBJECT_NOT_IN_MLS', 'SUBJECT_UNCONFIRMED']));
  });

  it('E536 owner question 9 (ISA-3 audit F2): anyone who may pause marks the subject disputed: a Team Lead, an Admin and the Owner, never inserting the watch row', async () => {
    const admin = await h.invite(w.owner, 'admin');
    const disputed = (l: SellerLead) => h.su.query<{ at: Date | null }>(`SELECT subject_disputed_at AS at FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId]);
    for (const who of [w.teamLead!, admin, w.owner]) {
      const l = await sellerLead(h, w);
      await confirm(w, l);
      const r = await call<{ ok: boolean; sentence: string }>(who, 'POST', `/contacts/${l.id}/ai-isa/seller/subject-disputed`, {});
      expect([r.status, r.body.sentence]).toEqual([200, 'Marked disputed. Recent sales stop until the owner confirms the home again.']);
      expect((await disputed(l)).rows[0]!.at).not.toBeNull();
      expect(((await build(l)) as { codes: string[] }).codes).toEqual(['SUBJECT_DISPUTED']);
    }
    // no watch row yet (the system makes it at the first turn): nothing to dispute, and a non-owner never inserts one
    const l = await sellerLead(h, w);
    await h.su.query(`DELETE FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId]);
    const r = await call<{ ok: boolean; sentence: string }>(w.teamLead!, 'POST', `/contacts/${l.id}/ai-isa/seller/subject-disputed`, {});
    expect([r.status, r.body.sentence]).toEqual([200, 'Nothing to mark yet: the owner has not confirmed the home.']);
    expect((await disputed(l)).rows).toEqual([]);
  });

  it('E536: a new property address becomes the default and unconfirms the subject (SUBJECT_CHANGED at read time)', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    await h.su.query(`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code) VALUES ($1, gen_random_uuid(), $2, 'property', '999 Other Rd', 'Oakland', 'CA', '94110')`, [w.tenantId, l.id]);
    const codes = ((await withSellerPacksCleared(h, () => build(l))) as { codes: string[] }).codes;
    expect(codes.some((c) => c === 'SUBJECT_CHANGED' || c === 'SUBJECT_NOT_IN_MLS')).toBe(true);
  });

  it('E536: a nearby question gives data_unavailable to the agent and no nearby_sale row is written (nearby sales are not sent in v1)', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const bundle = await asSystem(h, w, l, (tx, a, actor) => sellerBundleInTx(tx, actor, a, nowInstant()));
    expect(bundle.handles.every((x) => x.handle.startsWith('C'))).toBe(true);
    const n = await h.su.query(`SELECT count(*)::int AS n FROM ai_isa_shared_facts WHERE fact_kind = 'nearby_sale'`);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('E535 R-ISA-18: freshness', () => {
  it('E535: a stale feed gives no fact (FEED_STALE for comps, no competition handle); comps are blocked by FEED_STALE, not by a sold row’s age', async () => {
    const w2 = await sellerWorld(h);
    const l = await sellerLead(h, w2);
    await mlsSale({ h, tenantId: w2.tenantId, mls: w2.mls }, { status: 'active', line1: '301 Rival St', beds: 3, sqft: 1500 });
    await confirm(w2, l);
    const comps = () => withSellerPacksCleared(h, () => asSystem(h, w2, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)));
    // a fresh feed whose sold rows were last seen 90 days ago (the incremental feed never re-sends a closed sale): comps are built
    await h.su.query(`UPDATE listings SET last_seen_in_feed_at = now() - interval '90 days' WHERE tenant_id = $1 AND status = 'sold'`, [w2.tenantId]);
    expect((await comps()).ok).toBe(true);
    // the feed itself goes stale: the code says so (FEED_STALE), and no competition handle is offered
    await feedLastSyncedAt({ h, mls: w2.mls }, new Date(Date.now() - 3 * 86_400_000));
    expect(await comps()).toEqual({ ok: false, codes: ['FEED_STALE'] });
    const b = await asSystem(h, w2, l, (tx, a, actor) => sellerBundleInTx(tx, actor, a, nowInstant()));
    expect([b.handles, b.unavailable]).toEqual([[], ['competition_unavailable: FEED_STALE', 'sold_comps_unavailable: FEED_STALE']]);
  });

  it('E535: a row unseen for 3 days in a fresh feed is never offered as a handle; each fact keeps its own as-of', async () => {
    const w2 = await sellerWorld(h);
    const l = await sellerLead(h, w2);
    const id = await mlsSale({ h, tenantId: w2.tenantId, mls: w2.mls }, { status: 'active', line1: '302 Rival St', beds: 3, sqft: 1500 });
    const id2 = await mlsSale({ h, tenantId: w2.tenantId, mls: w2.mls }, { status: 'active', line1: '303 Rival St', beds: 3, sqft: 1500 });
    await confirm(w2, l);
    // each fact keeps its own as-of: min(the row's last_seen_in_feed_at, its feed's last sync), here the row's own
    await h.su.query(`UPDATE listings SET last_seen_in_feed_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    await h.su.query(`UPDATE listings SET last_seen_in_feed_at = now() - interval '5 hours' WHERE id = $1`, [id2]);
    const before = await asSystem(h, w2, l, (tx, a, actor) => sellerBundleInTx(tx, actor, a, nowInstant()));
    expect(before.handles).toHaveLength(2);
    const msg = await asSystem(h, w2, l, async (tx, a, actor) => {
      const now = nowInstant();
      const ctx = await contextFor(tx, a, now);
      return queueIsaMessageInTx({ tx, deps: deps(), actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
        { kind: 'queue_message', messageKind: 'facts', purpose: 'marketing', channel: 'email', lines: [], text: null, handles: ['C1', 'C2'], offerId: null, slotIndex: null, initiated: true }, a.machine);
    });
    const asOf = (await h.su.query<{ same: boolean; listing_id: string }>(`SELECT f.listing_id, f.as_of = date_trunc('milliseconds', l.last_seen_in_feed_at) AS same FROM ai_isa_shared_facts f JOIN listings l ON l.id = f.listing_id
      WHERE f.message_id = $1 ORDER BY f.listing_id`, [msg])).rows;
    expect(asOf).toEqual([id, id2].sort().map((x) => ({ listing_id: x, same: true })));
    await h.su.query(`UPDATE listings SET last_seen_in_feed_at = now() - interval '3 days' WHERE id = ANY ($1::uuid[])`, [[id, id2]]);
    const after = await asSystem(h, w2, l, (tx, a, actor) => sellerBundleInTx(tx, actor, a, nowInstant()));
    expect(after.handles).toEqual([]);
  });
});

describe('E537 R-ISA-18: a fact that changes between build and send', () => {
  it('E537: active → pending between build and send gives FACT_CHANGED and one re-render job; a sync that moves only last_synced_at still sends; H3 via worker refuses', async () => {
    const w2 = await sellerWorld(h);
    const l = await sellerLead(h, w2);
    const rec = saleReso({ status: 'active', line1: '303 Rival St', beds: 3, sqft: 1500, listPriceCents: 51_000_000 });
    await syncSales({ h, tenantId: w2.tenantId, mls: w2.mls }, [rec]);
    await confirm(w2, l);
    const id = (await asSystem(h, w2, l, async (tx, a, actor) => {
      const now = nowInstant();
      const ctx = await contextFor(tx, a, now);
      return queueIsaMessageInTx({ tx, deps: deps(), actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq },
        { kind: 'queue_message', messageKind: 'facts', purpose: 'marketing', channel: 'sms', lines: [], text: null, handles: ['C1'], offerId: null, slotIndex: null, initiated: true }, a.machine);
    }))!;
    const check = (via: 'assistant' | 'worker' = 'assistant') => asSystem(h, w2, l, (tx, _a, actor) => sellerFactsCurrentInTx(tx, actor, id, nowInstant()), via);
    await feedLastSyncedAt({ h, mls: w2.mls }, new Date());
    expect(await check()).toEqual({ codes: [], licenceOk: true });
    expect(await check('worker')).toEqual({ codes: ['SELLER_FACTS_NOT_ALLOWED'], licenceOk: false });
    await syncSales({ h, tenantId: w2.tenantId, mls: w2.mls }, [{ ...rec, StandardStatus: 'Pending', ModificationTimestamp: new Date().toISOString() }]);
    expect((await check()).codes).toEqual(['FACT_CHANGED']);
    const jobs = await h.su.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.seller_rerender'`, [w2.tenantId]);
    expect(jobs.rows[0].n).toBe(1);
    await check();
    expect((await h.su.query(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.seller_rerender'`, [w2.tenantId])).rows[0].n).toBe(1);
  });
});

describe('E538 R-ISA-26: the seller home link', () => {
  it('E538 R-ISA-26: another brokerage’s live listing of the home refuses a seller start (AI_ISA_LISTED_ELSEWHERE) and ends care as link 10', async () => {
    const l = await sellerLead(h, w);
    await mlsSale(fw(), { status: 'active', line1: l.line1, beds: 3, sqft: 1500 });
    const code = await asSystem(h, w, l, (tx) => sellerStartRefusalInTx(tx, l.id, 'seller', nowInstant()));
    expect(code).toBe('AI_ISA_LISTED_ELSEWHERE');
    const run = await asSystem(h, w, l, (tx, _a, actor) => runSellerWatchInTx(tx, deps(), actor, l.assignmentId, nowInstant()));
    expect(run.code).toBe('ENDED');
    const a = await h.su.query(`SELECT end_reason FROM ai_isa_assignments WHERE id = $1`, [l.assignmentId]);
    expect(a.rows[0].end_reason).toBe('listed_elsewhere');
  });

  it('E538 R-ISA-26: the team’s own live listing of the home ends care with active_client', async () => {
    const l = await sellerLead(h, w);
    await teamListing(w.agents[0]!, { addressLine1: l.line1, city: 'Oakland', region: 'CA', postalCode: '94110' });
    expect(await asSystem(h, w, l, (tx) => sellerStartRefusalInTx(tx, l.id, 'seller', nowInstant()))).toBe('AI_ISA_ACTIVE_CLIENT');
  });

  it('E538 R-ISA-15: a near match pauses care; "different home" plus resume lifts the pause while comps stay blocked by the near match', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const near = await mlsSale(fw(), { status: 'active', line1: l.line1, line2: 'Unit 2', beds: 3, sqft: 1500 });
    const linkOf = () => asSystem(h, w, l, (tx, a) => import('./gates.js').then((g) => g.assignmentSubjectLinkInTx(tx, a)));
    const link = await linkOf();
    expect([link.effect, link.reason, link.listingIds]).toEqual(['pause', 'possible_listing', [near]]);
    expect(link.sentence).toBe('Possibly listed: confirm it’s a different home, then resume.');
    // the chain (H5) pauses care through link 10
    const run = await asSystem(h, w, l, (tx, _a, actor) => runSellerWatchInTx(tx, deps(), actor, l.assignmentId, nowInstant()));
    expect(run.code).toBe('PAUSED');
    expect((await h.su.query(`SELECT pause_reason FROM ai_isa_assignments WHERE id = $1`, [l.assignmentId])).rows[0].pause_reason).toBe('possible_listing');
    expect((await call(w.teamLead!, 'POST', `/contacts/${l.id}/ai-isa/seller/near-match-different`, { listingIds: [near] })).status).toBeGreaterThanOrEqual(400);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/near-match-different`, { listingIds: [near] })).status).toBe(200);
    expect((await linkOf()).effect).toBe('ok');
    // owner question 1: the resume lifts the pause; comps stay blocked while the live near match exists (R-CMA-7)
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/resume`, {})).status).toBe(200);
    expect((await h.su.query(`SELECT paused_at FROM ai_isa_assignments WHERE id = $1`, [l.assignmentId])).rows[0].paused_at).toBeNull();
    const r = await withSellerPacksCleared(h, () => build(l));
    expect((r as { codes: string[] }).codes).toContain('POSSIBLE_LIVE_LISTING');
  });

  it('E538: an owner demoted to isa or suspended gets no seller facts (CMA_SCOPE_LOST)', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    await h.su.query(`SET session_replication_role = replica; UPDATE memberships SET role = 'isa' WHERE user_id = '${w.agents[0]!.userId}' AND tenant_id = '${w.tenantId}'; SET session_replication_role = origin`);
    try {
      const r = await withSellerPacksCleared(h, () => build(l));
      expect((r as { codes: string[] }).codes).toContain('CMA_SCOPE_LOST');
    } finally {
      await h.su.query(`SET session_replication_role = replica; UPDATE memberships SET role = 'agent' WHERE user_id = '${w.agents[0]!.userId}' AND tenant_id = '${w.tenantId}'; SET session_replication_role = origin`);
    }
  });

  it('E538: a collaborator’s address edit clears the confirmation; only the owner confirms (another agent is 404)', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    expect((await panel(w.agents[0]!, l.id)).body.subject.confirmed).toBe(true);
    // the Team Lead edits the address through the people API, as themselves (RLS and the trigger run as the editor)
    const edit = await call(w.teamLead!, 'PATCH', `/contacts/${l.id}/addresses/${l.addressId}`, { kind: 'property', line1: l.line1.replace('Ct', 'Court'), line2: null, city: 'Oakland', region: 'CA', postalCode: '94110' });
    expect(edit.status).toBe(200);
    const p = await panel(w.agents[0]!, l.id);
    expect([p.body.subject.confirmed, (p.body.subject as unknown as { clearedReason: string | null }).clearedReason]).toEqual([false, 'address_changed']);
    expect(((await build(l)) as { codes: string[] }).codes).toContain('SUBJECT_UNCONFIRMED');
    const tl = await call(w.teamLead!, 'POST', `/contacts/${l.id}/ai-isa/confirm-subject`, { contactAddressId: l.addressId, recordListingId: l.recordId, factsSha256: 'a'.repeat(64) });
    expect([403, 404]).toContain(tl.status);
  });
});

describe('E502: a pricing hold suspends comps', () => {
  it('E502: a pricing_negotiation escalation suspends comps; a generic resolve keeps it; resume-comps clears it', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    await asSystem(h, w, l, (tx, a) => onEscalationInTx(tx, a, 'pricing_negotiation'));
    const p = await panel(w.agents[0]!, l.id);
    expect((p.body as unknown as { suspension: { suspended: boolean; sentence: string } }).suspension).toEqual({ suspended: true, sentence: 'Recent sales paused: they asked about price. Prepare or re-run a CMA, share one, or let the assistant keep sharing.' });
    expect(((await withSellerPacksCleared(h, () => build(l))) as { codes: string[] }).codes).toContain('COMPS_SUSPENDED');
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/resume-comps`, {})).status).toBe(200);
    expect((await withSellerPacksCleared(h, () => build(l))).ok).toBe(true);
  });

  it('E502: the owner’s new one-tap CMA clears a suspension; an unchanged re-tap does not', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/cma`, {})).status).toBeLessThan(300);
    await asSystem(h, w, l, (tx, a) => onEscalationInTx(tx, a, 'pricing_negotiation'));
    // an unchanged re-tap stores nothing
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/cma`, {})).status).toBe(200);
    expect(((await withSellerPacksCleared(h, () => build(l))) as { codes: string[] }).codes).toContain('COMPS_SUSPENDED');
    // a changed home (a new sale nearby) re-runs into a new draft
    await mlsSale(fw(), { closeDate: daysAgo(5), beds: 3, sqft: 1450 });
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/cma`, {})).status).toBe(201);
    const r = await withSellerPacksCleared(h, () => build(l));
    expect((r as { codes?: string[] }).codes ?? []).not.toContain('COMPS_SUSPENDED');
  });

  it('E502 (ISA-3 audit F1): an unchanged re-tap after the feed synced, or a supersede of the draft, moves only updated_at and keeps the suspension', async () => {
    const w2 = await sellerWorld(h);
    const l = await sellerLead(h, w2);
    await confirm(w2, l);
    expect((await call(w2.agents[0]!, 'POST', `/contacts/${l.id}/cma`, {})).status).toBe(201);
    await asSystem(h, w2, l, (tx, a) => onEscalationInTx(tx, a, 'pricing_negotiation'));
    const suspended = async () => ((await withSellerPacksCleared(h, () => asSystem(h, w2, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)))) as { codes?: string[] }).codes ?? [];
    const drafts = async () => (await h.su.query<{ id: string; status: string; moved: boolean }>(`SELECT c.id, c.status, c.updated_at > w.comps_suspended_at AS moved FROM cma_reports c
      JOIN ai_isa_seller_watch w ON w.contact_id = c.contact_id WHERE c.contact_id = $1 ORDER BY c.created_at`, [l.id])).rows;
    // the feed syncs (hourly in production): the unchanged re-tap refreshes only the draft's MLS data date
    await feedLastSyncedAt({ h, mls: w2.mls }, new Date());
    expect((await call(w2.agents[0]!, 'POST', `/contacts/${l.id}/cma`, {})).status).toBe(200);
    const [d] = await drafts();
    expect([d!.status, d!.moved]).toEqual(['draft', true]); // cma_reports_touch_updated_at moved updated_at past the suspension
    expect(await suspended()).toContain('COMPS_SUSPENDED');
    expect((await h.su.query(`SELECT comps_resumed_reason FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId])).rows[0].comps_resumed_reason).toBeNull();
    // a supersede of the draft (a merge's, or a later tap's) changes its status only
    await h.su.query(`UPDATE cma_reports SET status = 'superseded' WHERE id = $1`, [d!.id]);
    expect(await suspended()).toContain('COMPS_SUSPENDED');
  });
});

describe('R-ISA-20 R-ISA-19: the prompt and counts', () => {
  it('R-ISA-20: a message that carried comps enters the prompt as the fixed placeholder, never its body', async () => {
    const l = await sellerLead(h, w);
    await confirm(w, l);
    const id = await withSellerPacksCleared(h, () => printable(() => queueFacts(l, ['comps'])));
    expect(id).not.toBeNull();
    expect((await messageOf(id!)).channel).toBe('email');
    expect((await factsOf(id!)).every((f) => f.fact_kind === 'sold_comp_set' && f.price_kind === 'sold')).toBe(true);
    const ph = await asSystem(h, w, l, (tx) => factPlaceholdersInTx(tx, [id!]));
    expect(ph.get(id!)).toBe(COMPS_PLACEHOLDER);
    expect(COMPS_PLACEHOLDER).not.toMatch(/\$|\d|Sample|Brokerage/);
  });

  it('R-ISA-19: counts are shown to the agent as not sent, and never queued (COUNT_SHARE_ENABLED false)', async () => {
    expect(COUNT_SHARE_ENABLED).toBe(false);
    const l = await sellerLead(h, w);
    const p = await panel(w.agents[0]!, l.id);
    expect((p.body as unknown as { counts: { sentence: string } | null }).counts?.sentence).toMatch(/Not sent to clients yet/);
  });
});

describe('tenancy (R-TEN-1, R-PERM-5)', () => {
  it('R-TEN-1: another tenant’s member gets 404 on the panel and on confirm-subject; a forged contact id is 404', async () => {
    const l = await sellerLead(h, w);
    const other = await sellerWorld(h);
    expect((await panel(other.agents[0]!, l.id)).status).toBe(404);
    expect((await call(other.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/confirm-subject`, { contactAddressId: l.addressId, recordListingId: l.recordId, factsSha256: 'a'.repeat(64) })).status).toBe(404);
    expect((await panel(w.agents[0]!, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
