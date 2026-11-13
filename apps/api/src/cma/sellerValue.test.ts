// Lane V2-B deliverable 5 (R-CMA-7, R-CMA-10, R-SELL-2, R-SELL-4, E375, E366, E629-E632, E638, E639): the seller
// update's 'value' section through the real server, the reconcile pass and the send path. Real Postgres (app_user,
// RLS); MLS rows are RESO fixtures stored through V1-A's sync; fakes only, nothing real is sent.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { type Database, withTenantTx } from '@realty/db';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { grantConsent, randomPhone } from '../comms/testing.js';
import { TEST_ATTRIBUTION, TEST_DISCLAIMER, mlsConnection } from '../mls/testing.js';
import { assemble } from '../sellerUpdates/assembly.js';
import { periodOf } from '../sellerUpdates/store.js';
import { RECOMMENDATION, type SendT, type SellerListing, type UpdateT, call, cmd, draftsOf, reconcile, sellerListing } from '../sellerUpdates/testing.js';
import { systemActor } from '../worker/systemActor.js';
import type { TenantId } from '@realty/core/foundation';
import type { ResoLike } from '@realty/core/listings';
import { ownedContact } from '../comms/testing.js';
import { syncConnection } from '../mls/sync.js';
import { makeDue, mlsDeps, pagedFeed } from '../mls/testing.js';
import { SPARK_FIELD_MAPPING } from '../providers/integrations/spark.js';
import { SELLER_VALUE_SENTENCES } from './sellerValue.js';
import { TEST_STATEMENT, cmaPack, daysAgo, localSales, mlsSale, saleReso, teamListing } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let mls: string;

type ValueUpdate = UpdateT & { valueRemoved: boolean; valueNote: string | null; delivery: { contactId: string; status: string; reason?: string | null }[] | null };

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  mls = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: cmaPack({ maxStalenessHours: 72 }), lastSyncedAt: new Date() });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const mw = () => ({ h, tenantId: w.tenantId, mls });
const setPack = (pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [mls, JSON.stringify(pack)]);

async function withCmaCleared<T>(fn: () => Promise<T>): Promise<T> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma' AND status = 'published'");
  try {
    return await fn();
  } finally {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
  }
}

/** A seller listing in the fixtures' ZIP (94110), drafted by the reconcile pass. */
async function listing(o: { sellers?: number } = {}): Promise<SellerListing> {
  return sellerListing(agent(), { postalCode: '94110', ...o });
}
async function drafted(l: SellerListing): Promise<ValueUpdate> {
  await reconcile(h, w.tenantId);
  const r = await call<{ update: ValueUpdate | null }>(agent(), 'GET', `/listings/${l.listingId}/seller-update`);
  expect(r.status).toBe(200);
  return r.body.update!;
}
const view = async (id: string) => (await call<{ update: ValueUpdate }>(agent(), 'GET', `/seller-updates/${id}`)).body.update;
const valueOf = (u: UpdateT) => u.sections.find((s) => s.kind === 'value')!;
async function send(id: string, body: Record<string, unknown> = {}) {
  const v = await view(id);
  return call<SendT>(agent(), 'POST', `/seller-updates/${id}/send`, { commandId: cmd(), recommendation: RECOMMENDATION, recipientIds: v.recipients.filter((r) => r.sendable).map((r) => r.contactId), ...body });
}
const outbound = async (contactId: string) => (await h.su.query<{ status: string; channel: string; body: string }>("SELECT status, channel, body FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND action_category = 'seller_update' ORDER BY created_at", [contactId])).rows;

function spied(): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery: (a) => {
      statements.push(JSON.stringify(a.node));
      return a.node;
    },
    transformResult: async (a) => a.result,
  };
  return { db: { ...h.database, kysely: h.database.kysely.withPlugin(plugin) } as Database, statements };
}
const SOLD_READ = 'l.close_date IS NOT NULL';

