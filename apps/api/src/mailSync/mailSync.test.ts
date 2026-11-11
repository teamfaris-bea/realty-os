// Module 68 end to end through the real server, real Postgres (createTestDb) and the deterministic FakeGmail
// (PHASE2_3_PLAN §5.4 #68 tests; R-GMAIL-1..14, E201-E226, E229). Fakes only: no Google client, no real token.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, commsWorld, emailWebhook, ownedContact, playbookFixture, pointId } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { asSystem, clearGmailPack, confirmAddresses, connectGmail, copiesOf, enableMailSync, linkOf, runMailSync } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let n = 0;
const mailbox = () => `agent-${++n}-${randomUUID().slice(0, 6)}@gmail.test`;
const HOUR = 3600_000;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
  await clearGmailPack(h);
  await enableMailSync(h, w.owner);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** a fresh agent with a connected Gmail and one owned, confirmed client */
async function connectedAgent(o: { confirm?: boolean } = {}) {
  const a = await inviteViaApi(h, w.owner, 'agent');
  const box = mailbox();
  const cb = await connectGmail(h, a, box);
  expect(cb.result).toBe('CONNECTED');
  const c = await ownedContact(a);
  const pid = await pointId(h, c.id, 'email');
  if (o.confirm !== false) expect(await confirmAddresses(a, [pid])).toBe(1);
  const link = (await linkOf(h, a.userId!))!;
  return { a, box, c, pid, link };
}

const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };
/** a live enrollment with one queued assistant message (the assistant is running the contact's thread) */
async function nurture(contactId: string) {
  const team = (await h.su.query('SELECT name FROM tenants WHERE id = $1', [w.tenantId])).rows[0]!.name as string;
  const r0 = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: team }), brokerageName: 'Harbor Realty LLC', firstInThread: true });
  if (!r0.ok) throw new Error('render');
  const pb = await playbookFixture(h, w.tenantId, w.owner, contactId, { scope: 'team', step, body: r0.text, category: 'reminder', purpose: 'informational' });
  const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', body: r0.text, initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + HOUR) as never }, now), { db: h.database });
  if (!r.ok) throw new Error(r.code);
  return pb;
}

