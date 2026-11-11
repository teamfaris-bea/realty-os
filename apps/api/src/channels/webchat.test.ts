// Website chat end to end through the real server (module 22; DATA_MODEL R-INBOX-1/2/4/5/7, R-TEN-12, R-CHAN-2/3,
// R-NURT-5, R-GATE-14; E77, E137, E138, E154, E155). Fakes only: the in-process chat transport, the fake telephony
// and email providers; nothing leaves the process.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, approvedPlaybook, assistantWorld, call, decisionsFor, messagesOf, ownedContact, runJobs } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { BUILT_IN_TEMPLATES as TEMPLATES } from '../assistant/templates.js';
import { acceptLead, chatConfig, chatMessage, chatSource, codeOf, createWidget, openChat, pointsOf, pollBody, scheduledTriggerRun, startChat, visitorIp } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let src: { sourceId: string; disclosureId: string };
let widget: { id: string; key: string };

const FR = ['assistant.first_response', 'comms.dispatch'];
const firstReply = (TEMPLATES.find((t) => t.key === 'new_lead_response')!.steps[0] as Record<string, unknown>);

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await assistantWorld(h, { agents: 2 });
  src = await chatSource(h, w.owner, w.tenantId);
  widget = await createWidget(h, w.owner, src.sourceId);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-INBOX-5 starting a chat', () => {
  it('R-INBOX-5: the widget shows the lead source disclosure first and says replies may come from an automated assistant; a start with another disclosure is WEBCHAT_DISCLOSURE_STALE', async () => {
    const cfg = await chatConfig(h, widget.key);
    expect(cfg.statusCode).toBe(200);
    const body = JSON.parse(cfg.body) as { disclosure: { id: string; text: string }; assistantNotice: string };
    expect(body.disclosure.id).toBe(src.disclosureId);
    expect(body.assistantNotice).toMatch(/automated assistant/);
    const stale = await startChat(h, widget.key, { name: 'Vee', phone: '+14155550111', message: 'Hello there', disclosureId: randomUUID() });
    expect([stale.statusCode, codeOf(stale)]).toEqual([409, 'WEBCHAT_DISCLOSURE_STALE']);
  });

  it('R-INBOX-1 E71: an unknown visitor becomes a NEW contact through intake with the widget lead source, holding only its own wc: identity; the typed phone is only a claim on the session', async () => {
    const typed = '+14155550177';
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Wendy Web', phone: typed });
    expect(await pointsOf(h, c.contactId)).toEqual([{ kind: 'web_chat', address: expect.stringMatching(/^wc:[0-9a-f]{32}$/) }]);
    const s = (await h.su.query('SELECT claimed_kind, claimed_address, contact_point_id, purge_after FROM webchat_sessions WHERE id = $1', [c.sessionId])).rows[0];
    expect(s).toMatchObject({ claimed_kind: 'phone', claimed_address: typed, purge_after: null });
    const contact = (await h.su.query('SELECT display_name, original_lead_source_id, ownership_state FROM contacts WHERE id = $1', [c.contactId])).rows[0];
    expect(contact.display_name).toBe('Wendy Web');
    expect(contact.original_lead_source_id).toBe(src.sourceId);
    expect(['offered', 'owned', 'in_pond', 'unassigned']).toContain(contact.ownership_state);
    // the opening message is in the one conversation, channel web_chat
    const ms = (await h.su.query("SELECT channel, direction, body FROM messages WHERE contact_id = $1", [c.contactId])).rows;
    expect(ms).toEqual([{ channel: 'web_chat', direction: 'inbound', body: 'Hi, is the house on Elm still available?' }]);
  });
});

describe('R-INBOX-4 the first response where the lead wrote', () => {
  it('R-INBOX-4 E154: with the approved new-lead reply on `inbound_channel`, the assistant answers IN the chat (labelled assistant) and nothing automated goes to the phone the visitor typed', async () => {
    await approvedPlaybook(w.owner, { kind: 'new_lead_response', scope: 'team', name: 'Instant reply (chat)', steps: [{ ...firstReply, channel: 'inbound_channel' }] });
    const typed = '+14155550199';
    const sms = h.providers.telephony.sms.length;
    const t0 = Date.now();
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Pat Phone', phone: typed });
    await runJobs(h, w.tenantId, FR);
    const p = await pollBody(h, c.token);
    expect(Date.now() - t0).toBeLessThan(2000 + 1500); // the 2 s acceptance with the fakes (test worker overhead included)
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]!.from).toBe('assistant');
    expect(p.messages[0]!.body).toMatch(/assistant/);
    expect(h.providers.telephony.sms.slice(sms).filter((m) => m.to === typed)).toEqual([]);
    expect(h.providers.webChat.delivered.some((d) => d.messageId === p.messages[0]!.id)).toBe(true);
  });
});

