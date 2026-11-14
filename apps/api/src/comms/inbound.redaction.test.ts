// b18 item a (PHASE2_3_PLAN Q-PORTAL-16; owner product direction 2026-11-14): a client's reply that quotes the portal
// sign-in link is stored with the token value removed and labelled as redacted, by text, by email (HTML included),
// as an MMS text part and in the rendered history; opt-outs still read what was sent; no log line or copy has it.
// Synthetic tokens and fictional numbers only.
import { randomBytes, randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestInquiry } from '../assistant/repos/context.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { chatSource, createWidget, openChat } from '../channels/testing.js';
import { postIntake } from '../leads/testing.js';
import { linkLine, portalLinkUrl } from '../portal/shared/copy.js';
import { SIGNIN_TOKEN_HIDDEN, SIGNIN_TOKEN_PLACEHOLDER } from '../portal/shared/redact.js';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { readTextParts } from './mmsTextJob.js';
import { type CommsWorld, call, commsWorld, emailWebhook, inboundSms, ownedContact, playbookFixture, telephonyWebhook } from './testing.js';

const BASIC = { username: 'vendor-hook', password: 'basic-password-0123456789' };
let h: ApiHarness;
let w: CommsWorld;
let origin: string;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'trace', config: { emailInbound: { formats: ['postmark'], basicAuth: BASIC } } });
  w = await commsWorld(h, { agents: 1 });
  origin = h.config.webOrigins[0]!;
});
afterAll(async () => {
  await h?.close();
});

const newToken = () => randomBytes(32).toString('base64url');
const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };

/** A live enrollment with one queued assistant message, so the reply pauses it and hands back (claims with snippets). */
async function nurture(contactId: string): Promise<void> {
  const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
  const r0 = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: s.t ?? s.b }), brokerageName: s.b, firstInThread: true });
  if (!r0.ok) throw new Error('render');
  const pb = await playbookFixture(h, w.tenantId, w.owner, contactId, { scope: 'team', step, body: r0.text, category: 'reminder', purpose: 'informational' });
  const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', body: r0.text, initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
  if (!r.ok) throw new Error(r.code);
}

/** Every stored copy of an inbound message's words we write: the message, its text parts, handback claims and their evidence, feed cards, notifications, audit. */
async function storedAnywhere(needle: string): Promise<string[]> {
  const q = async (label: string, text: string) => ((await h.su.query(text, [w.tenantId, `%${needle}%`])).rows.length > 0 ? [label] : []);
  return [
    ...(await q('messages', 'SELECT 1 FROM messages WHERE tenant_id = $1 AND (body LIKE $2 OR subject LIKE $2)')),
    ...(await q('message_text_parts', 'SELECT 1 FROM message_text_parts WHERE tenant_id = $1 AND body LIKE $2')),
    ...(await q('assistant_claims', 'SELECT 1 FROM assistant_claims WHERE tenant_id = $1 AND text LIKE $2')),
    ...(await q('evidence_refs', 'SELECT 1 FROM evidence_refs WHERE tenant_id = $1 AND snippet LIKE $2')),
    ...(await q('assistant_actions', 'SELECT 1 FROM assistant_actions WHERE tenant_id = $1 AND (explanation LIKE $2 OR payload::text LIKE $2)')),
    ...(await q('priority_feed_items', 'SELECT 1 FROM priority_feed_items WHERE tenant_id = $1 AND row_to_json(priority_feed_items)::text LIKE $2')),
    ...(await q('notifications', 'SELECT 1 FROM notifications WHERE tenant_id = $1 AND (title LIKE $2 OR body LIKE $2)')),
    ...(await q('audit_log', 'SELECT 1 FROM audit_log WHERE tenant_id = $1 AND row_to_json(audit_log)::text LIKE $2')),
  ];
}

/** An upcoming appointment: the agent's free-form email is informational (R-CONSENT-5), as in inbound.test.ts. */
async function appointmentContext(contactId: string, userId: string): Promise<void> {
  await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), contactId, userId]);
}

