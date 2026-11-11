// Module 37 (web/inbox) in jsdom: a web-chat conversation and a text in one thread with their channel tags
// (R-INBOX-1), compose on the client's last open channel and why it is on another, a reply to a chat that
// ended (E77, R-INBOX-7), opt-outs never offered and always explained (D1, R-PAR-12), and the assistant's
// web-chat first response shown as automatic (R-INBOX-4). Web chat is offered from the reachability summary's
// web_chat entry (module 22); its sends go through compose/channelApi.ts on the real routes, answered here with
// the responses the real API sends (compose/channelApi.contract.test.tsx checks those against the API's schemas).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, chatEndedReply, decision, draftAction, findToast, fullContact, iso, reachability, stopReason, timelineItem } from '../feed/lib/testing.js';
import { lastInboundChannel, liveChat } from './ThreadPage.js';

const user = () => userEvent.setup();
const ids = (n: number) => `01900000-0000-7000-8000-0000000e${String(5600 + n).padStart(4, '0')}`;

/** Newest first, as GET /contacts/:id/timeline returns them. */
function chatThenText() {
  return [
    timelineItem({ id: ids(4), detail: 'web_chat:inbound', preview: 'Is the open house still on?', occurredAt: iso(-60_000) }),
    timelineItem({ id: ids(3), detail: 'web_chat:outbound', preview: 'Hi Jane, this is the Harbor team assistant. Ava will reply shortly.', occurredAt: iso(-120_000), actor: null }),
    timelineItem({ id: ids(2), type: 'call', detail: 'outbound:completed', preview: 'connected', occurredAt: iso(-3_600_000), actor: { userId: IDS.me, displayName: 'Ava Agent' } }),
    timelineItem({ id: ids(1), detail: 'email:inbound', preview: 'Sending the pre-approval letter', occurredAt: iso(-7_200_000) }),
    timelineItem({ id: ids(0), detail: 'sms:inbound', preview: 'does saturday work?', occurredAt: iso(-86_400_000) }),
  ];
}

function fake(items = chatThenText()) {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items, nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, (c) => ({ status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: (c.body as { body: string }).body } }));
}

/** The summary as module 22's API sends it: texts and email open, and the website chat as given. */
const summary = (chat: Parameters<typeof reachability>[2], blocks: Parameters<typeof reachability>[1] = {}) => ({ status: 200, body: { reachability: reachability(IDS.jane, blocks, chat) } });

const chatSent = { status: 200, body: { message: { id: IDS.message, channel: 'web_chat', status: 'sent', statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor: null, dispatchedAt: iso(0) }, decision: decision({}), result: 'sent' } };

