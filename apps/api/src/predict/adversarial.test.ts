// Adversarial tests of module 50: try to get a person-level datum, a neighbour's record, an out-of-model feature, a
// protected proxy, a withdrawn model's output, another agent's card or a user's write through the prediction path.
// R-PRED-1, R-PRED-2, R-PRED-4, R-PRED-5, R-AST-12, R-PERM-4; E120, E122, E144.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { contactOf, feedOf, type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { recordFromLookup } from './decide.js';
import { defineModel as defineModelUnchecked, resolveModels } from './models.js';
import { FakePublicRecords, parsePublicRecord } from './provider.js';
import { PROPERTY_MODEL, approvedModel, definitionOf, homeAddress, pass, releaseModel, rowsOf, savedListings, setModelStatus, testRegistry, vendorRecord } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const PERSON_LEVEL = {
  age: 47,
  dateOfBirth: '1979-02-02',
  maritalStatus: 'married',
  phone: '+15555550123',
  email: 'owner@example.test',
  lender: 'Example Mortgage Co',
  mortgageOriginationDate: '2019-01-01',
  ownerOccupied: true,
  householdSize: 4,
  otherOwnedAddresses: [{ line1: '9 Elsewhere Rd', city: 'Exampleton', region: 'CA', postalCode: '90002' }],
  ownerMailingAddress: { line1: 'PO Box 1', city: 'Exampleton', region: 'CA', postalCode: '90003' },
};

describe('R-PRED-2: the vendor payload is cut down to property facts', () => {
  it('R-PRED-2: a payload carrying age, marital status, phone, lender, household or other owners\' addresses is cut down to the address, owner names, four facts and a reference', async () => {
    const a = { line1: '12 Synthetic Ct', city: 'Exampleton', region: 'CA', postalCode: '90001', county: 'X', geo: { lat: 1, lng: 2 } };
    const l = parsePublicRecord({ ...vendorRecord(a, ['Pat Doe']), ...PERSON_LEVEL, address: a, __proto__: { injected: true } });
    expect(l.status).toBe('found');
    if (l.status !== 'found') return;
    expect(Object.keys(l.candidate).sort()).toEqual(['address', 'facts', 'ownerNames', 'provenance', 'providerRef']);
    expect(Object.keys(l.candidate.address).sort()).toEqual(['city', 'line1', 'line2', 'postalCode', 'region']);
    expect(Object.keys(l.candidate.facts).sort()).toEqual(['assessedValueCents', 'lastSaleDate', 'lastSalePriceCents', 'recentPermit']);
    // the age (47) is matched as a JSON value: the record's random providerRef (a UUID) can contain the digits 47
    expect(JSON.stringify(l)).not.toMatch(/"age"|:47[,}]|married|5555550123|Mortgage Co|Elsewhere|PO Box|2019-01-01|householdSize|injected/);
    // malformed facts become null rather than a guess
    const bad = parsePublicRecord({ ...vendorRecord(a, ['Pat Doe']), lastSaleDate: 'last spring', lastSalePriceCents: -5, assessedValueCents: 1.5, recentPermit: 'yes', providerRef: 'x y z<script>' });
    expect(bad.status === 'found' && bad.candidate.facts).toEqual({ lastSaleDate: null, lastSalePriceCents: null, assessedValueCents: null, recentPermit: null });
    expect(bad.status === 'found' && bad.candidate.providerRef).toBeNull();
    expect(parsePublicRecord({ available: false, address: a })).toEqual({ status: 'not_available' });
    // source-neutral provenance (D10): each value's source and as-of date, bare or wrapped; a bad label is dropped
    const p = parsePublicRecord({ ...vendorRecord(a, ['Pat Doe']), source: 'County assessor', asOf: '2026-10-01', lastSaleDate: { value: '2012-05-01', source: 'County register of deeds', asOf: '2026-09-15' }, recentPermit: { value: true, source: '<b>x</b>' } });
    expect(p.status === 'found' && p.candidate.provenance).toEqual({
      lastSaleDate: { source: 'County register of deeds', asOf: '2026-09-15' },
      lastSalePriceCents: { source: 'County assessor', asOf: '2026-10-01' },
      assessedValueCents: { source: 'County assessor', asOf: '2026-10-01' },
      recentPermit: { source: 'County assessor', asOf: '2026-10-01' },
    });
    expect(p.status === 'found' && p.candidate.facts).toMatchObject({ lastSaleDate: '2012-05-01', recentPermit: true });
    expect(parsePublicRecord('not an object')).toEqual({ status: 'not_available' });
  });

  it('R-PRED-2: through the pass the stored row holds no person-level column, mortgage and occupancy stay NULL, and no name is stored', async () => {
    const def = await approvedModel(h);
    const records = new FakePublicRecords();
    const c = await contactOf(w.agents[0]!, { firstName: 'Ola' });
    const home = await homeAddress(h, w.tenantId, c.id);
    records.put(home.address, { ...vendorRecord(home.address, ['OLA DOE']), ...PERSON_LEVEL });
    await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    const rec = (await rowsOf(h, c.id)).records[0]!;
    expect(rec).toMatchObject({ owner_name_match: true, mortgage_origination_date: null, owner_occupied: null });
    expect(JSON.stringify(rec)).not.toMatch(/OLA|Doe|married|Mortgage Co|5555550123|1979-02-02|Elsewhere/i);
    await setModelStatus(h, def.version, 'withdrawn');
  });

  it('E122: a record for a neighbouring address, the same street in another city, or a different unit is not attached', () => {
    const home = { line1: '14 Synthetic Ct', line2: 'Unit 3', city: 'Exampleton', region: 'CA', postalCode: '90001' };
    const names = ['Pat Doe'];
    for (const other of [{ ...home, line1: '16 Synthetic Ct' }, { ...home, city: 'Otherton' }, { ...home, line2: 'Unit 4' }, { ...home, postalCode: '90011' }]) {
      const l = parsePublicRecord(vendorRecord(other, ['DOE, PAT']));
      expect(recordFromLookup(l, { address: home, names })).toMatchObject({ outcome: 'needs_review', detail: 'address_mismatch', ownerNameMatch: false, facts: null, providerRef: null });
    }
    // the same address written differently still attaches (core normalization)
    const same = parsePublicRecord(vendorRecord({ ...home, line1: '14 SYNTHETIC COURT', line2: '#3' }, ['DOE, PAT']));
    expect(recordFromLookup(same, { address: home, names }).outcome).toBe('attached');
  });
});

