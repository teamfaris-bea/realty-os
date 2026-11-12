// api/predict over real Postgres as app_user (module 50; PHASE2_3_PLAN §5.4 "49. core/predict and 50. api/predict").
// R-PRED-1..6, R-OWN-27, R-DATA-6/7, R-PERM-4; E120, E121, E122, E144.
//
// Models are synthetic (testing.ts) and registered under unique versions through an injected registry; the
// superuser writes prediction_models rows exactly as the platform would (no app code writes that table). Every
// read of a band or card goes through the normal agent path (GET /feed, RLS-bound). Public records come from the
// deterministic fake only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, command, contactOf, feedOf, type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { freshReauth } from '../admin/testing.js';
import { FakePublicRecords } from './provider.js';
import {
  FIRST_PARTY_MODEL,
  PROPERTY_MODEL,
  approvedModel,
  definitionOf,
  homeAddress,
  pass,
  releaseModel,
  rowsOf,
  savedListings,
  setModelStatus,
  sideEffectCounts,
  testRegistry,
  vendorRecord,
} from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const other = () => w.agents[1]!;
const likelyCards = async (c: (typeof w.agents)[number]) => (await feedOf(c)).all.filter((x) => x.itemType === 'likely_to_move');

/** An owned contact of `a` (name "<first> Doe") with a home address and a fake public record that names them. */
async function flaggedContact(a = agent(), o: { first?: string; owners?: string[]; saves?: number; records?: FakePublicRecords } = {}) {
  const first = o.first ?? `Pat${randomUUID().slice(0, 4)}`;
  const c = await contactOf(a, { firstName: first });
  const home = await homeAddress(h, w.tenantId, c.id);
  const records = o.records ?? new FakePublicRecords();
  records.put(home.address, vendorRecord(home.address, o.owners ?? [`DOE, ${first.toUpperCase()}`], { lastSaleDate: '2012-05-01', recentPermit: true }));
  if ((o.saves ?? 3) > 0) await savedListings(h, w.tenantId, c.id, o.saves ?? 3);
  return { contact: c, home, records, first };
}

describe('module 50: a fresh database', () => {
  it('R-PRED-1: a fresh database holds no prediction model (models ship withdrawn until counsel review), and the shipped registry is empty', async () => {
    expect((await h.su.query('SELECT count(*)::int AS n FROM prediction_models')).rows[0].n).toBe(0);
    const { MODEL_DEFINITIONS } = await import('./models.js');
    expect(MODEL_DEFINITIONS.size).toBe(0);
    // with no model able to score, the pass reads no contact and writes nothing
    const { report } = await pass(h, w.tenantId, { registry: MODEL_DEFINITIONS });
    expect(report).toMatchObject({ outcome: 'no_model', scoringModels: [], lookups: { made: 0 }, predictions: { evaluated: 0 } });
  });
});

describe('accept: an approved fixture model, a fake public record and saved listings give the owner one card', () => {
  it('E144 R-PRED-5: the band and the card are visible on GET /feed; withdrawing hides both at once with the rows untouched, the next pass writes nothing for it, re-approving brings them back', async () => {
    const def = await approvedModel(h);
    const reg = testRegistry(def);
    const { contact, records } = await flaggedContact();
    const r1 = await pass(h, w.tenantId, { registry: reg, publicRecords: records });
    expect(r1.alerts).toEqual([]);
    expect(r1.report.lookups).toMatchObject({ attached: 1, needsReview: 0 });

    const rows = await rowsOf(h, contact.id);
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]).toMatchObject({ owner_name_match: true, recent_permit: true, mortgage_origination_date: null, owner_occupied: null });
    expect(rows.predictions).toHaveLength(1);
    expect(rows.predictions[0]).toMatchObject({ model_version: def.version, band: 'likely_90d' });
    expect(rows.cards).toHaveLength(1);

    const cards = (await likelyCards(agent())).filter((c) => c.contact?.id === contact.id);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.primaryAction).toEqual({ kind: 'open_contact', label: 'Open contact', contactId: contact.id });
    expect(card.alternatives).toEqual([]);
    const labels = card.reasons.map((r) => r.label);
    expect(labels[0]).toBe('Scorecard band: may move in the next 90 days');
    expect(labels).toContain('14 years in the home');
    expect(labels).toContain('Saved 3 listings recently');
    expect(labels.at(-1)).toBe('Of 120 people flagged in the back-test, 31 transacted within 90 days');
    expect(JSON.stringify(card)).not.toMatch(/points|probabilit|confidence|likelihood|percent|"score"/i);

    // withdraw: hidden at once (no write), and the rows are untouched
    const snapshot = JSON.stringify(await rowsOf(h, contact.id));
    await setModelStatus(h, def.version, 'withdrawn');
    expect((await likelyCards(agent())).some((c) => c.contact?.id === contact.id)).toBe(false);
    expect(JSON.stringify(await rowsOf(h, contact.id))).toBe(snapshot);
    const r2 = await pass(h, w.tenantId, { registry: reg, publicRecords: records });
    expect(r2.report.outcome === 'no_model' || !r2.report.scoringModels.includes(def.version)).toBe(true);
    expect(JSON.stringify(await rowsOf(h, contact.id))).toBe(snapshot);

    await setModelStatus(h, def.version, 'approved');
    expect((await likelyCards(agent())).filter((c) => c.contact?.id === contact.id)).toHaveLength(1);
    await setModelStatus(h, def.version, 'withdrawn');
  });

  it('E121 R-PRED-4: after the pass flags a contact, exactly one card exists and nothing else happened: no message, call, notification, assistant action, step run, enrollment, task, ownership event or other job', async () => {
    const def = await approvedModel(h);
    const { contact, records } = await flaggedContact();
    const before = await sideEffectCounts(h, w.tenantId);
    const r = await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    expect(r.report.cards.inserted).toBeGreaterThanOrEqual(1);
    expect((await rowsOf(h, contact.id)).cards).toHaveLength(1);
    expect(await sideEffectCounts(h, w.tenantId)).toEqual(before);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});