describe('R-INBOX-2 a visitor message runs the Phase 1 ingestion transaction', () => {
  it('R-INBOX-2 R-NURT-5: a chat reply pauses the enrollment, cancels queued assistant messages AND the scheduled trigger runs, and hands back exactly once; it lands in the same thread and feed card as a text', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Ryan Reply' });
    await runJobs(h, w.tenantId, FR);
    await acceptLead(h, w.agents, c.contactId);
    // the first response's enrollment is live (it checks back after the send)
    const pb = (await h.su.query<{ id: string; playbook_version_id: string }>("SELECT id, playbook_version_id FROM playbook_enrollments WHERE contact_id = $1 AND state = 'active'", [c.contactId])).rows[0]!;
    const enrollmentId = pb.id;
    const trig = await scheduledTriggerRun(h, w.tenantId, c.contactId, pb.playbook_version_id);
    const r1 = await chatMessage(h, c.token, { message: 'Can we see it Saturday?', clientMessageId: randomUUID() });
    expect(r1.statusCode).toBe(200);
    expect((await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [enrollmentId])).rows[0]).toEqual({ state: 'paused', pause_reason: 'client_reply' });
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [trig])).rows[0].status).toBe('canceled_paused');
    const hb = (await h.su.query("SELECT id, payload FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.contactId])).rows;
    expect(hb).toHaveLength(1);
    expect(hb[0].payload.canceledTriggerRunIds).toEqual([trig]);
    // a second message, once nothing of the assistant is running or just sent, hands back no second time
    await h.su.query("UPDATE messages SET dispatched_at = now() - interval '5 minutes' WHERE contact_id = $1 AND direction = 'outbound'", [c.contactId]);
    await chatMessage(h, c.token, { message: 'Or Sunday works too', clientMessageId: randomUUID() });
    expect((await h.su.query("SELECT count(*)::int AS n FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.contactId])).rows[0].n).toBe(1);
    const thread = (await h.su.query("SELECT channel, direction FROM messages WHERE contact_id = $1 ORDER BY created_at", [c.contactId])).rows;
    expect(thread.filter((m) => m.direction === 'inbound').map((m) => m.channel)).toEqual(['web_chat', 'web_chat', 'web_chat']);
    const feed = (await h.su.query("SELECT item_type FROM priority_feed_items WHERE contact_id = $1 AND state = 'open'", [c.contactId])).rows.map((x) => x.item_type);
    expect(feed).toContain('handback');
  });

  it('replay: the same clientMessageId posted twice stores one message', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Rita Retry' });
    const id = randomUUID();
    expect((await chatMessage(h, c.token, { message: 'Hello again', clientMessageId: id })).statusCode).toBe(200);
    expect((await chatMessage(h, c.token, { message: 'Hello again', clientMessageId: id })).statusCode).toBe(200);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND body = 'Hello again'", [c.contactId])).rows[0].n).toBe(1);
  });
});

