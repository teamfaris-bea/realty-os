// The feed card's channel hint reads the send gate's opt-out fan-out (R-PAR-12, R-CONSENT-7, outbound-3):
// an opt-out on a phone the agent then removed still blocks texting (calling) the person's other phone, so the
// card never shows a channel as available while the composer and the send gate refuse it. A phone removed as a
// confirmed wrong number is outside the fan-out, exactly as in comms/repos/gate.ts optOutFanoutPhoneHmacs.
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { optOutFanoutPhoneHmacs } from '../comms/repos/gate.js';
import { intake } from '../leads/testing.js';
import { type AssistantWorld, assistantWorld, call, inboundSms, randomEmail, randomPhone } from '../assistant/testing.js';
import { randomUUID } from 'node:crypto';
import { acceptLead, chatMessage, chatSource, createWidget, openChat, SITE } from '../channels/testing.js';
import { gateSummaries } from './repos/feedInputs.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

async function person(name: string): Promise<{ contactId: string; first: string; second: string; firstId: string }> {
  const [first, second] = [randomPhone(), randomPhone()];
  const r = await intake(h, w, { fullName: name, phones: [first, second], emails: [randomEmail()] });
  const firstId = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [r.contactId, first])).rows[0]!.id;
  return { contactId: r.contactId, first, second, firstId };
}
const revoke = async (contactId: string, pointId: string, channel: 'sms' | 'voice') =>
  expect((await call(w.owner, 'POST', `/contacts/${contactId}/consent`, { kind: 'revoke', pointId, channel, purpose: 'all', evidence: { note: 'asked us to stop' } })).status).toBe(200);
const remove = async (contactId: string, pointId: string, reason: string) =>
  expect((await call(w.owner, 'POST', `/contacts/${contactId}/points/${pointId}/remove`, { reason })).status).toBe(200);
const hint = (contactId: string) =>
  withTenantTx(w.owner.actor(), async (tx) => (await gateSummaries(tx, [contactId])).get(contactId as never) ?? {}, { db: h.database });
const fanout = (contactId: string) => withTenantTx(w.owner.actor(), (tx) => optOutFanoutPhoneHmacs(tx, contactId), { db: h.database });

describe('feed channel hint = the send gate\'s opt-out fan-out (R-PAR-12)', () => {
  it('R-PAR-12 a STOP on a phone that was then removed blocks texting on the card, as the gate does', async () => {
    const p = await person('Hana Hint');
    await revoke(p.contactId, p.firstId, 'sms');
    await remove(p.contactId, p.firstId, 'old');
    // the gate: the removed phone is in the fan-out, so the remaining phone is denied
    expect(await fanout(p.contactId)).toHaveLength(2);
    const g = await hint(p.contactId);
    expect(g.sms).toEqual({ outcome: 'deny', explanation: 'Opted out of texts' });
    expect(g.voice).toBeUndefined(); // calling the live phone is still allowed
    expect(g.email).toBeUndefined();
  });

  it('R-PAR-12 outbound-3 a "do not call me" on a removed phone blocks calling the other phone on the card', async () => {
    const p = await person('Vic Voice');
    await revoke(p.contactId, p.firstId, 'voice');
    await remove(p.contactId, p.firstId, 'old');
    const g = await hint(p.contactId);
    expect(g.voice).toEqual({ outcome: 'deny', explanation: 'Asked not to be called' });
    expect(g.sms).toBeUndefined();
  });

  it('R-PAR-12 a phone removed as a confirmed wrong number is outside the fan-out: its STOP does not block the person', async () => {
    // one phone texts STOP and then "Wrong number" (a recorded wrong-number report), a second phone is added
    // afterwards, and the first is removed as a confirmed wrong number (the reachability test's E169 shape)
    const first = randomPhone();
    const r = await intake(h, w, { fullName: 'Wren Wrong', phones: [first], emails: [randomEmail()] });
    const p = { contactId: r.contactId };
    expect((await inboundSms(h, first, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await inboundSms(h, first, w.mainNumber, 'Wrong number')).statusCode).toBe(200);
    expect((await call(w.owner, 'POST', `/contacts/${p.contactId}/points`, { kind: 'phone', address: randomPhone(), label: 'work' })).status).toBe(201);
    const gone = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [p.contactId, first])).rows[0]!.id;
    await remove(p.contactId, gone, 'wrong_number');
    expect(await fanout(p.contactId)).toHaveLength(1);
    const g = await hint(p.contactId);
    expect(g.sms).toBeUndefined();
  });
});

