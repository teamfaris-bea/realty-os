// The web_chat entry of the reachability summary (GET /contacts/:id/reachability, GET /reachability; module 22,
// R-INBOX-7, E77, E155, R-CHAN-3). It says, before anyone types, whether a reply in the contact's website chat can
// go out now: the chat identity a reply goes to (the one compose picks: the open session's first), whether that
// session is still open (the visitor was seen in the last 30 minutes) and its widget connected, and the opt-outs on
// the chat identities. Every summary here is compared with the send-time gate for the same contact at the same
// moment (the compose preview on channel web_chat: the same canContact as the send, nothing stored), so the summary
// can never offer a chat the send would refuse, or the reverse. Fakes only: nothing leaves the process.
import { randomUUID } from 'node:crypto';
import { REACHABILITY_REASONS } from '@realty/core/compliance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call, ownedContact } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { acceptLead, chatMessage, chatSource, createWidget, openChat } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let src: { sourceId: string; disclosureId: string };
let widget: { id: string; key: string };

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await assistantWorld(h, { agents: 1 });
  src = await chatSource(h, w.owner, w.tenantId);
  widget = await createWidget(h, w.owner, src.sourceId);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface Reason {
  code: string;
  source: string;
  purposes: string[];
  addressHint: string | null;
}
interface ChatReach {
  hasAddress: boolean;
  defaultPointId: string | null;
  blocked: boolean;
  reasons: Reason[];
  points: { pointId: string; addressHint: string; blocked: boolean; reasons: Reason[] }[];
  session: { open: boolean; widgetConnected: boolean } | null;
}
interface Reach {
  contactId: string;
  purposeNow: 'marketing' | 'informational';
  channels: { sms: { hasAddress: boolean }; email: { hasAddress: boolean }; voice: { hasAddress: boolean }; web_chat: ChatReach };
}

const PREDICTED = new Set<string>(REACHABILITY_REASONS);
const reach = async (c: TestClient, id: string) => {
  const r = await call<{ reachability: Reach }>(c, 'GET', `/contacts/${id}/reachability`);
  expect(r.status).toBe(200);
  return r.body.reachability;
};

/** The web_chat entry agrees with the send-time gate: the opt-out reasons it predicts, and CHANNEL_NOT_CONNECTED. */
async function expectChatAgrees(agent: TestClient, contactId: string): Promise<ChatReach> {
  const wc = (await reach(agent, contactId)).channels.web_chat;
  const p = await call<{ decision: { reasons: string[] } }>(agent, 'POST', `/contacts/${contactId}/messages/preview`, { channel: 'web_chat', body: 'Checking in about the house.' });
  if (!wc.hasAddress) {
    // no chat to reply to: the preview has nothing to check either
    expect([p.status, p.code]).toEqual([422, 'CONTACT_POINT_MISSING']);
    expect(wc).toMatchObject({ defaultPointId: null, blocked: false, reasons: [], session: null });
    return wc;
  }
  expect(p.status).toBe(200);
  const predicted = p.body.decision.reasons.filter((x) => PREDICTED.has(x)).sort();
  const notConnected = p.body.decision.reasons.includes('CHANNEL_NOT_CONNECTED');
  expect(wc.reasons.map((x) => x.code).sort()).toEqual(predicted);
  expect(wc.session !== null && wc.session.open && wc.session.widgetConnected).toBe(!notConnected);
  expect(wc.blocked).toBe(predicted.length > 0 || notConnected);
  return wc;
}

describe('the web_chat entry of the reachability summary agrees with the send-time gate', () => {
  it('a contact who never wrote in website chat has no chat: nothing to offer, nothing blocked', async () => {
    const c = await ownedContact(w.agents[0]!);
    const wc = await expectChatAgrees(w.agents[0]!, c.id);
    expect(wc).toEqual({ hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [], session: null });
  });

  it('R-INBOX-7 E77: an open chat can be answered; once the visitor has been gone 30 minutes the summary says the session ended, exactly when the send would be refused CHANNEL_NOT_CONNECTED', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Olive Open' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    const open = await expectChatAgrees(agent, c.contactId);
    expect(open).toMatchObject({ hasAddress: true, blocked: false, reasons: [], session: { open: true, widgetConnected: true } });
    // the identity a reply goes to is the session's own chat identity, never anything the visitor typed
    const point = (await h.su.query<{ id: string }>('SELECT contact_point_id AS id FROM webchat_sessions WHERE id = $1', [c.sessionId])).rows[0]!;
    expect(open.defaultPointId).toBe(point.id);
    expect(open.points).toEqual([{ pointId: point.id, addressHint: 'Website chat', blocked: false, reasons: [] }]);
    // clock fixture: the visitor was last seen 31 minutes ago (no application path moves time)
    await h.su.query("UPDATE webchat_sessions SET last_seen_at = now() - interval '31 minutes', started_at = now() - interval '40 minutes' WHERE id = $1", [c.sessionId]);
    const idle = await expectChatAgrees(agent, c.contactId);
    expect(idle).toMatchObject({ hasAddress: true, blocked: true, reasons: [], session: { open: false, widgetConnected: true } });
  });

  it('R-INBOX-7: after the widget is disconnected its chats cannot be answered, and the summary says the widget is off', async () => {
    const w2 = await createWidget(h, w.owner, src.sourceId);
    const c = await openChat(h, w2.key, src.disclosureId, { name: 'Dee Disconnect' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    expect((await expectChatAgrees(agent, c.contactId)).blocked).toBe(false);
    expect((await call(w.owner, 'POST', `/admin/integrations/connections/${w2.id}/disconnect`)).status).toBe(200);
    const off = await expectChatAgrees(agent, c.contactId);
    expect(off).toMatchObject({ hasAddress: true, blocked: true, session: { open: true, widgetConnected: false } });
  });

  it('E155 R-CHAN-3: after "please stop contacting me" in the chat, the chat is blocked by that opt-out, with its source, as the send would be', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Sam Stop', message: 'Hi, I had a question about Elm St' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    expect((await chatMessage(h, c.token, { message: 'Please stop contacting me', clientMessageId: randomUUID() })).statusCode).toBe(200);
    const wc = await expectChatAgrees(agent, c.contactId);
    expect(wc.blocked).toBe(true);
    expect(wc.session).toEqual({ open: true, widgetConnected: true });
    expect(wc.reasons).toEqual([expect.objectContaining({ code: 'CONSENT_REVOKED', source: 'opt_out_language' })]);
    expect(wc.points[0]).toMatchObject({ blocked: true, addressHint: 'Website chat' });
  });

  it('the feed batch (GET /reachability) carries the same web_chat entry as the single route, and no summary names the chat identity itself', async () => {
    const a = await openChat(h, widget.key, src.disclosureId, { name: 'Bea Batch' });
    const agent = await acceptLead(h, w.agents, a.contactId);
    const plain = await ownedContact(agent);
    const many = await call<{ reachability: Reach[] }>(agent, 'GET', `/reachability?contactIds=${a.contactId},${plain.id}`);
    expect(many.status).toBe(200);
    const byId = new Map(many.body.reachability.map((r) => [r.contactId, r]));
    for (const id of [a.contactId, plain.id]) expect(byId.get(id)).toEqual(await reach(agent, id));
    expect(byId.get(a.contactId)!.channels.web_chat.session).toEqual({ open: true, widgetConnected: true });
    const addr = (await h.su.query<{ address: string }>("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'web_chat'", [a.contactId])).rows[0]!.address;
    expect(addr).toMatch(/^wc:[0-9a-f]{32}$/);
    expect(JSON.stringify(many.body)).not.toContain(addr.slice(3));
  });
});
