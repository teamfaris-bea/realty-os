// F1-ERASE-DNC-TOCTOU (batch 5 review; D1, R-DATA-4, migration 0041): erasing a person who asked not to be contacted,
// while another transaction adds a phone to that person.
//
// Before the fix the erasure was check-then-act: the route's carry and the database's PERSON_DO_NOT_CONTACT_UNCARRIED
// check both read a snapshot without the new phone, the DELETE then waited for the writer and cascade-deleted the phone
// with no revoke, and the number was texted afterwards (by an agent, and by the lead-email first response). Now the
// route locks the person in the global lock order (the address locks of every point of every record of the person,
// then the records FOR UPDATE) before it carries the do-not-contact, and app.purge_contact_internal locks the records
// before its own check: the writer is waited for, its phone is carried, and the number stays blocked.
//
// The writers are the real routes (the lead-email webhook, the Needs review accept, POST /contacts/:id/points); the
// overlap is only widened from outside, by a superuser session holding a table lock that makes the writer's own next
// statement wait after it inserted the phone. Real Postgres as app_user, fake providers, own createTestDb database.
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { approvedPlaybook, runJobs } from '../assistant/testing.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomEmail, randomPhone, sendText } from '../comms/testing.js';
import { contactsWith, enableInbox, labelledBody, messageRows, outcomeOf, postLeadEmail } from '../leadEmail/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let owner: TestClient;
let agent: TestClient;
let inbox: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  owner = w.owner;
  agent = w.agents[0]!;
  inbox = (await enableInbox(h, owner, w.sourceId)).address!;
  // the 60-second first response (R-AST-16) of a verified lead email
  await approvedPlaybook(owner, { templateKey: 'new_lead_response' });
}, 300_000);
afterAll(async () => {
  await h?.close();
});

const FIRST_RESPONSE = ['assistant.first_response', 'comms.dispatch'];
const zillow = { from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'pass' }] };
const unaligned = { from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'bulk-mailer.test', result: 'pass' }] };
const ALL_PHONE = ['sms:informational', 'sms:marketing', 'voice:informational', 'voice:marketing'];
const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone).length;
const exists = async (id: string) => (await h.su.query('SELECT 1 FROM contacts WHERE id = $1', [id])).rowCount === 1;
/** The tenant HMAC of an address (hex): consent stays keyed by it after every point carrying it is gone. */
const hmacOf = (address: string) =>
  withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => Buffer.from(await h.app.platform.envelope.inTx(tx, w.tenantId as TenantId).hmacAddress(w.tenantId as TenantId, address)).toString('hex'), { db: h.database });
const revoked = async (hex: string) =>
  (await h.su.query<{ k: string }>("SELECT channel || ':' || purpose AS k FROM consent_state WHERE tenant_id = $1 AND status = 'revoked' AND address_hmac = decode($2, 'hex') ORDER BY 1", [w.tenantId, hex])).rows.map((r) => r.k);