describe('module 37: one thread, every channel tagged', () => {
  it('R-INBOX-1: a web-chat conversation, an email, a call and a text appear in one thread, oldest first, each with its channel tag', async () => {
    agentApp(fake(), `/contacts/${IDS.jane}/thread`);
    const convo = await screen.findByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(within(convo).getAllByRole('listitem').length).toBe(5));
    const tags = [...convo.querySelectorAll('[data-channel-tag]')].map((e) => e.textContent);
    expect(tags).toEqual(['SMS', 'Email', 'Call', 'Web chat', 'Web chat']);
    const rows = within(convo).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('does saturday work?');
    expect(rows[3]).toContain('Harbor team assistant');
    expect(rows[4]).toContain('Is the open house still on?');
  });

  it('R-INBOX-4: the assistant\'s 60-second web-chat first response is tagged Web chat and labelled "Sent automatically", never as a person', async () => {
    agentApp(fake(), `/contacts/${IDS.jane}/thread`);
    const convo = await screen.findByRole('list', { name: 'Conversation' });
    const row = await within(convo).findByText(/Harbor team assistant/);
    const li = row.closest('li')!;
    expect(li.textContent).toContain('Web chat');
    expect(li.textContent).toContain('Sent automatically');
    expect(li.textContent).not.toContain('Ava Agent');
  });

  it('a reply refused because the chat had ended says so in words, never as sent', async () => {
    const items = [timelineItem({ id: ids(9), detail: 'web_chat:outbound', preview: 'Yes, 10 to 12', status: 'blocked', statusReason: 'CHANNEL_NOT_CONNECTED', actor: { userId: IDS.me, displayName: 'Ava Agent' }, occurredAt: iso(-30_000) }), ...chatThenText()];
    agentApp(fake(items), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Not sent: the chat had ended')).toBeInTheDocument();
  });

  it('a channel this app does not know is tagged only "Message"; nothing names Messenger or Instagram (D2)', async () => {
    const items = [timelineItem({ id: ids(8), detail: 'messenger:inbound', preview: 'hello', occurredAt: iso(-10_000) })];
    agentApp(fake(items), `/contacts/${IDS.jane}/thread`);
    const convo = await screen.findByRole('list', { name: 'Conversation' });
    await within(convo).findByText('hello');
    expect([...convo.querySelectorAll('[data-channel-tag]')].map((e) => e.textContent)).toEqual(['Message']);
    expect(document.body.textContent).not.toMatch(/messenger|instagram|facebook/i);
  });

  it('the thread refreshes quickly only while a web chat is recent, from the server; the last inbound channel is the client\'s latest message', () => {
    const now = Date.now();
    expect(liveChat(chatThenText(), now)).toBe(true);
    expect(liveChat(chatThenText(), now + 31 * 60_000)).toBe(false);
    expect(liveChat([timelineItem({ detail: 'sms:inbound', occurredAt: iso(0) })], now)).toBe(false);
    expect(lastInboundChannel(chatThenText())).toBe('web_chat');
    expect(lastInboundChannel(chatThenText().slice(2))).toBe('email');
    expect(lastInboundChannel([timelineItem({ detail: 'mms:inbound' })])).toBe('sms');
    expect(lastInboundChannel([timelineItem({ detail: 'sms:outbound' })])).toBeNull();
  });
});

