// Module 22 beyond the chat window (real Postgres, real server, fakes only): the Message-ID hash on platform email
// (R-GMAIL-12, E201), partner lead feeds (R-INBOX-9, E79), the person-level do-not-contact (R-CHAN-2/3, F19), the
// widget settings (R-PERM-5) and the single caller of deliverChannelMessage (R-GATE-15).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UserActor } from '@realty/core/foundation';
import { enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call, ownedContact, randomPhone, runJobs } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { emailWebhook, playbookFixture } from '../comms/testing.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { enableInbox, labelledBody } from '../leadEmail/testing.js';
import { command, intake } from '../leads/testing.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { makeChannelHandlers } from './handlers.js';
import { normalizeMessageId, rfcMessageIdSha256 } from './rfcMessageId.js';
import { acceptLead, chatSource, codeOf, createWidget, openChat, scheduledTriggerRun } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const userActor = (c: { userId?: string | null; tenantId?: string | null; role?: unknown }): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role, sessionId: 'test' }) as unknown as UserActor;
const appointmentContext = (contactId: string, userId: string) =>
  h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), contactId, userId]);

describe('R-GMAIL-12 messages.rfc_message_id_sha256 on platform email, written as the system', () => {
  it('R-GMAIL-12: the normalization is stable (brackets, folding, case preserved) and refuses junk', () => {
    expect(normalizeMessageId('  <abc.123@mail.example>  ')).toBe('<abc.123@mail.example>');
    expect(normalizeMessageId('(comment) <a@b>\r\n ')).toBe('<a@b>');
    expect(normalizeMessageId('a@b')).toBe('<a@b>');
    expect(normalizeMessageId('<A@b>')).not.toBe(normalizeMessageId('<a@b>'));
    for (const bad of [null, '', 'no-at-sign', '<>', '<a b@c>', 'x'.repeat(3000)]) expect(normalizeMessageId(bad)).toBeNull();
    expect(rfcMessageIdSha256('<a@b>')!.equals(createHash('sha256').update('<a@b>').digest())).toBe(true);
  });

  it('R-GMAIL-12: outbound email stores the hash of the Message-ID the provider confirmed, at TX2 (as the system); a write from a person\'s transaction (TX1) is refused, and the hash is final', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await appointmentContext(c.id, agent.userId!);
    const r = await call<{ result: string; message: { id: string } }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Details inside.', idempotencyKey: `e-${randomUUID()}` });
    expect(r.body.result).toBe('sent');
    const sent = h.providers.email.sent.find((m) => m.idempotencyKey === r.body.message.id)!;
    const row = (await h.su.query<{ rfc_message_id_sha256: Buffer }>('SELECT rfc_message_id_sha256 FROM messages WHERE id = $1', [r.body.message.id])).rows[0]!;
    const confirmed = (await h.providers.email.lookupMessage(r.body.message.id)) as { rfcMessageId?: string } | null;
    expect(sent).toBeDefined();
    expect(row.rfc_message_id_sha256.equals(rfcMessageIdSha256(confirmed!.rfcMessageId!)!)).toBe(true);
    // TX1 runs as the person: the DB refuses the hash from them (messages_rfc_guard)
    const other = await call<{ message: { id: string } }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Later', body: 'Scheduled', scheduleAt: new Date(Date.now() + 3600_000).toISOString(), idempotencyKey: `e-${randomUUID()}` });
    const refused = await withTenantTx(userActor(agent), (tx) => sql`UPDATE messages SET rfc_message_id_sha256 = ${createHash('sha256').update('x').digest()} WHERE id = ${other.body.message.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(refused).toMatch(/RFC_MESSAGE_ID_SYSTEM_ONLY/);
    const changed = await withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => sql`UPDATE messages SET rfc_message_id_sha256 = ${createHash('sha256').update('y').digest()} WHERE id = ${r.body.message.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(changed).toMatch(/RFC_MESSAGE_ID_FINAL/);
  });

  it('R-GMAIL-12 E201: inbound platform email stores the hash as the system, and a second delivery of the same Message-ID (a Reply-All reaching both paths) hands back once: email:{contact}:{hash}', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await appointmentContext(c.id, agent.userId!);
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: { stepKey: 's1' }, body: 'Checking in', category: 'reminder', purpose: 'informational' });
    await call(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hello', body: 'Hi there', idempotencyKey: `e-${randomUUID()}` });
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    await scheduledTriggerRun(h, w.tenantId, c.id, pb.versionId);
    const mid = `<${randomUUID()}@client.example>`;
    for (const eventId of [randomUUID(), randomUUID()]) {
      const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId, from: c.email, to: replyTo, subject: 'Re: Hello', text: 'Sounds good', headers: { 'Message-ID': mid } });
      expect(r.statusCode).toBe(200);
      // keep the assistant "active" for the second delivery too (a scheduled trigger firing it cancels): only the
      // shared key may stop a second handback
      await scheduledTriggerRun(h, w.tenantId, c.id, pb.versionId);
    }
    const hash = rfcMessageIdSha256(mid)!;
    const rows = (await h.su.query<{ rfc_message_id_sha256: Buffer | null }>("SELECT rfc_message_id_sha256 FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((x) => x.rfc_message_id_sha256?.equals(hash))).toBe(true);
    const hb = (await h.su.query("SELECT dedupe_key FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows;
    expect(hb).toEqual([{ dedupe_key: `email:${c.id}:${hash.toString('hex')}` }]);
  });
});

async function feedConnection(kind: 'zillow_feed' | 'realtor_feed', sourceId: string): Promise<string> {
  const id = randomUUID();
  const credId = randomUUID();
  await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
    const enc = await h.app.platform.envelope.inTx(tx, w.tenantId as never).encrypt(w.tenantId as never, { table: 'provider_credentials', column: 'secret_enc', rowId: credId }, Buffer.from(JSON.stringify({ accessToken: 'fake-partner-token' })));
    await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (app.tenant_id(), ${credId}::uuid, ${kind === 'zillow_feed' ? 'zillow' : 'realtor'}, ${Buffer.from(enc)}, 1)`.execute(tx);
    await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${id}::uuid, ${kind}, 'Feed', ${sourceId}::uuid)`.execute(tx);
    await sql`UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = ${`acct-${id.slice(0, 8)}`}, credential_id = ${credId}::uuid WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  }, { db: h.database });
  return id;
}

async function runFeedPoll(): Promise<void> {
  await withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => enqueueJob(tx, { queue: 'default', kind: 'leads.feed_poll', payload: {}, dedupeKey: `feed-test:${randomUUID()}` }), { db: h.database });
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeChannelHandlers(() => ({ envelope: deps.envelope, ids: deps.ids })), ...makeCommsHandlers(() => deps)]);
  await createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `feed-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger }).drain(10);
}

