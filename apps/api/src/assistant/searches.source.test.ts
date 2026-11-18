// R-LSRC-10 M7 (owner boundary B18S-5; R-LSRC-8, R-LSRC-9): a saved-search alert is automated contact. For a person
// nothing automatic may go to (a marked source's person, or an imported person whose source is not reviewed yet) the
// alert sender skips them BEFORE anything is marked: no message is queued, no match is recorded as alerted and the
// search's last alert time does not move. So nothing is recorded as alerted that was not sent, and when the Owner
// reviews the source the homes still on the market are alerted then. An alert already queued when the person became
// covered is refused at dispatch, and its homes are released the same way. Covered people never fill the batch.
// Made-up labels and sources; fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { freshReauth } from '../comms/testing.js';
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED } from '../leads/automatedContact.js';
import { importedPerson } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { sendDueAlertsInTx } from './searches.js';
import { type AssistantWorld, assistantWorld, call, depsOf, listing, messageRow, messagesOf, ownedContact, runJobs } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let agent: TestClient;
let plain: string;
let marked: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h, w.owner);
  plain = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (alerts test)', kind: 'referral' })).body.source.id;
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (alerts test)', kind: 'referral' })).body.source.id;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** An active instant search of `contactId`, alerting by text, with one matching home that has not been alerted. */
async function searchWithMatch(contactId: string, postalCode: string): Promise<{ searchId: string; listingId: string }> {
  const listingId = await listing(h, w, agent.userId!, { postalCode });
  const searchId = randomUUID();
  await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Homes','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, searchId, contactId, JSON.stringify({ postalCodes: [postalCode] })]);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [], alertFrequency: 'instant', alertChannel: 'sms' })).status).toBe(200);
  await h.su.query(`UPDATE saved_searches SET status = 'active', activated_at = now() WHERE id = $1`, [searchId]);
  await h.su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now()) ON CONFLICT DO NOTHING', [w.tenantId, searchId, listingId]);
  return { searchId, listingId };
}
const sweep = (o: { limit?: number; searchId?: string } = {}) => withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => sendDueAlertsInTx(tx, depsOf(h), w.tenantId, now, o), { db: h.database });
const alertsOf = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');
const recorded = async (searchId: string) => {
  const m = (await h.su.query<{ alerted: string | null }>('SELECT alerted_message_id AS alerted FROM saved_search_matches WHERE search_id = $1', [searchId])).rows.map((r) => r.alerted);
  const s = (await h.su.query<{ at: Date | null }>('SELECT last_alerted_at AS at FROM saved_searches WHERE id = $1', [searchId])).rows[0]!.at;
  return { alerted: m, lastAlertedAt: s };
};
const mapLabel = async (label: string, leadSourceId: string | null) => {
  await freshReauth(h, w.owner);
  const r = await call(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId });
  expect(r.status).toBe(200);
};

