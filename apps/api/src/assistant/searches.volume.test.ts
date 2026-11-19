// R-LSRC-10 M7 at volume (review round 5; migration 0104): the saved-search alert sender asks the source check once per
// covered person, holds their searches, and does not ask again on every run.
//
// One team has 5,003 people nothing automatic may go to (imported, their source not reviewed), each with an active
// instant search and a matching home that was never alerted, three lead sources marked "No automated contact for leads
// from this source", and one reviewed person whose search sorts AFTER all of them. Their matches are never recorded as
// alerted (nothing was sent), so these searches are "pending" for as long as the Owner leaves the source in review.
//
// Before this change the sender left them out by calling app.person_source_refusal inside its due-batch query: every
// run (every ten minutes, and once per newly matched listing) asked the definer again for every one of them, seconds a
// run at this size and the 30 s statement timeout at a few tens of thousands, which stops alerts for the whole team.
// Now the first run asks once per person, in pages, with no lock on them, holds their searches for an hour
// (saved_searches.alerts_held_until) and still sends the reviewed person's alert; every later run skips the held
// searches on a plain column and asks nothing. The Owner's mapping clears the holds of that label's people, and a hold
// that ran out is asked again once. Two proofs: the stated times (first run under 20 s, later runs under 1 s; measured
// here: about 8 s, which is the one question per covered person at about 1.5 ms each, and under 50 ms) and the
// database's own counters (each definer call probes lead_inquiries once: the two later runs make fewer than 50 index
// scans of it, where the old sender made more than 10,000 and took the 8 s on every run).
//
// The asking is done BEFORE any person is locked: the seconds a first run spends on the source check must not be
// seconds during which an alerted person's lock is held (their inbound STOP, their pause and the agent's own text
// take that lock). The last case reads the order of the sender's own statements.
// Made-up labels and sources; fakes only.
import { randomUUID } from 'node:crypto';
import { type Database, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { freshReauth } from '../comms/testing.js';
import { importedPerson, suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { sendDueAlertsInTx } from './searches.js';
import { type AssistantWorld, assistantWorld, call, depsOf, listing, messagesOf, ownedContact } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let agent: TestClient;
let plain: string;
let listingId: string;
let reviewed: { contactId: string; searchId: string };
const small: { contactId: string; searchId: string }[] = [];
const BIG = 'Big unreviewed label (alerts volume test)';
const SMALL = 'Small unreviewed label (alerts volume test)';
const COVERED = 5000;
const ZIP = '94121';
const FIRST_RUN_BUDGET_MS = 20_000;
const LATER_RUN_BUDGET_MS = 1000;
const HOUR_MS = 3_600_000;

/** An active instant search of `contactId`, alerting by text, with the one matching home not yet alerted. */
async function searchWithMatch(contactId: string): Promise<string> {
  const searchId = randomUUID();
  await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Homes','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, searchId, contactId, JSON.stringify({ postalCodes: [ZIP] })]);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [], alertFrequency: 'instant', alertChannel: 'sms' })).status).toBe(200);
  await h.su.query(`UPDATE saved_searches SET status = 'active', activated_at = now() WHERE id = $1`, [searchId]);
  await h.su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now()) ON CONFLICT DO NOTHING', [w.tenantId, searchId, listingId]);
  return searchId;
}

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await assistantWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h, w.owner);
  const src = async (name: string) => (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name, kind: 'referral' })).body.source.id;
  plain = await src('Northgate Referrals (alerts volume test)');
  for (const n of ['one', 'two', 'three']) {
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', `/lead-sources/${await src(`Partner ${n} (alerts volume test)`)}/ai-care`, { noAiCare: true })).status).toBe(200);
  }
  listingId = await listing(h, w, agent.userId!, { postalCode: ZIP });

  // three people under a small unreviewed label, made through the API
  let smallBatch: string | undefined;
  for (let i = 0; i < 3; i++) {
    const c = await ownedContact(agent);
    smallBatch = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: SMALL, ...(smallBatch ? { batchId: smallBatch } : {}) })).batchId;
    small.push({ contactId: c.id, searchId: await searchWithMatch(c.id) });
  }
  // 5,000 people under a big unreviewed label, each with an active instant search and the pending match: copies of one
  // real person and one real search, written in bulk as the migration owner (fixtures only). Their ids sort first.
  const seed = small[0]!;
  const stage = (await h.su.query<{ id: string }>(`SELECT id FROM import_stages WHERE batch_id = $1 AND category = 'contacts'`, [smallBatch])).rows[0]!.id;
  const copy = async (table: string, id: string, expr: string) => {
    const cols = (await h.su.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [table],
    )).rows.map((r) => `"${r.column_name}"`);
    return { cols: cols.join(', '), sel: cols.map((c) => (c === '"id"' ? id : c === '"contact_id"' ? expr : `x.${c}`)).join(', ') };
  };
  const cid = "('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid";
  const sid = "('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid";
  const contacts = await copy('contacts', cid, '');
  const searches = await copy('saved_searches', sid, cid);
  await suFixture(h, [
    { text: `INSERT INTO contacts (${contacts.cols}) SELECT ${contacts.sel} FROM contacts x, generate_series(1, $2) g WHERE x.id = $1`, values: [seed.contactId, COVERED] },
    { text: `INSERT INTO saved_searches (${searches.cols}) SELECT ${searches.sel} FROM saved_searches x, generate_series(1, $2) g WHERE x.id = $1`, values: [seed.searchId, COVERED] },
    { text: `INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) SELECT $1, ${sid}, $2, now() FROM generate_series(1, $3) g`, values: [w.tenantId, listingId, COVERED] },
    {
      text: `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id)
             SELECT $1, gen_random_uuid(), $2, 'big#' || g, now(), jsonb_build_object('category', 'contacts', 'leadSourceLabel', $3::text), 'imported', 'contacts', ${cid}
               FROM generate_series(1, $4::int) g`,
      values: [w.tenantId, stage, BIG, COVERED],
    },
  ]);
  // the reviewed person: created last, so their id sorts after every covered person's
  const c = await ownedContact(agent);
  reviewed = { contactId: c.id, searchId: await searchWithMatch(c.id) };
  await h.su.query('ANALYZE contacts; ANALYZE saved_searches; ANALYZE saved_search_matches; ANALYZE import_records');
}, 600_000);
afterAll(async () => {
  await h?.close();
});