describe('R-INBOX-9 E79 partner lead feeds (leads.feed_poll, fakes only)', () => {
  it('E79 R-INBOX-9: a Zillow feed lead and the same lead by DKIM-aligned lead email create ONE contact; the cursor advances; a re-poll creates nothing', async () => {
    const connId = await feedConnection('zillow_feed', w.sourceId);
    const phone = randomPhone();
    const email = `feed-${randomUUID().slice(0, 8)}@example.test`;
    h.providers.integrations.leadFeeds.zillow.leads.push({ externalLeadId: `z-${randomUUID()}`, receivedAt: new Date().toISOString(), name: 'Fiona Feed', phone, email, message: 'Interested in 12 Harbor Way', listingRef: 'FAKE-MLS-1001' });
    await runFeedPoll();
    const viaFeed = (await h.su.query<{ contact_id: string }>("SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND address = $2", [w.tenantId, email])).rows;
    expect(viaFeed).toHaveLength(1);
    const conn = (await h.su.query('SELECT sync_cursor, last_error_code, next_sync_at IS NOT NULL AS scheduled FROM integration_connections WHERE id = $1', [connId])).rows[0];
    expect(conn).toMatchObject({ last_error_code: null, scheduled: true });
    expect(conn.sync_cursor).not.toBeNull();
    // the same person by lead email
    const inbox = await enableInbox(h, w.owner, w.sourceId);
    const { postLeadEmail } = await import('../leadEmail/testing.js');
    const r = await postLeadEmail(h, { to: inbox.address!, from: 'Zillow Leads <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'pass' }], text: labelledBody({ name: 'Fiona Feed', email, phone, message: 'Interested in 12 Harbor Way' }) });
    expect(r.statusCode).toBe(200);
    const all = (await h.su.query<{ contact_id: string }>("SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND (address = $2 OR address = $3)", [w.tenantId, email, phone])).rows;
    expect(all.map((x) => x.contact_id)).toEqual([viaFeed[0]!.contact_id]);
    await h.su.query('UPDATE integration_connections SET next_sync_at = now() - interval \'1 second\' WHERE id = $1', [connId]);
    await runFeedPoll();
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries WHERE contact_id = $1', [viaFeed[0]!.contact_id])).rows[0].n).toBe(2);
  });

  it('R-INBOX-9: with no partner access (the production adapter) a feed connection stays honestly needs_partner_access and nothing is polled', async () => {
    const id = randomUUID();
    await h.su.query("INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES ($1,$2,'realtor_feed','realtor.com',$3)", [w.tenantId, id, w.sourceId]);
    const real = h.providers.integrations.leadFeeds.realtor;
    const { PartnerLeadFeed } = await import('../providers/integrations/real.js');
    (h.providers.integrations.leadFeeds as { realtor: unknown }).realtor = new PartnerLeadFeed('realtor');
    try {
      await runFeedPoll();
    } finally {
      (h.providers.integrations.leadFeeds as { realtor: unknown }).realtor = real;
    }
    expect((await h.su.query('SELECT status, status_reason FROM integration_connections WHERE id = $1', [id])).rows[0]).toEqual({ status: 'needs_partner_access', status_reason: 'PARTNER_ACCESS_REQUIRED' });
  });
});

describe('R-CHAN-2 the person-level do-not-contact', () => {
  it('R-CHAN-2 R-CHAN-3: a person-level do-not-contact set by an agent blocks every channel: texts, email and web chat, for every initiator; the guard refuses a forced send', async () => {
    const src = await chatSource(h, w.owner, w.tenantId, 'Chat DNC');
    const wid = await createWidget(h, w.owner, src.sourceId);
    const chat = await openChat(h, wid.key, src.disclosureId, { name: 'Dee Nocontact' });
    const agent = await acceptLead(h, w.agents, chat.contactId);
    const phone = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${chat.contactId}/points`, { kind: 'phone', address: phone, label: 'mobile' })).status).toBe(201);
    expect((await call(agent, 'POST', `/contacts/${chat.contactId}/points`, { kind: 'email', address: `dee-${randomUUID().slice(0, 6)}@example.test` })).status).toBe(201);
    const dnc = await call<{ doNotContact: boolean; revokedPoints: number }>(agent, 'POST', `/contacts/${chat.contactId}/do-not-contact`, { reason: 'asked_on_call' });
    expect([dnc.status, dnc.body.revokedPoints]).toEqual([200, 3]);
    const chans = (await h.su.query("SELECT DISTINCT channel FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke' ORDER BY channel", [chat.contactId])).rows.map((x) => x.channel);
    expect(chans).toEqual(['email', 'sms', 'voice', 'web_chat']);
    await appointmentContext(chat.contactId, agent.userId!);
    for (const channel of ['sms', 'email', 'web_chat'] as const) {
      const r = await call<{ result: string; decision: { reasons: string[] } }>(agent, 'POST', `/contacts/${chat.contactId}/messages`, { channel, body: 'Hi', ...(channel === 'email' ? { subject: 'Hi' } : {}), idempotencyKey: `x-${randomUUID()}` });
      expect([channel, r.body.result]).toEqual([channel, 'blocked']);
      expect(r.body.decision.reasons).toContain('PERSON_DO_NOT_CONTACT');
    }
  });

  it('F19 R-CHAN-3: closing a lead with reason do_not_contact records the person-level opt-out in the SAME transaction (every point revoked, do_not_contact_at set); other close reasons do not', async () => {
    const a = await intake(h, w, { fullName: 'Cleo Close', phones: [randomPhone()] });
    const agent = await acceptLead(h, w.agents, a.contactId);
    const r = await command(agent, a.contactId, 'close', { reason: 'do_not_contact' });
    expect(r.status).toBe(200);
    const c = (await h.su.query('SELECT closed_reason, do_not_contact_at, do_not_contact_event_id FROM contacts WHERE id = $1', [a.contactId])).rows[0];
    expect(c.closed_reason).toBe('do_not_contact');
    expect(c.do_not_contact_at).not.toBeNull();
    const ev = (await h.su.query("SELECT id, source FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [a.contactId])).rows;
    expect(ev.map((e) => e.source)).toEqual(['agent_revoke', 'agent_revoke']);
    expect(ev.map((e) => e.id)).toContain(c.do_not_contact_event_id);
    const b = await intake(h, w, { fullName: 'Sid Spam', phones: [randomPhone()] });
    const ag2 = await acceptLead(h, w.agents, b.contactId);
    expect((await command(ag2, b.contactId, 'close', { reason: 'spam' })).status).toBe(200);
    expect((await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [b.contactId])).rows[0].do_not_contact_at).toBeNull();
  });

  it('R-CHAN-2: app.record_person_opt_out refuses a citation that is not a revoke of that contact, and never clears', async () => {
    const x = await ownedContact(w.agents[0]!);
    const y = await ownedContact(w.agents[0]!);
    await call(w.agents[0]!, 'POST', `/contacts/${y.id}/do-not-contact`, { reason: 'asked_in_person' });
    const yEvent = (await h.su.query<{ do_not_contact_event_id: string }>('SELECT do_not_contact_event_id FROM contacts WHERE id = $1', [y.id])).rows[0]!.do_not_contact_event_id;
    const err = await withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => sql`SELECT app.record_person_opt_out(${x.id}::uuid, ${yEvent}::uuid)`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/PERSON_OPT_OUT_EVIDENCE/);
    const again = await withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => sql<{ s: boolean }>`SELECT app.record_person_opt_out(${y.id}::uuid, ${yEvent}::uuid) AS s`.execute(tx), { db: h.database });
    expect(again.rows[0]!.s).toBe(false);
  });
});

describe('R-PERM-5 widget settings', () => {
  it('R-PERM-5: only Owner/Admin see or change widgets; the key is shown once and rotating it retires the old embed at once', async () => {
    const src = await chatSource(h, w.owner, w.tenantId, 'Chat RBAC');
    const wid = await createWidget(h, w.owner, src.sourceId, ['https://a.example']);
    for (const c of w.agents) {
      expect((await call(c, 'GET', '/admin/web-chat/widgets')).status).toBe(404);
      expect((await call(c, 'POST', '/admin/web-chat/widgets', { displayName: 'x', leadSourceId: src.sourceId })).status).toBe(404);
    }
    const list = await call<{ widgets: { id: string }[] }>(w.owner, 'GET', '/admin/web-chat/widgets');
    expect(JSON.stringify(list.body)).not.toContain(wid.key);
    const rot = await call<{ widgetKey: string }>(w.owner, 'POST', `/admin/web-chat/widgets/${wid.id}/rotate`);
    expect(rot.status).toBe(200);
    expect(rot.body.widgetKey).not.toBe(wid.key);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/chat/${wid.key}`, headers: { origin: 'https://a.example' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/chat/${rot.body.widgetKey}`, headers: { origin: 'https://a.example' } })).statusCode).toBe(200);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action IN ('webchat.widget_created','webchat.widget_key_rotated')", [w.tenantId])).rows[0].n).toBeGreaterThanOrEqual(2);
    const bad = await call(w.owner, 'PUT', `/admin/web-chat/widgets/${wid.id}/origins`, { allowedOrigins: ['javascript:alert(1)'] });
    expect([bad.status, bad.code]).toEqual([422, 'VALIDATION_FAILED']);
    void codeOf;
  });

  it('R-PERM-5: the embed details (brokerage, disclosure) are Owner/Admin only and never carry the key; a source without a disclosure says so', async () => {
    const src = await chatSource(h, w.owner, w.tenantId, 'Chat embed');
    const wid = await createWidget(h, w.owner, src.sourceId, ['https://a.example']);
    for (const c of w.agents) expect((await call(c, 'GET', `/admin/web-chat/widgets/${wid.id}/embed`)).status).toBe(404);
    const e = await call<{ brokerage: string; disclosure: { id: string; text: string } | null }>(w.owner, 'GET', `/admin/web-chat/widgets/${wid.id}/embed`);
    expect(e.status).toBe(200);
    expect(e.body.disclosure?.id).toBe(src.disclosureId);
    expect(e.body.brokerage.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.body)).not.toContain(wid.key);
    expect(JSON.stringify(e.body)).not.toMatch(/wk_[0-9a-f]{40}/);
    const bare = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Chat no disclosure', kind: 'website' });
    const wid2 = await createWidget(h, w.owner, bare.body.source.id, []);
    const e2 = await call<{ disclosure: unknown }>(w.owner, 'GET', `/admin/web-chat/widgets/${wid2.id}/embed`);
    expect([e2.status, e2.body.disclosure]).toEqual([200, null]);
    expect((await call(w.owner, 'GET', `/admin/web-chat/widgets/${randomUUID()}/embed`)).status).toBe(404);
  });
});

describe('R-GATE-15 deliverChannelMessage has one caller', () => {
  it('R-GATE-15: apps/api/src/comms/dispatch.ts is the only module that calls deliverChannelMessage (the transport defines it; tests may read its log)', () => {
    const root = join(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);
    const callers = files.filter((f) => /\.deliverChannelMessage\s*\(|\[\s*['"]deliverChannelMessage['"]\s*\]|\{\s*deliverChannelMessage\s*\}/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(callers).toEqual(['comms/dispatch.ts']);
    const definers = files.filter((f) => /deliverChannelMessage\s*\(m:/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(definers).toEqual(['channels/transport.ts']);
  });
});

void runJobs;
