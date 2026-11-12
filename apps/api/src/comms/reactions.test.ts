// D5b texting reactions through the real server and the inbound transaction (R-REACT-1 … R-REACT-7; E300–E309).
// Fakes only (the fake telephony, email and AI providers); every person and team here is synthetic.
import { randomUUID } from 'node:crypto';
import { classifyInbound } from '@realty/core/compliance';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionsOf, appointment, approvedPlaybook, type ApprovedPlaybook, runJobs as runAssistantJobs, smsStep } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { queueOutboundInTx } from './compose.js';
import { ingestInbound } from './inbound.js';
import { reactionExtras } from './reactions.js';
import { chatMessage, chatSource, createWidget, openChat } from '../channels/testing.js';
import { type CommsWorld, call, commsWorld, emailWebhook, freshReauth, inboundSms, ownedContact, playbookFixture, randomPhone, sendText, type TestContact } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let w2: CommsWorld;
let brokerage: string;
let team: string;
let pb: ApprovedPlaybook;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 3 });
  w2 = await commsWorld(h, { agents: 1 });
  const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
  brokerage = s.b;
  team = s.t ?? s.b;
  pb = await approvedPlaybook(w.owner, {
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Confirm',
    steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, you are set for {{appointment_time}}.', slots: ['first_name', 'appointment_time'] })],
  });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const E301 = [
  { body: 'Liked “Let me know if you don’t want any more texts about this one”', quote: 'Let me know if you don’t want any more texts about this one', reading: 'OPT_OUT_LANGUAGE' },
  { body: 'Loved “No more texts about Oak St, I promise. Talk soon!”', quote: 'No more texts about Oak St, I promise. Talk soon!', reading: 'OPT_OUT_LANGUAGE' },
  { body: 'Questioned “Wrong number?”', quote: 'Wrong number?', reading: 'WRONG_NUMBER' },
  { body: 'Removed a heart from “Do not text after 9”', quote: 'Do not text after 9', reading: 'OPT_OUT_LANGUAGE' },
];

const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };
function stepBody(): string {
  const r = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: team }), brokerageName: brokerage, firstInThread: true });
  if (!r.ok) throw new Error('render');
  return r.text;
}

/** A live enrollment with one queued (scheduled) assistant message for the contact. */
async function nurture(contactId: string): Promise<{ messageId: string; enrollmentId: string }> {
  const f = await playbookFixture(h, w.tenantId, w.owner, contactId, { scope: 'team', step, body: stepBody(), category: 'reminder', purpose: 'informational' });
  const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', body: stepBody(), initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: f.actionId, playbookStepRunId: f.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
  if (!r.ok) throw new Error(r.code);
  return { messageId: r.messageId, enrollmentId: f.enrollmentId };
}

/** The agent texts `body` to the contact from the team main number; returns the message id. */
const stored = new Map<string, string>();
async function teamText(agentIdx: number, c: TestContact, body: string): Promise<string> {
  const r = await sendText(w.agents[agentIdx]!, c.id, body);
  expect(r.body.result, JSON.stringify(r.body)).toBe('sent');
  const id = r.body.message!.id;
  // the phone quotes the whole text it received: the stored body (with the sign-off the server adds)
  stored.set(body, (await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id])).rows[0]!.body);
  return id;
}

/** The stored body of the latest team text sent as `plain` (what a phone quotes). */
function Q(plain: string): string {
  const b = stored.get(plain);
  if (b === undefined) throw new Error(`no team text "${plain}"`);
  return b;
}

async function lastInbound(contactId: string): Promise<{ id: string; opt_out_keyword: string | null; channel: string }> {
  return (await h.su.query("SELECT id, opt_out_keyword, channel FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY occurred_at DESC, id DESC LIMIT 1", [contactId])).rows[0];
}

async function reactionRow(messageId: string): Promise<{ target_message_id: string; action: string; reaction: string; emoji: string | null; whole_text_reading: string } | undefined> {
  return (await h.su.query('SELECT target_message_id, action, reaction, emoji, whole_text_reading FROM message_reactions WHERE message_id = $1', [messageId])).rows[0];
}

/** What an opt-out or wrong-number reading would have written for the contact (R-CONSENT-8, -11, R-CHAN-3). */
async function consentSide(c: TestContact): Promise<{ revokes: number; dnc: boolean; wrongNumber: number }> {
  const revokes = (await h.su.query("SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND contact_id = $2 AND event_type = 'revoke'", [w.tenantId, c.id])).rows[0].n as number;
  const dnc = (await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [c.id])).rows[0].do_not_contact_at !== null;
  const wrongNumber = (await h.su.query("SELECT count(*)::int AS n FROM contact_points WHERE contact_id = $1 AND status = 'wrong_number'", [c.id])).rows[0].n as number;
  return { revokes, dnc, wrongNumber };
}