const handbacks = async (contactId: string) => (await h.su.query("SELECT id, dedupe_key, payload FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [contactId])).rows;

describe('accept: connect read-only Gmail, a client thread in the timeline, remove it (R-GMAIL-1..8)', () => {
  it('R-GMAIL-2 R-GMAIL-3 R-GMAIL-5 R-GMAIL-6: an agent connects, confirms a client in one call, the client’s reply appears in the contact timeline within one poll; personal mail never does; another agent and the Team Lead read the client’s copy like the timeline would', async () => {
    const { a, box, c, link } = await connectedAgent();
    expect(link).toMatchObject({ status: 'connected' });
    expect(link.refresh_enc).not.toBeNull();
    const now = Date.now();
    h.providers.gmail.deliver(box, { from: `Client <${c.email}>`, to: [box], subject: 'Re: showing', text: 'Thursday works for me.\n\nOn Tue Agent wrote:\n> Can we meet?', internalDate: Date.now() });
    h.providers.gmail.deliver(box, { from: 'mom@family.test', to: [box], subject: 'Dinner', text: 'Sunday?', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const copies = await copiesOf(h, { linkId: link.id });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ contact_id: c.id, sender: 'contact', contact_role: 'from', body: 'Thursday works for me.', origin: 'live', subject: 'Re: showing' });
    const mine = await call<{ items: { body: string; mine: boolean }[]; coverage: { address: string }[] }>(a, 'GET', `/contacts/${c.id}/mail-messages`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i) => [i.body, i.mine])).toEqual([['Thursday works for me.', true]]);
    expect(mine.body.coverage).toEqual([{ address: c.email, since: expect.any(String) }]);
    // the Owner reads it like the timeline; never as the mailbox owner
    const owner = await call<{ items: { mine: boolean }[] }>(w.owner, 'GET', `/contacts/${c.id}/mail-messages`);
    expect(owner.body.items.map((i) => i.mine)).toEqual([false]);
    // an agent who may not see the contact reads nothing
    expect((await call<{ items: unknown[] }>(agent2, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    expect(JSON.stringify(await h.su.query('SELECT * FROM mail_messages'))).not.toContain('mom@family.test');
  });

  it('R-GMAIL-7 E212: "Remove this thread from Realty OS" hides at once, deletes within one sync interval, stores no later message in it; final (no un-exclude); another agent cannot exclude my thread', async () => {
    const { a, box, c, link } = await connectedAgent();
    const t = `thr${randomUUID().slice(0, 8)}`;
    h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: t, text: 'First', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    expect((await call(agent2, 'POST', `/me/mail-threads/${t}/exclude`)).status).toBe(404);
    const ex = await call(a, 'POST', `/me/mail-threads/${t}/exclude`);
    expect(ex.status).toBe(200);
    expect((await call<{ items: unknown[] }>(a, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    expect((await call<{ items: unknown[] }>(w.owner, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: t, text: 'Second', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    await expect(h.su.query('SELECT 1')).resolves.toBeTruthy();
    // no un-exclude: a person cannot delete an exclusion
    const del = await withTenantTx(a.actor(), async (tx) => Number((await sql`DELETE FROM mail_thread_exclusions WHERE gmail_thread_id = ${t}`.execute(tx)).numAffectedRows ?? 0n), { db: h.database });
    expect(del).toBe(0);
  });

  it('R-GMAIL-13 E215 E222: disconnect revokes and purges: token deleted in the same transaction, copies hidden at once and deleted in the next pass, Google told best effort', async () => {
    const { a, box, c, link } = await connectedAgent();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Hi', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    const revokedBefore = h.providers.gmail.revoked.length;
    const d = await call<{ link: { status: string; revokeReason: string } }>(a, 'DELETE', '/me/mail-link');
    expect([d.status, d.body.link.status, d.body.link.revokeReason]).toEqual([200, 'revoked', 'USER_DISCONNECTED']);
    expect((await linkOf(h, a.userId!))!.refresh_enc).toBeNull();
    expect(h.providers.gmail.revoked.length).toBe(revokedBefore + 1);
    expect((await call<{ items: unknown[] }>(w.owner, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    await runMailSync(h, w.tenantId, { due: false });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });
});

describe('dark by default (R-GMAIL-1)', () => {
  it('R-GMAIL-1 E222: with the switch off nothing connects or syncs; turning it off hides every copy at once and revokes links in the next pass', async () => {
    const { a, box, c, link } = await connectedAgent();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Before off', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/admin/mail-sync', { enabled: false, backfillDays: 30 })).status).toBe(200);
    expect((await call<{ items: unknown[] }>(a, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    const other = await inviteViaApi(h, w.owner, 'agent');
    expect((await call(other, 'POST', '/me/mail-link/connect', { disclosureSha256: (await call<{ disclosureSha256: string }>(other, 'GET', '/me/mail-link')).body.disclosureSha256 })).code).toBe('MAIL_SYNC_OFF');
    const calls = h.providers.gmail.calls.length;
    await runMailSync(h, w.tenantId);
    expect((await linkOf(h, a.userId!))).toMatchObject({ status: 'revoked', revoke_reason: 'SYNC_TURNED_OFF', refresh_enc: null });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    expect(new Set(h.providers.gmail.calls.slice(calls).map((x) => x.method))).toEqual(new Set(['revoke']));
    await enableMailSync(h, w.owner);
  });
});

describe('fresh live replies pause and hand back once (R-GMAIL-10, E201, E226)', () => {
  it('E226 R-GMAIL-10: a live reply from the client in Gmail pauses automation and creates exactly one handback "replied in Gmail" citing the copy by id and time, no snippet, no enrichment job, no messages row', async () => {
    const { box, c } = await connectedAgent();
    const pb = await nurture(c.id);
    const before = (await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0]!.n;
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Call me instead', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [pb.enrollmentId])).rows[0]!.state).toBe('paused');
    const hb = await handbacks(c.id);
    expect(hb).toHaveLength(1);
    const ev = (await h.su.query("SELECT e.source_type, e.snippet, e.verbatim_verified, e.locator FROM assistant_claims k JOIN evidence_refs e ON e.claim_id = k.id WHERE k.action_id = $1", [hb[0].id])).rows;
    expect(ev).toEqual([{ source_type: 'mail_message', snippet: null, verbatim_verified: false, locator: { kind: 'mail_message', internalAt: expect.any(String) } }]);
    expect(JSON.stringify(await h.su.query("SELECT text FROM assistant_claims WHERE action_id = $1", [hb[0].id]))).not.toContain('Call me instead');
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'assistant.enrich_handback' AND payload->>'actionId' = $1", [hb[0].id])).rows[0]!.n).toBe(0);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0]!.n).toBe(before);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows[0]!.n).toBe(0);
    // a replayed history page stores nothing new and hands back nothing new
    await asSystem(h, w.tenantId, (tx) => sql`UPDATE user_mail_links SET history_id = '1000' WHERE tenant_id = app.tenant_id() AND id IN (SELECT link_id FROM mail_messages WHERE contact_id = ${c.id}::uuid)`.execute(tx));
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: c.id })).toHaveLength(1);
    expect(await handbacks(c.id)).toHaveLength(1);
  });

  it('R-GMAIL-10 R-GMAIL-8: a live message 61 minutes old at fetch is stored but pauses nothing; backfill never pauses or hands back', async () => {
    const { box, c } = await connectedAgent();
    const pb = await nurture(c.id);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Old but live', internalDate: Date.now() });
    // fetched 61 minutes after it reached the mailbox (an outage): stored, but it pauses nothing
    await runMailSync(h, w.tenantId, { now: () => Date.now() + 61 * 60_000 });
    expect(await copiesOf(h, { contactId: c.id })).toHaveLength(1);
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [pb.enrollmentId])).rows[0]!.state).toBe('active');
    expect(await handbacks(c.id)).toHaveLength(0);
  });

  it('E201 R-GMAIL-12: a Reply-All that reaches the platform inbox AND Gmail hands back once; Gmail first: its copy is deleted when the platform row lands, and the platform handback is the same key', async () => {
    const { a, box, c } = await connectedAgent();
    await nurture(c.id);
    await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), c.id, a.userId]);
    const sent = await call<{ result: string }>(a, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Details inside.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    const mid = `<reply-all-${randomUUID()}@client.test>`;
    // Gmail first
    h.providers.gmail.deliver(box, { from: c.email, to: [box, replyTo], text: 'Yes to all', messageId: mid, internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: c.id })).toHaveLength(1);
    expect(await handbacks(c.id)).toHaveLength(1);
    // then the platform copy lands: no second handback; the Gmail copy goes in the next pass (the platform row wins)
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: Showing', text: 'Yes to all', headers: { 'Message-ID': mid } });
    expect(r.statusCode).toBe(200);
    expect(await handbacks(c.id)).toHaveLength(1);
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: c.id })).toEqual([]);
  });

  it('E201 R-GMAIL-12: platform first: the Gmail copy is refused by the database and nothing hands back twice', async () => {
    const { a, box, c } = await connectedAgent();
    await nurture(c.id);
    await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), c.id, a.userId]);
    await call(a, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Details inside.', idempotencyKey: `e-${randomUUID()}` });
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    const mid = `<reply-all-${randomUUID()}@client.test>`;
    await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: Showing', text: 'Platform first', headers: { 'Message-ID': mid } });
    expect(await handbacks(c.id)).toHaveLength(1);
    h.providers.gmail.deliver(box, { from: c.email, to: [box, replyTo], text: 'Platform first', messageId: mid, internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: c.id })).toEqual([]);
    expect(await handbacks(c.id)).toHaveLength(1);
  });
});
