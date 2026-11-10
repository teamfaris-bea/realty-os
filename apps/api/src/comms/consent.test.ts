// Consent capture, suppressions, email events and unsubscribe (R-CONSENT-4, -9, -18, -19; R-AUDIT-5; R-PERM-1).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { staleReauth } from '../admin/testing.js';
import { suFixture } from '../leads/testing.js';
import { EMAIL_REF_HEADER } from './render.js';
import { type CommsWorld, call, commsWorld, emailWebhook, freshReauth, ownedContact, pointId } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let tc: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, others: ['tc'] });
  tc = w.others[0]!;
  h.providers.email.verifiedDomains.add('mail.consent.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.consent.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  for (const a of w.agents) await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@mail.consent.test`, displayName: 'Agent', userId: a.userId, domainId: dom.body.domain.id });
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
});
afterAll(async () => {
  await h?.close();
});

const sendEmail = (c: TestClient, contactId: string) =>
  call<{ result: string; message: { id: string } | null; decision: { reasons: string[] } | null }>(c, 'POST', `/contacts/${contactId}/messages`, { channel: 'email', subject: 'New homes', body: 'Fresh listings for you.', idempotencyKey: `e-${randomUUID()}` });
const refOf = (messageId: string) => h.providers.email.sent.find((m) => m.idempotencyKey === messageId)!.headers![EMAIL_REF_HEADER]!;

describe('staff consent entry (R-CONSENT-4)', () => {
  it('R-CONSENT-4: an agent records consent at most express (agent_entry), or verbal_on_call citing the call; anything stronger is refused; the entry is audited with a redacted diff', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const pid = await pointId(h, c.id, 'phone');
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'record', pointId: pid, channel: 'sms', purpose: 'marketing', level: 'express_written', evidence: {} })).status).toBe(422);
    const ok = await call<{ state: { level: string; status: string }[] }>(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'record', pointId: pid, channel: 'sms', purpose: 'informational', level: 'express', evidence: { note: 'said yes at the open house' } });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toEqual([{ channel: 'sms', purpose: 'informational', status: 'granted', level: 'express' }]);
    const ev = (await h.su.query("SELECT source, consent_level, actor_kind, actor_user_id, address_hint FROM consent_events WHERE contact_id = $1", [c.id])).rows[0]!;
    expect(ev).toEqual({ source: 'agent_entry', consent_level: 'express', actor_kind: 'user', actor_user_id: agent.userId, address_hint: `•••-•••-${c.phone.slice(-4)}` });
    const audit = (await h.su.query<{ changes: Record<string, unknown> }>("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'consent.recorded' AND entity_id = $2", [w.tenantId, pid])).rows[0]!;
    expect(JSON.stringify(audit.changes)).not.toContain(c.phone);
    expect(audit.changes).toMatchObject({ kind: { from: null, to: 'record' }, channel: { from: null, to: 'sms' } });
  });

  it('R-PERM-1: consent entry follows the matrix: a TC cannot, an agent cannot when the tenant switch is off, another agent cannot see the contact (404)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const pid = await pointId(h, c.id, 'phone');
    const body = { kind: 'record', pointId: pid, channel: 'sms', purpose: 'informational', level: 'express', evidence: {} };
    expect((await call(tc, 'POST', `/contacts/${c.id}/consent`, body)).status).toBe(404);
    expect((await call(w.agents[1]!, 'POST', `/contacts/${c.id}/consent`, body)).status).toBe(404);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET agent_consent_entry_allowed = false WHERE tenant_id = $1', values: [w.tenantId] }]);
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, body)).status).toBe(404);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET agent_consent_entry_allowed = true WHERE tenant_id = $1', values: [w.tenantId] }]);
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, body)).status).toBe(200);
  });
});

