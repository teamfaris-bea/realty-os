// The web_chat entry of the reachability summary (GET /contacts/:id/reachability, GET /reachability; module 22,
// R-INBOX-7, E77, E155, R-CHAN-3). It says, before anyone types, whether a reply in the contact's website chat can
// go out now: the chat identity a reply goes to (the one compose picks: the open session's first), whether that
// session is still open (the visitor was seen in the last 30 minutes) and its widget connected, the opt-outs on
// the chat identities and the person-level do-not-contact (R-CHAN-2, also one a merge carried; review optouts/F1 of
// batch 6). Every summary here is compared with the send-time gate for the same contact at the same moment (the
// compose preview on channel web_chat, and on texts and email: the same canContact as the send, nothing stored),
// reason for reason: every reason the preview gives but the chat's session (check 10, the `session` facts) must be
// one the summary names, so the summary can never offer a chat the send would refuse, or the reverse. Fakes only:
// nothing leaves the process.
import { randomUUID } from 'node:crypto';
import { REACHABILITY_REASONS } from '@realty/core/compliance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call, inboundSms, ownedContact, randomEmail, randomPhone } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth } from '../leads/testing.js';
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
  // fixture: one agent takes every chat lead of this file (none is contacted, so the default cap of 5 would send the
  // later ones to the pond)
  await h.su.query('UPDATE tenant_settings SET uncontacted_capacity_cap = 50 WHERE tenant_id = $1', [w.tenantId]);
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
interface Entry {
  hasAddress: boolean;
  defaultPointId: string | null;
  blocked: boolean;
  reasons: Reason[];
}
interface Reach {
  contactId: string;
  purposeNow: 'marketing' | 'informational';
  /** the person-level do-not-contact (R-CHAN-2), the evidence of the reason every channel carries */
  doNotContact: (Reason & { at: string | null }) | null;
  channels: { sms: Entry; email: Entry; voice: Entry; web_chat: ChatReach };
}

const PREDICTED = new Set<string>(REACHABILITY_REASONS);
const reach = async (c: TestClient, id: string) => {
  const r = await call<{ reachability: Reach }>(c, 'GET', `/contacts/${id}/reachability`);
  expect(r.status).toBe(200);
  return r.body.reachability;
};
/** Every reason of a preview a summary must name: all of them but the chat's session (check 10); each a predicted one. */
const fullSet = (reasons: readonly string[]): string[] => {
  const out = reasons.filter((x) => x !== 'CHANNEL_NOT_CONNECTED').sort();
  for (const x of out) expect(PREDICTED.has(x), `${x} is a reason no summary names`).toBe(true);
  return out;
};

/** The web_chat entry agrees with the send-time gate: every reason the send gives, and CHANNEL_NOT_CONNECTED. */
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
  const predicted = fullSet(p.body.decision.reasons);
  const notConnected = p.body.decision.reasons.includes('CHANNEL_NOT_CONNECTED');
  expect(wc.reasons.map((x) => x.code).sort()).toEqual(predicted);
  expect(wc.session !== null && wc.session.open && wc.session.widgetConnected).toBe(!notConnected);
  expect(wc.blocked).toBe(predicted.length > 0 || notConnected);
  return wc;
}

/** The texts or email entry agrees with the send-time gate in the same way (the compose preview on that channel). */
async function expectChannelAgrees(agent: TestClient, contactId: string, ch: 'sms' | 'email'): Promise<Entry> {
  const e = (await reach(agent, contactId)).channels[ch];
  expect(e.hasAddress, ch).toBe(true);
  const p = await call<{ decision: { reasons: string[] } }>(agent, 'POST', `/contacts/${contactId}/messages/preview`, { channel: ch, body: 'Checking in about the house.', ...(ch === 'email' ? { subject: 'The house' } : {}) });
  expect(p.status).toBe(200);
  const predicted = fullSet(p.body.decision.reasons);
  expect(e.reasons.map((x) => x.code).sort(), ch).toEqual(predicted);
  expect(e.blocked, ch).toBe(predicted.length > 0);
  return e;
}