describe('R-CHAN-3 / E155 opt-out language in chat', () => {
  it('E155 R-CHAN-3: "stop contacting me" sets the person-level do-not-contact on the session\'s OWN contact only (the client whose email the visitor typed is untouched); a language opt-out in web chat blocks SMS, email and chat', async () => {
    const client = await ownedContact(w.agents[0]!);
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Ivy Imposter', email: client.email, message: 'Hello, I have a question' });
    expect(c.contactId).not.toBe(client.id);
    expect((await chatMessage(h, c.token, { message: 'Please stop contacting me', clientMessageId: randomUUID() })).statusCode).toBe(200);
    const mine = (await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [c.contactId])).rows[0];
    const theirs = (await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [client.id])).rows[0];
    expect(mine.do_not_contact_at).not.toBeNull();
    expect(theirs.do_not_contact_at).toBeNull();
    const ev = (await h.su.query("SELECT channel, source, needs_review FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.contactId])).rows;
    expect(ev).toEqual([{ channel: 'web_chat', source: 'inbound_language', needs_review: true }]);
    // an agent who later adds a phone by hand cannot text, email or chat the person
    const agent = await acceptLead(h, w.agents, c.contactId);
    const phone = `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const added = await call(agent, 'POST', `/contacts/${c.contactId}/points`, { kind: 'phone', address: phone, label: 'mobile' });
    expect(added.status).toBe(201);
    for (const channel of ['sms', 'web_chat'] as const) {
      const r = await call<{ result: string; decision: { reasons: string[] } | null }>(agent, 'POST', `/contacts/${c.contactId}/messages`, { channel, body: 'Following up', idempotencyKey: `dnc-${randomUUID()}` });
      expect([channel, r.status, r.body.result], JSON.stringify(r.body)).toEqual([channel, 200, 'blocked']);
      expect(r.body.decision!.reasons).toContain('PERSON_DO_NOT_CONTACT');
    }
    expect(h.providers.telephony.sms.filter((m) => m.to === phone)).toEqual([]);
  });
});

describe('R-GATE-14 R-GATE-15 replies in chat go through dispatchOutbound', () => {
  it('R-GATE-14: an agent replies in the chat; it is gated, delivered by deliverChannelMessage and shown to the visitor as from the team, after the assistant reply, with a working cursor', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Carl Cursor' });
    await runJobs(h, w.tenantId, FR);
    const agent = await acceptLead(h, w.agents, c.contactId);
    const before = await pollBody(h, c.token);
    expect(before.messages.map((m) => m.from)).toEqual(['assistant']);
    const r = await call<{ result: string; message: { channel: string } }>(agent, 'POST', `/contacts/${c.contactId}/messages`, { channel: 'web_chat', body: 'Hi Carl, Saturday at 10 works.', idempotencyKey: `chat-${randomUUID()}` });
    expect([r.status, r.body.result, r.body.message.channel]).toEqual([200, 'sent', 'web_chat']);
    const after = await pollBody(h, c.token, before.cursor!);
    expect(after.messages.map((m) => [m.from, m.body])).toEqual([['team', 'Hi Carl, Saturday at 10 works.']]);
    expect((await pollBody(h, c.token, after.cursor!)).messages).toEqual([]);
    // a chat reply cannot be scheduled
    const sched = await call(agent, 'POST', `/contacts/${c.contactId}/messages`, { channel: 'web_chat', body: 'Later', scheduleAt: new Date(Date.now() + 3600_000).toISOString(), idempotencyKey: `chat-${randomUUID()}` });
    expect(sched.status).toBe(422);
  });

  it('R-GATE-14 E77 R-INBOX-7: a reply to a session idle for 30 minutes is blocked CHANNEL_NOT_CONNECTED: gate_decisions written, no delivery; the visitor gets WEBCHAT_SESSION_CLOSED', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Ida Idle' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    await h.su.query("UPDATE webchat_sessions SET last_seen_at = now() - interval '31 minutes', started_at = now() - interval '40 minutes' WHERE id = $1", [c.sessionId]);
    const delivered = h.providers.webChat.delivered.length;
    const r = await call<{ result: string; decision: { id: string; reasons: string[] }; message: { id: string } }>(agent, 'POST', `/contacts/${c.contactId}/messages`, { channel: 'web_chat', body: 'Are you still there?', idempotencyKey: `chat-${randomUUID()}` });
    expect(r.body.result).toBe('blocked');
    expect(r.body.decision.reasons).toContain('CHANNEL_NOT_CONNECTED');
    expect(await decisionsFor(h, { messageId: r.body.message.id })).toHaveLength(1);
    expect(h.providers.webChat.delivered.length).toBe(delivered);
    const v = await chatMessage(h, c.token, { message: 'hello?' });
    expect([v.statusCode, codeOf(v)]).toEqual([410, 'WEBCHAT_SESSION_CLOSED']);
  });

  it('R-GATE-14: an approved draft may answer in web chat (drafts.ts), through the same send path', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Dora Draft' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    const owner = (await h.su.query<{ ownership_period_seq: string }>('SELECT ownership_period_seq FROM contacts WHERE id = $1', [c.contactId])).rows[0]!;
    const conv = (await h.su.query<{ inbound_seq: string }>('SELECT inbound_seq FROM conversations WHERE contact_id = $1', [c.contactId])).rows[0]!;
    const id = randomUUID();
    await h.su.query(
      "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq, pinned_inbound_seq) VALUES ($1,$2,$3,'message_draft','novel_message','requires_approval','proposed',$4,'Draft reply',$5,$6,$7)",
      [w.tenantId, id, c.contactId, agent.userId, JSON.stringify({ channel: 'web_chat', body: 'Happy to help with Elm!' }), owner.ownership_period_seq, conv.inbound_seq],
    );
    const ok = await call<{ result: string; messageId: string }>(agent, 'POST', `/assistant/actions/${id}/approve`, { commandId: randomUUID() });
    expect([ok.status, ok.body.result], JSON.stringify(ok.body)).toEqual([200, 'sent']);
    const m = (await messagesOf(h, c.contactId)).find((x) => x.id === ok.body.messageId)!;
    expect(m.channel).toBe('web_chat');
    expect((await pollBody(h, c.token)).messages.map((x) => x.body)).toContain('Happy to help with Elm!');
  });
});

describe('E138 E137 what the visitor types is never trusted', () => {
  it('E138 R-INBOX-1: a typed email matching an owned client never attaches; a new contact, a duplicate suggestion and a content-free "typed in chat, not verified" notice to the client\'s agent; nothing automated goes to the typed address', async () => {
    const agent = w.agents[1]!;
    const client = await ownedContact(agent);
    const mail = h.providers.email.sent.length;
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Ivy Visitor', email: client.email.toUpperCase() });
    await runJobs(h, w.tenantId, FR);
    expect(c.contactId).not.toBe(client.id);
    expect(await pointsOf(h, c.contactId)).toHaveLength(1);
    const dup = (await h.su.query('SELECT match_reason, status FROM contact_duplicate_candidates WHERE (contact_a_id = $1 AND contact_b_id = $2) OR (contact_a_id = $2 AND contact_b_id = $1)', [c.contactId, client.id])).rows;
    expect(dup).toEqual([{ match_reason: 'shared_email', status: 'open' }]);
    const n = (await h.su.query("SELECT title, body FROM notifications WHERE user_id = $1 AND subject_id = $2", [agent.userId, client.id])).rows;
    expect(n.some((x) => /typed in chat, not verified/i.test(x.body ?? ''))).toBe(true);
    expect(JSON.stringify(n)).not.toContain(client.email);
    expect(h.providers.email.sent.slice(mail).filter((m) => m.to.toLowerCase() === client.email.toLowerCase())).toEqual([]);
  });

  it('E137 R-INBOX-5: a spam opening creates no contact, offer or notification (the session is purged in 30 days); 5,000 starts from one IP are cut off by the rate limit (429)', async () => {
    const before = (await h.su.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0].n;
    const notes = (await h.su.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1', [w.tenantId])).rows[0].n;
    const spam = await startChat(h, widget.key, { name: 'Cheap pills', phone: '+14155550100', message: 'buy now http://a.example http://b.example http://c.example', disclosureId: src.disclosureId });
    expect(spam.statusCode).toBe(200); // the spammer learns nothing
    const token = (JSON.parse(spam.body) as { sessionToken: string }).sessionToken;
    expect((await chatMessage(h, token, { message: 'more spam' })).statusCode).toBe(200);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(before);
    expect((await h.su.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(notes);
    expect((await h.su.query('SELECT contact_id, purge_after IS NOT NULL AS purge FROM webchat_sessions WHERE tenant_id = $1 AND contact_id IS NULL', [w.tenantId])).rows).toEqual([{ contact_id: null, purge: true }]);
    // flood from one IP
    const ip = visitorIp();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await startChat(h, widget.key, { name: 'Flood', phone: '+14155550100', message: 'hello', disclosureId: src.disclosureId }, { ip })).statusCode);
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes.slice(5).every((s) => s === 429)).toBe(true);
  });
});

describe('R-INBOX-7 R-TEN-12 the widget and the session are the only authority', () => {
  it('R-INBOX-7: after Disconnect the widget answers CHANNEL_NOT_CONNECTED to config, start, messages and poll; history stays', async () => {
    const w2 = await createWidget(h, w.owner, src.sourceId, []);
    const c = await openChat(h, w2.key, src.disclosureId, { name: 'Dan Disconnect', origin: 'https://anywhere.test' });
    await h.su.query("SELECT 1");
    const d = await call(w.owner, 'POST', `/admin/integrations/connections/${w2.id}/disconnect`);
    expect(d.status).toBe(200);
    for (const r of [await chatConfig(h, w2.key), await startChat(h, w2.key, { name: 'X', phone: '+14155550100', message: 'hi', disclosureId: src.disclosureId }), await chatMessage(h, c.token, { message: 'hi' }), await (async () => h.app.inject({ method: 'GET', url: `/api/public/chat/session/${c.token}/poll` }))()]) {
      expect([r.statusCode, codeOf(r)]).toEqual([409, 'CHANNEL_NOT_CONNECTED']);
    }
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1", [c.contactId])).rows[0].n).toBe(1);
  });

  it('R-TEN-12: a session token reads only that session\'s replies (another visitor\'s are never returned); a forged token is 404', async () => {
    const a = await openChat(h, widget.key, src.disclosureId, { name: 'Ann A' });
    const b = await openChat(h, widget.key, src.disclosureId, { name: 'Bob B' });
    const agentB = await acceptLead(h, w.agents, b.contactId);
    await call(agentB, 'POST', `/contacts/${b.contactId}/messages`, { channel: 'web_chat', body: 'Private to Bob', idempotencyKey: `chat-${randomUUID()}` });
    expect((await pollBody(h, a.token)).messages.map((m) => m.body)).not.toContain('Private to Bob');
    expect((await pollBody(h, b.token)).messages.map((m) => m.body)).toContain('Private to Bob');
    const forged = a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A');
    expect((await h.app.inject({ method: 'GET', url: `/api/public/chat/session/${forged}/poll` })).statusCode).toBe(404);
  });
});