describe('email events, suppressions and unsubscribe (R-CONSENT-9, -18, -19)', () => {
  it('R-CONSENT-19: email opens and clicks are behaviour signals, never facts', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendEmail(agent, c.id);
    expect(r.body.result).toBe('sent');
    const ref = refOf(r.body.message!.id);
    expect((await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref, type: 'delivered' })).statusCode).toBe(200);
    await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref, type: 'opened' });
    await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref, type: 'clicked' });
    const ev = (await h.su.query('SELECT event_type, reliability FROM behavior_events WHERE contact_id = $1 ORDER BY occurred_at, event_type', [c.id])).rows;
    expect(ev).toEqual(expect.arrayContaining([{ event_type: 'email_opened', reliability: 'signal' }, { event_type: 'email_clicked', reliability: 'signal' }]));
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [r.body.message!.id])).rows[0]!.status).toBe('delivered');
    // a forged reference (wrong MAC) is never routed to a tenant
    const forged = `${ref.slice(0, -4)}AAAA`;
    expect((await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref: forged, type: 'bounced' })).statusCode).toBe(200);
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [r.body.message!.id])).rows[0]!.status).toBe('delivered');
  });

  it('R-CONSENT-9: a hard bounce suppresses the address (the next email is denied SUPPRESSED); only an Owner/Admin, re-authenticated, can lift it, once, with a reason', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendEmail(agent, c.id);
    await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref: refOf(r.body.message!.id), type: 'bounced' });
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [r.body.message!.id])).rows[0]!.status).toBe('bounced');
    const s = (await h.su.query<{ id: string; reason: string }>("SELECT id, reason FROM suppressions WHERE tenant_id = $1 AND address_hint LIKE $2", [w.tenantId, `${c.email.slice(0, 1)}•••@%`])).rows.find((x) => x.reason === 'hard_bounce')!;
    expect(s).toBeDefined();
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('SUPPRESSED');
    expect((await call(agent, 'POST', `/suppressions/${s.id}/lift`, { reason: 'fixed address' })).status).toBe(404);
    await staleReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/suppressions/${s.id}/lift`, { reason: 'mailbox fixed' })).code).toBe('REAUTH_REQUIRED');
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/suppressions/${s.id}/lift`, { reason: 'mailbox fixed' })).status).toBe(200);
    expect((await call(w.owner, 'POST', `/suppressions/${s.id}/lift`, { reason: 'again' })).code).toBe('ALREADY_REVIEWED');
    expect((await h.su.query("SELECT lifted_by_user_id FROM suppressions WHERE id = $1", [s.id])).rows[0]!.lifted_by_user_id).toBe(w.owner.userId);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'suppression.lifted' AND entity_id = $2", [w.tenantId, s.id])).rows).toHaveLength(1);
    expect((await sendEmail(agent, c.id)).body.result).toBe('sent');
  });

  it('R-CONSENT-9: a spam complaint is a suppression that is never liftable', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendEmail(agent, c.id);
    await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref: refOf(r.body.message!.id), type: 'complained' });
    const s = (await h.su.query<{ id: string }>("SELECT id FROM suppressions WHERE tenant_id = $1 AND reason = 'spam_complaint' AND address_hint LIKE $2", [w.tenantId, `${c.email.slice(0, 1)}•••@%`])).rows[0]!;
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/suppressions/${s.id}/lift`, { reason: 'please' })).code).toBe('SUPPRESSION_NOT_LIFTABLE');
  });

  it('R-CONSENT-18: the one-click unsubscribe link (the person\'s own action) revokes marketing email; the next marketing email is denied', async () => {
    const agent = w.agents[1]!;
    const c = await ownedContact(agent);
    const r = await sendEmail(agent, c.id);
    expect(r.body.result).toBe('sent');
    const mail = h.providers.email.sent.find((m) => m.idempotencyKey === r.body.message!.id)!;
    const url = new URL(/^<(.+)>$/.exec(mail.headers!['List-Unsubscribe']!)![1]!);
    expect((await h.app.inject({ method: 'GET', url: url.pathname })).statusCode).toBe(200);
    const post = await h.app.inject({ method: 'POST', url: url.pathname, headers: { origin: 'http://localhost:5173' } });
    expect(post.statusCode).toBe(200);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('CONSENT_REVOKED');
    const bad = await h.app.inject({ method: 'POST', url: url.pathname.replace(/.{4}$/, (x) => (x === 'AAAA' ? 'BBBB' : 'AAAA')), headers: { origin: 'http://localhost:5173' } });
    expect(bad.statusCode).toBe(404);
  });
});
