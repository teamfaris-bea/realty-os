// A website chat follows a person merge (R-OWN-24, R-INBOX-1, E138, E140; review findings optouts/F2,
// tenancy-public/F1, ui-compose/F2 of batch 6).
//
// A merge copies the loser's chat identity onto the survivor under a new id (0027 app.contacts_merge_children), and
// the visitor's next messages already land on the survivor (inbound resolves the identity's address over live
// records). The session itself stayed on the merged-away record and its original point, so every reply path, which
// finds a chat through the session's point (chatRoutes), found none on the survivor (422 CONTACT_POINT_MISSING), the
// merged-away record refused (409 CONTACT_MERGED), and the visitor's still-open chat could never be answered; the
// claim the visitor typed was read only from the record the session named, so it vanished from the survivor, and a
// returning visitor who typed it again was suggested as nobody's duplicate. Migration 0046 moves the loser's
// sessions to the survivor and its copy of the same chat identity in the merge transaction itself. Real Postgres,
// the real server, fake providers only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call, ownedContact, randomEmail } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth } from '../leads/testing.js';
import { acceptLead, chatMessage, chatSource, createWidget, openChat, pollBody } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let src: { sourceId: string; disclosureId: string };
let widget: { id: string; key: string };

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await assistantWorld(h, { agents: 2 });
  src = await chatSource(h, w.owner, w.tenantId);
  widget = await createWidget(h, w.owner, src.sourceId);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface ChatEntry {
  hasAddress: boolean;
  defaultPointId: string | null;
  blocked: boolean;
  session: { open: boolean; widgetConnected: boolean } | null;
}
const chatOf = async (c: TestClient, id: string): Promise<ChatEntry> => {
  const r = await call<{ reachability: { channels: { web_chat: ChatEntry } } }>(c, 'GET', `/contacts/${id}/reachability`);
  expect(r.status).toBe(200);
  return r.body.reachability.channels.web_chat;
};
const reply = (c: TestClient, id: string, body: string) =>
  call<{ result: string; message: { status: string } | null }>(c, 'POST', `/contacts/${id}/messages`, { channel: 'web_chat', body, idempotencyKey: `k-${randomUUID()}` });