async function notificationsFor(userId: string, since: Date): Promise<{ kind: string; priority: string; title: string }[]> {
  return (await h.su.query('SELECT kind, priority, title FROM notifications WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at', [userId, since])).rows;
}

async function auditFor(action: string, messageId: string): Promise<{ reason: string | null }[]> {
  return (await h.su.query('SELECT reason FROM audit_log WHERE tenant_id = $1 AND action = $2 AND entity_id = $3', [w.tenantId, action, messageId])).rows;
}

type TItem = { id: string; type: string; reaction: { action: string; reaction: string; emoji: string | null; targetMessageId: string; quote: string; raw: string; narrowed: boolean } | null; reactedWith: { reaction: string; emoji: string | null; at: string } | null };
async function timeline(agentIdx: number, contactId: string): Promise<TItem[]> {
  const r = await call<{ items: TItem[] }>(w.agents[agentIdx]!, 'GET', `/contacts/${contactId}/timeline`);
  expect(r.status).toBe(200);
  return r.body.items;
}

describe('recognition and link (R-REACT-1, R-REACT-2)', () => {
  it('E300: a tapback quoting the team text links (love, add), shows under that bubble and is a reply (pause, one handback, feed card, notification)', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Sam', confirmDistinct: true });
    const target = await teamText(0, c, 'See you at 3');
    const n = await nurture(c.id);
    const since = new Date();
    expect((await inboundSms(h, c.phone, w.mainNumber, `Loved “${Q('See you at 3')}”`)).statusCode).toBe(200);
    const m = await lastInbound(c.id);
    expect(await reactionRow(m.id)).toEqual({ target_message_id: target, action: 'add', reaction: 'love', emoji: null, whole_text_reading: 'none' });
    expect(m.opt_out_keyword).toBeNull();
    expect((await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0]).toEqual({ state: 'paused', pause_reason: 'client_reply' });
    const hb = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback');
    expect(hb).toHaveLength(1);
    const claims = (await h.su.query<{ kind: string; text: string }>('SELECT claim_kind AS kind, text FROM assistant_claims WHERE action_id = $1 ORDER BY ordinal', [hb[0]!.id])).rows;
    expect(claims.find((x) => x.text === `Sam loved “${Q('See you at 3')}”.`)).toMatchObject({ kind: 'fact' });
    expect(claims.some((x) => /your text/i.test(x.text))).toBe(false);
    expect(hb[0]!.explanation).toBe('Sam reacted to a text, so the assistant paused and handed the conversation back to you.');
    expect(await notificationsFor(w.agents[0]!.userId!, since)).toEqual([expect.objectContaining({ title: 'Sam D. reacted to a text' })]);
    const items = await timeline(0, c.id);
    expect(items.find((t) => t.id === m.id)!.reaction).toEqual({ action: 'add', reaction: 'love', emoji: null, targetMessageId: target, quote: Q('See you at 3'), raw: `Loved “${Q('See you at 3')}”`, narrowed: false });
    expect(items.find((t) => t.id === target)!.reactedWith).toMatchObject({ reaction: 'love', emoji: null });
  });

  const E302_WAYS = ['another phone', 'another contact', 'another team number', '31 days ago', 'imported', 'blocked', 'failed', 'never sent'] as const;
  it.each(E302_WAYS)('R-REACT-2 R-REACT-3 E302: %s ⇒ not a reaction, classified exactly as before (person-level do-not-contact with needs_review)', async (way) => {
    const { body, quote } = E301[1]!;
    const agentIdx = way === 'another team number' ? 2 : 0;
    const c = await ownedContact(w.agents[agentIdx]!, { confirmDistinct: true });
    if (way === 'another phone') {
      const other = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      void other;
      const second = randomPhone();
      await h.su.query("INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label) SELECT tenant_id, $2, contact_id, 'phone', $3, digest($3, 'sha256'), 'work' FROM contact_points WHERE contact_id = $1 LIMIT 1", [c.id, randomUUID(), second]);
      // the team text went to the contact's other phone (a stored row: no real send)
      const t = await teamText(0, c, quote);
      await h.su.query('UPDATE messages SET to_address = $2 WHERE id = $1', [t, second]);
    } else if (way === 'another contact') {
      const other = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await teamText(0, other, quote);
    } else if (way === 'another team number') {
      await freshReauth(h, w.owner);
      const direct = await call<{ number: { id: string } }>(w.owner, 'POST', '/numbers', { purpose: 'agent_direct', assignedUserId: w.agents[2]!.userId, registrationId: w.registrationId });
      expect(direct.status).toBe(201);
      const t = await teamText(2, c, quote);
      expect((await h.su.query('SELECT phone_number_id FROM messages WHERE id = $1', [t])).rows[0].phone_number_id).not.toBe(w.mainNumberId);
    } else if (way === '31 days ago') {
      const t = await teamText(0, c, quote);
      await h.su.query("UPDATE messages SET occurred_at = now() - interval '31 days', dispatched_at = now() - interval '31 days' WHERE id = $1", [t]);
    } else if (way === 'imported') {
      const t = await teamText(0, c, quote);
      await h.su.query("SET session_replication_role = replica; UPDATE messages SET imported = true, initiator = 'import', import_record_id = gen_random_uuid(), initiated_by_user_id = NULL WHERE id = '" + t + "'; SET session_replication_role = origin;");
    } else if (way === 'blocked' || way === 'failed') {
      const t = await teamText(0, c, quote);
      await h.su.query('UPDATE messages SET status = $2 WHERE id = $1', [t, way]);
    }
    expect(classifyInbound(body, { optOut: [], resubscribe: [], help: [] }).kind).toBe('opt_out_language');
    // the reaction quotes the team text exactly as stored, so only the bound decides
    await inboundSms(h, c.phone, w.mainNumber, way === 'never sent' ? body : body.replace(quote, Q(quote)));
    const m = await lastInbound(c.id);
    expect(await reactionRow(m.id)).toBeUndefined();
    expect(m.opt_out_keyword).not.toBeNull();
    expect((await consentSide(c)).dnc).toBe(true);
    expect(await auditFor('consent.opt_out_received', m.id)).toEqual([{ reason: 'OPT_OUT_LANGUAGE' }]);
    expect(await auditFor('consent.reaction_quote_not_read', m.id)).toEqual([]);
  });

  it('R-REACT-1 R-REACT-3 E303: words around a reaction make it an ordinary text, so the written opt-out counts', async () => {
    const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    await teamText(0, c, 'See you at 3');
    await inboundSms(h, c.phone, w.mainNumber, `Loved “${Q('See you at 3')}” please stop texting me`);
    const m = await lastInbound(c.id);
    expect(await reactionRow(m.id)).toBeUndefined();
    expect((await consentSide(c)).dnc).toBe(true);
  });

  it('R-REACT-1 R-REACT-2 E304: Google Messages and Spanish forms link; the emoji is kept as received', async () => {
    const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    const target = await teamText(0, c, 'See you at 4');
    const q = Q('See you at 4');
    const ZW = '​';
    const ZWNJ = '‌';
    const HAIR = ' ';
    const SCOTLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const forms: [string, string, string | null][] = [
      [`${ZW}👍${ZW} to “${HAIR}${q}${HAIR}”`, 'emoji', '👍'],
      [`${ZW}❤️${ZW} to "${HAIR}${q}${HAIR}"`, 'emoji', '❤️'],
      [`😂 to "${q}"`, 'emoji', '😂'],
      [`${ZW}👍${ZW} a “${HAIR}${q}${HAIR}”`, 'emoji', '👍'],
      [`Se quitó ${ZWNJ}👍${ZWNJ} de "${HAIR}${q}${HAIR}"`, 'emoji', '👍'],
      [`Se ha quitado 👍 de "${q}"`, 'emoji', '👍'],
      [`Le encantó “${q}”`, 'love', null],
      [`Reacted ‼️ to “${q}”`, 'emoji', '‼️'],
      [`Reacted ${SCOTLAND} to “${q}”`, 'emoji', SCOTLAND],
    ];
    for (const [body, reaction, emoji] of forms) {
      await inboundSms(h, c.phone, w.mainNumber, body);
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id), body).toMatchObject({ target_message_id: target, reaction, emoji });
    }
  });

  it('R-REACT-6 R-REACT-4 E305: a removal clears the chip, a later add replaces it; it is still a reply', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Sam', confirmDistinct: true });
    const target = await teamText(0, c, 'Offer is in');
    const since = new Date();
    await inboundSms(h, c.phone, w.mainNumber, `Loved “${Q('Offer is in')}”`);
    expect((await timeline(0, c.id)).find((t) => t.id === target)!.reactedWith).toMatchObject({ reaction: 'love' });
    await inboundSms(h, c.phone, w.mainNumber, `Removed a heart from “${Q('Offer is in')}”`);
    const rm = await lastInbound(c.id);
    let items = await timeline(0, c.id);
    expect(items.find((t) => t.id === target)!.reactedWith).toBeNull();
    expect(items.find((t) => t.id === rm.id)!.reaction).toMatchObject({ action: 'remove', reaction: 'love', quote: Q('Offer is in') });
    await inboundSms(h, c.phone, w.mainNumber, `Removed 👍 from “${Q('Offer is in')}”`); // non-matching removal
    await inboundSms(h, c.phone, w.mainNumber, `Dejó de encantarle “${Q('Offer is in')}”`);
    await inboundSms(h, c.phone, w.mainNumber, `Reacted 👍 to “${Q('Offer is in')}”`);
    items = await timeline(0, c.id);
    expect(items.find((t) => t.id === target)!.reactedWith).toMatchObject({ reaction: 'emoji', emoji: '👍' });
    const titles = (await notificationsFor(w.agents[0]!.userId!, since)).map((n) => n.title);
    expect(titles).toContain('Sam D. removed a reaction from a text');
    expect(titles).toContain('Sam D. reacted to a text');
  });

  it('R-REACT-1 R-REACT-2 E306: a media reaction is not parsed and is an ordinary text', async () => {
    const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    await teamText(0, c, 'an image');
    for (const body of ['Loved an image', '👍 to a photo', 'Le gustó una imagen']) {
      await inboundSms(h, c.phone, w.mainNumber, body);
      expect(await reactionRow((await lastInbound(c.id)).id), body).toBeUndefined();
    }
  });

  it('R-REACT-2 E307: a cut quote is not linked; spacing, case and quote style are ignored', async () => {
    const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    const target = await teamText(0, c, 'No more texts about Oak St, I promise. Talk soon!');
    await inboundSms(h, c.phone, w.mainNumber, 'Loved “No more texts about Oak St, I…”');
    const cut = await lastInbound(c.id);
    expect(await reactionRow(cut.id)).toBeUndefined();
    expect(cut.opt_out_keyword).not.toBeNull();
    const c2 = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    const t2 = await teamText(0, c2, 'Don’t forget the keys');
    await inboundSms(h, c2.phone, w.mainNumber, `loved "${Q('Don’t forget the keys').replace('Don’t forget', "don't  FORGET")}"`);
    expect(await reactionRow((await lastInbound(c2.id)).id)).toMatchObject({ target_message_id: t2 });
    void target;
  });

  const E308_WAYS = ['web chat', 'email', 'MMS with media', 'imported FUB history', 'agent alert phone', 'unknown number', 'shared phone, other contact'] as const;
  it.each(E308_WAYS)('R-REACT-1 R-REACT-2 E308: %s ⇒ never a reaction, handled exactly as before', async (way) => {
    // Questioned “Wrong number?”, quoting the team text as stored when there is one
    const body = (): string => (stored.has('Wrong number?') ? `Questioned “${Q('Wrong number?')}”` : E301[2]!.body);
    const before = (await h.su.query('SELECT count(*)::int AS n FROM message_reactions WHERE tenant_id = $1', [w.tenantId])).rows[0].n as number;
    if (way === 'web chat') {
      // recognition runs for SMS only: a reaction-shaped chat message is classified as before (web chat)
      const src = await chatSource(h, w.owner, w.tenantId, `Chat ${randomUUID().slice(0, 4)}`);
      const widget = await createWidget(h, w.owner, src.sourceId);
      const chat = await openChat(h, widget.key, src.disclosureId, { name: 'Wren Web', phone: randomPhone() });
      expect((await chatMessage(h, chat.token, { message: body(), clientMessageId: randomUUID() })).statusCode).toBe(200);
      const m = await lastInbound(chat.contactId);
      expect(m.channel).toBe('web_chat');
      expect(m.opt_out_keyword).not.toBeNull();
      expect(await reactionRow(m.id)).toBeUndefined();
    } else if (way === 'email') {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await teamText(0, c, 'Wrong number?');
      // an upcoming appointment makes the agent's free-form email informational (R-CONSENT-5)
      await appointment(h, w, c.id, w.agents[0]!.userId!);
      const sent = await call<{ result: string }>(w.agents[0]!, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hi', body: 'Wrong number?', idempotencyKey: `e-${randomUUID()}` });
      expect(sent.body.result).toBe('sent');
      const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
      await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: Hi', text: body() });
      const m = await lastInbound(c.id);
      expect(m.channel).toBe('email');
      expect(m.opt_out_keyword).not.toBeNull();
      expect(await reactionRow(m.id)).toBeUndefined();
    } else if (way === 'MMS with media') {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await teamText(0, c, 'Wrong number?');
      const r = await ingestInbound(systemActor(w.tenantId, 'provider'), { kind: 'sms', providerRef: `MM${randomUUID().replace(/-/g, '')}`, from: c.phone, to: w.mainNumber, body: body(), mediaCount: 1 }, w.deps);
      expect(r.kind).toBe('stored');
      if (r.kind !== 'stored') return;
      expect(r.classification).toBe('wrong_number');
      expect(await reactionRow(r.messageId!)).toBeUndefined();
    } else if (way === 'imported FUB history') {
      // imported outbound is never a candidate (imported inbound history is never ingested or classified)
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      const t = await teamText(0, c, 'Wrong number?');
      await h.su.query("SET session_replication_role = replica; UPDATE messages SET imported = true, initiator = 'import', import_record_id = gen_random_uuid(), initiated_by_user_id = NULL WHERE id = '" + t + "'; SET session_replication_role = origin;");
      await inboundSms(h, c.phone, w.mainNumber, body());
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id)).toBeUndefined();
      expect((await consentSide(c)).wrongNumber).toBe(1);
    } else if (way === 'agent alert phone') {
      const agent = w.agents[1]!;
      const phone = randomPhone();
      const ch = await agent.post('/api/me/alert-phone', { phone });
      const code = h.providers.telephony.verificationCodes.at(-1)!.code;
      expect((await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code })).statusCode).toBe(200);
      await inboundSms(h, phone, w.mainNumber, body());
      expect((await h.su.query('SELECT 1 FROM messages WHERE from_address = $1', [phone])).rows).toHaveLength(0);
    } else if (way === 'unknown number') {
      const phone = randomPhone();
      await inboundSms(h, phone, w.mainNumber, body());
      const m = (await h.su.query("SELECT id, contact_id, opt_out_keyword FROM messages WHERE from_address = $1 AND direction = 'inbound'", [phone])).rows[0];
      expect(m.opt_out_keyword).not.toBeNull();
      expect(await reactionRow(m.id)).toBeUndefined();
    } else {
      // two contacts share a phone; the team text went to A, the reply lands on B (the most recent thread)
      const phone = randomPhone();
      const a = await ownedContact(w.agents[0]!, { phone, firstName: 'Ann' });
      const b = await ownedContact(w.agents[0]!, { phone, firstName: 'Bob', confirmDistinct: true });
      await teamText(0, a, 'Wrong number?');
      await teamText(0, b, 'Hi Bob');
      await inboundSms(h, phone, w.mainNumber, body());
      const m = (await h.su.query("SELECT id, contact_id, opt_out_keyword FROM messages WHERE from_address = $1 AND direction = 'inbound' ORDER BY occurred_at DESC LIMIT 1", [phone])).rows[0];
      expect(m.contact_id).toBe(b.id);
      expect(m.opt_out_keyword).not.toBeNull();
      expect(await reactionRow(m.id)).toBeUndefined();
    }
    expect((await h.su.query('SELECT count(*)::int AS n FROM message_reactions WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(before);
  });
});