const inbound = async (contactId: string) =>
  (await h.su.query<{ id: string; channel: string; body: string; subject: string | null; content_redacted: string | null; opt_out_keyword: string | null }>("SELECT id, channel, body, subject, content_redacted, opt_out_keyword FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at", [contactId])).rows;

async function timeline(contactId: string) {
  const r = await call<{ items: { id: string; preview: string | null; redaction: string | null }[] }>(w.agents[0]!, 'GET', `/contacts/${contactId}/timeline?limit=100`);
  expect(r.status).toBe(200);
  return r.body.items;
}

/** b18 review F4: the thread's attachments view (MMS text parts), as the web thread reads it */
async function textPartsOf(contactId: string, messageId: string) {
  const r = await call<{ messages: { messageId: string; textParts: { position: number; status: string; text: string | null; redaction: string | null }[] }[] }>(w.agents[0]!, 'GET', `/contacts/${contactId}/attachments`);
  expect(r.status).toBe(200);
  return r.body.messages.find((m) => m.messageId === messageId)!.textParts;
}

describe('R-PORTAL-20 a quoted portal sign-in token is never stored (Q-PORTAL-16)', () => {
  it('R-PORTAL-20 E720: an SMS reaction quoting the sign-in text is stored without the token, labelled redacted; handback, feed and logs never carry it; the thread says so', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await nurture(c.id);
    const t = newToken();
    const quoted = `${linkLine({ brokerage: 'Acme Realty', name: 'Jane', channel: 'sms' })} ${portalLinkUrl(origin, t)}`;
    const r = await inboundSms(h, c.phone, w.mainNumber, `Liked “${quoted}”`);
    expect(r.statusCode).toBe(200);
    const [m] = await inbound(c.id);
    expect(m!.body).not.toContain(t);
    expect(m!.body).toContain(`/portal.html#token=${SIGNIN_TOKEN_PLACEHOLDER}`);
    expect(m!.body.startsWith('Liked “Acme Realty: sign-in link')).toBe(true);
    expect(m!.content_redacted).toBe('portal_signin_token');
    // the reply paused the assistant and handed back, with the client's words as evidence: redacted there too
    expect((await h.su.query("SELECT 1 FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows).toHaveLength(1);
    expect(await storedAnywhere(t)).toEqual([]);
    for (const line of h.logs) expect(line).not.toContain(t);
    const item = (await timeline(c.id)).find((i) => i.id === m!.id)!;
    expect(item.redaction).toBe('stored');
    expect(item.preview).not.toContain(t);
  });

  it('R-PORTAL-20 E720: an email reply quoting the sign-in email by text (generic signed format) is stored without the token, subject included, and labelled', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await appointmentContext(c.id, agent.userId!);
    const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Your sign-in link', body: 'Here is the link you asked for.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const replyTo = h.providers.email.sent.filter((x) => x.to === c.email).at(-1)!.replyTo!;
    const [t1, t2] = [newToken(), newToken()];
    const text = `Got it, thanks.\n\nOn Fri, Acme Realty wrote:\n> Sign in here (the link itself is not kept in the message history):\n> ${portalLinkUrl(origin, t1)}\n`;
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: `Re: link ${portalLinkUrl(origin, t2)}`, text });
    expect(r.statusCode).toBe(200);
    const [m] = await inbound(c.id);
    expect(m!.channel).toBe('email');
    expect(m!.body).not.toContain(t1);
    expect(m!.subject).not.toContain(t2);
    expect(m!.body).toContain('Got it, thanks.');
    expect(m!.content_redacted).toBe('portal_signin_token');
    expect(await storedAnywhere(t1)).toEqual([]);
    expect(await storedAnywhere(t2)).toEqual([]);
    for (const line of h.logs) expect(line).not.toContain(t1);
  });

  it('R-PORTAL-20 E720: a Postmark reply with only an HTML body (an anchor, an entity-encoded # and a wrapped, percent-encoded link) stores the text taken from it without any token', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await appointmentContext(c.id, agent.userId!);
    const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Your sign-in link', body: 'Here is the link you asked for.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const replyTo = h.providers.email.sent.filter((x) => x.to === c.email).at(-1)!.replyTo!;
    const [t1, t2, t3] = [newToken(), newToken(), newToken()];
    const html = `<div>Thank you!</div><blockquote><p>Sign in here:</p><a href="${portalLinkUrl(origin, t1)}">${portalLinkUrl(origin, t1)}</a>`
      + `<p>${origin}/portal.html&#35;token=${t2}</p><p><a href="https://wrapper.example/?url=x">https://wrapper.example/?url=${encodeURIComponent(portalLinkUrl(origin, t3))}</a></p></blockquote>`;
    const pm = { MessageID: randomUUID(), From: c.email, FromFull: { Email: c.email, Name: 'Jane' }, To: replyTo, ToFull: [{ Email: replyTo }], OriginalRecipient: replyTo, Subject: 'Re: Your sign-in link', TextBody: '', HtmlBody: html, Headers: [] };
    const r = await h.app.inject({ method: 'POST', url: '/api/webhooks/email/postmark/inbound', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${BASIC.username}:${BASIC.password}`).toString('base64')}` }, payload: JSON.stringify(pm) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, routed: true });
    const [m] = await inbound(c.id);
    expect(m!.body).toContain('Thank you!');
    for (const t of [t1, t2, t3]) {
      expect(m!.body).not.toContain(t);
      expect(await storedAnywhere(t)).toEqual([]);
      for (const line of h.logs) expect(line).not.toContain(t);
    }
    expect(m!.content_redacted).toBe('portal_signin_token');
  });

  it('R-PORTAL-20: opt-out language next to a quoted link still revokes (classification reads the message as sent) and is stored redacted', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const t = newToken();
    await inboundSms(h, c.phone, w.mainNumber, `Please stop texting me. I never asked for ${portalLinkUrl(origin, t)}`);
    const [m] = await inbound(c.id);
    expect(m!.opt_out_keyword).not.toBeNull();
    expect(m!.body).not.toContain(t);
    expect(m!.body.startsWith('Please stop texting me.')).toBe(true);
    expect(m!.content_redacted).toBe('portal_signin_token');
    expect((await h.su.query("SELECT 1 FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).rows.length).toBeGreaterThan(0);
  });

  it('R-PORTAL-20: an MMS text part quoting the link is stored without the token and labelled; the attachments view returns that label (b18 review F4)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const t = newToken();
    const mm = `MM${randomBytes(16).toString('hex')}`;
    const me = `ME${randomBytes(16).toString('hex')}`;
    h.providers.telephony.media.set(me, { bytes: new Uint8Array(Buffer.from(`See ${portalLinkUrl(origin, t)}`, 'utf8')), contentType: 'text/plain' });
    const form = { MessageSid: mm, From: c.phone, To: w.mainNumber, Body: '', NumMedia: '1', MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${mm}/Media/${me}`, MediaContentType0: 'text/plain' };
    expect((await telephonyWebhook(h, '/webhooks/telephony/sms', form)).statusCode).toBe(200);
    const messageId = (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0]!.id;
    const j = (await h.su.query<{ payload: { messageRef: string; parts: { position: number; ref: string | null }[] } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [messageId])).rows[0]!.payload;
    await readTextParts(systemActor(w.tenantId, 'provider'), { messageId, messageRef: j.messageRef, parts: j.parts }, w.deps);
    const part = (await h.su.query('SELECT status, body, content_redacted FROM message_text_parts WHERE message_id = $1', [messageId])).rows[0]!;
    expect(part.status).toBe('read');
    expect(part.body).not.toContain(t);
    expect(part.body).toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect(part.content_redacted).toBe('portal_signin_token');
    expect(await storedAnywhere(t)).toEqual([]);
    // b18 review F4: the attachments view (what the thread shows under the message) labels the part as stored redacted;
    // the message row itself held no token, so its own label stays null and only the part's label says it
    const [shown] = await textPartsOf(c.id, messageId);
    expect(shown).toMatchObject({ status: 'read', redaction: 'stored' });
    expect(shown!.text).toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect(shown!.text).not.toContain(t);
    expect((await h.su.query('SELECT content_redacted FROM messages WHERE id = $1', [messageId])).rows[0]!.content_redacted).toBeNull();
  });

  it('R-PORTAL-20 (b18 review F4): an MMS text part stored before the redaction existed is shown hidden ("display", "[sign-in token hidden]", never "removed") and its stored record is never rewritten; a part with no token carries no label', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const parts = async (text: string) => {
      const mm = `MM${randomBytes(16).toString('hex')}`;
      const me = `ME${randomBytes(16).toString('hex')}`;
      h.providers.telephony.media.set(me, { bytes: new Uint8Array(Buffer.from(text, 'utf8')), contentType: 'text/plain' });
      const form = { MessageSid: mm, From: c.phone, To: w.mainNumber, Body: '', NumMedia: '1', MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${mm}/Media/${me}`, MediaContentType0: 'text/plain' };
      expect((await telephonyWebhook(h, '/webhooks/telephony/sms', form)).statusCode).toBe(200);
      const messageId = (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0]!.id;
      const j = (await h.su.query<{ payload: { messageRef: string; parts: { position: number; ref: string | null }[] } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [messageId])).rows[0]!.payload;
      await readTextParts(systemActor(w.tenantId, 'provider'), { messageId, messageRef: j.messageRef, parts: j.parts }, w.deps);
      return messageId;
    };
    const older = await parts('See you at the open house.');
    const t = newToken();
    const old = `Earlier: ${portalLinkUrl(origin, t)}`;
    // fixture only: a part as batch 17 stored it (no application path writes one any more; a read part's body is
    // otherwise fixed by its trigger)
    await h.su.query(`SET session_replication_role = replica`);
    try {
      await h.su.query('UPDATE message_text_parts SET body = $2 WHERE message_id = $1', [older, old]);
    } finally {
      await h.su.query(`SET session_replication_role = origin`);
    }
    const [shown] = await textPartsOf(c.id, older);
    expect(shown).toMatchObject({ status: 'read', redaction: 'display' });
    expect(shown!.text).toContain(SIGNIN_TOKEN_HIDDEN);
    expect(shown!.text).not.toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect(shown!.text).not.toContain(t);
    expect((await h.su.query('SELECT body, content_redacted FROM message_text_parts WHERE message_id = $1', [older])).rows[0]).toEqual({ body: old, content_redacted: null });
    const plain = await parts('Saturday works.');
    expect((await textPartsOf(c.id, plain))[0]).toMatchObject({ text: 'Saturday works.', redaction: null });
  });

  it('R-PORTAL-20: a message stored before the redaction existed is shown with the token hidden ("display") and its stored record is never rewritten', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await inboundSms(h, c.phone, w.mainNumber, 'hello');
    const [m] = await inbound(c.id);
    const t = newToken();
    const old = `Earlier: ${portalLinkUrl(origin, t)}`;
    // fixture only: a record as batch 17 stored it (no application path writes one any more)
    await h.su.query('UPDATE messages SET body = $2 WHERE id = $1', [m!.id, old]);
    const item = (await timeline(c.id)).find((i) => i.id === m!.id)!;
    expect(item.preview).not.toContain(t);
    // b18 review F4: hidden on screen only, so the shown text says hidden, never "removed" (the stored copy keeps it)
    expect(item.preview).toContain(SIGNIN_TOKEN_HIDDEN);
    expect(item.preview).not.toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect(item.redaction).toBe('display');
    expect((await inbound(c.id))[0]!.body).toBe(old);
    expect((await inbound(c.id))[0]!.content_redacted).toBeNull();
    // a message with no token carries no label
    const c2 = await ownedContact(agent);
    await inboundSms(h, c2.phone, w.mainNumber, 'See you Saturday');
    expect((await timeline(c2.id)).find((i) => i.preview === 'See you Saturday')!.redaction).toBeNull();
    expect((await inbound(c2.id))[0]!.content_redacted).toBeNull();
  });

  it('R-PORTAL-20: the label is fixed once written (0093): it can be neither cleared nor put on a record stored as received', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await inboundSms(h, c.phone, w.mainNumber, `Liked “${portalLinkUrl(origin, newToken())}”`);
    await inboundSms(h, c.phone, w.mainNumber, 'plain');
    const [a, b] = await inbound(c.id);
    await expect(h.su.query('UPDATE messages SET content_redacted = NULL WHERE id = $1', [a!.id])).rejects.toThrow(/CONTENT_REDACTED_FIXED/);
    await expect(h.su.query("UPDATE messages SET content_redacted = 'portal_signin_token' WHERE id = $1", [b!.id])).rejects.toThrow(/CONTENT_REDACTED_FIXED/);
    await expect(h.su.query("UPDATE messages SET content_redacted = 'other' WHERE id = $1", [b!.id])).rejects.toThrow();
  });
});

