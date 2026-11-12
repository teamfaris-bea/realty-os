// Thread + compose in jsdom: human sends with one idempotency key per tap (retries reuse it), the
// inline send check in the server's words (shown as soon as the box opens), the send-time outcome as
// it came back (sent, scheduled for the agent's time, blocked with the reason; never "send anyway"),
// assistant drafts approved as is or edited, the stale-draft re-review (R-AST-6) and an invalidated
// draft (nothing sent; the text stays).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, findToast, IDS, agentApp, decision, draftAction, err, fullContact, iso, reachability, stopReason, timelineItem } from '../feed/lib/testing.js';

const user = () => userEvent.setup();

function threadFake(items = [timelineItem()]) {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items, nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: '' } });
}

const sent = (over: Record<string, unknown> = {}) => ({ status: 200, body: { message: { id: IDS.message, channel: 'sms', status: 'sent', statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor: null, dispatchedAt: iso(0) }, decision: decision({}), result: 'sent', ...over } });

describe('Thread', () => {
  it('shows texts oldest first and labels outbound messages no person sent as "Sent automatically"', async () => {
    const items = [
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5503', detail: 'sms:outbound', preview: 'Thanks! Jane, this is the Harbor team assistant.', occurredAt: iso(-60_000), actor: null }),
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5502', detail: 'sms:outbound', preview: 'Hi Jane, it is Ava.', occurredAt: iso(-300_000), actor: { userId: IDS.me, displayName: 'Ava Agent' } }),
      timelineItem({ occurredAt: iso(-600_000) }),
    ];
    agentApp(threadFake(items), `/contacts/${IDS.jane}/thread`);
    const convo = await screen.findByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(within(convo).getAllByRole('listitem').length).toBe(3));
    const rows = within(convo).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('does saturday work?');
    expect(rows[1]).toContain('Ava Agent');
    expect(rows[2]).toContain('Sent automatically');
  });

  it('a human text carries one idempotency key; an automatic retry after a dropped connection reuses it', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, (_c, n) => (n === 1 ? 'network-error' : sent()));
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await u.type(box, 'On my way');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    const calls = fake.callsTo(`POST /contacts/${IDS.jane}/messages`);
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_:.-]{8,100}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(calls[0]!.body).toMatchObject({ channel: 'sms', body: 'On my way' });
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('F1: a text whose answer was lost and whose retry came back as the API\'s replay of a send the gate blocked ("noop", the blocked message) says Not sent and keeps the text; a replay of one that went out says Sent', async () => {
    const blocked = { id: IDS.message, channel: 'sms', status: 'blocked', statusReason: 'CONSENT_REVOKED', purpose: 'informational', body: 'On my way', subject: null, scheduledFor: null, dispatchedAt: null };
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, (_c, n) => (n === 1 ? 'network-error' : { status: 200, body: { message: blocked, decision: null, result: 'noop' } }));
    const view = agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await user().type(box, 'On my way');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not sent.')).toBeInTheDocument();
    expect(box).toHaveValue('On my way');
    expect(screen.getByTestId('toast').textContent ?? '').not.toContain('Sent to Jane.');
    view.view.unmount();
    // the replay of a text that did go out is the sent message: that is said, and the box clears
    const ok = threadFake().on(`POST /contacts/${IDS.jane}/messages`, (_c, n) => (n === 1 ? 'network-error' : { ...sent(), body: { ...sent().body, decision: null, result: 'noop' } }));
    agentApp(ok, `/contacts/${IDS.jane}/thread?compose=sms`);
    const again = await screen.findByRole('textbox', { name: 'Text message' });
    await user().type(again, 'See you at 11');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    await waitFor(() => expect(again).toHaveValue(''));
  });

  it('the inline gate preview shows the server sentence before sending (e.g. a shared number that opted out)', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview', outcome: 'deny', explanation: 'This number opted out of texts on Nov 3' }), body: '' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    await user().type(await screen.findByRole('textbox', { name: 'Text message' }), 'Hello');
    expect(await screen.findByText('This number opted out of texts on Nov 3')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'sms', body: 'Hello' });
  });

  it('the box shows the text exactly as it will go out when the send adds to it (the brokerage line on a marketing text); nothing extra when it is the typed text', async () => {
    let reply = 'Open house Saturday!\n— Harbor Realty LLC';
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages/preview`, () => ({ status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: reply } }));
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await user().type(box, 'Open house Saturday!');
    const final = await screen.findByRole('figure', { name: 'What Jane will get' });
    // exactly the server's rendering, line break and brokerage line included
    expect(final.querySelector('p')!.textContent).toBe('Open house Saturday!\n— Harbor Realty LLC');
    // an informational text goes out as typed: nothing extra is shown
    reply = 'See you at 11';
    await user().clear(box);
    await user().type(box, 'See you at 11');
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'sms', body: 'See you at 11' }));
    await waitFor(() => expect(screen.queryByRole('figure', { name: 'What Jane will get' })).toBeNull());
  });

  it('R-CONSENT-7: an opt-out is said as soon as the box opens, in exact words, from the reachability summary (no stand-in preview); with no other channel, Send stays disabled for it', async () => {
    const fake = threadFake()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ emails: [] }) } })
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    await user().type(screen.getByRole('textbox', { name: 'Text message' }), 'Saturday?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription('Texted STOP on Nov 10');
    // nothing is previewed for a channel that is blocked anyway, and nothing ever previews a stand-in text
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`)).toEqual([]);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
  });

  it('D1: opened to text a person who texted STOP, the box never offers Text: the option is disabled with the exact reason, and it writes by email and says why', async () => {
    const fake = threadFake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    const text = screen.getByRole('radio', { name: 'Text' });
    expect(text).toBeDisabled();
    expect(text).toHaveAccessibleDescription('Text not offered: Texted STOP on Nov 10');
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing by email: texting is blocked.');
    await user().type(screen.getByRole('textbox', { name: 'Email message' }), 'Saturday?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'email', body: 'Saturday?' }));
    // never a stand-in text, and never anything previewed or sent on the blocked channel
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).every((c) => (c.body as { channel: string; body: string }).channel === 'email' && (c.body as { body: string }).body !== 'Hi')).toBe(true);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
  });

  it('D1: blocked on both text and email, the box writes on the channel it was opened on and says why that one is blocked; Send stays disabled', async () => {
    const unsubscribed = stopReason({ source: 'unsubscribe', keyword: null, addressHint: 'j•••@example.test' });
    const both = () =>
      threadFake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()], email: [unsubscribed] }) } });
    // opened from Email: the email box, with the unsubscribe as its reason (never only the texting reason)
    const fake = both();
    const { view } = agentApp(fake, `/contacts/${IDS.jane}/thread?compose=email`);
    await user().type(await screen.findByRole('textbox', { name: 'Email message' }), 'Saturday?');
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(/^Unsubscribed from email/);
    expect(screen.getByRole('radio', { name: 'Text' })).toHaveAccessibleDescription('Text not offered: Texted STOP on Nov 10');
    // review ui-compose/F9: the checked, disabled option of the box's own channel is described too, by an element that exists
    expect(screen.getByRole('radio', { name: 'Email' })).toHaveAccessibleDescription(/^Unsubscribed from email/);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`)).toEqual([]);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toEqual([]);
    view.unmount();
    // opened from Text: the text box, with the STOP as its reason
    agentApp(both(), `/contacts/${IDS.jane}/thread?compose=sms`);
    await user().type(await screen.findByRole('textbox', { name: 'Text message' }), 'Saturday?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription('Texted STOP on Nov 10');
  });

  it('D1 (review ui-compose/F4, F9): Edit of an email draft (?compose=draft) for a person blocked on text and email opens the Email box with the draft\'s subject, never the Text box; Send and the checked Email option both say why', async () => {
    const unsubscribed = stopReason({ source: 'unsubscribe', keyword: null, addressHint: 'j•••@example.test' });
    const emailDraft = draftAction({ draft: { channel: 'email', subject: 'Saturday showing', body: 'Hi Jane, Saturday at 11 works.' } });
    const fake = threadFake()
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()], email: [unsubscribed] }) } })
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: emailDraft } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const box = await screen.findByRole('textbox', { name: 'Email message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works.'));
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Saturday showing');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(/^Unsubscribed from email/);
    expect(screen.getByRole('radio', { name: 'Email' })).toHaveAccessibleDescription(/^Unsubscribed from email/);
    expect(screen.getByRole('radio', { name: 'Text' })).toHaveAccessibleDescription('Text not offered: Texted STOP on Nov 10');
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toEqual([]);
  });

  it('an allowed send shows no badge, no consent question and no quiet-hours wait', async () => {
    agentApp(threadFake(), `/contacts/${IDS.jane}/thread?compose=sms`);
    await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(document.querySelector('[data-gate-outcome]')).toBeNull());
    expect(document.body.textContent).not.toMatch(/consent|quiet hours|contact hours|send anyway/i);
  });

  it('a send scheduled for a time the agent picked says when it goes out, in words', async () => {
    const until = '2026-11-11T17:00:00.000Z';
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, sent({ result: 'scheduled', decision: null, message: { id: IDS.message, channel: 'sms', status: 'scheduled', statusReason: null, purpose: 'informational', body: 'x', subject: null, scheduledFor: until, dispatchedAt: null } }));
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    await u.type(await screen.findByRole('textbox', { name: 'Text message' }), 'Tomorrow?');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    // while the fixed instant is still in the future (wall clock), the thread also lists the scheduled message with
    // the same words, so more than one element may match: the compose status must be among them
    expect((await screen.findAllByText(/^Sends Wed, Nov 11, \d{1,2}:00 (AM|PM)\.$/, undefined, { timeout: 5000 })).length).toBeGreaterThanOrEqual(1);
  });

  it('a send the gate blocks keeps the text and shows why', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: null, decision: decision({ outcome: 'deny', explanation: 'Opted out of texts' }), result: 'not_created' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await u.type(box, 'Hi');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Opted out of texts')).toBeInTheDocument();
    expect(screen.getByText(/Not sent:/)).toBeInTheDocument();
    expect(box).toHaveValue('Hi');
    expect(screen.queryByRole('button', { name: /anyway/ })).toBeNull();
  });

  it('review ui-compose/F9: after a send the gate blocked, when the refreshed summary now blocks the channel, every aria-describedby of the box still points at an element on the page', async () => {
    let stopped = false;
    // a phone only: once texting is blocked there is no other channel, so the box stays on Text
    const fake = threadFake()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ emails: [] }) } })
      .on(`GET /contacts/${IDS.jane}/reachability`, () => ({ status: 200, body: { reachability: reachability(IDS.jane, stopped ? { sms: [stopReason()] } : {}) } }))
      .on(`POST /contacts/${IDS.jane}/messages`, () => {
        stopped = true; // Jane's STOP landed while the agent was typing: the send is refused and the summary asked again
        return { status: 200, body: { message: null, decision: decision({ outcome: 'deny', explanation: 'Opted out of texts' }), result: 'not_created' } };
      });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    await u.type(await screen.findByRole('textbox', { name: 'Text message' }), 'Hi');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent:/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    const form = screen.getByRole('form', { name: 'Message Jane Doe' });
    for (const el of form.querySelectorAll('[aria-describedby]')) {
      for (const ref of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) expect(document.getElementById(ref), `${el.outerHTML.slice(0, 80)} -> #${ref}`).not.toBeNull();
    }
  });

  it('when the preview already said why and the send is blocked, the reason is shown once, not twice', async () => {
    const deny = decision({ id: null, phase: 'preview', outcome: 'deny', explanation: 'Opted out of texts' });
    const fake = threadFake()
      .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: deny, body: '' } })
      .on(`POST /contacts/${IDS.jane}/messages`, { status: 200, body: { message: null, decision: decision({ outcome: 'deny', explanation: 'Opted out of texts' }), result: 'not_created' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    await u.type(await screen.findByRole('textbox', { name: 'Text message' }), 'Hi');
    expect(await screen.findByText('Opted out of texts')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText('Opted out of texts')).toHaveLength(1));
  });

  it('an outbound text the send-time check blocked is never drawn as sent: the thread says it was not sent', async () => {
    const items = [
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5504', detail: 'sms:outbound', preview: 'Hi Jane, still looking?', occurredAt: iso(-60_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'blocked' }),
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5505', detail: 'sms:outbound', preview: 'See you Saturday', occurredAt: iso(-30_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'sent' }),
    ];
    agentApp(threadFake(items), `/contacts/${IDS.jane}/thread`);
    const convo = await screen.findByRole('list', { name: 'Conversation' });
    await waitFor(() => expect(within(convo).getAllByRole('listitem').length).toBe(2));
    const rows = within(convo).getAllByRole('listitem').map((li) => li.textContent ?? '');
    const blocked = rows.find((r) => r.includes('still looking'))!;
    const ok = rows.find((r) => r.includes('See you Saturday'))!;
    expect(blocked).toContain('Not sent: blocked by a sending rule');
    expect(ok).not.toMatch(/Not sent|Not delivered/);
  });

  it('the thread says exactly why: "Not sent: texted STOP on Nov 10", "Not delivered: the carrier rejected it"', async () => {
    const items = [
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5506', detail: 'sms:outbound', preview: 'Still looking?', occurredAt: iso(-60_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'blocked', statusReason: 'CONSENT_REVOKED', blockedBy: stopReason() }),
      timelineItem({ id: '01900000-0000-7000-8000-0000000e5507', detail: 'sms:outbound', preview: 'Open house Sunday', occurredAt: iso(-30_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', providerErrorCode: '30008' }),
    ];
    agentApp(threadFake(items), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Not sent: texted STOP on Nov 10')).toBeInTheDocument();
    expect(screen.getByText('Not delivered: the carrier rejected it')).toBeInTheDocument();
  });

  it('E27: a message held because Jane replied says so, and its sender can Send anyway or Cancel', async () => {
    const held = timelineItem({ id: '01900000-0000-7000-8000-0000000e5508', detail: 'sms:outbound', preview: 'See you at 10', occurredAt: iso(-60_000), actor: { userId: IDS.me, displayName: 'Ava Agent' }, status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    const fake = threadFake([held])
      .on(`POST /messages/${held.id}/send`, sent())
      .on(`POST /messages/${held.id}/cancel`, { status: 200, body: { message: { id: held.id, channel: 'sms', status: 'canceled', statusReason: 'CANCELED_BY_SENDER', purpose: null, body: 'x', subject: null, scheduledFor: null, dispatchedAt: null } } });
    agentApp(fake, `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Held because Jane replied')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Held message' });
    await user().click(within(group).getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => expect(fake.callsTo(`POST /messages/${held.id}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /messages/${held.id}/send`)[0]!.body).toEqual({});
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    await user().click(within(group).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fake.callsTo(`POST /messages/${held.id}/cancel`)).toHaveLength(1));
  });

  it('E27: someone else\'s held message offers no actions, and says who can', async () => {
    const held = timelineItem({ id: '01900000-0000-7000-8000-0000000e5509', detail: 'sms:outbound', preview: 'See you at 10', occurredAt: iso(-60_000), actor: { userId: IDS.pat, displayName: 'Ben Agent' }, status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    agentApp(threadFake([held]), `/contacts/${IDS.jane}/thread`);
    expect(await screen.findByText('Held because Jane replied')).toBeInTheDocument();
    expect(screen.getByText('Only Ben Agent can send or cancel it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
  });

  it('an edited assistant draft is approved with the edited text', async () => {
    const fake = threadFake()
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    await u.clear(box);
    await u.type(box, 'Hi Jane, Saturday at noon works.');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)[0]!.body).toMatchObject({ editedPayload: { channel: 'sms', body: 'Hi Jane, Saturday at noon works.' } });
  });

  it('an assistant email draft shows what Jane will get (the agent\'s signature and the brokerage footer) from the preview, and Send approves the draft as is', async () => {
    // the approval renders the same signature and footer as this preview (R-PAR-25; api assistant/drafts.test.ts)
    const final = 'Yes, Saturday 1-3 works.\n\nAva Agent\nLic. #01234567\n\n--\nHarbor Realty LLC';
    const fake = threadFake()
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction({ draft: { channel: 'email', subject: 'Saturday', body: 'Yes, Saturday 1-3 works.' } }) } })
      .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: final } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const box = await screen.findByRole('textbox', { name: 'Email message' });
    await waitFor(() => expect(box).toHaveValue('Yes, Saturday 1-3 works.'));
    const figure = await screen.findByRole('figure', { name: 'What Jane will get' });
    expect(figure.querySelector('p')!.textContent).toBe(final);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'email', body: 'Yes, Saturday 1-3 works.', subject: 'Saturday' });
    await user().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)[0]!.body).not.toHaveProperty('editedPayload');
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(0);
  });

  it.each([["DATE_MOVED", "The deal date in this update moved since it was drafted, so it can't be sent as written. Your text is still here; Send sends it as your own message."], ["DATE_NO_LONGER_DRIVES", "The deal date in this update was completed or waived, so this update won't be sent. Your text is still here; Send sends it as your own message."], ["DATE_GONE", "The deal date in this update no longer exists, so this update won't be sent. Your text is still here; Send sends it as your own message."]] as [string, string][])('R-TXN-5 E557: a draft whose deal date changed (%s) is detached like an invalidated one: the text stays and Send sends it as the agent\'s own message', async (reason, text) => {
    const fake = threadFake()
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, err(409, 'DRAFT_STALE', { reason, dealDateId: IDS.draft, boundDueVersion: 1, currentDueVersion: 2 }))
      .on(`POST /contacts/${IDS.jane}/messages`, { status: 201, body: { result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/replied since this was drafted/)).toBeNull();
    expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(1));
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1);
  });

  it('R-AST-6: approving a draft the client has replied to since is refused as stale; the box says so and the next Send carries the re-reviewed inbound seq', async () => {
    const fake = threadFake()
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, (c) =>
        (c.body as { reviewedInboundSeq?: number }).reviewedInboundSeq === 7
          ? { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } }
          : err(409, 'DRAFT_STALE', { inboundSeq: 7, pinnedInboundSeq: 6 }),
      );
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    const timelineBefore = fake.callsTo(`GET /contacts/${IDS.jane}/timeline?limit=100`).length;
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Jane replied since this was drafted. Read the new message above, then send if it still fits.')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${IDS.jane}/timeline?limit=100`).length).toBeGreaterThan(timelineBefore));
    expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    const bodies = fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`).map((c) => c.body as { reviewedInboundSeq?: number; commandId: string });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.reviewedInboundSeq).toBeUndefined();
    expect(bodies[1]!.reviewedInboundSeq).toBe(7);
  });

  it('an invalidated draft sends nothing; the text stays and Send then sends it as the agent’s own message', async () => {
    const fake = threadFake()
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, err(409, 'DRAFT_INVALIDATED'))
      .on(`POST /contacts/${IDS.jane}/messages`, sent());
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/This draft no longer applies: the lead's owner changed\. Nothing was sent\./)).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)).toHaveLength(1));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)[0]!.body).toMatchObject({ channel: 'sms', body: 'Hi Jane, Saturday at 11 works. Want me to book it?' });
  });

  it('a draft whose reasoning the assistant could not verify is flagged "Check this" before sending', async () => {
    const a = draftAction();
    const fake = threadFake().on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: { ...a, claims: [{ ...a.claims[0]!, needsReview: true }] } } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    expect(await screen.findByText('Check this')).toBeInTheDocument();
    expect(screen.getByText('Read it before sending.')).toBeInTheDocument();
  });

  // Batch 6 review ui-compose/F7: a merged-away record was a dead end: its thread offered the box, the send was refused
  // (CONTACT_MERGED) with "Open the person's current record ..." and no link, although the API names that record.
  it('R-OWN-24: a record merged into another says so with a link to the current record, and offers no box to write in', async () => {
    const fake = new FakeFetch()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ merged: true, mergedIntoContactId: IDS.pat }) } })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [timelineItem()], nextCursor: null } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText(/This record was merged into another contact\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the current record' })).toHaveAttribute('href', `/contacts/${IDS.pat}`);
    expect(screen.queryByRole('textbox', { name: 'Text message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    // review R3: nor a Call above it, which the API refuses the same way
    expect(screen.queryByRole('button', { name: 'Call' })).toBeNull();
    expect(fake.calls.some((c) => c.path.endsWith('/messages/preview'))).toBe(false);
  });

  it('R-OWN-24 R-PERM-5: a merged record whose current record the viewer cannot open says so with no link, no box and no Call', async () => {
    const fake = new FakeFetch()
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact({ merged: true, mergedIntoContactId: null }) } })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [timelineItem()], nextCursor: null } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText("This record was merged into another contact you can't open. Ask its owner or an Admin.")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the current record' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Text message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Call' })).toBeNull();
    expect(fake.calls.some((c) => c.path.endsWith('/messages/preview'))).toBe(false);
  });

  it('R-OWN-24: a send refused because the record was merged meanwhile links to the record the person lives on now', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages`, err(409, 'CONTACT_MERGED', { mergedInto: IDS.pat }));
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    await u.type(await screen.findByRole('textbox', { name: 'Text message' }), 'Hi');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/This record was merged into another one, so nothing was done here\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open their current record' })).toHaveAttribute('href', `/contacts/${IDS.pat}/thread?compose=sms`);
  });

  it('a pond or offer card has no thread until it is the agent’s lead', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${IDS.pat}`, { status: 200, body: { contact: { id: IDS.pat, view: 'card', displayName: 'Pat L.', intent: null, source: null, createdAt: iso(-1000), pondSummary: null, ownership: { state: 'in_pond', pondId: IDS.pond, pondName: 'Team', offerId: null, offerExpiresAt: null, offeredToMe: false, seq: 1 } } } });
    agentApp(fake, `/contacts/${IDS.pat}/thread`);
    expect(await screen.findByText('Not your lead yet')).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path.includes('/timeline'))).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
