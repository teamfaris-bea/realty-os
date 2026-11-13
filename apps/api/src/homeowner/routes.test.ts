// GET /api/contacts/:id/homeowner (module 78; D10): the viewer's RLS, the strict schema, honest states.
// Real Postgres as app_user, the deterministic public-records fake only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ownedContact } from '../comms/testing.js';
import { call, command } from '../leads/testing.js';
import { beforeThisMonth, closedDeal } from '../nurture/testing.js';
import { FakePublicRecords, PUBLIC_RECORDS_TEST_TEXT } from '../predict/provider.js';
import { type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { HomeownerResponse, type HomeownerResponseT } from './schemas.js';
import { addAddress, countyRecord, homeowner, nextBeaufortAddress, refresh } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let records: FakePublicRecords;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
  records = new FakePublicRecords();
  records.today = () => new Date().toISOString().slice(0, 10);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const get = (who: { userId: string | null }, id: string) => call<HomeownerResponseT>(who as never, 'GET', `/contacts/${id}/homeowner`);

describe('GET /api/contacts/:id/homeowner (R-HOME-7)', () => {
  it('R-HOME-7 E585: a contact the viewer cannot see is 404, as is an unknown id; a contact that is not recognised is { recognized: false, homes: [] }', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records);
    expect((await get(w.agents[1]!, c.id)).status).toBe(404);
    expect((await get(w.agents[0]!, '01900000-0000-7000-8000-000000000000')).status).toBe(404);
    const plain = await ownedContact(w.agents[0]!, { consent: false });
    await addAddress(w.agents[0]!, plain.id, nextBeaufortAddress());
    const r = await get(w.agents[0]!, plain.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recognized: false, reasons: [], homes: [], mergedRecords: false, outreach: { built: false, clearanceOn: null } });
  });

  it('R-HOME-4 R-HOME-7: a matched home shows each value with its source and date; the response is strict and names no owner, score or estimate', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records);
    const before = await get(w.agents[0]!, c.id);
    expect(before.body.homes[0]).toMatchObject({ outcome: 'pending', check: { state: 'not_checked' } });
    await refresh(h, w.tenantId, { publicRecords: records });
    const r = await get(w.agents[0]!, c.id);
    expect(r.status).toBe(200);
    expect(HomeownerResponse.parse(r.body)).toEqual(r.body);
    expect(r.body.recognized).toBe(true);
    expect(r.body.reasons).toEqual([{ reason: 'seller_intent', since: null }]);
    const home = r.body.homes[0]!;
    expect(home).toMatchObject({ outcome: 'matched', county: { key: 'sc-beaufort', name: 'Beaufort County', mode: 'connector' }, mailingDiffers: true });
    expect(home.check.state).toBe('checked');
    const price = home.rows.find((x) => x.key === 'last_transfer_price_cents')!;
    expect(price).toMatchObject({ state: 'value', value: 25_000_000, source: 'Beaufort County GIS parcel layer', asOf: null });
    expect(price.state === 'value' && price.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(home.yearsOwned).toMatchObject({ since: '2015-06-01', source: 'Beaufort County GIS parcel layer' });
    expect(home.rows.filter((x) => x.state === 'pending_d9').map((x) => x.key)).toEqual(['mls_sale_history', 'in_house_value']);
    expect(home.loansLink?.label).toMatch(/Register of Deeds/);
    expect(home.taxRatesLink?.label).toBe('Beaufort County millage rates');
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(c.first.toUpperCase());
    expect(text).not.toMatch(/score|confidence|percent|estimat|balance|equity|ownerName|TEST-/i);
    expect(HomeownerResponse.safeParse({ ...r.body, homes: [{ ...home, ownerNames: ['X'] }] }).success).toBe(false);
    expect(HomeownerResponse.safeParse({ ...r.body, score: 1 }).success).toBe(false);
  });

  // b11 api-ui/F5: outside production (and in a staging demo with ALLOW_FAKE_PROVIDERS) the provider is the fake, which
  // is configured; its answers read as county findings unless the panel says no county was asked.
  it('R-HOME-4 R-HOME-5: on the test public-records source every home says no county was asked, checked or not', async () => {
    expect(h.providers.publicRecords.test).toBe(true);
    const c = await homeowner(h, w, w.agents[0]!, records);
    await addAddress(w.agents[0]!, c.id, nextBeaufortAddress({ postalCode: '29936' }));
    await refresh(h, w.tenantId, { publicRecords: records });
    const r = await get(w.agents[0]!, c.id);
    expect(r.status).toBe(200);
    expect(r.body.homes.map((x) => x.outcome).sort()).toEqual(['links_only', 'matched']);
    expect(r.body.homes.map((x) => x.providerNote)).toEqual([PUBLIC_RECORDS_TEST_TEXT, PUBLIC_RECORDS_TEST_TEXT]);
  });

  it('R-HOME-7 E589: the Team Lead reads it too; another tenant\'s user gets 404', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records);
    expect((await get(w.teamLead!, c.id)).status).toBe(200);
    const other = await workspaceWorld(h, { agents: 1 });
    expect((await get(other.agents[0]!, c.id)).status).toBe(404);
  }, 120_000);

  it('R-HOME-7: a past buyer\'s closing date is shown only to a viewer who can see the deal', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Pat', consent: false });
    const a = nextBeaufortAddress();
    await addAddress(w.agents[0]!, c.id, a);
    // the deal belongs to agent 2: agent 1 owns the contact but cannot see the deal
    await closedDeal(h, w.tenantId, c.id, w.agents[1]!.userId!, beforeThisMonth(10));
    records.put(a, countyRecord(a, ['PAT DOE']));
    await refresh(h, w.tenantId, { publicRecords: records });
    const own = await get(w.owner, c.id);
    expect(own.body.reasons).toEqual([{ reason: 'past_buyer', since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    const agent = await get(w.agents[0]!, c.id);
    expect(agent.status).toBe(200);
    expect(agent.body.reasons).toEqual([{ reason: 'past_buyer', since: null }]);
    expect(agent.body.homes[0]?.outcome).toBe('matched');
  });

  // b11 reconciliation homeowner-3: the county transfer date needs the Gisfile step, which is off by default
  it('R-HOME-4 R-HOME-7 E582: with no county transfer date, years owned counts from the team closing, only for a viewer who sees the deal', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Lee', consent: false });
    const a = nextBeaufortAddress();
    await addAddress(w.agents[0]!, c.id, a);
    const closedAt = new Date(Date.UTC(2021, 2, 15, 15));
    // the deal belongs to agent 2: agent 1 owns the contact but cannot see the deal
    await closedDeal(h, w.tenantId, c.id, w.agents[1]!.userId!, closedAt);
    records.put(a, countyRecord(a, ['LEE DOE'], { homeowner: { last_transfer_date: null, last_transfer_price_cents: null } }));
    await refresh(h, w.tenantId, { publicRecords: records });
    const own = (await get(w.owner, c.id)).body.homes[0]!;
    expect(own.outcome).toBe('matched');
    expect(own.rows.find((x) => x.key === 'last_transfer_date')).toMatchObject({ state: 'not_available' });
    expect(own.yearsOwned).toMatchObject({ since: '2021-03-15', basis: 'team_closing', source: "the team's closed deal in this CRM" });
    expect(own.yearsOwned!.years).toBeGreaterThanOrEqual(5);
    const agent = (await get(w.agents[0]!, c.id)).body.homes[0]!;
    expect(agent.outcome).toBe('matched');
    expect(agent.yearsOwned).toBeNull();
    expect(JSON.stringify(agent)).not.toContain('2021-03-15');
  });

  // b11 reconciliation homeowner-7 (owner question 16's default): seller inquiries of any age count, with the date shown
  it('R-HOME-1 R-HOME-7: a sell or value inquiry of any age recognises the person, and the reason shows the latest inquiry\'s date (team time zone)', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Ash', consent: false });
    await addAddress(w.agents[0]!, c.id, nextBeaufortAddress());
    const inquiry = (type: string, at: string) => h.su.query(
      `INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7, 'attached')`,
      [w.tenantId, randomUUID(), c.id, w.sourceId, at, type, `fp-${randomUUID()}`]);
    // The test team's zone is picked so its local hour is 10-16 when the test runs (zoneWithLocalHour), anywhere from
    // UTC-12 to UTC+14, so the expected day is the instant's date in that zone, not its UTC date.
    const tz = (await h.su.query<{ tz: string }>(`SELECT default_timezone AS tz FROM tenant_settings WHERE tenant_id = $1`, [w.tenantId])).rows[0]!.tz;
    const teamDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    await inquiry('value', '2019-04-02T16:00:00Z');
    expect((await get(w.agents[0]!, c.id)).body.reasons).toEqual([{ reason: 'seller_inquiry', since: teamDay('2019-04-02T16:00:00Z') }]);
    await inquiry('sell', '2022-08-09T16:00:00Z');
    await inquiry('buy', '2024-01-05T16:00:00Z');
    expect((await get(w.agents[0]!, c.id)).body.reasons).toEqual([{ reason: 'seller_inquiry', since: teamDay('2022-08-09T16:00:00Z') }]);
  });

  // b11 reconciliation homeowner-4: the panel listed only home and property rows, so a past buyer's K2 mailing subject
  // that was not checked yet was missing and the panel said no address was recorded.
  it('R-HOME-2 E560: an unchecked K2 subject of any kind is listed; an incomplete home and a plain mailing row are not', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Kai', consent: false });
    const bought = nextBeaufortAddress();
    await addAddress(w.agents[0]!, c.id, bought, 'mailing');
    await closedDeal(h, w.tenantId, c.id, w.agents[0]!.userId!, beforeThisMonth(), { listing: { line1: bought.line1, city: bought.city, postalCode: bought.postalCode } });
    const r = await get(w.agents[0]!, c.id);
    expect(r.body.reasons.map((x) => x.reason)).toEqual(['past_buyer']);
    expect(r.body.homes.map((x) => [x.address.split(',')[0], x.outcome])).toEqual([[bought.line1, 'pending']]);
    // a recognised seller with only a mailing row and an incomplete home: nothing to look up, so no home is listed
    const s = await ownedContact(w.agents[0]!, { firstName: 'Rae', consent: false });
    await addAddress(w.agents[0]!, s.id, nextBeaufortAddress(), 'mailing');
    await h.su.query(`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, region, postal_code) VALUES ($1, gen_random_uuid(), $2, 'home', '5 Sample Lane', 'SC', '29902')`, [w.tenantId, s.id]);
    await h.su.query(`UPDATE contacts SET intent = 'seller' WHERE id = $1`, [s.id]);
    const v = await get(w.agents[0]!, s.id);
    expect(v.body).toMatchObject({ recognized: true, homes: [] });
  });

  // b11 ownership-data/F6: a merge moves no addresses, inquiries or intent (0027), so a recognised duplicate's home and
  // its sell inquiry stay on the merged-away record. The engine closes that record with no owner, and contacts RLS then
  // hides it from the survivor's agent and Team Lead, so the flag is read from the survivor's merge tree (0075's
  // app.contact_merge_tree_ids: ids only), not from the hidden record itself.
  it('R-HOME-1 R-HOME-9 E569: after an engine merge the survivor\'s agent, its Team Lead and the Owner are each told that the profile uses only its own addresses, inquiries and intent', async () => {
    const survivor = await homeowner(h, w, w.agents[0]!, records, { reason: 'homeowner_tag' });
    const loser = await homeowner(h, w, w.agents[0]!, records, { reason: 'seller_inquiry' });
    expect((await get(w.agents[0]!, survivor.id)).body.mergedRecords).toBe(false);
    const m = await command(w.agents[0]!, survivor.id, 'merge', { loserId: loser.id });
    expect(m.status).toBe(200);
    expect((await h.su.query('SELECT merged_into_contact_id, owner_user_id FROM contacts WHERE id = $1', [loser.id])).rows[0]).toEqual({ merged_into_contact_id: survivor.id, owner_user_id: null });
    for (const viewer of [w.agents[0]!, w.teamLead!, w.owner]) {
      const r = await get(viewer, survivor.id);
      expect(r.status).toBe(200);
      expect(r.body.mergedRecords).toBe(true);
      expect(r.body.recognized).toBe(true);
      expect(r.body.reasons.map((x) => x.reason)).toEqual(['homeowner_tag']);
      expect(r.body.homes.map((x) => x.address.split(',')[0])).toEqual([survivor.address.line1]);
    }
    // the peer agent still sees nothing of the survivor
    expect((await get(w.agents[1]!, survivor.id)).status).toBe(404);
  });

  it('R-HOME-1 R-HOME-7 E569: a duplicate recognised only by its sell inquiry, merged into an unrecognised record: the survivor is not recognised and shows no profile (recognition does not carry over); the flag is still true for each viewer', async () => {
    const survivor = await ownedContact(w.agents[0]!, { consent: false });
    await addAddress(w.agents[0]!, survivor.id, nextBeaufortAddress());
    const loser = await homeowner(h, w, w.agents[0]!, records, { reason: 'seller_inquiry' });
    const m = await command(w.agents[0]!, survivor.id, 'merge', { loserId: loser.id });
    expect(m.status).toBe(200);
    for (const viewer of [w.agents[0]!, w.teamLead!, w.owner]) {
      const r = await get(viewer, survivor.id);
      expect(r.body).toEqual({ recognized: false, reasons: [], homes: [], mergedRecords: true, outreach: { built: false, clearanceOn: null } });
    }
  });

  it('R-HOME-8: the outreach line is never built; the counsel clearance shows only once recorded', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records);
    expect((await get(w.agents[0]!, c.id)).body.outreach).toEqual({ built: false, clearanceOn: null });
    await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = '2026-11-12T12:00:00Z' WHERE key = 'platform:public_records_outreach' AND status = 'published'`);
    try {
      expect((await get(w.agents[0]!, c.id)).body.outreach).toEqual({ built: false, clearanceOn: '2026-11-12' });
    } finally {
      await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:public_records_outreach'`);
    }
  });

  it('R-HOME-5 E575: a Jasper home is links only, never looked up', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records, { address: { postalCode: '29936' } });
    const calls = records.homeownerCalls.length;
    await refresh(h, w.tenantId, { publicRecords: records });
    expect(records.homeownerCalls.slice(calls).some((x) => x.includes(c.address.line1.toLowerCase().split(' ')[0]!) && x.endsWith('29936'))).toBe(false);
    const home = (await get(w.agents[0]!, c.id)).body.homes[0]!;
    expect(home).toMatchObject({ outcome: 'links_only', county: { key: 'sc-jasper', mode: 'links' }, check: { state: 'links_only' } });
    expect(home.lookupLinks.map((l) => l.label)).toEqual(['Jasper County Assessor on qPublic']);
  });

  it('R-HOME-3 E562: an owner mismatch shows the outcome and keeps no value', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records, { owners: () => ['SOMEONE ELSE'] });
    await refresh(h, w.tenantId, { publicRecords: records });
    const home = (await get(w.agents[0]!, c.id)).body.homes[0]!;
    expect(home).toMatchObject({ outcome: 'not_matched', matchDetail: 'owner_name_mismatch', mailingDiffers: null, yearsOwned: null });
    expect(home.rows.filter((x) => x.state === 'value')).toEqual([]);
    expect(JSON.stringify(home)).not.toContain('SOMEONE');
  });

  it('R-HOME-7: it writes nothing: no audit row, no profile, no job', async () => {
    const c = await homeowner(h, w, w.agents[0]!, records);
    const count = async () => (await h.su.query(`SELECT (SELECT count(*) FROM audit_log WHERE tenant_id = $1) + (SELECT count(*) FROM homeowner_profiles WHERE tenant_id = $1) + (SELECT count(*) FROM jobs WHERE tenant_id = $1) AS n`, [w.tenantId])).rows[0].n;
    const before = await count();
    await get(w.agents[0]!, c.id);
    expect(await count()).toBe(before);
  });
});