const ownerOf = async (id: string) => (await h.su.query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM contacts WHERE id = $1', [id])).rows[0]!.owner_user_id;
const sessionRow = async (sessionId: string) => (await h.su.query<{ contact_id: string; contact_point_id: string }>('SELECT contact_id, contact_point_id FROM webchat_sessions WHERE id = $1', [sessionId])).rows[0]!;
const chatPoints = async (contactId: string) => (await h.su.query<{ id: string; address: string }>("SELECT id, address FROM contact_points WHERE contact_id = $1 AND kind = 'web_chat' ORDER BY created_at, id", [contactId])).rows;

/** The Owner merges `loser` into `survivor` (the survivor's owner keeps the person when both are owned). */
async function merge(survivor: string, loser: string): Promise<void> {
  const [s, l] = [await ownerOf(survivor), await ownerOf(loser)];
  await freshReauth(h, w.owner);
  const m = await command(w.owner, survivor, 'merge', { loserId: loser, ...(s && l && s !== l ? { ownerChoice: s } : {}) });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
}

describe('a website chat follows a person merge (R-OWN-24)', () => {
  it('R-OWN-24 E138 E140 R-INBOX-1: a chat lead merged into the person its typed email matched (the suggested, earlier record survives): the survivor answers the open chat and the visitor reads it; the merged-away record shows no chat and takes nothing new', async () => {
    const client = await ownedContact(w.agents[0]!);
    const chat = await openChat(h, widget.key, src.disclosureId, { name: 'Ivy Visitor', email: client.email });
    await acceptLead(h, w.agents, chat.contactId);
    expect((await h.su.query("SELECT status FROM contact_duplicate_candidates WHERE contact_a_id = LEAST($1::uuid, $2::uuid) AND contact_b_id = GREATEST($1::uuid, $2::uuid)", [client.id, chat.contactId])).rows).toEqual([{ status: 'open' }]);
    const before = (await chatPoints(chat.contactId))[0]!;
    await merge(client.id, chat.contactId);

    // the session now names the survivor and its copy of the very same chat identity
    const copy = (await chatPoints(client.id)).find((p) => p.address === before.address)!;
    expect(copy.id).not.toBe(before.id);
    expect(await sessionRow(chat.sessionId)).toEqual({ contact_id: client.id, contact_point_id: copy.id });

    // the survivor's summary has the open chat, and a reply in it goes out to the visitor
    const agent = w.agents[0]!;
    expect(await chatOf(agent, client.id)).toMatchObject({ hasAddress: true, defaultPointId: copy.id, blocked: false, session: { open: true, widgetConnected: true } });
    const sent = await reply(agent, client.id, 'Hi Ivy, yes, it is still available.');
    expect([sent.status, sent.body.result], JSON.stringify(sent.body)).toEqual([200, 'sent']);
    expect((await pollBody(h, chat.token)).messages.map((m) => [m.from, m.body])).toContainEqual(['team', 'Hi Ivy, yes, it is still available.']);
    // the visitor's next message lands on the survivor, in the same chat
    expect((await chatMessage(h, chat.token, { message: 'Great, can I see it Saturday?', clientMessageId: randomUUID() })).statusCode).toBe(200);
    expect((await h.su.query("SELECT contact_id FROM messages WHERE direction = 'inbound' AND channel = 'web_chat' AND body = 'Great, can I see it Saturday?'")).rows).toEqual([{ contact_id: client.id }]);

    // the feed's Reply on the survivor: the card offers the chat, and the summary it is judged by says it is open
    type Card = { contact: { id: string } | null; primaryAction: { kind: string } };
    const feed = await call<{ pinned: Card[]; scored: Card[] }>(agent, 'GET', '/feed');
    const card = [...feed.body.pinned, ...feed.body.scored].find((c) => c.contact?.id === client.id);
    expect(card?.primaryAction.kind).toBe('reply_chat');

    // the merged-away record: no chat on its summary (nothing there could answer it), and nothing new addressed to it
    expect(await chatOf(w.owner, chat.contactId)).toMatchObject({ hasAddress: false, defaultPointId: null, session: null });
    const refused = await reply(w.owner, chat.contactId, 'Hello?');
    expect([refused.status, refused.code]).toEqual([409, 'CONTACT_MERGED']);
  });

  it('R-OWN-24 R-INBOX-1 (finding UXA-5): what the visitor typed stays with the person after a merge, and a returning visitor who types it again is suggested as a duplicate of the survivor', async () => {
    const typed = randomEmail();
    const chat = await openChat(h, widget.key, src.disclosureId, { name: 'Sam Rivera', email: typed });
    await acceptLead(h, w.agents, chat.contactId);
    // the agent knows Sam from a call: a contact of their own, with another email, merged with the chat lead by hand
    const known = await ownedContact(w.agents[1]!, { confirmDistinct: true, firstName: 'Sam' });
    await merge(known.id, chat.contactId);
    type Full = { contact: { typedInChat?: { kind: string; address: string }[] } };
    const view = await call<Full>(w.agents[1]!, 'GET', `/contacts/${known.id}`);
    expect(view.status).toBe(200);
    expect(view.body.contact.typedInChat).toEqual([expect.objectContaining({ kind: 'email', address: typed })]);
    // the same visitor comes back under another name and types the same email: a duplicate of the survivor
    const again = await openChat(h, widget.key, src.disclosureId, { name: 'S. Rivera', email: typed.toUpperCase() });
    const dup = (await h.su.query('SELECT match_reason, status FROM contact_duplicate_candidates WHERE contact_a_id = LEAST($1::uuid, $2::uuid) AND contact_b_id = GREATEST($1::uuid, $2::uuid)', [known.id, again.contactId])).rows;
    expect(dup).toEqual([{ match_reason: 'shared_email', status: 'open' }]);
  });

  it('R-OWN-24 (finding UXA-5): two chat leads of one visitor, the earlier one surviving: a reply goes to the chat the visitor is in now, never to the survivor\'s own chat that ended', async () => {
    const typed = randomEmail();
    const first = await openChat(h, widget.key, src.disclosureId, { name: 'Pat Earlier', email: typed });
    await acceptLead(h, w.agents, first.contactId);
    // clock fixture: the first visit ended (the visitor was last seen 2 hours ago); no application path moves time
    await h.su.query("UPDATE webchat_sessions SET started_at = now() - interval '3 hours', last_seen_at = now() - interval '2 hours' WHERE id = $1", [first.sessionId]);
    const second = await openChat(h, widget.key, src.disclosureId, { name: 'Pat Later', email: typed });
    await acceptLead(h, w.agents, second.contactId);
    const laterIdentity = (await chatPoints(second.contactId))[0]!.address;
    await merge(first.contactId, second.contactId);
    expect((await sessionRow(second.sessionId)).contact_id).toBe(first.contactId);
    const ownerId = await ownerOf(first.contactId);
    const agent = w.agents.find((a) => a.userId === ownerId)!;
    const sent = await reply(agent, first.contactId, 'Hi Pat, I am here.');
    expect([sent.status, sent.body.result], JSON.stringify(sent.body)).toEqual([200, 'sent']);
    expect((await pollBody(h, second.token)).messages.map((m) => m.body)).toContain('Hi Pat, I am here.');
    // it went to the identity of the chat the visitor is in, not to the survivor's own (ended) one
    expect((await h.su.query("SELECT to_address FROM messages WHERE direction = 'outbound' AND body = 'Hi Pat, I am here.'")).rows).toEqual([{ to_address: laterIdentity }]);
  });
});