describe('lane V2-B deliverable 5: the seller update\'s value section', () => {
  it('R-CMA-10 as shipped (platform:cma uncleared): unavailable, the agent sentence only, no "Home value" block in the preview, and no sold data read', async () => {
    await localSales(mw(), 8);
    const l = await listing();
    const u = await drafted(l);
    expect(valueOf(u)).toMatchObject({ state: 'unavailable', statement: SELLER_VALUE_SENTENCES.notCleared, lines: [] });
    expect(u.preview.body).not.toContain('Home value');
    const spy = spied();
    const d = (await draftsOf(h, l.listingId))[0]!;
    await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => assemble(tx, l.listingId, periodOf((d.payload as { period: never }).period), now), { db: spy.db });
    expect(spy.statements.some((s) => s.includes(SOLD_READ))).toBe(false);
  });

  it('R-CMA-10 R-SELL-2: with platform:cma cleared the update shows the range, its comps through clientView with sold price, date and brokerage, the statement, attribution and disclaimer; one claim cites every comp', async () => {
    const l = await listing();
    const u = await withCmaCleared(() => drafted(l));
    const s = valueOf(u);
    expect(s.state).toBe('has_data');
    expect(s.statement).toMatch(/^An estimate from comparable recent MLS sales, not an appraisal\. MLS data as of /);
    const texts = s.lines.map((x) => x.text);
    expect(texts[0]).toMatch(/^Estimated value: \$[\d,]+ \(range \$[\d,]+–\$[\d,]+\), from recent MLS sales as of [A-Z][a-z]{2} \d{1,2}, \d{4}\. This is an estimate, not an appraisal\.$/);
    expect(texts[1]).toBe('Comparable closed sales:');
    const comps = texts.filter((t) => / sold [A-Z][a-z]{2} \d{1,2}, \d{4} for \$/.test(t));
    expect(comps.length).toBeGreaterThanOrEqual(3);
    for (const c of comps) expect(c).toMatch(/, listed by Other Brokerage \(test\)$/);
    for (const t of [TEST_STATEMENT, TEST_ATTRIBUTION, TEST_DISCLAIMER]) expect(texts).toContain(t);
    expect(JSON.stringify(s)).not.toMatch(/adjusted|weight|backtest|confidence/i);
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]!.evidence).toHaveLength(comps.length);
    expect(s.sources[0]!.evidence.every((e) => e.sourceType === 'listing')).toBe(true);
    expect(u.preview.body).toContain('Home value');
    expect(u.preview.body).toContain(texts[0]!);
  });

  it('E375 R-CMA-10: two comps ⇒ "Value range unavailable: not enough comparable sales." with no digits; with the display pack unreviewed, the agent sentence only (configuration is read first)', async () => {
    const w2 = await assistantWorld(h, { agents: 1 });
    const m2 = await mlsConnection(h, w2.tenantId, w2.owner.userId!, { pack: cmaPack({ maxStalenessHours: 72 }), lastSyncedAt: new Date() });
    await localSales({ h, tenantId: w2.tenantId, mls: m2 }, 2);
    const l = await sellerListing(w2.agents[0]!, { postalCode: '94110' });
    const get = async () => {
      await reconcile(h, w2.tenantId);
      return (await call<{ update: ValueUpdate }>(w2.agents[0]!, 'GET', `/listings/${l.listingId}/seller-update`)).body.update;
    };
    const u = await withCmaCleared(get);
    expect(valueOf(u)).toMatchObject({ state: 'unavailable', statement: 'Value range unavailable: not enough comparable sales.', lines: [{ text: 'Value range unavailable: not enough comparable sales.' }] });
    expect(JSON.stringify(valueOf(u).lines)).not.toMatch(/\d/);
    expect(u.preview.body).toContain('Value range unavailable: not enough comparable sales.');
    await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [m2, JSON.stringify(cmaPack({ reviewed: false, maxStalenessHours: 72 }))]);
    const v = (await withCmaCleared(() => call<{ update: ValueUpdate }>(w2.agents[0]!, 'POST', `/seller-updates/${u.id}/reassemble`))).body.update;
    expect(valueOf(v)).toMatchObject({ state: 'unavailable', statement: SELLER_VALUE_SENTENCES.displayOff, lines: [] });
    expect(v.preview.body).not.toContain('Home value');
  });

  it('M1 R-CMA-7: client_cma false with automated_notes true ⇒ agent only', async () => {
    const l = await listing();
    await setPack(cmaPack({ maxStalenessHours: 72, valuation: { client_cma: false } }));
    try {
      const u = await withCmaCleared(() => drafted(l));
      expect(valueOf(u)).toMatchObject({ state: 'unavailable', statement: SELLER_VALUE_SENTENCES.licence, lines: [] });
    } finally {
      await setPack(cmaPack({ maxStalenessHours: 72 }));
    }
  });

  it('E629 E638 R-SELL-4: a new comp after assembly ⇒ SELLER_UPDATE_STALE and one tap reassembles; re-viewed a day later with no new data ⇒ the same valuation date and hash', async () => {
    const l = await listing();
    const u = await withCmaCleared(() => drafted(l));
    const d = (await draftsOf(h, l.listingId))[0]!;
    const p = d.payload as { period: never; dataSha256: string };
    const later = await withCmaCleared(() => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => assemble(tx, l.listingId, periodOf(p.period), (now + 86_400_000) as Instant), { db: h.database }));
    expect(later.dataSha256).toBe(p.dataSha256);
    expect(later.sections.find((x) => x.kind === 'value')!.lines[0]!.text).toBe(valueOf(u).lines[0]!.text);
    await mlsSale(mw(), { closeDate: daysAgo(3), sqft: 1450, closePriceCents: 61_000_000 });
    expect((await withCmaCleared(() => view(u.id))).stale).toBe(true);
    const r = await withCmaCleared(() => send(u.id));
    expect([r.status, (r.body as unknown as { error: { code: string } }).error.code]).toEqual([409, 'SELLER_UPDATE_STALE']);
    const again = (await withCmaCleared(() => call<{ update: ValueUpdate }>(agent(), 'POST', `/seller-updates/${u.id}/reassemble`))).body.update;
    expect(again.stale).toBe(false);
    expect(valueOf(again).state).toBe('has_data');
  });

  it('E631 E89: the agent removes the value section: kept across a recommendation patch and reassembly; the sent text has none and no child carries a value to re-check', async () => {
    const l = await listing();
    const u = await withCmaCleared(() => drafted(l));
    const removed = (await withCmaCleared(() => call<{ update: ValueUpdate }>(agent(), 'PATCH', `/seller-updates/${u.id}`, { valueRemoved: true }))).body.update;
    expect(removed.valueRemoved).toBe(true);
    expect(removed.preview.body).not.toContain('Home value');
    await withCmaCleared(() => call(agent(), 'PATCH', `/seller-updates/${u.id}`, { recommendation: RECOMMENDATION }));
    const re = (await withCmaCleared(() => call<{ update: ValueUpdate }>(agent(), 'POST', `/seller-updates/${u.id}/reassemble`))).body.update;
    expect(re.valueRemoved).toBe(true);
    const r = await withCmaCleared(() => send(u.id));
    expect(r.status).toBe(200);
    const [m] = await outbound(l.sellers[0]!.id);
    expect(m!.body).not.toContain('Home value');
    expect(m!.body).not.toContain('Estimated value');
    const child = (await h.su.query<{ payload: Record<string, unknown> }>("SELECT payload FROM assistant_actions WHERE trigger_ref->>'kind' = 'seller_update_send' AND trigger_ref->>'actionId' = $1", [u.id])).rows[0]!;
    expect(child.payload['value']).toBeUndefined();
  });

  it('E630 R-CMA-10: a seller reached by text gets no value section, an email co-seller does, and the view says so', async () => {
    const l = await listing();
    const sms = await call<{ contact: { id: string } }>(agent(), 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Text', lastName: 'Only', phones: [randomPhone()] });
    await grantConsent(agent(), sms.body.contact.id, 'sms');
    expect((await call(agent(), 'POST', `/listings/${l.listingId}/contacts`, { contactId: sms.body.contact.id, role: 'co_seller' })).status).toBe(200);
    const u = await withCmaCleared(() => drafted(l));
    const v = await withCmaCleared(() => view(u.id));
    expect(v.recipients.find((r) => r.contactId === sms.body.contact.id)?.channel).toBe('sms');
    expect(v.valueNote).toBe('Sellers who get this by text won’t see the value range.');
    const r = await withCmaCleared(() => send(u.id));
    expect(r.status).toBe(200);
    const [e] = await outbound(l.sellers[0]!.id);
    const [t] = await outbound(sms.body.contact.id);
    expect(e!.channel).toBe('email');
    expect(e!.body).toContain('Estimated value');
    expect(t!.channel).toBe('sms');
    expect(t!.body).not.toContain('Estimated value');
    expect(t!.body).not.toContain('Home value');
  });

  it('E632 R-CMA-7: platform:cma revoked after the tap and before the messages are queued ⇒ nothing queued, each child blocked with the reason, the tap reports blocked / not_queued, and the resume pass never sends it', async () => {
    const l = await listing();
    const u = await withCmaCleared(() => drafted(l));
    const seller = l.sellers[0]!.id;
    const d = (await draftsOf(h, l.listingId))[0]!;
    const value = (d.payload as { value?: unknown }).value;
    expect(value).toBeDefined();
    // the rows step C writes, with step D never run (the fixture of sellerUpdates.test.ts's resume case), the child carrying the value
    await h.su.query("UPDATE assistant_actions SET status = 'approved', decided_by_user_id = $2, decided_at = now(), edited_payload = $3::jsonb WHERE id = $1", [u.id, agent().userId, JSON.stringify({ recommendation: RECOMMENDATION, excludedFeedbackIds: [], recipients: [{ contactId: seller, channel: 'email' }], address: l.address, valueRemoved: false })]);
    const seq = (await h.su.query('SELECT ownership_period_seq AS p FROM contacts WHERE id = $1', [seller])).rows[0].p;
    const childId = randomUUID();
    await h.su.query(
      `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq, decided_by_user_id, decided_at, trigger_ref, dedupe_key, created_at)
       VALUES ($1, $2, $3, 'message_draft', 'seller_update', 'requires_approval', 'approved', $4, 'Your seller update, sent on your tap.', $5::jsonb, $6, $4, now(), $7::jsonb, $8, now() - interval '5 minutes')`,
      [w.tenantId, childId, seller, agent().userId, JSON.stringify({ sellerUpdateActionId: u.id, channel: 'email', subject: 'Weekly update', text: `Update\n\nHome value\n${valueOf(u).lines[0]!.text}\n\nMy recommendation\n${RECOMMENDATION}`, signature: null, value }), seq,
       JSON.stringify({ kind: 'seller_update_send', actionId: u.id, listing_id: l.listingId }), `seller_update_send:${u.id}:${seller}`],
    );
    // platform:cma is not cleared now: the "Try again" tap re-runs D
    const r = await send(u.id);
    expect(r.status).toBe(200);
    expect(await outbound(seller)).toEqual([]);
    const child = (await h.su.query<{ status: string; explanation: string }>('SELECT status, explanation FROM assistant_actions WHERE id = $1', [childId])).rows[0]!;
    expect(child.status).toBe('blocked');
    expect(child.explanation).toMatch(/^Not sent: the value range can no longer be shown to clients \(.+\)\.$/);
    // b13 audit V2B-3 (E632, brief E6): the tap, the view and every later tap carry the child's own reason (never "no
    // address to send to"), and a later tap still reports it, never 'failed' with no seller
    expect(r.body).toEqual({ actionId: u.id, status: 'approved', result: 'blocked', messageId: null, recipients: [{ contactId: seller, messageId: null, result: 'not_queued', reason: child.explanation }] });
    expect((await view(u.id)).delivery).toEqual([{ contactId: seller, name: expect.any(String), channel: 'email', status: 'not_queued', reason: child.explanation }]);
    const again = await send(u.id);
    expect(again.body).toEqual({ actionId: u.id, status: 'approved', result: 'blocked', messageId: null, recipients: [{ contactId: seller, messageId: null, result: 'not_queued', reason: child.explanation }] });
    // the resume pass reads approved or executed children only: never sent later, even once platform:cma is cleared
    await withCmaCleared(() => reconcile(h, w.tenantId));
    expect(await outbound(seller)).toEqual([]);
    expect((await withCmaCleared(() => send(u.id))).body).toMatchObject({ result: 'blocked', recipients: [{ contactId: seller, result: 'not_queued', reason: child.explanation }] });
    expect(await outbound(seller)).toEqual([]);
  });

  it('E639 R-CMA-7: a comp the pack hides from clients (internet display withheld) ⇒ the COMPS_HIDDEN line', async () => {
    const w2 = await assistantWorld(h, { agents: 1 });
    const m2 = await mlsConnection(h, w2.tenantId, w2.owner.userId!, { pack: cmaPack({ maxStalenessHours: 72 }), lastSyncedAt: new Date() });
    await localSales({ h, tenantId: w2.tenantId, mls: m2 }, 8, { displayAllowed: false });
    const l = await sellerListing(w2.agents[0]!, { postalCode: '94110' });
    const u = await withCmaCleared(async () => {
      await reconcile(h, w2.tenantId);
      return (await call<{ update: ValueUpdate }>(w2.agents[0]!, 'GET', `/listings/${l.listingId}/seller-update`)).body.update;
    });
    expect(valueOf(u).lines).toEqual([{ text: 'Value range unavailable: some of the sales it rests on can’t be shown under the MLS licence.', feedback: null }]);
  });

  it('E366 R-MLS-5: a mirrored team sale among the comps is shown from clientSoldView (the team row\'s address, the mirror\'s sold price)', async () => {
    const team = await teamListing(agent() as TestClient, { addressLine1: '700 Sample Avenue', status: 'sold', sqft: 1450, beds: 3, mlsNumber: `TM${Date.now() % 100000}` });
    const number = (await h.su.query<{ n: string }>('SELECT mls_number AS n FROM listings WHERE id = $1', [team])).rows[0]!.n;
    await mlsSale(mw(), { mlsNumber: number, line1: '700 Sample Ave', closeDate: daysAgo(5), sqft: 1450, beds: 3, closePriceCents: 52_000_000 });
    const l = await listing();
    const u = await withCmaCleared(() => drafted(l));
    expect(valueOf(u).lines.map((x) => x.text)).toContain('700 Sample Avenue, Oakland: sold ' + new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${daysAgo(5)}T12:00:00Z`)) + ' for $520,000');
  });
});

describe('b13 audit V2B-4 R-MLS-7: a seller value range never rests on BuildingAreaTotal (fix/mls-size merged before V2-B)', () => {
  it('E642 R-MLS-7 R-CMA-10: the subject\'s MLS mirror and the local sales synced under the Spark mapping with only BuildingAreaTotal store no size; a listing with no size of its own reads "the home\'s size or type is not on record", one with the agent\'s size reads "not enough comparable sales"; no number either way', async () => {
    const w2 = await assistantWorld(h, { agents: 1 });
    const m2 = await mlsConnection(h, w2.tenantId, w2.owner.userId!, { pack: cmaPack({ maxStalenessHours: 72 }), lastSyncedAt: new Date() });
    const a2 = w2.agents[0]!;
    const number = `TM${Date.now() % 100000}`;
    const own = await teamListing(a2 as TestClient, { addressLine1: '760 Sample Avenue', postalCode: '94110', status: 'active', sqft: undefined, mlsNumber: number });
    const seller = await ownedContact(a2 as TestClient, { consent: false, firstName: 'Sam' });
    expect((await call(a2, 'POST', `/listings/${own}/contacts`, { contactId: seller.id, role: 'seller' })).status).toBe(200);
    const sized = await sellerListing(a2, { postalCode: '94110' }); // the agent entered 1,450 sq ft (sellerUpdates/testing.ts)
    /** A Spark-style record: the total area only (synthetic, larger than the living area it replaces), no LivingArea. */
    const totalAreaOnly = (r: ResoLike): ResoLike => ({ ...r, BuildingAreaTotal: Math.round(Number(r['LivingArea']) * 1.3), LivingArea: null });
    const records = [
      ...Array.from({ length: 8 }, (_, i) => saleReso({ sqft: 1200 + i * 60, beds: 3, closeDate: daysAgo(20 + i * 25), contractDate: daysAgo(50 + i * 25), closePriceCents: 42_000_000 + i * 1_500_000 })),
      saleReso({ mlsNumber: number, line1: '760 Sample Ave', status: 'active', closePriceCents: null, closeDate: null, sqft: 1500 }),
    ].map(totalAreaOnly);
    await makeDue(h, m2);
    const synced = await syncConnection(mlsDeps(h, { [m2]: { ...pagedFeed([records]), fields: SPARK_FIELD_MAPPING } }), w2.tenantId as TenantId, m2);
    expect(synced).toMatchObject({ outcome: 'synced', skippedInvalid: 0, inserted: records.length });
    expect((await h.su.query<{ sized: number }>("SELECT count(sqft)::int AS sized FROM listings WHERE tenant_id = $1 AND source = 'mls'", [w2.tenantId])).rows[0]!.sized).toBe(0);
    const u = await withCmaCleared(async () => {
      await reconcile(h, w2.tenantId);
      const get = async (id: string) => (await call<{ update: ValueUpdate }>(a2, 'GET', `/listings/${id}/seller-update`)).body.update;
      return { own: await get(own), sized: await get(sized.listingId) };
    });
    const line = (t: string) => ({ state: 'unavailable', statement: `Value range unavailable: ${t}.`, lines: [{ text: `Value range unavailable: ${t}.`, feedback: null }] });
    expect(valueOf(u.own)).toMatchObject(line('the home’s size or type is not on record'));
    expect(valueOf(u.sized)).toMatchObject(line('not enough comparable sales'));
    for (const x of [u.own, u.sized]) {
      expect(JSON.stringify(valueOf(x))).not.toMatch(/\$|\d/);
      expect(x.preview.body).not.toMatch(/Estimated value/);
    }
  });
});

describe('b13 audit V2B-10 E633 R-CMA-7 R-MLS-5: a secondary MLS mirror of the subject listing at a variant key is never a near match on the seller-range path', () => {
  it('E633: relisted under a new MLS number, the team listing keeps its first MLS record (still live, at the variant "780 Sample Street"; the listing is "780 Sample Avenue") as a second mirror; resolveSubject puts it in the self set, so the range shows (has_data); unlinked, the same row reads "another live MLS listing may be this home"', async () => {
    const w3 = await assistantWorld(h, { agents: 1 });
    const a3 = w3.agents[0]!;
    const m3 = await mlsConnection(h, w3.tenantId, w3.owner.userId!, { pack: cmaPack({ maxStalenessHours: 72 }), lastSyncedAt: new Date() });
    const mw3 = { h, tenantId: w3.tenantId, mls: m3 };
    await localSales(mw3, 8);
    const first = `TA${Date.now() % 100000}`;
    const second = `TB${Date.now() % 100000}`;
    const own = await teamListing(a3 as TestClient, { addressLine1: '780 Sample Avenue', postalCode: '94110', status: 'active', mlsNumber: first });
    const seller = await ownedContact(a3 as TestClient, { consent: false, firstName: 'Sam' });
    expect((await call(a3, 'POST', `/listings/${own}/contacts`, { contactId: seller.id, role: 'seller' })).status).toBe(200);
    // the first MLS record, at a variant of the address (another street key), linked by its number
    const secondary = await mlsSale(mw3, { mlsNumber: first, line1: '780 Sample Street', status: 'active', closePriceCents: null, closeDate: null, sqft: 1450 });
    // relisted: the team listing takes the new number, and its new MLS record is at the listing's own address
    expect((await call(a3, 'PATCH', `/listings/${own}`, { mlsNumber: second })).status).toBe(200);
    const primary = await mlsSale(mw3, { mlsNumber: second, line1: '780 Sample Avenue', status: 'active', closePriceCents: null, closeDate: null, sqft: 1450 });
    const linked = (await h.su.query<{ id: string; team_listing_id: string | null }>('SELECT id, team_listing_id FROM listings WHERE id = ANY ($1::uuid[])', [[secondary, primary]])).rows;
    expect(linked.map((r) => r.team_listing_id)).toEqual([own, own]);
    const u = await withCmaCleared(async () => {
      await reconcile(h, w3.tenantId);
      return (await call<{ update: ValueUpdate }>(a3, 'GET', `/listings/${own}/seller-update`)).body.update;
    });
    expect(valueOf(u).state).toBe('has_data');
    expect(JSON.stringify(valueOf(u))).not.toMatch(/another live MLS listing may be this home/);
    // the control: the same row without the mirror link is a near match (fail closed, the range withheld)
    await h.su.query('UPDATE listings SET team_listing_id = NULL WHERE id = $1', [secondary]);
    const v = (await withCmaCleared(() => call<{ update: ValueUpdate }>(a3, 'POST', `/seller-updates/${u.id}/reassemble`))).body.update;
    expect(valueOf(v)).toMatchObject({ state: 'unavailable', lines: [{ text: 'Value range unavailable: another live MLS listing may be this home.', feedback: null }] });
  });
});
