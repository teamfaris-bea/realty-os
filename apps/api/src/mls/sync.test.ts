// mls.sync through real Postgres and the Phase 1 saved-search path, with a deterministic record feed only
// (no provider, no network). R-MLS-1, R-MLS-2, R-MLS-3, R-MLS-5, R-MLS-6, R-OWN-27; E81, E85, E86, E141.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import type { TenantId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTESTATION_TEXT } from '../admin/policy.js';
import { freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, listing, messagesOf, ownedContact, runJobs } from '../assistant/testing.js';
import { sendDueAlertsInTx } from '../assistant/searches.js';
import { SparkError } from '../providers/integrations/spark.js';
import { systemActor } from '../worker/systemActor.js';
import { syncConnection, syncDueConnections } from './sync.js';
import { REVIEWED_PACK, TEST_ATTRIBUTION, TEST_DISCLAIMER, makeDue, mlsConnection, mlsDeps, mlsRows, pagedFeed, reso } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const tid = () => w.tenantId as TenantId;

/** An active saved search on one postal code for a new contact of agent 0; returns ids. */
async function activeSearch(zip: string, o: { channel?: 'sms' | 'email' } = {}): Promise<{ contactId: string; searchId: string }> {
  const agent = w.agents[0]!;
  const c = await ownedContact(agent);
  const searchId = randomUUID();
  await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Near the park','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, searchId, c.id, JSON.stringify({ postalCodes: [zip] })]);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [], alertChannel: o.channel ?? 'sms' })).status).toBe(200);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/activate`)).status).toBe(200);
  return { contactId: c.id, searchId };
}
const alerts = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');
const matches = async (searchId: string) => (await h.su.query<{ listing_id: string; alerted_message_id: string | null }>('SELECT listing_id, alerted_message_id FROM saved_search_matches WHERE search_id = $1 ORDER BY matched_at', [searchId])).rows;

async function sync(connectionId: string, feed: ReturnType<typeof pagedFeed>, tenant = tid()) {
  await makeDue(h, connectionId);
  return syncConnection(mlsDeps(h, { [connectionId]: feed }), tenant, connectionId);
}

describe('mls.sync: upsert by (source, mls_number) with the monotonic modification', () => {
  it('E141 R-MLS-1: an out-of-order (older) or equal modification is skipped; the newer row stays; the DB trigger refuses an older one (MLS_STALE_UPDATE)', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([
      [reso(141, { ListPrice: 600000, ModificationTimestamp: '2026-11-10T12:00:00Z', PostalCode: '94141' })],
      [reso(141, { ListPrice: 1, ModificationTimestamp: '2026-11-10T11:00:00Z', PostalCode: '94141' })],
      [reso(141, { ListPrice: 2, ModificationTimestamp: '2026-11-10T12:00:00Z', PostalCode: '94141' })],
    ]);
    expect(await sync(conn, feed)).toMatchObject({ outcome: 'synced', inserted: 1, skippedStale: 0 });
    expect(await sync(conn, feed)).toMatchObject({ outcome: 'synced', inserted: 0, updated: 0, skippedStale: 1 });
    expect(await sync(conn, feed)).toMatchObject({ outcome: 'synced', updated: 0, skippedStale: 1 });
    const row = (await mlsRows(h, w.tenantId)).find((r) => r.mls_number === 'M141')!;
    expect([Number(row.list_price_cents), row.mls_modified_at.toISOString()]).toEqual([60_000_000, '2026-11-10T12:00:00.000Z']);
    await expect(
      withTenantTx(systemActor(tid(), 'provider'), async (tx) => void (await sql`UPDATE listings SET mls_modified_at = '2026-11-01T00:00:00Z', list_price_cents = 1 WHERE id = ${row.id}`.execute(tx)), { db: h.database }),
    ).rejects.toThrow(/MLS_STALE_UPDATE/);
  });

  it('R-MLS-1: MLS rows are written only by the system actor (a person, even the Owner, cannot insert or edit one)', async () => {
    const row = (await mlsRows(h, w.tenantId)).find((r) => r.mls_number === 'M141')!;
    await expect(
      withTenantTx(w.owner.actor(), async (tx) => void (await sql`UPDATE listings SET list_price_cents = 5 WHERE id = ${row.id}`.execute(tx)), { db: h.database }),
    ).rejects.toThrow(/row-level security|policy/);
    await expect(
      withTenantTx(w.owner.actor(), async (tx) => void (await sql`INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code) VALUES (app.tenant_id(), ${randomUUID()}, 'mls', 'X1', 'active', '1 A St', 'Oakland', 'CA', '94110')`.execute(tx)), { db: h.database }),
    ).rejects.toThrow(/row-level security|policy/);
  });

  it('records core cannot normalize are skipped (codes counted, nothing stored) and the cursor still advances', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([[reso(1501, { ListOfficeName: null }), reso(1502, { StandardStatus: 'Mystery' }), reso(1503, { PostalCode: '94150' })]]);
    expect(await sync(conn, feed)).toMatchObject({ inserted: 1, skippedInvalid: 2 });
    expect((await h.su.query('SELECT sync_cursor FROM integration_connections WHERE id = $1', [conn])).rows[0]).toEqual({ sync_cursor: 'c3' });
  });
});

describe('MLS rows in the Phase 1 saved-search alerts (R-MLS-6, R-MLS-2)', () => {
  it('R-MLS-6: one alert per new match, with attribution, disclaimer and the listing brokerage; a re-sync of the same listing never alerts again (no trigger duplicate)', async () => {
    const { contactId, searchId } = await activeSearch('94606');
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([[reso(606, { PostalCode: '94606' })], [reso(606, { PostalCode: '94606', ListPrice: 480000, ModificationTimestamp: '2026-11-10T13:00:00Z' })], [reso(606, { PostalCode: '94606', ListPrice: 470000, ModificationTimestamp: '2026-11-10T14:00:00Z' })]]);
    expect((await sync(conn, feed)).matched).toBe(1);
    expect(await alerts(contactId)).toHaveLength(1);
    const body = (await alerts(contactId))[0]!.body;
    expect(body).toContain('Listed by Other Brokerage (test)');
    expect(body).toContain(TEST_ATTRIBUTION);
    expect(body).toContain(TEST_DISCLAIMER);
    expect(body).toContain('616 Sample Ave, Oakland');
    // control for the switch test below: with search_alert on, the MLS alert is dispatched by the gate
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND dispatched_at IS NOT NULL', [contactId])).rows[0]).toEqual({ n: 1 });
    for (let i = 0; i < 2; i++) expect((await sync(conn, feed)).matched).toBe(0);
    expect(await alerts(contactId)).toHaveLength(1);
    expect(await matches(searchId)).toHaveLength(1);
  });

  it('R-MLS-6: a city search finds MLS rows whatever the capitalisation (the indexed prefilter is complete)', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await sync(conn, pagedFeed([[reso(6301, { City: 'McKittrick Hollow', PostalCode: '94631' }), reso(6302, { City: 'MCKITTRICK HOLLOW', PostalCode: '94632' })]]));
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = randomUUID();
    await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'City','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, id, c.id, JSON.stringify({ cities: [{ city: 'mckittrick hollow' }] })]);
    const r = await call<{ search: { matches: { source: string; listingBrokerageName: string | null; postalCode: string }[] } }>(agent, 'GET', `/saved-searches/${id}/preview`);
    expect(r.body.search.matches.map((m) => m.postalCode).sort()).toEqual(['94631', '94632']);
    expect(r.body.search.matches.every((m) => m.source === 'mls' && m.listingBrokerageName === 'Other Brokerage (test)')).toBe(true);
  });

  it('R-MLS-2: nothing reaches a client until the pack is counsel-reviewed and carries attribution and disclaimer', async () => {
    const { contactId } = await activeSearch('94602');
    const { reviewed_by_counsel_at: _r, ...unreviewed } = REVIEWED_PACK;
    const { attribution_text: _a, ...noAttribution } = REVIEWED_PACK;
    for (const [i, pack] of [unreviewed, noAttribution, {}].entries()) {
      const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: pack as Record<string, unknown> });
      expect((await sync(conn, pagedFeed([[reso(6020 + i, { PostalCode: '94602' })]]))).inserted).toBe(1);
    }
    expect(await alerts(contactId)).toEqual([]);
  });

  it('E81 R-MLS-5: the team\'s own listing in the feed is linked to the team row, which stays authoritative; the client hears about it once', async () => {
    const team = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94681' });
    await h.su.query("UPDATE listings SET mls_number = 'M681' WHERE id = $1", [team]);
    const { contactId, searchId } = await activeSearch('94681');
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await sync(conn, pagedFeed([[reso(681, { PostalCode: '94681', StandardStatus: 'Pending' })]]));
    const mirror = (await mlsRows(h, w.tenantId)).find((r) => r.mls_number === 'M681')!;
    expect(mirror.team_listing_id).toBe(team);
    expect((await matches(searchId)).map((m) => m.listing_id)).toEqual([team]);
    expect(await alerts(contactId)).toHaveLength(1);
    expect((await alerts(contactId))[0]!.body).not.toContain('Listed by'); // the team row, not the MLS copy
  });

  it('E86: a listing whose broker opted out of internet display is never alerted; an alert queued before the opt-out is canceled', async () => {
    const { contactId, searchId } = await activeSearch('94686');
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([
      [reso(686, { PostalCode: '94686', InternetEntireListingDisplayYN: false })],
      [reso(687, { PostalCode: '94686', ModificationTimestamp: '2026-11-10T11:00:00Z' })],
      [reso(687, { PostalCode: '94686', InternetEntireListingDisplayYN: 'N', ModificationTimestamp: '2026-11-10T12:00:00Z' })],
    ]);
    expect((await sync(conn, feed)).matched).toBe(0);
    expect(await alerts(contactId)).toEqual([]);
    expect((await sync(conn, feed)).matched).toBe(1);
    const [queued] = await alerts(contactId);
    expect(['queued', 'scheduled']).toContain(queued!.status);
    await sync(conn, feed);
    const after = (await alerts(contactId)).find((m) => m.id === queued!.id)!;
    expect([after.status, after.status_reason]).toEqual(['canceled', 'MLS_DISPLAY_WITHDRAWN']);
    expect((await matches(searchId)).every((m) => m.alerted_message_id === null)).toBe(true);
    await withTenantTx(systemActor(tid(), 'assistant'), (tx, now) => sendDueAlertsInTx(tx, mlsDeps(h), w.tenantId, now, { searchId }), { db: h.database });
    expect(await alerts(contactId)).toHaveLength(1);
  });

  it('E85 R-MLS-3: feed down (stale) ⇒ the connection is degraded, queued MLS alerts are canceled, MLS matches pause; they resume when the feed is back', async () => {
    const { contactId, searchId } = await activeSearch('94685');
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    let down = false;
    const feed = pagedFeed([[reso(685, { PostalCode: '94685' })]], { fail: () => (down ? new SparkError('UNREACHABLE', 503) : null) });
    expect((await sync(conn, feed)).matched).toBe(1);
    const [queued] = await alerts(contactId);
    // three days without a successful sync
    down = true;
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '3 days' WHERE id = $1", [conn]);
    expect(await sync(conn, feed)).toMatchObject({ outcome: 'failed', code: 'UNREACHABLE' });
    expect((await h.su.query('SELECT status, status_reason FROM integration_connections WHERE id = $1', [conn])).rows[0]).toEqual({ status: 'degraded', status_reason: 'UNREACHABLE' });
    expect((await alerts(contactId)).find((m) => m.id === queued!.id)).toMatchObject({ status: 'canceled', status_reason: 'MLS_FEED_STALE' });
    // a released match is not alerted while the feed is stale (stale data is never sent)
    const sent = await withTenantTx(systemActor(tid(), 'assistant'), (tx, now) => sendDueAlertsInTx(tx, mlsDeps(h), w.tenantId, now, { searchId }), { db: h.database });
    expect(sent).toBe(0);
    // back up: recovered, fresh, and the fresh listing is alerted
    down = false;
    feed.push([reso(685, { PostalCode: '94685', ModificationTimestamp: '2026-11-10T15:00:00Z' })]);
    expect((await sync(conn, feed)).outcome).toBe('synced');
    expect((await h.su.query('SELECT status FROM integration_connections WHERE id = $1', [conn])).rows[0]).toEqual({ status: 'connected' });
    await withTenantTx(systemActor(tid(), 'assistant'), (tx, now) => sendDueAlertsInTx(tx, mlsDeps(h), w.tenantId, now, { searchId }), { db: h.database });
    expect((await alerts(contactId)).filter((m) => m.status !== 'canceled')).toHaveLength(1);
  });

  it("the Owner's search_alert switch still stops MLS alerts (the send-time gate decides, unchanged)", async () => {
    type Pol = { activePolicyId: string; versions: { id: string; autonomousCategories: string[] }[] };
    const cur = (await call<Pol>(w.owner, 'GET', '/compliance-policies')).body;
    const categories = cur.versions.find((v) => v.id === cur.activePolicyId)!.autonomousCategories;
    expect(categories).toContain('search_alert');
    const off = await call(w.owner, 'POST', '/compliance-policies', { autonomousCategories: categories.filter((c) => c !== 'search_alert'), activate: true });
    expect(off.status).toBe(201);
    try {
      const { contactId } = await activeSearch('94699');
      const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
      expect((await sync(conn, pagedFeed([[reso(699, { PostalCode: '94699' })]]))).matched).toBe(1);
      await runJobs(h, w.tenantId, ['comms.dispatch']);
      const a = await alerts(contactId);
      expect(a.length).toBeGreaterThan(0);
      for (const m of a) expect(['sent', 'delivered']).not.toContain(m.status);
      expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND dispatched_at IS NOT NULL', [contactId])).rows[0]).toEqual({ n: 0 });
    } finally {
      await freshReauth(h, w.owner);
      const on = await call(w.owner, 'POST', '/compliance-policies', { autonomousCategories: categories, activate: true, attestation: ATTESTATION_TEXT });
      expect(on.status).toBe(201);
    }
  });
});

describe('R-OWN-27: woken from next_sync_at, claimed once, behind the cursor fence', () => {
  it('only due connections run; a run moves next_sync_at forward (stored instant)', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([[reso(2701, { PostalCode: '94270' })]]);
    await h.su.query("UPDATE integration_connections SET next_sync_at = now() + interval '1 hour' WHERE tenant_id = $1 AND kind = 'mls_feed'", [w.tenantId]);
    expect(await syncDueConnections(mlsDeps(h, { [conn]: feed }), tid())).toEqual([]);
    await makeDue(h, conn);
    const r = await syncDueConnections(mlsDeps(h, { [conn]: feed }), tid());
    expect(r.map((x) => [x.connectionId, x.outcome])).toEqual([[conn, 'synced']]);
    const next = (await h.su.query<{ due: boolean }>('SELECT next_sync_at > now() + interval \'10 minutes\' AS due FROM integration_connections WHERE id = $1', [conn])).rows[0]!;
    expect(next.due).toBe(true);
  });

  it('two concurrent runs of one connection: one syncs, the other is fenced by the claim', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await makeDue(h, conn);
    const deps = mlsDeps(h, { [conn]: pagedFeed([[reso(2702, { PostalCode: '94270' })], [reso(2703, { PostalCode: '94270' })]]) });
    const r = await Promise.all([syncConnection(deps, tid(), conn), syncConnection(deps, tid(), conn)]);
    expect(r.map((x) => x.outcome).sort()).toEqual(['fenced', 'synced']);
  });

  it('the cursor fence: if the cursor moved while the page was read, nothing of the page is written', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const inner = pagedFeed([[reso(2704, { PostalCode: '94270' })]]);
    const racing = {
      fields: {},
      async records(c: string | null, n: number) {
        await h.su.query("UPDATE integration_connections SET sync_cursor = 'moved-by-another-run' WHERE id = $1", [conn]);
        return inner.records(c, n);
      },
    };
    await makeDue(h, conn);
    expect((await syncConnection(mlsDeps(h, { [conn]: racing }), tid(), conn)).outcome).toBe('fenced');
    expect((await mlsRows(h, w.tenantId)).some((r) => r.mls_number === 'M2704')).toBe(false);
  });

  it('a disconnected or not-live connection is never synced', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query("UPDATE integration_connections SET status = 'revoked', status_reason = 'X' WHERE id = $1", [conn]);
    await makeDue(h, conn);
    expect((await syncConnection(mlsDeps(h, { [conn]: pagedFeed([[reso(2705)]]) }), tid(), conn)).outcome).toBe('fenced');
  });
});

describe('cross-tenant isolation (R-TEN-1)', () => {
  it('another tenant cannot sync, claim or read this tenant\'s connection or rows; its search never matches them', async () => {
    const b = await assistantWorld(h, { agents: 1 });
    const connA = await mlsConnection(h, w.tenantId, w.owner.userId!);
    // B's system actor running A's connection id: RLS hides it, nothing is claimed or written
    await makeDue(h, connA);
    const r = await syncConnection(mlsDeps(h, { [connA]: pagedFeed([[reso(9001, { PostalCode: '94901' })]]) }), b.tenantId as TenantId, connA);
    expect(r.outcome).toBe('fenced');
    expect(await mlsRows(h, b.tenantId)).toEqual([]);
    // A's rows never reach B's searches
    await sync(connA, pagedFeed([[reso(9002, { PostalCode: '94902' })]]));
    const agentB = b.agents[0]!;
    const cB = await ownedContact(agentB);
    const sB = randomUUID();
    await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'B','proposed','{"postalCodes":["94902"]}'::jsonb,'{}'::jsonb)`, [b.tenantId, sB, cB.id]);
    expect((await call(agentB, 'POST', `/saved-searches/${sB}/approve`, { checked: [] })).status).toBe(200);
    const act = await call<{ search: { matches: unknown[] } }>(agentB, 'POST', `/saved-searches/${sB}/activate`);
    expect(act.body.search.matches).toEqual([]);
    const seen = await withTenantTx(agentB.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM listings WHERE source = 'mls'`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(seen).toBe(0);
  });
});