/** A person who asked not to be contacted: POST /contacts/:id/do-not-contact revoked every point they had then. */
async function askedPerson() {
  const p = await ownedContact(agent, { consent: false });
  expect((await call(agent, 'POST', `/contacts/${p.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
  expect(await revoked(await hmacOf(p.phone))).toEqual(ALL_PHONE);
  return p;
}

/** A superuser session holding `LOCK TABLE <table> IN SHARE MODE`: the writer's next INSERT or UPDATE there waits. */
async function tableLock(table: 'lead_email_messages' | 'audit_log') {
  const c = new pg.Client({ connectionString: h.testDb.ownerUrl, application_name: 'erasure-race-locker' });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`LOCK TABLE ${table} IN SHARE MODE`);
  return {
    async release() {
      await c.query('COMMIT');
      await c.end();
    },
  };
}

interface Backend {
  pid: number;
  q: string;
}
const backends = async () =>
  (await h.su.query<Backend & { wait_event_type: string | null; blockers: number[] }>(
    `SELECT pid, wait_event_type, query AS q, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND state <> 'idle'`,
  )).rows;
async function waitFor(label: string, pred: (b: Backend & { wait_event_type: string | null; blockers: number[] }) => boolean): Promise<Backend> {
  for (let i = 0; i < 200; i++) {
    const hit = (await backends()).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await backends())}`);
}
/** The writer, waiting on the outside table lock after it wrote the phone. */
const writerWaiting = (verb: RegExp) => waitFor('the writer at the table lock', (b) => b.wait_event_type === 'Lock' && verb.test(b.q));
/** The erasure, waiting on the writer (an address lock, or the person's row). */
const eraserWaitingOn = (writer: Backend) => waitFor('the erasure waiting on the writer', (b) => b.wait_event_type === 'Lock' && b.blockers.includes(writer.pid));

/** After the person is gone: their later phone X is still never texted, by a person or by the lead-email first response. */
async function expectXStillBlocked(x: string): Promise<void> {
  const later = randomEmail();
  const before = smsTo(x);
  expect(outcomeOf(await postLeadEmail(h, { to: inbox, ...zillow, text: labelledBody({ name: 'Jay Later', email: later, phone: x }) }))).toBe('lead_created');
  const [fresh] = await contactsWith(h, w.tenantId, later);
  expect(fresh).toBeDefined();
  await runJobs(h, w.tenantId, FIRST_RESPONSE);
  expect(smsTo(x) - before, 'the autonomous first response never texts X').toBe(0);
  const again = await ownedContact(agent, { consent: false, phone: x, confirmDistinct: true });
  const s = await sendText(agent, again.id, 'Hi, following up on your inquiry');
  expect([s.body.result, s.body.decision?.reasons]).toEqual(['blocked', ['CONSENT_REVOKED']]);
  expect(smsTo(x) - before).toBe(0);
}

describe('F1-ERASE-DNC-TOCTOU: an erasure that overlaps a write adding a phone to the person carries the do-not-contact onto that phone (D1, R-DATA-4)', () => {
  it('positive control: a verified lead email with a fresh number gets the autonomous first response (so a 0 below is the opt-out, not a dead pipeline)', async () => {
    const x = randomPhone();
    const before = smsTo(x);
    expect(outcomeOf(await postLeadEmail(h, { to: inbox, ...zillow, text: labelledBody({ name: 'Pat Fresh', email: randomEmail(), phone: x }) }))).toBe('lead_created');
    await runJobs(h, w.tenantId, FIRST_RESPONSE);
    expect(smsTo(x) - before).toBe(1);
  }, 120_000);

  it('D1 R-DATA-4 R-LEM-4: a verified lead email attaches phone X to the person and has not committed when the Owner erases them; the erasure waits for it, carries the revoke onto X, and X is never texted afterwards (before: X had no revoke and got the first response)', async () => {
    const p = await askedPerson();
    const x = randomPhone();
    const locker = await tableLock('lead_email_messages');
    const posting = postLeadEmail(h, { to: inbox, ...zillow, text: labelledBody({ name: 'Jane Doe', email: p.email, phone: x }) });
    const writer = await writerWaiting(/insert into lead_email_messages/i);
    await freshReauth(h, owner);
    const erasing = call(owner, 'POST', `/contacts/${p.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    await eraserWaitingOn(writer);
    await locker.release();
    const le = await posting;
    const er = await erasing;
    expect(outcomeOf(le)).toBe('lead_created');
    expect([er.status, er.body]).toEqual([200, { erased: true }]);
    expect(await exists(p.id)).toBe(false);
    expect((await messageRows(h, w.tenantId)).at(-1)).toMatchObject({ status: 'lead_created', contact_id: null });
    // X was the person's for a moment: its revoke outlives them (HMAC-keyed, as the number they already had)
    expect(await revoked(await hmacOf(x))).toEqual(ALL_PHONE);
    await expectXStillBlocked(x);
  }, 180_000);

  it('D1 R-DATA-4 R-LEM-6: a reviewer accepts a held email that attaches phone X to the person while the Owner erases them: the same (X carried, never texted)', async () => {
    const p = await askedPerson();
    const x = randomPhone();
    expect(outcomeOf(await postLeadEmail(h, { to: inbox, ...unaligned, text: labelledBody({ name: 'Jane Doe', email: p.email, phone: x }) }))).toBe('needs_review');
    const heldRow = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(heldRow.status).toBe('needs_review');
    const locker = await tableLock('lead_email_messages');
    await freshReauth(h, owner);
    const accepting = call<{ contactId: string }>(owner, 'POST', `/lead-email/reviews/${heldRow.id}/accept`, {});
    const writer = await writerWaiting(/update lead_email_messages/i);
    const erasing = call(owner, 'POST', `/contacts/${p.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    await eraserWaitingOn(writer);
    await locker.release();
    const ac = await accepting;
    const er = await erasing;
    expect([ac.status, ac.body.contactId]).toEqual([200, p.id]);
    expect([er.status, er.body]).toEqual([200, { erased: true }]);
    expect(await exists(p.id)).toBe(false);
    expect(await revoked(await hmacOf(x))).toEqual(ALL_PHONE);
    await expectXStillBlocked(x);
  }, 180_000);

  it('D1 R-DATA-4 R-PAR-11: a phone added through POST /contacts/:id/points (an address the person shares with nothing) while the Owner erases them: the erasure waits on the person\'s row lock, carries the revoke, and the number stays blocked', async () => {
    const p = await askedPerson();
    const x = randomPhone();
    const locker = await tableLock('audit_log');
    const adding = call(agent, 'POST', `/contacts/${p.id}/points`, { kind: 'phone', address: x });
    const writer = await writerWaiting(/insert into audit_log/i);
    await freshReauth(h, owner);
    const erasing = call(owner, 'POST', `/contacts/${p.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    await eraserWaitingOn(writer);
    await locker.release();
    expect((await adding).status).toBe(201);
    const er = await erasing;
    expect([er.status, er.body]).toEqual([200, { erased: true }]);
    expect(await exists(p.id)).toBe(false);
    expect(await revoked(await hmacOf(x))).toEqual(ALL_PHONE);
    await expectXStillBlocked(x);
  }, 180_000);
});