describe('E122 R-PRED-2: a record attaches only on an exact address and an owner-name match', () => {
  it('E122: an owner-name mismatch, an address mismatch, missing data and a not-available answer each give owner_name_match false, no facts, no feature and no card', async () => {
    // a property-only model: without an attached record nothing can score above none
    const def = await approvedModel(h, { ...PROPERTY_MODEL, features: ['years_in_home', 'recent_permit'], rules: [{ feature: 'years_in_home', steps: [{ min: 10, points: 40 }] }, { feature: 'recent_permit', whenTrue: 30 }], bandThresholds: { likely: 60, watch: 30 } });
    const records = new FakePublicRecords();
    const a = agent();
    const name = await contactOf(a, { firstName: 'Quinn' });
    const nameHome = await homeAddress(h, w.tenantId, name.id);
    records.put(nameHome.address, vendorRecord(nameHome.address, ['SOMEONE ELSE'], { recentPermit: true }));
    const addr = await contactOf(a, { firstName: 'Rowan' });
    const addrHome = await homeAddress(h, w.tenantId, addr.id);
    const neighbour = { ...addrHome.address, line1: addrHome.address.line1.replace(/^\d+/, (n) => String(Number(n) + 2)) };
    records.put(addrHome.address, vendorRecord(neighbour, ['ROWAN DOE'], { recentPermit: true }));
    const missing = await contactOf(a, { firstName: 'Sage' });
    const missingHome = await homeAddress(h, w.tenantId, missing.id);
    records.put(missingHome.address, vendorRecord(missingHome.address, [], { recentPermit: true }));
    const none = await contactOf(a, { firstName: 'Tate' });
    await homeAddress(h, w.tenantId, none.id); // the fake answers not available

    const r = await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    expect(r.report.lookups.needsReview).toBeGreaterThanOrEqual(3);
    expect(r.report.lookups.notAvailable).toBeGreaterThanOrEqual(1);
    for (const c of [name, addr, missing, none]) {
      const x = await rowsOf(h, c.id);
      expect(x.records).toHaveLength(1);
      expect(x.records[0]).toMatchObject({ owner_name_match: false, last_sale_date: null, last_sale_price_cents: null, assessed_value_cents: null, recent_permit: null, provider_ref: null, mortgage_origination_date: null, owner_occupied: null });
      expect(x.predictions[0]).toMatchObject({ band: 'not_enough_data', reasons: [] });
      expect(x.cards).toHaveLength(0);
    }
    // a no-facts row is not due again before the refresh age: a second pass makes no lookup for them
    const calls = records.calls.length;
    await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    expect(records.calls.length).toBe(calls);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});

describe('R-PRED-1: a version scores only with its approved row, its definition and equal features', () => {
  it('R-PRED-1: an approved row with no definition, or with features unequal to its definition, scores nothing and raises WORKER_ERROR with reason PREDICTION_MODEL_INVALID', async () => {
    const c = await flaggedContact();
    const orphan = definitionOf(FIRST_PARTY_MODEL);
    await releaseModel(h, orphan.version, orphan.features, 'approved'); // no definition registered
    const drift = definitionOf(FIRST_PARTY_MODEL);
    await releaseModel(h, drift.version, ['recent_saves'], 'approved'); // the row names fewer features than its definition
    const r = await pass(h, w.tenantId, { registry: testRegistry(drift), publicRecords: c.records });
    expect(r.report.outcome).toBe('no_model');
    expect(r.alerts).toEqual([
      { severity: 'P2', code: 'WORKER_ERROR', tenantId: w.tenantId, details: { reason: 'PREDICTION_MODEL_INVALID', modelVersion: orphan.version, detail: 'no_definition' } },
      { severity: 'P2', code: 'WORKER_ERROR', tenantId: w.tenantId, details: { reason: 'PREDICTION_MODEL_INVALID', modelVersion: drift.version, detail: 'features_differ' } },
    ].sort((a, b) => (a.details.modelVersion < b.details.modelVersion ? -1 : 1)));
    const n = await h.su.query('SELECT count(*)::int AS n FROM contact_predictions WHERE model_version = ANY ($1::text[])', [[orphan.version, drift.version]]);
    expect(n.rows[0].n).toBe(0);
    expect(c.records.calls).toEqual([]);
    await setModelStatus(h, orphan.version, 'withdrawn');
    await setModelStatus(h, drift.version, 'withdrawn');
  });

  it('a draft or withdrawn row never scores and raises nothing; a first-party model makes no lookup at all', async () => {
    const draft = definitionOf(FIRST_PARTY_MODEL);
    await releaseModel(h, draft.version, draft.features, 'draft');
    const c = await flaggedContact();
    const r1 = await pass(h, w.tenantId, { registry: testRegistry(draft), publicRecords: c.records });
    expect([r1.report.outcome, r1.alerts]).toEqual(['no_model', []]);
    const fp = await approvedModel(h, FIRST_PARTY_MODEL);
    const r2 = await pass(h, w.tenantId, { registry: testRegistry(fp), publicRecords: c.records });
    expect(r2.report.scoringModels).toEqual([fp.version]);
    expect(c.records.calls).toEqual([]); // no model that can score names a property feature
    expect((await rowsOf(h, c.contact.id)).records).toHaveLength(0);
    expect((await rowsOf(h, c.contact.id)).predictions.find((p) => p.model_version === fp.version)).toMatchObject({ band: 'watch' });
    await setModelStatus(h, fp.version, 'withdrawn');
  });
});

describe('R-PRED-3: band, reasons and back-test, never a probability', () => {
  it('R-PRED-3: the stored prediction and the GET /feed card (snapshot); no key anywhere names a probability, confidence, likelihood, percent or score', async () => {
    const def = await approvedModel(h);
    const { contact, records } = await flaggedContact(agent(), { first: 'Snapshot' });
    await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    const p = (await rowsOf(h, contact.id)).predictions[0]!;
    const rec = (await rowsOf(h, contact.id)).records[0]!;
    const stored = { band: p.band, reasons: JSON.parse(JSON.stringify(p.reasons).replaceAll(rec.id, '<record>').replaceAll(contact.id, '<contact>')) };
    expect(stored).toMatchSnapshot();
    const card = (await likelyCards(agent())).find((c) => c.contact?.id === contact.id)!;
    const shown = JSON.parse(JSON.stringify({ itemType: card.itemType, band: card.band, reasons: card.reasons, primaryAction: card.primaryAction, alternatives: card.alternatives }).replaceAll(contact.id, '<contact>'));
    expect(shown).toMatchSnapshot();
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    const forbidden = /probab|confiden|likelihood|percent|score/i;
    expect(keys(card).filter((k) => forbidden.test(k))).toEqual([]);
    expect(keys(p).filter((k) => forbidden.test(k))).toEqual([]);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});

describe('cards follow the contact and the agent (R-PRED-3, R-PRED-4, R-PRED-6)', () => {
  it('a re-scored card updates in place; dropping to none closes it by condition; the agent closing it means it never comes back for them', async () => {
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    const reg = testRegistry(def);
    const a = agent();
    const c = await contactOf(a, { firstName: 'Ira' });
    await savedListings(h, w.tenantId, c.id, 1);
    await pass(h, w.tenantId, { registry: reg });
    const first = (await rowsOf(h, c.id)).cards;
    expect(first).toHaveLength(1);
    expect(first[0].reasons.map((r: { label: string }) => r.label)).toContain('Saved 1 listing recently');
    await savedListings(h, w.tenantId, c.id, 1);
    // same local date: the inputs changed, so the row changes in place (one card, new words)
    await pass(h, w.tenantId, { registry: reg });
    const second = (await rowsOf(h, c.id)).cards;
    expect(second.map((x) => [x.id, x.state])).toEqual([[first[0].id, 'open']]);
    expect(second[0].reasons.map((r: { label: string }) => r.label)).toContain('Saved 2 listings recently');
    // drops to none: closed by condition, comes back when it rises again
    // (the saves are 3 days old: a 1-day window counts none of them; behavior_events is append-only)
    const shortWindow = { recentSavesWindowDays: 1 };
    await pass(h, w.tenantId, { registry: reg, settings: shortWindow });
    expect((await rowsOf(h, c.id)).cards.map((x) => [x.state, x.resolved_by])).toEqual([['done', 'condition']]);
    await savedListings(h, w.tenantId, c.id, 1, 'fact', 0);
    await pass(h, w.tenantId, { registry: reg, settings: shortWindow });
    const back = (await likelyCards(a)).filter((x) => x.contact?.id === c.id);
    expect(back).toHaveLength(1);
    // the agent's own Done is final for that key
    expect((await call(a, 'POST', `/feed/${back[0]!.id}/done`)).status).toBe(200);
    await savedListings(h, w.tenantId, c.id, 3);
    await pass(h, w.tenantId, { registry: reg });
    expect(['likely_90d', 'watch']).toContain((await rowsOf(h, c.id)).predictions[0].band); // still flagged, yet no card
    expect((await likelyCards(a)).some((x) => x.contact?.id === c.id)).toBe(false);
    expect((await rowsOf(h, c.id)).cards.filter((x) => x.state === 'open')).toHaveLength(0);
    await setModelStatus(h, def.version, 'withdrawn');
  });

  it('R-PERM-4: a reassigned contact\'s card is closed for the previous owner and written for the new one; agent X\'s contact never yields a card for agent Y', async () => {
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    const reg = testRegistry(def);
    const c = await contactOf(agent(), { firstName: 'Juno' });
    await savedListings(h, w.tenantId, c.id, 3);
    await pass(h, w.tenantId, { registry: reg });
    expect((await likelyCards(agent())).filter((x) => x.contact?.id === c.id)).toHaveLength(1);
    expect((await likelyCards(other())).some((x) => x.contact?.id === c.id)).toBe(false);
    const re = await command(w.owner, c.id, 'reassign', { toUserId: other().userId });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await likelyCards(agent())).some((x) => x.contact?.id === c.id)).toBe(false); // RLS: no longer visible
    await pass(h, w.tenantId, { registry: reg });
    const cards = (await rowsOf(h, c.id)).cards;
    expect(cards.map((x) => [x.user_id, x.state, x.resolved_by])).toEqual([
      [agent().userId, 'done', 'condition'],
      [other().userId, 'open', null],
    ]);
    expect((await likelyCards(other())).filter((x) => x.contact?.id === c.id)).toHaveLength(1);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});

describe('R-PRED-6: do-not-contact and erasure', () => {
  it('R-PRED-6: a do-not-contact contact gets no card; an existing card leaves GET /feed at once and is closed by the next pass; a do-not-contact carried through a merge counts too', async () => {
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    const reg = testRegistry(def);
    const a = agent();
    const c = await contactOf(a, { firstName: 'Dana' });
    await savedListings(h, w.tenantId, c.id, 3);
    await pass(h, w.tenantId, { registry: reg });
    expect((await likelyCards(a)).filter((x) => x.contact?.id === c.id)).toHaveLength(1);
    const dnc = await call(a, 'POST', `/contacts/${c.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(dnc.status, JSON.stringify(dnc.body)).toBe(200);
    expect((await likelyCards(a)).some((x) => x.contact?.id === c.id)).toBe(false); // at once, before any pass
    await pass(h, w.tenantId, { registry: reg });
    expect((await rowsOf(h, c.id)).cards.map((x) => [x.state, x.resolved_by])).toEqual([['done', 'condition']]);

    // merge: the duplicate opted out; the survivor carries the do-not-contact and gets no card
    const email = `merge-${randomUUID().slice(0, 8)}@example.test`;
    const survivor = await contactOf(a, { firstName: 'Mel', email });
    const dup = await (await import('../comms/testing.js')).ownedContact(a, { firstName: 'Mel', email, consent: false, confirmDistinct: true });
    expect((await call(a, 'POST', `/contacts/${dup.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    const m = await command(a, survivor.id, 'merge', { loserId: dup.id });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await h.su.query('SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [survivor.id])).rows[0].dnc).toBe(true);
    await savedListings(h, w.tenantId, survivor.id, 3);
    await pass(h, w.tenantId, { registry: reg });
    expect((await rowsOf(h, survivor.id)).cards).toHaveLength(0);
    await setModelStatus(h, def.version, 'withdrawn');
  });

  it('R-PRED-6 R-DATA-7: after app.erase_contact no property record, prediction or card remains', async () => {
    const def = await approvedModel(h);
    const { contact, records } = await flaggedContact(agent(), { first: 'Erin' });
    await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    const before = await rowsOf(h, contact.id);
    expect([before.records.length, before.predictions.length, before.cards.length]).toEqual([1, 1, 1]);
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'POST', `/contacts/${contact.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await rowsOf(h, contact.id);
    expect([after.records.length, after.predictions.length, after.cards.length]).toEqual([0, 0, 0]);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});