describe('adversarial: a crafted reaction-shaped text never hides an opt-out (R-REACT-1, R-REACT-2, R-REACT-3)', () => {
  it('R-REACT-1 R-REACT-3 E303: keywords and opt-out words outside the quote, a second quote, or a forged own-words part are read as before; another tenant\'s identical text never links', async () => {
    const crafted = (q: string) => [
      `Loved “${q}” STOP`,
      `STOP Loved “${q}”`,
      `Loved “${q}” “stop texting me”`,
      `Stop texting me to “${q}”`,
      `Reacted STOP to “${q}”`,
      `Loved \u00AD“${q}” please stop texting me`,
    ];
    for (const make of [0, 1, 2, 3, 4, 5]) {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await teamText(0, c, 'See you at 5');
      const body = crafted(Q('See you at 5'))[make]!;
      await inboundSms(h, c.phone, w.mainNumber, body);
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id), body).toBeUndefined();
    }
    // the same phone in another tenant got the identical text: nothing links across tenants
    const phone = randomPhone();
    const other = await ownedContact(w2.agents[0]!, { phone });
    const r = await sendText(w2.agents[0]!, other.id, 'See you at 5');
    expect(r.body.result).toBe('sent');
    const theirs = (await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [r.body.message!.id])).rows[0]!.body;
    const mine = await ownedContact(w.agents[0]!, { phone, confirmDistinct: true });
    await inboundSms(h, phone, w.mainNumber, `Questioned “${theirs}”`);
    const m = await lastInbound(mine.id);
    expect(await reactionRow(m.id)).toBeUndefined();
  });
});

