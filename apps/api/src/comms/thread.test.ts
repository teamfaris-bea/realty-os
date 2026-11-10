// What the thread says about messages that did not simply go out (lane optout-visibility items 3 and 4):
// the timeline carries messages.status_reason, the provider error code and, for a blocked message, the
// opt-out the send-time decision rested on (as it was at that moment); a message held because the
// client replied (E27) can be sent anyway or canceled by its sender, both audited, and Send anyway is
// still checked at send time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, messageRow, ownedContact, runJobs, sendText, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

interface Item {
  id: string;
  type: string;
  status: string | null;
  statusReason: string | null;
  providerErrorCode: string | null;
  blockedBy: { code: string; source: string; keyword: string | null; at: string | null; evidence: { inboundMessageId: string | null; consentEventId: string | null } } | null;
}
const timeline = async (c: typeof w.agents[0], id: string) => (await call<{ items: Item[] }>(c, 'GET', `/contacts/${id}/timeline?limit=100`)).body.items;
const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);

async function scheduleThenReply(agent: typeof w.agents[0], c: { id: string; phone: string }, reply: string): Promise<string> {
  const r = await sendText(agent, c.id, 'Following up on the house', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
  expect((await inboundSms(h, c.phone, w.mainNumber, reply)).statusCode).toBe(200);
  await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
  await runJobs(h, w.tenantId, ['comms.dispatch']);
  return r.body.message!.id;
}

describe('the thread says why a message did not go out', () => {
  it('R-CONSENT-7: a text tried after STOP is blocked, and the thread names the STOP (keyword, date, inbound message) even after the person texts START again', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const stopMsg = (await h.su.query<{ id: string }>("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1", [c.id])).rows[0]!.id;
    const r = await sendText(agent, c.id, 'Are you still looking?');
    expect(r.body.result).toBe('blocked');
    const item = (await timeline(agent, c.id)).find((i) => i.id === r.body.message!.id)!;
    expect(item).toMatchObject({ status: 'blocked', statusReason: 'CONSENT_REVOKED', blockedBy: { code: 'CONSENT_REVOKED', source: 'keyword', keyword: 'STOP' } });
    expect(item.blockedBy!.evidence.inboundMessageId).toBe(stopMsg);
    // START restores texting; the old blocked message still says what blocked it at the time
    expect((await inboundSms(h, c.phone, w.mainNumber, 'START')).statusCode).toBe(200);
    const again = (await timeline(agent, c.id)).find((i) => i.id === r.body.message!.id)!;
    expect(again.blockedBy).toMatchObject({ source: 'keyword', keyword: 'STOP' });
    // non-message items carry no status fields
    for (const i of await timeline(agent, c.id)) if (i.type !== 'message') expect([i.statusReason, i.providerErrorCode, i.blockedBy]).toEqual([null, null, null]);
  });

  it('a text the carrier did not deliver carries its status reason and the provider error code', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Hello from the team');
    expect(r.body.result).toBe('sent');
    const ref = (await messageRow(h, r.body.message!.id)).provider_message_ref!;
    expect((await telephonyWebhook(h, `/webhooks/telephony/status?m=${r.body.message!.id}`, { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '30007', From: w.mainNumber, To: c.phone })).statusCode).toBe(200);
    const item = (await timeline(agent, c.id)).find((i) => i.id === r.body.message!.id)!;
    expect(item).toMatchObject({ status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', providerErrorCode: '30007', blockedBy: null });
  });
});

describe('E27 held messages: Send anyway and Cancel', () => {
  it('E27: a scheduled text held because the client replied shows as held in the thread; Send anyway sends it and is audited', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await scheduleThenReply(agent, c, 'We found a place actually');
    expect((await timeline(agent, c.id)).find((i) => i.id === id)).toMatchObject({ status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    expect(smsTo(c.phone)).toHaveLength(0);
    // only the sender can act on it (another agent does not even see it)
    expect((await call(w.agents[1]!, 'POST', `/messages/${id}/send`, {})).status).toBe(404);
    const re = await call<{ result: string }>(agent, 'POST', `/messages/${id}/send`, {});
    expect(re.body.result).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(1);
    const a = (await h.su.query("SELECT actor_user_id, reason, changes FROM audit_log WHERE tenant_id = $1 AND action = 'message.held_send' AND entity_id = $2", [w.tenantId, id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_user_id: agent.userId, reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    expect(JSON.stringify(a[0].changes)).not.toContain('Following up');
  });

  it('E27: Cancel on a held message cancels it, sends nothing, and is audited', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await scheduleThenReply(agent, c, 'Call me instead');
    const r = await call<{ message: { status: string; statusReason: string } }>(agent, 'POST', `/messages/${id}/cancel`, {});
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ status: 'canceled', statusReason: 'CANCELED_BY_SENDER' });
    expect(smsTo(c.phone)).toHaveLength(0);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'message.held_cancel' AND entity_id = $2 AND actor_user_id = $3", [w.tenantId, id, agent.userId])).rows).toHaveLength(1);
    expect((await call(agent, 'POST', `/messages/${id}/send`, {})).body).toMatchObject({ error: { code: 'MESSAGE_NOT_SENDABLE' } });
  });

  it('E27 R-CONSENT-10: when the reply was STOP, the held message is canceled with the opt-out, and Send anyway can never send it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await scheduleThenReply(agent, c, 'STOP');
    const m = await messageRow(h, id);
    expect(['canceled', 'blocked']).toContain(m.status);
    const re = await call<{ result?: string; error?: { code: string } }>(agent, 'POST', `/messages/${id}/send`, {});
    expect(re.body.result === 'blocked' || re.body.error?.code === 'MESSAGE_NOT_SENDABLE').toBe(true);
    expect(smsTo(c.phone).filter((s) => s.body.includes('Following up'))).toHaveLength(0);
  });
});