describe('module 37: compose on the client\'s last open channel', () => {
  it('opens on web chat while the chat is open and Jane wrote last there, and says so; Send posts a web-chat reply with one idempotency key, previewed like a text', async () => {
    const f = fake().on(`GET /contacts/${IDS.jane}/reachability`, summary('open')).on(`POST /contacts/${IDS.jane}/messages`, (_c, n) => (n === 1 ? 'network-error' : chatSent));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    const radio = await screen.findByRole('radio', { name: 'Web chat' });
    await waitFor(() => expect(radio).toBeChecked());
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Replying in web chat, where Jane wrote last.');
    // Text and Email stay offered: nothing blocks them
    expect(screen.getByRole('radio', { name: 'Text' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeEnabled();
    // no scheduling a chat reply, and no window copy (D2)
    expect(screen.queryByRole('button', { name: 'Send later' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/window|24 hours|24-hour/i);
    await user().type(screen.getByRole('textbox', { name: 'Web chat message' }), 'Yes, 10 to 12');
    // the box previews the real text on web chat (module 22's preview route), exactly as for a text
    await waitFor(() => expect(f.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).map((c) => c.body)).toContainEqual({ channel: 'web_chat', body: 'Yes, 10 to 12' }));
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    const calls = f.callsTo(`POST /contacts/${IDS.jane}/messages`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ channel: 'web_chat', body: 'Yes, 10 to 12' });
    expect((calls[1]!.body as { idempotencyKey: string }).idempotencyKey).toBe((calls[0]!.body as { idempotencyKey: string }).idempotencyKey);
    expect(calls[0]!.body).not.toHaveProperty('scheduleAt');
  });

  it('opened from a Text tap, the box texts and says where Jane wrote last', async () => {
    agentApp(fake(), `/contacts/${IDS.jane}/thread?compose=sms`);
    const text = await screen.findByRole('radio', { name: 'Text' });
    await waitFor(() => expect(text).toBeChecked());
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Jane wrote last in web chat.');
  });

  it('E77 R-INBOX-7: a reply to a chat that ended since the summary was read is not sent; the text stays, Web chat is no longer offered and says why, and the box moves to text', async () => {
    const f = fake().on(`GET /contacts/${IDS.jane}/reachability`, summary('open')).on(`POST /contacts/${IDS.jane}/messages`, chatEndedReply('Yes, 10 to 12'));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    const chat = await screen.findByRole('radio', { name: 'Web chat' });
    await waitFor(() => expect(chat).toBeChecked());
    const box = screen.getByRole('textbox', { name: 'Web chat message' });
    await user().type(box, 'Yes, 10 to 12');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent: the chat has ended \(Jane left the page, or the chat was turned off\)\. Your text is still here\. Send now sends it by text\./)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Web chat' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Web chat' })).toHaveAccessibleDescription(/^Web chat not offered: The chat has ended/);
    expect(screen.getByRole('radio', { name: 'Text' })).toBeChecked();
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing by text: the web chat has ended.');
    expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('Yes, 10 to 12');
    // nothing was sent by text on the agent's behalf
    expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`).every((c) => (c.body as { channel: string }).channel === 'web_chat')).toBe(true);
  });

  it('F1: a reply whose answer was lost (a dropped connection, a 502) and whose automatic retry came back as the API\'s replay ("noop", the blocked message) is never shown as sent: the chat ended, the text stays', async () => {
    const replay = chatEndedReply('Yes, 10 to 12');
    // what the API answers the same idempotency key again: the stored message, result noop (with or without its decision)
    for (const decisionOnReplay of [null, replay.body.decision]) {
      const f = fake().on(`GET /contacts/${IDS.jane}/reachability`, summary('open')).on(`POST /contacts/${IDS.jane}/messages`, (_c, n) => (n === 1 ? 'network-error' : { status: 200, body: { ...replay.body, decision: decisionOnReplay, result: 'noop' } }));
      const view = agentApp(f, `/contacts/${IDS.jane}/thread`);
      const chat = await screen.findByRole('radio', { name: 'Web chat' });
      await waitFor(() => expect(chat).toBeChecked());
      await user().type(screen.getByRole('textbox', { name: 'Web chat message' }), 'Yes, 10 to 12');
      await user().click(screen.getByRole('button', { name: 'Send' }));
      expect(await screen.findByText(/Not sent: the chat has ended/)).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('Yes, 10 to 12');
      expect(screen.getByTestId('toast').textContent ?? '').not.toContain('Sent to Jane.');
      expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(2);
      view.view.unmount();
    }
  });

  it('F1: a web-chat draft approved twice for one tap (the answer was lost) reports what the first approval did: the chat had ended, nothing was sent; the next tap sends the agent\'s own text, never a re-approval', async () => {
    const draft = draftAction({ draft: { channel: 'web_chat', subject: null, body: 'Happy to help with Elm!' } });
    const ended = decision({ id: '01900000-0000-7000-8000-0000000d0001', outcome: 'deny', reasons: ['CHANNEL_NOT_CONNECTED'], explanation: 'The chat has ended, so this was not sent.' });
    const f = fake()
      .on(`GET /contacts/${IDS.jane}/reachability`, summary('open'))
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draft } })
      // the API's replay of the same commandId: result noop, the stored decision and the message's status (module 22)
      .on(`POST /assistant/actions/${IDS.draft}/approve`, (_c, n) => (n === 1 ? 'network-error' : { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'noop', messageId: IDS.message, decision: ended, messageStatus: 'blocked' } }))
      .on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: { id: '01900000-0000-7000-8000-0000000e5577', channel: 'sms', status: 'sent', statusReason: null, purpose: 'informational', body: 'Happy to help with Elm!', subject: null, scheduledFor: null, dispatchedAt: iso(0) }, decision: decision({}), result: 'sent' } });
    agentApp(f, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const box = await screen.findByRole('textbox', { name: 'Web chat message' });
    await waitFor(() => expect(box).toHaveValue('Happy to help with Elm!'));
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent: the chat has ended .*Send now sends it by text\./)).toBeInTheDocument();
    expect(screen.getByTestId('toast').textContent ?? '').not.toContain('Sent to Jane.');
    expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveValue('Happy to help with Elm!');
    // "Send now sends it by text": a new message of the agent's own, on text
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    expect(f.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(2);
    expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`).map((c) => c.body)).toEqual([expect.objectContaining({ channel: 'sms', body: 'Happy to help with Elm!' })]);
  });

  it('E77 R-INBOX-7: before anyone types, the summary says the chat ended or was turned off: Web chat is shown closed with that reason, and the box writes by text and says why', async () => {
    for (const [chat, reason, left] of [
      ['ended', 'The chat has ended: they left the page', 'the web chat has ended'],
      ['off', 'The website chat was turned off', 'the website chat was turned off'],
    ] as const) {
      const f = fake().on(`GET /contacts/${IDS.jane}/reachability`, summary(chat));
      const view = agentApp(f, `/contacts/${IDS.jane}/thread`);
      const web = await screen.findByRole('radio', { name: 'Web chat' });
      await waitFor(() => expect(web).toBeDisabled());
      expect(web).toHaveAccessibleDescription(`Web chat not offered: ${reason}`);
      expect(screen.getByRole('radio', { name: 'Text' })).toBeChecked();
      expect(screen.getByTestId('channel-why')).toHaveTextContent(`Writing by text: ${left}.`);
      // nothing was sent and no chat preview was asked for
      expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
      expect(f.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).filter((c) => (c.body as { channel: string }).channel === 'web_chat')).toEqual([]);
      view.view.unmount();
    }
  });

  it('E155 R-CHAN-3: after "stop contacting me" in the chat the summary blocks the chat with that opt-out, in words', async () => {
    const said = stopReason({ source: 'opt_out_language', keyword: null, addressHint: 'web chat' });
    agentApp(fake().on(`GET /contacts/${IDS.jane}/reachability`, summary({ reasons: [said] })), `/contacts/${IDS.jane}/thread`);
    const web = await screen.findByRole('radio', { name: 'Web chat' });
    await waitFor(() => expect(web).toBeDisabled());
    expect(web).toHaveAccessibleDescription('Web chat not offered: Asked in the chat to stop being contacted on Nov 10');
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing by text: web chat is blocked.');
  });

  it('a lead who only ever chatted, once the chat ended, has nothing to write on: the reason is shown and Send stays disabled', async () => {
    const chatOnly = fullContact({ phones: [], emails: [] });
    const f = new FakeFetch()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: chatOnly } })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: chatThenText().slice(0, 2), nextCursor: null } })
      .on(`GET /contacts/${IDS.jane}/reachability`, summary('ended'));
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('The chat has ended: they left the page')).toBeInTheDocument();
    await user().type(screen.getByRole('textbox', { name: 'Web chat message' }), 'Hello?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
  });

  it('no web chat is offered when the summary says there is no chat to reply to, whatever the thread shows', async () => {
    agentApp(fake().on(`GET /contacts/${IDS.jane}/reachability`, summary('none')), `/contacts/${IDS.jane}/thread`);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Email' })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'Web chat' })).toBeNull());
  });

  it('D1: Jane texted last but texting is blocked: the box writes by email, says why, and Text shows the exact reason', async () => {
    const items = [timelineItem({ detail: 'sms:inbound', preview: 'STOP', occurredAt: iso(-60_000) })];
    agentApp(fake(items).on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } }), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing by email: texting is blocked.');
  });

  it('R-PAR-12 E168: a STOP from a phone the agent removed still blocks texting; the box never offers Text and names the removed number', async () => {
    const removed = stopReason({ otherAddress: true, addressHint: '•••-•••-0199', addressRemoved: true });
    agentApp(fake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [removed] }) } }), `/contacts/${IDS.jane}/thread?compose=sms`);
    const text = await screen.findByRole('radio', { name: 'Text' });
    await waitFor(() => expect(text).toBeDisabled());
    expect(text).toHaveAccessibleDescription('Text not offered: Texted STOP from •••‑•••‑0199 (removed number) on Nov 10');
    // the box moves to the last channel Jane wrote on that is still open, and says why it left Text
    expect(screen.getByRole('radio', { name: 'Web chat' })).toBeChecked();
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing in web chat: texting is blocked.');
  });

  it('D1: with every channel blocked, nothing is offered: each reason is shown and Send stays disabled', async () => {
    const items = [timelineItem({ detail: 'sms:inbound', occurredAt: iso(-60_000) })];
    const unsub = stopReason({ source: 'unsubscribe', keyword: null, addressHint: 'j•••@example.com' });
    const f = fake(items).on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()], email: [unsub] }) } });
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Unsubscribed from email on Nov 10')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText('Texted STOP on Nov 10')).toBeInTheDocument();
    await user().type(screen.getByRole('textbox', { name: 'Text message' }), 'Hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(f.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
    expect(f.callsTo(`POST /contacts/${IDS.jane}/messages/preview`)).toEqual([]);
  });
});
