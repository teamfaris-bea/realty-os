// E536 and E538 cases the brief names that had no test (batch 13 audit F9): every subject state the panel and the
// gates refuse on, the ISA ceilings (the complete engine set or nothing, never partial), SELLER_WITHHELD under either AVM
// flag scope, the adapter's brokerage rule and the schema refusal of send_comps with handles. Real Postgres through the
// API harness; fakes only; packs cleared only in this test's database, in try/finally.
import { parseIsaModelOutput } from '@realty/core/isa';
import type { DisplayListing } from '@realty/core/listings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { HOME, cmaPack, daysAgo, localSales, saleReso, syncSales, teamListing } from '../../cma/testing.js';
import { type ListingRow, type StoredResult, clientReadiness, notLivingAreaSize, readinessConnections } from './cmaSeam.js';
import { adaptComp, buildCompsInTx } from './comps.js';
import { call } from '../testing.js';
import { PRINTABLE_STATEMENTS, type SellerLead, type SellerWorld, asSystem, confirm, nextHomeLine, nowInstant, panel, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

const codesOf = (w: SellerWorld, l: SellerLead) =>
  withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS))).then((r) => (r.ok ? [] : r.codes));
const fw = (w: SellerWorld) => ({ h, tenantId: w.tenantId, mls: w.mls });
/** The owner's confirm with the record id and a hash it never saw: the route's own refusal of the current state answers. */
const confirmAnyway = (w: SellerWorld, l: SellerLead) => call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/confirm-subject`, { contactAddressId: l.addressId, recordListingId: l.recordId, factsSha256: '0'.repeat(64) });

/** A seller lead whose own MLS record is synced as given (its ModificationTimestamp, type, display), and 8 comps. */
async function leadWithRecord(w: SellerWorld, record: Record<string, unknown>): Promise<SellerLead> {
  const line1 = nextHomeLine();
  const [id] = await syncSales(fw(w), [{ ...saleReso({ line1, closeDate: daysAgo(400), beds: 3, sqft: 1500, bathsX10: 20 }), ...record }]);
  const l = await sellerLead(h, w, { line1, record: null });
  return { ...l, recordId: id! };
}

describe('E536 R-ISA-18: every subject state keeps comps off (ISA-3 audit F9)', () => {
  it('E536: a home whose newest MLS record is more than 10 years old is SUBJECT_RECORD_OLD, with "Prepare a CMA" as the next step', async () => {
    const w = await sellerWorld(h);
    const l = await leadWithRecord(w, { ModificationTimestamp: new Date(Date.now() - 11 * 365.25 * 86_400_000).toISOString() });
    const p = await panel(w.agents[0]!, l.id);
    expect([p.body.subject.state, (p.body.subject as unknown as { code: string; nextStep: string }).code, (p.body.subject as unknown as { nextStep: string }).nextStep]).toEqual(['record_old', 'SUBJECT_RECORD_OLD', 'Prepare a CMA (enter type and size)']);
    expect(await codesOf(w, l)).toEqual(expect.arrayContaining(['SUBJECT_RECORD_OLD', 'SUBJECT_UNCONFIRMED']));
    expect((await confirmAnyway(w, l)).code).toBe('SUBJECT_RECORD_OLD');
  });

  it('E536: land is CMA_SUBJECT_TYPE_NOT_SUPPORTED: no confirmation, no comps', async () => {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w);
    await h.su.query(`UPDATE listings SET property_type = 'land' WHERE id = $1`, [l.recordId]);
    const p = await panel(w.agents[0]!, l.id);
    expect([p.body.subject.state, (p.body.subject as unknown as { code: string }).code]).toEqual(['type_not_supported', 'CMA_SUBJECT_TYPE_NOT_SUPPORTED']);
    expect(await codesOf(w, l)).toContain('CMA_SUBJECT_TYPE_NOT_SUPPORTED');
    expect((await confirmAnyway(w, l)).code).toBe('CMA_SUBJECT_TYPE_NOT_SUPPORTED');
  });

  it('E536 R-ISA-18: a record the MLS keeps off internet display is not displayable: the home is never shown or confirmed', async () => {
    const w = await sellerWorld(h);
    const l = await leadWithRecord(w, { InternetEntireListingDisplayYN: false });
    const p = await panel(w.agents[0]!, l.id);
    expect(['not_displayable', 'not_in_mls']).toContain(p.body.subject.state);
    expect(p.body.subject.confirmed).toBe(false);
    expect((await codesOf(w, l)).some((c) => c === 'SUBJECT_INCOMPLETE' || c === 'SUBJECT_NOT_IN_MLS')).toBe(true);
    expect(['SUBJECT_INCOMPLETE', 'SUBJECT_NOT_IN_MLS']).toContain((await confirmAnyway(w, l)).code);
  });

  it('E536 R-MLS-5: a sold mirror of the team\'s own listing is shown through the sold-mirror rendering with its team row, and confirms', async () => {
    const w = await sellerWorld(h);
    const line1 = nextHomeLine();
    const mls = `TM${Date.now() % 100_000}`;
    await teamListing(w.agents[1]!, { addressLine1: line1, city: 'Oakland', region: 'CA', postalCode: '94110', status: 'sold', sqft: 1500, beds: 3, mlsNumber: mls });
    const l = await sellerLead(h, w, { line1, record: { mlsNumber: mls } });
    expect((await h.su.query(`SELECT team_listing_id IS NOT NULL AS m FROM listings WHERE id = $1`, [l.recordId])).rows[0].m).toBe(true);
    const p = await panel(w.agents[0]!, l.id);
    expect([p.body.subject.state, p.body.subject.recordListingId]).toEqual(['ok', l.recordId]);
    expect((await confirm(w, l)).status).toBe(200);
  });
});

describe('E536 R-ISA-18: the ceilings: the complete engine set or nothing, never partial, no count (ISA-3 audit F9)', () => {
  /** A world whose only comparable sales are `o` (8 of them), and a confirmed seller lead. */
  async function only(o: Parameters<typeof localSales>[2]): Promise<{ w: SellerWorld; l: SellerLead }> {
    const w = await sellerWorld(h);
    const l = await sellerLead(h, w, { comps: 0 });
    await localSales(fw(w), 8, o);
    expect((await confirm(w, l)).status).toBe(200);
    return { w, l };
  }
  const noPartial = (codes: string[]) => expect(JSON.stringify(codes)).not.toMatch(/\d/);

  it('E536: sales only 13 to 20 months old (the engine reaches back 24 months): COMPS_CEILING', async () => {
    const { w, l } = await only({ closeDate: daysAgo(420), contractDate: daysAgo(450) });
    const codes = await codesOf(w, l);
    expect(codes).toEqual(['COMPS_CEILING']);
    noPartial(codes);
  });

  it('E536: sales only across the city (another subdivision and ZIP, miles away): COMPS_CEILING (the city tier is not an ISA tier)', async () => {
    const { w, l } = await only({ subdivision: 'Far Hills (test)', postalCode: '94619', latE6: HOME.latE6 + 90_000, lonE6: HOME.lonE6 + 90_000 });
    const codes = await codesOf(w, l);
    expect(codes).toEqual(['COMPS_CEILING']);
    noPartial(codes);
  });

  it('E536: only dissimilar sales (twice the size): no comps, never a partial set', async () => {
    const { w, l } = await only({ sqft: 3400 });
    const codes = await codesOf(w, l);
    expect(codes).toEqual(['NO_VALUE']);
    noPartial(codes);
  });

  it('E536: comps the MLS keeps off internet display: COMPS_HIDDEN', async () => {
    const { w, l } = await only({ displayAllowed: false });
    const codes = await codesOf(w, l);
    expect(codes).toEqual(['COMPS_HIDDEN']);
    noPartial(codes);
  });
});

describe('E538 R-ISA-18: SELLER_WITHHELD under either AVM flag scope (ISA-3 audit F9)', () => {
  it('E538: the home\'s live MLS listing says no automated valuation (AVM N) under a pack scoping the flag to internet display only: SELLER_WITHHELD for the AI ISA use, not for a client CMA', async () => {
    const w = await sellerWorld(h, { pack: cmaPack({ valuation: { ai_isa_comps: true, avm_flag_scope: 'internet_display_only' } }) });
    const live = (await syncSales(fw(w), [saleReso({ status: 'active', line1: nextHomeLine(), beds: 3, sqft: 1500, avmDisplayAllowed: false })]))[0]!;
    const row = (await h.su.query<{ k: string }>('SELECT address_key AS k FROM listings WHERE id = $1', [live])).rows[0]!;
    const out = await asSystem(h, w, await sellerLead(h, w), async (tx) => {
      const now = nowInstant();
      const base = { conns: await readinessConnections(tx, now), now, state: 'CA', addressKey: row.k, addressLine: null, subjectMlsListingId: live, compSales: [], readConnectionIds: [], nearMatchDismissed: [], hasValue: true, notLivingArea: notLivingAreaSize([]) };
      return { isa: await clientReadiness(tx, { ...base, use: 'ai_isa' }), client: await clientReadiness(tx, { ...base, use: 'client_cma' }) };
    });
    expect(out.isa.share.blockers.map((b) => b.code)).toContain('SELLER_WITHHELD');
    expect(out.client.share.blockers.map((b) => b.code)).not.toContain('SELLER_WITHHELD');
  });
});

describe('E536 R-ISA-18: the adapter and the model schema (ISA-3 audit F9)', () => {
  const comp = { tier: 'within_1mi', why: ['Within 1 mile.'], ref: { identity: 'x' }, labels: [] } as unknown as StoredResult['comps'][number];
  const shown = { closePriceCents: 50_000_000, closeDate: '2026-10-01', beds: 3, sqft: 1500, omittedFields: [], addressHidden: false, address: { line1: '1 Test Way' }, listingBrokerageName: null } as unknown as DisplayListing;

  it('E536: a sale with no brokerage of its own takes its mirror\'s; with neither it is refused (no comps, never a nameless line)', () => {
    expect(adaptComp(comp, shown, { listing_brokerage_name: 'Mirror Brokerage (test)' } as unknown as ListingRow)?.listingBrokerageName).toBe('Mirror Brokerage (test)');
    expect(adaptComp(comp, shown, { listing_brokerage_name: null } as unknown as ListingRow)).toBeNull();
    expect(adaptComp(comp, shown, { listing_brokerage_name: '  ' } as unknown as ListingRow)).toBeNull();
  });

  it('E536 R-ISA-13: send_comps with handles is refused by the schema (the model never picks which comps are shown)', () => {
    const out = (actions: unknown[]) => parseIsaModelOutput(JSON.stringify({ reply: null, qualification: [], actions, summary: null }));
    expect(out([{ type: 'send_comps' }]).ok).toBe(true);
    expect(out([{ type: 'send_comps', handles: ['C1'] }])).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(out([{ type: 'send_comps', comps: [1, 2, 3] }])).toMatchObject({ ok: false, code: 'SCHEMA' });
  });
});