// b18 review B18S-2: the inquiry an intake writes (lead_inquiries.message, property_text and the encrypted raw payload)
// is a stored copy of what the person typed too: the opening web-chat message, a lead form or a lead webhook. It is
// stored redacted and labelled (0097), the person page and the assistant's prompt never carry the value, and an older
// inquiry is hidden at read time and never rewritten.
describe('R-PORTAL-20 a quoted sign-in token is not stored in an inquiry either (b18 review B18S-2)', () => {
  type InquiryRow = { id: string; message: string | null; property_text: string | null; content_redacted: string | null; raw_payload_enc: Buffer | null };
  const inquiriesOf = async (contactId: string) =>
    (await h.su.query<InquiryRow>('SELECT id, message, property_text, content_redacted, raw_payload_enc FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at', [contactId])).rows;
  const rawOf = (row: InquiryRow) => withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) =>
    Buffer.from(await h.app.platform.envelope.inTx(tx, w.tenantId as never).decrypt(w.tenantId as never, { table: 'lead_inquiries', column: 'raw_payload_enc', rowId: row.id }, new Uint8Array(row.raw_payload_enc!))).toString('utf8'), { db: h.database });
  const personInquiries = async (contactId: string) => {
    const r = await call<{ contact: { inquiries: { message: string | null; propertyText: string | null; redaction: string | null }[] } }>(w.owner, 'GET', `/contacts/${contactId}`);
    expect(r.status).toBe(200);
    return r.body.contact.inquiries;
  };
  const promptInquiry = (contactId: string) => withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => latestInquiry(tx, contactId), { db: h.database });

  it('R-PORTAL-20 B18S-2: a web-chat opening message quoting the sign-in link is stored without the token in the message AND the inquiry (plain text and raw payload), the inquiry is labelled, and the person page and the assistant prompt never carry it', async () => {
    const src = await chatSource(h, w.owner, w.tenantId);
    const widget = await createWidget(h, w.owner, src.sourceId);
    const t = newToken();
    const chat = await openChat(h, widget.key, src.disclosureId, { name: 'Sam Visitor', email: 'visitor.b18s2@example.test', message: `this sign-in link did not work ${portalLinkUrl(origin, t)}` });
    const [m] = await inbound(chat.contactId);
    expect(m!.body).not.toContain(t);
    expect(m!.content_redacted).toBe('portal_signin_token');
    const [i] = await inquiriesOf(chat.contactId);
    expect(i!.message).not.toContain(t);
    expect(i!.message).toContain(`/portal.html#token=${SIGNIN_TOKEN_PLACEHOLDER}`);
    expect(i!.message!.startsWith('this sign-in link did not work')).toBe(true);
    expect(i!.content_redacted).toBe('portal_signin_token');
    const raw = await rawOf(i!);
    expect(raw).not.toContain(t);
    expect(raw).toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect((await h.su.query('SELECT 1 FROM lead_inquiries WHERE tenant_id = $1 AND (message LIKE $2 OR property_text LIKE $2)', [w.tenantId, `%${t}%`])).rows).toEqual([]);
    const [shown] = await personInquiries(chat.contactId);
    expect(shown!.message).not.toContain(t);
    expect(shown!.redaction).toBe('stored');
    expect((await promptInquiry(chat.contactId))!.message).not.toContain(t);
    for (const line of h.logs) expect(line).not.toContain(t);
  });

  it('R-PORTAL-20 B18S-2: a lead webhook inquiry quoting it in its message and its property text is stored without either token and labelled; one with no token is stored as received and unlabelled', async () => {
    const [t1, t2] = [newToken(), newToken()];
    const r = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Pat Example', emails: [`pat.b18s2.${randomUUID().slice(0, 8)}@example.test`], message: `My link: ${portalLinkUrl(origin, t1)}`, propertyText: `12 Elm St ${origin}/portal.html%23token%3D${t2}` });
    expect([200, 201]).toContain(r.statusCode);
    const contactId = (JSON.parse(r.body) as { contactId: string }).contactId;
    const [i] = await inquiriesOf(contactId);
    expect(i!.message).not.toContain(t1);
    expect(i!.property_text).not.toContain(t2);
    expect(i!.property_text!.startsWith('12 Elm St')).toBe(true);
    expect(i!.content_redacted).toBe('portal_signin_token');
    const raw = await rawOf(i!);
    expect(raw).not.toContain(t1);
    expect(raw).not.toContain(t2);
    const plain = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Lee Example', emails: [`lee.b18s2.${randomUUID().slice(0, 8)}@example.test`], message: 'Is it still available?' });
    const [p] = await inquiriesOf((JSON.parse(plain.body) as { contactId: string }).contactId);
    expect(p).toMatchObject({ message: 'Is it still available?', content_redacted: null });
  });

  it('R-PORTAL-20 B18S-2: an inquiry stored before the redaction existed is shown on the person page and given to the assistant with the token hidden ("display") and never rewritten; the label is fixed once written (0097)', async () => {
    const r = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Kim Example', emails: [`kim.b18s2.${randomUUID().slice(0, 8)}@example.test`], message: 'Hello' });
    const contactId = (JSON.parse(r.body) as { contactId: string }).contactId;
    const [i] = await inquiriesOf(contactId);
    const t = newToken();
    const old = `Earlier: ${portalLinkUrl(origin, t)}`;
    // fixture only: an inquiry as batch 17 stored it (no application path writes one any more)
    await h.su.query('UPDATE lead_inquiries SET message = $2 WHERE id = $1', [i!.id, old]);
    const [shown] = await personInquiries(contactId);
    expect(shown!.message).not.toContain(t);
    expect(shown!.message).toContain(SIGNIN_TOKEN_HIDDEN);
    expect(shown!.redaction).toBe('display');
    expect((await promptInquiry(contactId))!.message).not.toContain(t);
    expect((await inquiriesOf(contactId))[0]).toMatchObject({ message: old, content_redacted: null });
    // the label cannot be put on a record stored as received, nor cleared from one stored redacted
    await expect(h.su.query("UPDATE lead_inquiries SET content_redacted = 'portal_signin_token' WHERE id = $1", [i!.id])).rejects.toThrow(/CONTENT_REDACTED_FIXED/);
    const red = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Ray Example', emails: [`ray.b18s2.${randomUUID().slice(0, 8)}@example.test`], message: `See ${portalLinkUrl(origin, newToken())}` });
    const [ri] = await inquiriesOf((JSON.parse(red.body) as { contactId: string }).contactId);
    expect(ri!.content_redacted).toBe('portal_signin_token');
    await expect(h.su.query('UPDATE lead_inquiries SET content_redacted = NULL WHERE id = $1', [ri!.id])).rejects.toThrow(/CONTENT_REDACTED_FIXED/);
  });
});