describe('the person-level do-not-contact on the card hint (R-CHAN-2, review optouts/F1 of batch 6)', () => {
  it('R-CHAN-2: a phone and an email added after the person asked not to be contacted carry no revoke of their own; the hint blocks texts, calls, email and the website chat with the person-level reason, as the send gate does', async () => {
    const r = await intake(h, w, { fullName: 'Dana Decline', phones: [], emails: [randomEmail()] });
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/points`, { kind: 'phone', address: randomPhone(), label: 'mobile' })).status).toBe(201);
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/points`, { kind: 'email', address: randomEmail(), label: 'other' })).status).toBe(201);
    const dnc = { outcome: 'deny', explanation: 'Asked not to be contacted at all' };
    expect(await hint(r.contactId)).toEqual({ sms: dnc, voice: dnc, email: dnc, web_chat: dnc });
  });

  it('review optouts/F1, chat-R3 of batch 6: an opt-out in the website chat blocks a reply in the chat only (the person did not ask about every channel), said by its source', async () => {
    const src = await chatSource(h, w.owner, w.tenantId, 'Website chat (hint)');
    const widget = await createWidget(h, w.owner, src.sourceId, [SITE]);
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Wes Wrong', email: randomEmail() });
    expect((await chatMessage(h, c.token, { message: 'Sorry, wrong person', clientMessageId: randomUUID() })).statusCode).toBe(200);
    expect(await hint(c.contactId)).toMatchObject({ web_chat: { outcome: 'deny', explanation: 'Marked as a wrong number' } });
    expect((await hint(c.contactId)).sms).toEqual({ outcome: 'unavailable', explanation: 'No working phone number' });
  });
});

describe('a website-chat lead on the feed (finding UXA-3)', () => {
  it('its chat identity (contact_points kind web_chat) is never read as an email address: a chat-only lead has no email, phone or text on the card, and no Email action', async () => {
    const src = await chatSource(h, w.owner, w.tenantId);
    const widget = await createWidget(h, w.owner, src.sourceId, [SITE]);
    const c = await openChat(h, widget.key, src.disclosureId, { name: 'Omar Diaz', email: randomEmail() });
    expect((await h.su.query('SELECT kind FROM contact_points WHERE contact_id = $1', [c.contactId])).rows).toEqual([{ kind: 'web_chat' }]);
    expect(await hint(c.contactId)).toEqual({
      sms: { outcome: 'unavailable', explanation: 'No working phone number' },
      voice: { outcome: 'unavailable', explanation: 'No working phone number' },
      email: { outcome: 'unavailable', explanation: 'No email address' },
    });
    // the agent's feed: the chat is where to answer
    const agent = await acceptLead(h, w.agents, c.contactId);
    type Card = { contact: { id: string } | null; primaryAction: { kind: string }; alternatives: { kind: string }[]; reasons: { label: string }[] };
    const feed = await call<{ pinned: Card[]; scored: Card[] }>(agent, 'GET', '/feed');
    const cards = [...feed.body.pinned, ...feed.body.scored].filter((x) => x.contact?.id === c.contactId);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect([card.primaryAction.kind, ...card.alternatives.map((a) => a.kind)]).not.toContain('email');
      expect(card.primaryAction.kind).toBe('reply_chat');
      expect(card.reasons.map((r) => r.label).join(' ')).not.toMatch(/They texted/);
    }
  });
});