const ownerOf = async (id: string) => (await h.su.query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM contacts WHERE id = $1', [id])).rows[0]!.owner_user_id;
/** The Owner merges `loser` into `survivor` (the survivor's owner keeps the person when both are owned). */
async function merge(survivor: string, loser: string): Promise<void> {
  const [s, l] = [await ownerOf(survivor), await ownerOf(loser)];
  await freshReauth(h, w.owner);
  const m = await command(w.owner, survivor, 'merge', { loserId: loser, ...(s && l && s !== l ? { ownerChoice: s } : {}) });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
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
    // the language set the person-level do-not-contact and revoked the chat: both are said, the person first
    expect(wc.reasons).toEqual([expect.objectContaining({ code: 'PERSON_DO_NOT_CONTACT', source: 'opt_out_language' }), expect.objectContaining({ code: 'CONSENT_REVOKED', source: 'opt_out_language' })]);
    expect(wc.points[0]).toMatchObject({ blocked: true, addressHint: 'Website chat' });
  });

  it('E155 R-CHAN-3 R-CHAN-2 (review optouts/F1): "please stop contacting me" in the chat of a lead the agent has a phone and an email for: texts and email are blocked by the person-level do-not-contact too, as the send does, never only the chat', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Pia Phone', message: 'Hi, I had a question about Oak Ave' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    expect((await call(agent, 'POST', `/contacts/${c.contactId}/points`, { kind: 'phone', address: randomPhone(), label: 'mobile' })).status).toBe(201);
    expect((await call(agent, 'POST', `/contacts/${c.contactId}/points`, { kind: 'email', address: randomEmail(), label: 'other' })).status).toBe(201);
    expect((await chatMessage(h, c.token, { message: 'Please stop contacting me', clientMessageId: randomUUID() })).statusCode).toBe(200);
    for (const ch of ['sms', 'email'] as const) {
      const e = await expectChannelAgrees(agent, c.contactId, ch);
      expect(e.reasons.map((r) => r.code), ch).toEqual(['PERSON_DO_NOT_CONTACT']);
    }
    expect((await expectChatAgrees(agent, c.contactId)).reasons.map((r) => r.code)).toEqual(['PERSON_DO_NOT_CONTACT', 'CONSENT_REVOKED']);
    // the summary names the do-not-contact itself, with its evidence (the language event in the chat)
    expect((await reach(agent, c.contactId)).doNotContact).toMatchObject({ code: 'PERSON_DO_NOT_CONTACT', source: 'opt_out_language', at: expect.any(String), evidence: { consentEventId: expect.any(String) } });
  });

  it('R-CHAN-3 R-CHAN-2 (review optouts/F1): "please stop texting me" from a phone added to a chat lead sets the person-level do-not-contact: the chat is blocked by it as well, as the send does', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Tess Text' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    const phone = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${c.contactId}/points`, { kind: 'phone', address: phone, label: 'mobile' })).status).toBe(201);
    expect((await inboundSms(h, phone, w.mainNumber, 'Please stop texting me')).statusCode).toBe(200);
    const wc = await expectChatAgrees(agent, c.contactId);
    expect(wc).toMatchObject({ blocked: true, session: { open: true, widgetConnected: true } });
    // the language named texts: the chat carries no revoke of its own, only the person's do-not-contact
    expect(wc.reasons.map((r) => r.code)).toEqual(['PERSON_DO_NOT_CONTACT']);
    expect((await expectChannelAgrees(agent, c.contactId, 'sms')).blocked).toBe(true);
  });

  it('R-CHAN-2 E140 (review optouts/F1): a duplicate that asked not to be contacted, merged into a chat lead: the chat lead\'s open chat is blocked by the do-not-contact the merge carried, as the send does, and its feed card offers no Reply', async () => {
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Dee Duplicate' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    const dup = await ownedContact(agent, { consent: false, confirmDistinct: true, firstName: 'Dee' });
    expect((await call(agent, 'POST', `/contacts/${dup.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    await merge(c.contactId, dup.id);
    const wc = await expectChatAgrees(agent, c.contactId);
    expect(wc).toMatchObject({ blocked: true, session: { open: true, widgetConnected: true } });
    expect(wc.reasons.map((r) => r.code)).toEqual(['PERSON_DO_NOT_CONTACT']);
    expect((await reach(agent, c.contactId)).doNotContact).toMatchObject({ code: 'PERSON_DO_NOT_CONTACT', source: 'agent_recorded' });
    for (const ch of ['sms', 'email'] as const) expect((await expectChannelAgrees(agent, c.contactId, ch)).reasons.map((r) => r.code)[0], ch).toBe('PERSON_DO_NOT_CONTACT');
    // the feed: no Reply in the chat, "can't reach them" with the reason, the contact to open
    type Card = { contact: { id: string } | null; primaryAction: { kind: string }; alternatives: { kind: string }[]; reasons: { code: string; label: string }[] };
    const feed = await call<{ pinned: Card[]; scored: Card[] }>(agent, 'GET', '/feed');
    const cards = [...feed.body.pinned, ...feed.body.scored].filter((x) => x.contact?.id === c.contactId);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect([card.primaryAction.kind, ...card.alternatives.map((a) => a.kind)]).not.toContain('reply_chat');
      expect(card.reasons.find((r) => r.code === 'CANT_CONTACT')?.label).toBe("Can't reach them right now: Asked not to be contacted at all");
    }
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