describe('the reaction is read by its own words (R-REACT-3)', () => {
  it.each([true, false])('R-REACT-3 E301 notice (live enrollment: %s): audited, said plainly, no consent change, and the next text is allowed', async (enrolled) => {
    for (const x of E301) {
      const c = await ownedContact(w.agents[0]!, { firstName: 'Sam', confirmDistinct: true });
      await teamText(0, c, x.quote);
      if (enrolled) await nurture(c.id);
      const before = await consentSide(c);
      const since = new Date();
      await inboundSms(h, c.phone, w.mainNumber, x.body.replace(x.quote, Q(x.quote)));
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id), x.body).toMatchObject({ whole_text_reading: x.reading.toLowerCase() });
      expect(m.opt_out_keyword).toBeNull();
      expect(await consentSide(c)).toEqual(before);
      expect(await auditFor('consent.reaction_quote_not_read', m.id)).toEqual([{ reason: x.reading }]);
      expect(await auditFor('consent.opt_out_received', m.id)).toEqual([]);
      const removed = x.body.startsWith('Removed');
      const verb = removed ? 'removed a reaction from a text' : 'reacted to a text';
      expect((await notificationsFor(w.agents[0]!.userId!, since)).map((n) => n.title)).toEqual([`Sam D. ${verb}. Not read as an opt-out or a wrong number: check it`]);
      const hb = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback');
      if (enrolled) {
        expect(hb).toHaveLength(1);
        expect(hb[0]!.explanation).toBe(`Sam ${verb}, so the assistant paused and handed the conversation back to you. The words in quotes come from a text sent to Sam, so they were not read as an opt-out or a wrong number.`);
      } else {
        expect(hb).toHaveLength(0);
      }
      const items = await timeline(0, c.id);
      expect(items.find((t) => t.id === m.id)!.reaction).toMatchObject({ narrowed: true });
      const next = await sendText(w.agents[0]!, c.id, 'Thanks, talk soon');
      expect(next.body.result).toBe('sent');
    }
  });

  it('R-REACT-3: unlinked, the same texts have exactly today\'s effects', async () => {
    for (const x of E301) {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await inboundSms(h, c.phone, w.mainNumber, x.body);
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id)).toBeUndefined();
      expect(await auditFor('consent.opt_out_received', m.id)).toEqual([{ reason: x.reading }]);
      const s = await consentSide(c);
      expect(s.revokes).toBeGreaterThan(0);
      if (x.reading === 'WRONG_NUMBER') expect(s.wrongNumber).toBe(1);
      else expect(s.dnc).toBe(true);
    }
  });
});