describe('R-PRED-1: a definition cannot widen its row', () => {
  it('R-PRED-1: a definition that cites a feature outside its row, or a rule outside its own features, scores nothing', async () => {
    const row = { version: 'predict/9.1', status: 'approved', features: ['recent_saves'], counsel_reviewed_at: new Date(), backtest_flagged: 10, backtest_transacted: 2, backtest_window_days: 90, backtest_dataset: 'synthetic' };
    const wider = definitionOf({ ...PROPERTY_MODEL }, 'predict/9.1');
    expect(resolveModels([row], new Map([[wider.version, wider]]))).toEqual({ scoring: [], invalid: [{ version: 'predict/9.1', reason: 'features_differ' }] });
    const sneaky = defineModelUnchecked({ version: 'predict/9.1', features: ['recent_saves'], rules: [{ feature: 'recent_saves', steps: [{ min: 1, points: 10 }] }, { feature: 'years_in_home', steps: [{ min: 1, points: 90 }] }], bandThresholds: { likely: 60, watch: 10 }, minFeaturesPresent: 1 });
    expect(resolveModels([row], new Map([[sneaky.version, sneaky]]))).toEqual({ scoring: [], invalid: [{ version: 'predict/9.1', reason: 'definition_invalid' }] });
    // and through the database: nothing is written for it
    const live = definitionOf({ features: ['recent_saves'], rules: [{ feature: 'recent_saves', steps: [{ min: 1, points: 10 }] }], bandThresholds: { likely: 60, watch: 10 }, minFeaturesPresent: 1 });
    await releaseModel(h, live.version, live.features, 'approved');
    const bad = defineModelUnchecked({ ...live, rules: [...live.rules, { feature: 'years_in_home', steps: [{ min: 1, points: 90 }] }] });
    const r = await pass(h, w.tenantId, { registry: new Map([[live.version, bad]]) });
    expect(r.report.invalidModels).toEqual([{ version: live.version, reason: 'definition_invalid' }]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_predictions WHERE model_version = $1', [live.version])).rows[0].n).toBe(0);
    await setModelStatus(h, live.version, 'withdrawn');
  });

  it('E120 R-AST-12: a contact with a self-reported protected-proxy pcs_timeline gets no stated timeline, even under a model that names stated_timeline_days', async () => {
    const def = await approvedModel(h, { features: ['stated_timeline_days', 'recent_saves'], rules: [{ feature: 'stated_timeline_days', steps: [{ max: 90, points: 90 }] }, { feature: 'recent_saves', steps: [{ min: 1, points: 5 }] }], bandThresholds: { likely: 60, watch: 30 }, minFeaturesPresent: 1 });
    const c = await contactOf(w.agents[0]!, { firstName: 'Pcs' });
    await h.su.query(`INSERT INTO contact_attributes (tenant_id, id, contact_id, key, value, sensitivity, self_reported) VALUES ($1, $2, $3, 'pcs_timeline', '"within 60 days"', 'protected_proxy', true)`, [w.tenantId, randomUUID(), c.id]);
    await h.su.query(`UPDATE contacts SET imported_fields = '{"timeline": "30 days", "stated_timeline_days": 30}'::jsonb WHERE id = $1`, [c.id]);
    await pass(h, w.tenantId, { registry: testRegistry(def) });
    const p = (await rowsOf(h, c.id)).predictions[0]!;
    expect(p.band).toBe('none');
    expect(JSON.stringify(p.reasons)).not.toMatch(/stated_timeline/);
    expect((await rowsOf(h, c.id)).cards).toHaveLength(0);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});

describe('R-PRED-5 E144: a model withdrawn mid-pass', () => {
  it('E144: a model withdrawn while the pass is looking records up leaves nothing visible: no band and no card', async () => {
    const def = await approvedModel(h);
    const records = new FakePublicRecords();
    const c = await contactOf(w.agents[0]!, { firstName: 'Mid' });
    const home = await homeAddress(h, w.tenantId, c.id);
    records.put(home.address, vendorRecord(home.address, ['MID DOE'], { recentPermit: true }));
    await savedListings(h, w.tenantId, c.id, 5);
    records.beforeAnswer = async () => void (await setModelStatus(h, def.version, 'withdrawn'));
    await pass(h, w.tenantId, { registry: testRegistry(def), publicRecords: records });
    expect((await rowsOf(h, c.id)).predictions.filter((p) => p.model_version === def.version)).toHaveLength(0);
    expect((await feedOf(w.agents[0]!)).all.some((x) => x.contact?.id === c.id && x.itemType === 'likely_to_move')).toBe(false);
  });
});

describe('R-PRED-4 R-PERM-4: only the system writes; only the owner gets the card', () => {
  it('R-PRED-4: any user role\'s or support\'s write to prediction_models, property_records or contact_predictions is refused', async () => {
    const def = await approvedModel(h);
    const c = await contactOf(w.agents[0]!, { firstName: 'Wren' });
    const home = await homeAddress(h, w.tenantId, c.id);
    const support: Actor = { kind: 'support', userId: w.owner.userId!, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
    const actors: [string, Actor][] = [['owner', w.owner.actor()], ['agent', w.agents[0]!.actor()], ...(w.teamLead ? [['team_lead', w.teamLead.actor()] as [string, Actor]] : []), ['support', support]];
    const writes = [
      sql`INSERT INTO prediction_models (version, status, features) VALUES ('predict/77.1', 'draft', ARRAY['recent_saves'])`,
      sql`UPDATE prediction_models SET status = 'approved' WHERE version = ${def.version}`,
      sql`INSERT INTO property_records (tenant_id, id, contact_id, contact_address_id, owner_name_match, fetched_at, retention_until)
          VALUES (app.tenant_id(), ${randomUUID()}, ${c.id}, ${home.id}, true, now(), now() + interval '30 days')`,
      sql`INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
          VALUES (app.tenant_id(), ${c.id}, ${def.version}, 'likely_90d', '[{"feature":"recent_saves","points":90,"evidence_ref":"x"}]', repeat('a', 64), current_date)`,
      sql`SELECT * FROM app.purge_prediction_data()`,
    ];
    for (const [label, actor] of actors) {
      for (const q of writes) {
        await expect(withTenantTx(actor, (tx) => q.execute(tx), { db: h.database }), label).rejects.toBeTruthy();
      }
    }
    const rows = await rowsOf(h, c.id);
    expect([rows.records.length, rows.predictions.length]).toEqual([0, 0]);
    // the system, for its part, can never write prediction_models either (platform-only)
    await expect(withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => writes[1]!.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    await setModelStatus(h, def.version, 'withdrawn');
  });

  it('R-PERM-4: agent X\'s flagged contact yields a card for X only, never for agent Y or the Team Lead', async () => {
    const def = await approvedModel(h);
    const x = w.agents[0]!;
    const y = w.agents[1]!;
    const c = await contactOf(x, { firstName: 'Xen' });
    await savedListings(h, w.tenantId, c.id, 5);
    await pass(h, w.tenantId, { registry: testRegistry(def) });
    const cards = (await rowsOf(h, c.id)).cards;
    expect(cards.map((r) => r.user_id)).toEqual([x.userId]);
    expect((await feedOf(y)).all.some((r) => r.contact?.id === c.id)).toBe(false);
    if (w.teamLead) expect((await feedOf(w.teamLead)).all.some((r) => r.contact?.id === c.id && r.itemType === 'likely_to_move')).toBe(false);
    await setModelStatus(h, def.version, 'withdrawn');
  });
});