async function timedSweep(): Promise<{ sent: number; ms: number }> {
  const t0 = Date.now();
  const sent = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => sendDueAlertsInTx(tx, depsOf(h), w.tenantId, now, {}), { db: h.database });
  return { sent, ms: Date.now() - t0 };
}
/** Index scans of lead_inquiries so far (each call of the source definer makes one); waits for the counters to be reported. */
async function inquiryProbes(): Promise<number> {
  await new Promise((r) => setTimeout(r, 11_000));
  const r = await h.su.query<{ n: string }>("SELECT COALESCE(idx_scan, 0)::text AS n FROM pg_stat_user_tables WHERE relname = 'lead_inquiries'");
  return Number(r.rows[0]!.n);
}
const held = async () =>
  (await h.su.query<{ n: number; soonest: Date | null; latest: Date | null }>(
    'SELECT count(*)::int AS n, min(alerts_held_until) AS soonest, max(alerts_held_until) AS latest FROM saved_searches WHERE tenant_id = $1 AND alerts_held_until > now()', [w.tenantId],
  )).rows[0]!;
const recordedForCovered = async () =>
  (await h.su.query<{ alerted: number; stamped: number; messages: number }>(
    `SELECT (SELECT count(*)::int FROM saved_search_matches m WHERE m.tenant_id = $1 AND m.search_id <> $2 AND m.alerted_message_id IS NOT NULL) AS alerted,
            (SELECT count(*)::int FROM saved_searches s WHERE s.tenant_id = $1 AND s.id <> $2 AND s.last_alerted_at IS NOT NULL) AS stamped,
            (SELECT count(*)::int FROM messages x WHERE x.tenant_id = $1 AND x.contact_id <> $3 AND x.action_category = 'search_alert') AS messages`,
    [w.tenantId, reviewed.searchId, reviewed.contactId],
  )).rows[0]!;
const alertsOf = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');