describe('a reaction is a reply (R-REACT-4)', () => {
  it('R-REACT-4: a reaction and a plain "ok" give identical pause, cancels, handback count, feed card and notification kind/priority; only the copy differs', async () => {
    const run = async (reply: (c: TestContact) => string) => {
      const c = await ownedContact(w.agents[0]!, { firstName: 'Sam', confirmDistinct: true });
      await teamText(0, c, 'Sounds good');
      const n = await nurture(c.id);
      const trig = (await h.su.query("SELECT count(*)::int AS n FROM playbook_step_runs r JOIN playbook_enrollments e ON e.tenant_id = r.tenant_id AND e.id = r.enrollment_id WHERE e.contact_id = $1 AND r.status = 'canceled_paused'", [c.id])).rows[0].n;
      const since = new Date();
      await inboundSms(h, c.phone, w.mainNumber, reply(c));
      await call(w.agents[0]!, 'GET', '/feed');
      const enr = (await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [n.enrollmentId])).rows[0];
      const conv = (await h.su.query('SELECT automation_paused_at IS NOT NULL AS paused FROM conversations WHERE contact_id = $1', [c.id])).rows[0];
      const queued = (await h.su.query('SELECT status, status_reason FROM messages WHERE id = $1', [n.messageId])).rows[0];
      const hb = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback').length;
      const feed = (await h.su.query('SELECT item_type, band, score, reasons FROM priority_feed_items WHERE contact_id = $1 AND user_id = $2 AND resolved_at IS NULL ORDER BY created_at', [c.id, w.agents[0]!.userId])).rows;
      const notes = (await notificationsFor(w.agents[0]!.userId!, since)).map((x) => ({ kind: x.kind, priority: x.priority }));
      const trigAfter = (await h.su.query("SELECT count(*)::int AS n FROM playbook_step_runs r JOIN playbook_enrollments e ON e.tenant_id = r.tenant_id AND e.id = r.enrollment_id WHERE e.contact_id = $1 AND r.status = 'canceled_paused'", [c.id])).rows[0].n;
      return { enr, conv, queued, hb, feed, notes, trigCanceled: trigAfter - trig };
    };
    const ok = await run(() => 'ok');
    const rx = await run(() => `Liked “${Q('Sounds good')}”`);
    expect(rx).toEqual(ok);
    expect(ok.hb).toBe(1);
  });
});