describe('R-LSRC-10 M7: saved-search alerts skip a covered person before anything is marked', () => {
  it('E747: an imported person whose source is not reviewed gets no alert, no queued message, no match marked alerted and no last-alert time; once the Owner reviews the source the same homes are alerted, and only then recorded', async () => {
    const c = await ownedContact(agent);
    const label = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: `Unreviewed (alerts test ${randomUUID().slice(0, 6)})` })).label!;
    const s = await searchWithMatch(c.id, '94110');

    expect(await sweep({ searchId: s.searchId })).toBe(0);
    expect(await alertsOf(c.id)).toEqual([]);
    expect(await recorded(s.searchId)).toEqual({ alerted: [null], lastAlertedAt: null });
    // the sweep can run any number of times: still nothing queued, nothing recorded
    expect(await sweep()).toBe(0);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect(await alertsOf(c.id)).toEqual([]);
    expect(await recorded(s.searchId)).toEqual({ alerted: [null], lastAlertedAt: null });

    // the Owner reviews the source: the alert goes now, with the home that was waiting
    await mapLabel(label, plain);
    expect(await sweep({ searchId: s.searchId })).toBe(1);
    const [alert] = await alertsOf(c.id);
    expect(alert).toBeDefined();
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, alert!.id)).status).toBe('sent');
    const after = await recorded(s.searchId);
    expect(after.alerted).toEqual([alert!.id]);
    expect(after.lastAlertedAt).toBeInstanceOf(Date);
  });

  it('E747: a marked source\'s person is skipped the same way, and is alerted once the Owner turns the setting off', async () => {
    const c = await ownedContact(agent);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [c.id, marked]);
    const s = await searchWithMatch(c.id, '94111');
    expect(await sweep({ searchId: s.searchId })).toBe(0);
    expect(await alertsOf(c.id)).toEqual([]);
    expect(await recorded(s.searchId)).toEqual({ alerted: [null], lastAlertedAt: null });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: false })).status).toBe(200);
    try {
      expect(await sweep({ searchId: s.searchId })).toBe(1);
      expect((await recorded(s.searchId)).alerted).toEqual([(await alertsOf(c.id))[0]!.id]);
    } finally {
      await freshReauth(h, w.owner);
      expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
    }
  });

  it('E747: an alert already queued when the person becomes covered is refused at dispatch with the reason that applies, and its homes are released: nothing stays recorded as alerted that was not sent; after the review they are alerted', async () => {
    const c = await ownedContact(agent);
    const label = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: `Queued first (alerts test ${randomUUID().slice(0, 6)})` })).label!;
    await mapLabel(label, plain);
    const s = await searchWithMatch(c.id, '94112');
    expect(await sweep({ searchId: s.searchId })).toBe(1);
    const [queued] = await alertsOf(c.id);
    expect(['queued', 'scheduled']).toContain(queued!.status);
    expect((await recorded(s.searchId)).alerted).toEqual([queued!.id]);
    // the Owner removes the mapping before the alert is dispatched: the person is in review again
    await mapLabel(label, null);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const blocked = await messageRow(h, queued!.id);
    expect([blocked.status, blocked.status_reason]).toEqual(['blocked', SOURCE_UNCLASSIFIED]);
    expect(await recorded(s.searchId)).toEqual({ alerted: [null], lastAlertedAt: null });
    // while in review nothing is queued again
    expect(await sweep()).toBe(0);
    expect(await alertsOf(c.id)).toHaveLength(1);
    // reviewed again: a new alert with the released home, sent
    await mapLabel(label, plain);
    expect(await sweep({ searchId: s.searchId })).toBe(1);
    const fresh = (await alertsOf(c.id)).find((m) => m.id !== queued!.id)!;
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h, fresh.id)).status).toBe('sent');
    expect((await recorded(s.searchId)).alerted).toEqual([fresh.id]);
    // the marked-source reason is released the same way
    const d = await ownedContact(agent);
    const s2 = await searchWithMatch(d.id, '94113');
    expect(await sweep({ searchId: s2.searchId })).toBe(1);
    const [q2] = await alertsOf(d.id);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [d.id, marked]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const b2 = await messageRow(h, q2!.id);
    expect([b2.status, b2.status_reason]).toEqual(['blocked', SOURCE_NO_AUTOMATED_CONTACT]);
    expect(await recorded(s2.searchId)).toEqual({ alerted: [null], lastAlertedAt: null });
  });

  it('E747: covered people never fill the batch: with room for one search, the reviewed person\'s alert still goes although an unreviewed person\'s search sorts first', async () => {
    const first = await ownedContact(agent); // created first: its id sorts first in the batch
    const second = await ownedContact(agent);
    await importedPerson(h, w.tenantId, w.owner.userId!, first.id, { label: `Never reviewed (alerts test ${randomUUID().slice(0, 6)})` });
    const waiting = await searchWithMatch(first.id, '94114');
    const due = await searchWithMatch(second.id, '94114');
    expect(await sweep({ limit: 1 })).toBe(1);
    expect((await recorded(due.searchId)).alerted.every((x) => x !== null)).toBe(true);
    expect(await recorded(waiting.searchId)).toMatchObject({ lastAlertedAt: null });
    expect((await recorded(waiting.searchId)).alerted.every((x) => x === null)).toBe(true);
    expect(await alertsOf(first.id)).toEqual([]);
  });
});