describe('R-LSRC-10 M7: the alert sender at volume (5,003 covered pending searches, three marked sources)', () => {
  it('E747 E756: the first run sends the reviewed person\'s alert although 5,003 covered searches sort before it, holds every covered search for an hour and records nothing as alerted for them; the next runs ask nothing and answer inside the stated time', async () => {
    const first = await timedSweep();
    const afterFirst = await held();
    const probes0 = await inquiryProbes();
    const second = await timedSweep();
    const third = await timedSweep();
    const probes = (await inquiryProbes()) - probes0;
    console.info('R-LSRC-10 alerts at volume', { 'first run (ms)': first.ms, 'second run (ms)': second.ms, 'third run (ms)': third.ms, 'searches held after the first run': afterFirst.n, 'index scans of lead_inquiries by the second and third runs': probes });

    // the reviewed person is alerted in the very first run: covered people neither fill the batch nor starve it
    expect([first.sent, second.sent, third.sent]).toEqual([1, 0, 0]);
    expect(await alertsOf(reviewed.contactId)).toHaveLength(1);
    // every covered search is held, about an hour ahead; nothing was queued, marked or stamped for any of them
    expect(afterFirst.n).toBe(COVERED + 3);
    expect(afterFirst.soonest!.getTime()).toBeGreaterThan(Date.now() + HOUR_MS - 300_000);
    expect(afterFirst.latest!.getTime()).toBeLessThan(Date.now() + HOUR_MS + 60_000);
    expect(await recordedForCovered()).toEqual({ alerted: 0, stamped: 0, messages: 0 });
    // the stated times, and the counters: the later runs did not ask the definer about the held people
    expect(first.ms, 'first run').toBeLessThan(FIRST_RUN_BUDGET_MS);
    expect(second.ms, 'second run').toBeLessThan(LATER_RUN_BUDGET_MS);
    expect(third.ms, 'third run').toBeLessThan(LATER_RUN_BUDGET_MS);
    expect(probes).toBeLessThan(50);
  }, 300_000);

  it('E756: the Owner mapping a label clears the holds of that label\'s people and nobody else\'s, so the homes still waiting are alerted on the next run; a hold that ran out is asked again once and, still covered, held again', async () => {
    await freshReauth(h, w.owner);
    const t0 = Date.now();
    const mapped = await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: SMALL, leadSourceId: plain });
    const mapMs = Date.now() - t0;
    expect(mapped.status).toBe(200);
    expect(mapMs).toBeLessThan(LATER_RUN_BUDGET_MS);
    expect((await held()).n).toBe(COVERED);
    expect((await timedSweep()).sent).toBe(3);
    for (const s of small) expect(await alertsOf(s.contactId)).toHaveLength(1);

    // two holds of the big label run out (a clock fixture: the stored time is moved into the past)
    const lapsed = (await h.su.query<{ id: string }>(`UPDATE saved_searches SET alerts_held_until = now() - interval '1 second' WHERE id IN (SELECT id FROM saved_searches WHERE tenant_id = $1 AND alerts_held_until > now() ORDER BY id LIMIT 2) RETURNING id`, [w.tenantId])).rows.map((r) => r.id);
    expect(lapsed).toHaveLength(2);
    expect((await held()).n).toBe(COVERED - 2);
    const again = await timedSweep();
    expect(again.sent).toBe(0);
    expect(again.ms).toBeLessThan(LATER_RUN_BUDGET_MS);
    expect((await held()).n).toBe(COVERED);
    expect(await recordedForCovered()).toMatchObject({ alerted: 3, stamped: 3, messages: 3 }); // the small label's three, and nobody else

    // the Owner reviews the big label too: 5,000 holds cleared in one bounded statement
    await freshReauth(h, w.owner);
    const t1 = Date.now();
    expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: BIG, leadSourceId: plain })).status).toBe(200);
    expect(Date.now() - t1).toBeLessThan(5000);
    expect((await held()).n).toBe(0);
  }, 300_000);

  it('E756: every page of people is asked the source check before any person is locked, so an alerted person\'s lock is never held while thousands of others are asked', async () => {
    // the big label goes back in review: 5,000 covered pending searches again, none held
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: BIG, leadSourceId: null })).status).toBe(200);
    expect((await held()).n).toBe(0);
    // a reviewed person whose id sorts BEFORE all of them, with an active search and a home not yet alerted (a copy of
    // the reviewed person and their search, written as the migration owner: fixtures only)
    const early = { contactId: '00000000-0000-4000-7000-000000000001', searchId: '00000000-0000-4000-7000-000000000002' };
    const cols = async (table: string) =>
      (await h.su.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [table])).rows.map((r) => `"${r.column_name}"`);
    const contactCols = await cols('contacts');
    const searchCols = await cols('saved_searches');
    await suFixture(h, [
      { text: `INSERT INTO contacts (${contactCols.join(', ')}) SELECT ${contactCols.map((c) => (c === '"id"' ? '$2::uuid' : `x.${c}`)).join(', ')} FROM contacts x WHERE x.id = $1`, values: [reviewed.contactId, early.contactId] },
      {
        text: `INSERT INTO saved_searches (${searchCols.join(', ')}) SELECT ${searchCols.map((c) => (c === '"id"' ? '$2::uuid' : c === '"contact_id"' ? '$3::uuid' : `x.${c}`)).join(', ')} FROM saved_searches x WHERE x.id = $1`,
        values: [reviewed.searchId, early.searchId, early.contactId],
      },
      { text: 'INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now())', values: [w.tenantId, early.searchId, listingId] },
    ]);

    // the sender's own statements, in order: a page of people asked the source check, and a person's lock taken
    const order: ('ask' | 'lock')[] = [];
    const watched: Database = {
      ...h.database,
      kysely: h.database.kysely.withPlugin({
        transformQuery: ({ node }) => {
          const text = node.kind === 'RawNode' ? (node as unknown as { sqlFragments: readonly string[] }).sqlFragments.join(' ') : '';
          if (text.includes('app.person_source_refusal') && text.includes('unnest(')) order.push('ask');
          else if (text.includes('app.lock_contact')) order.push('lock');
          return node;
        },
        transformResult: async ({ result }) => result,
      }),
    };
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => sendDueAlertsInTx(tx, depsOf(h), w.tenantId, now, {}), { db: watched });

    expect(order.filter((x) => x === 'ask').length).toBeGreaterThanOrEqual(26); // 5,001 due searches, 200 a page
    expect(order.filter((x) => x === 'lock').length).toBeGreaterThanOrEqual(1); // the early person's
    expect(order.lastIndexOf('ask'), 'the last page is asked before the first lock is taken').toBeLessThan(order.indexOf('lock'));
    expect((await held()).n).toBe(COVERED);
  }, 300_000);
});