describe('a refused link (R-REACT-5)', () => {
  it('R-REACT-5 a refused link: the text is stored, classified as before, and audited; a deadlock retries the whole ingestion and links', async () => {
    await h.su.query(`CREATE FUNCTION public.test_reaction_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REACTION_TEST_REFUSED: test-only' USING ERRCODE = 'check_violation'; END $$`);
    await h.su.query('CREATE TRIGGER test_reaction_refuse BEFORE INSERT ON message_reactions FOR EACH ROW EXECUTE FUNCTION public.test_reaction_refuse()');
    try {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      await teamText(0, c, 'Questions about the HOA? Wrong number?');
      await inboundSms(h, c.phone, w.mainNumber, `Questioned “${Q('Questions about the HOA? Wrong number?')}”`);
      const m = await lastInbound(c.id);
      expect(await reactionRow(m.id)).toBeUndefined();
      expect(m.opt_out_keyword).not.toBeNull();
      expect((await consentSide(c)).wrongNumber).toBe(1);
      expect(await auditFor('consent.reaction_link_refused', m.id)).toEqual([{ reason: 'REACTION_TEST_REFUSED' }]);
    } finally {
      await h.su.query('DROP TRIGGER test_reaction_refuse ON message_reactions; DROP FUNCTION public.test_reaction_refuse()');
    }
    await h.su.query('CREATE SEQUENCE public.test_reaction_calls; GRANT USAGE ON SEQUENCE public.test_reaction_calls TO app_user');
    await h.su.query(`CREATE FUNCTION public.test_reaction_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('public.test_reaction_calls') = 1 THEN RAISE EXCEPTION 'test deadlock' USING ERRCODE = '40P01'; END IF; RETURN NEW; END $$`);
    await h.su.query('CREATE TRIGGER test_reaction_deadlock BEFORE INSERT ON message_reactions FOR EACH ROW EXECUTE FUNCTION public.test_reaction_deadlock()');
    try {
      const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
      const t = await teamText(0, c, 'Wrong number?');
      expect((await inboundSms(h, c.phone, w.mainNumber, `Questioned “${Q('Wrong number?')}”`)).statusCode).toBe(200);
      const all = (await h.su.query("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows;
      expect(all).toHaveLength(1);
      expect(await reactionRow(all[0].id)).toMatchObject({ target_message_id: t, whole_text_reading: 'wrong_number' });
      expect((await consentSide(c)).wrongNumber).toBe(0);
      expect((await h.su.query("SELECT last_value::int AS n FROM public.test_reaction_calls")).rows[0].n).toBe(2);
    } finally {
      await h.su.query('DROP TRIGGER test_reaction_deadlock ON message_reactions; DROP FUNCTION public.test_reaction_deadlock(); DROP SEQUENCE public.test_reaction_calls');
    }
  });

  it('R-REACT-5 timeline extras under RLS: nothing for another tenant or a contact the caller cannot see; a viewer who sees the thread gets both fields', async () => {
    const c = await ownedContact(w.agents[0]!, { confirmDistinct: true });
    const t = await teamText(0, c, 'Keys are under the mat');
    await inboundSms(h, c.phone, w.mainNumber, `Emphasized “${Q('Keys are under the mat')}”`);
    const m = await lastInbound(c.id);
    const ids = [m.id, t];
    const as = (actor: Parameters<typeof withTenantTx>[0]) => withTenantTx(actor, (tx) => reactionExtras(tx, ids), { db: h.database });
    const sizes = (x: Awaited<ReturnType<typeof reactionExtras>>) => [x.reaction.size, x.reactedWith.size];
    expect(sizes(await as(w2.owner.actor()))).toEqual([0, 0]);
    const seen = async (actor: Parameters<typeof withTenantTx>[0]) => (await withTenantTx(actor, async (tx) => (await (await import('kysely')).sql<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE id = ${m.id}`.execute(tx)).rows[0]!.n, { db: h.database }));
    for (const viewer of [w.agents[1]!, w.agents[2]!]) {
      const visible = await seen(viewer.actor());
      expect(sizes(await as(viewer.actor()))).toEqual(visible === 1 ? [1, 1] : [0, 0]);
    }
    for (const viewer of [w.agents[0]!, w.owner]) expect(sizes(await as(viewer.actor()))).toEqual([1, 1]);
    const owner = await call<{ items: TItem[] }>(w.owner, 'GET', `/contacts/${c.id}/timeline`);
    expect(owner.body.items.find((x) => x.id === m.id)!.reaction).toMatchObject({ reaction: 'emphasize', targetMessageId: t });
    expect(owner.body.items.find((x) => x.id === t)!.reactedWith).toMatchObject({ reaction: 'emphasize' });
  });
});

describe('the assistant (R-REACT-7)', () => {
  const PRICE = 'Would the sellers take 450k if we close fast?';
  async function handbackAfter(text: (stored: string) => string): Promise<{ contactId: string; handbackId: string }> {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { confirmDistinct: true });
    await teamText(0, c, PRICE);
    const appt = await appointment(h, w, c.id, agent.userId!);
    await call(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: pb.playbookId, anchor: { kind: 'appointment', id: appt } });
    await runAssistantJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    await inboundSms(h, c.phone, w.mainNumber, text(Q(PRICE)));
    const hb = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback');
    expect(hb).toHaveLength(1);
    await runAssistantJobs(h, w.tenantId, ['assistant.enrich_handback']);
    return { contactId: c.id, handbackId: hb[0]!.id };
  }

  it('R-REACT-7 E309: draftCategory ignores the quote (handback draft, the approved reply, a run draft); a plain text with the same words is money', async () => {
    const plain = await handbackAfter(() => PRICE);
    expect((await actionsOf(h, plain.contactId)).find((a) => a.id === plain.handbackId)!.payload.draftCategory).toBe('money');
    const r = await handbackAfter((q) => `Loved “${q}”`);
    expect((await actionsOf(h, r.contactId)).find((a) => a.id === r.handbackId)!.payload.draftCategory).toBe('novel_message');
    const ok = await call<{ messageId: string }>(w.agents[0]!, 'POST', `/assistant/actions/${r.handbackId}/approve`, { commandId: randomUUID() });
    expect(ok.status).toBe(200);
    expect((await actionsOf(h, r.contactId)).find((a) => a.kind === 'message_draft')).toMatchObject({ action_category: 'novel_message' });
    const d = await call<{ action: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${r.contactId}/drafts`, { commandId: randomUUID() });
    expect(d.status).toBe(200);
    expect((await actionsOf(h, r.contactId)).find((a) => a.id === d.body.action.id)).toMatchObject({ action_category: 'novel_message' });
  });

  it('R-REACT-7 E309: the prompt prints only the reaction, and an old reaction\'s target joins the bundle', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { confirmDistinct: true });
    const t = await teamText(0, c, PRICE);
    await inboundSms(h, c.phone, w.mainNumber, `Loved “${Q(PRICE)}”`);
    // push the target out of the loaded window
    await h.su.query("UPDATE messages SET occurred_at = now() - interval '2 days', dispatched_at = now() - interval '2 days' WHERE id = $1", [t]);
    for (let i = 0; i < 29; i++) await h.su.query("INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator, occurred_at) SELECT tenant_id, gen_random_uuid(), conversation_id, contact_id, 'sms', 'inbound', phone_number_id, from_address, to_address, $2, 'received', 'client', now() + make_interval(secs => $3) FROM messages WHERE contact_id = $1 AND direction = 'inbound' LIMIT 1", [c.id, `filler ${i}`, i + 1]);
    await h.su.query("UPDATE messages SET occurred_at = now() - interval '1 day' WHERE contact_id = $1 AND direction = 'inbound' AND body LIKE 'Loved%'", [c.id]);
    const calls = h.providers.ai.calls.length;
    const d = await call(agent, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    expect(d.status).toBe(200);
    const prompt = h.providers.ai.calls.slice(calls).map((x) => x.user).join('\n');
    expect(prompt).toContain(PRICE); // the team's text, as the agent's, by its own handle
    expect(prompt).toMatch(/client \(sms reaction to the team's text \[S\d+\]\):/);
    expect(prompt).not.toContain('Loved “');
  });
});
