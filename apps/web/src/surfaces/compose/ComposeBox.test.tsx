// Thread + compose in jsdom: human sends with one idempotency key per tap (retries reuse it), the
// inline send check in the server's words (shown as soon as the box opens), the send-time outcome as
// it came back (sent, scheduled for the agent's time, blocked with the reason; never "send anyway"),
// assistant drafts approved as is or edited, the stale-draft re-review (R-AST-6) and an invalidated
// draft (nothing sent; the text stays).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, draftAction, err, fullContact, iso, timelineItem } from '../feed/lib/testing.js';

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
    expect(await screen.findByText('Sent to Jane.')).toBeInTheDocument();
    const calls = fake.callsTo(`POST /contacts/${IDS.jane}/messages`);
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_:.-]{8,100}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(calls[0]!.body).toMatchObject({ channel: 'sms', body: 'On my way' });
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('the inline gate preview shows the server sentence before sending (e.g. a shared number that opted out)', async () => {
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview', outcome: 'deny', explanation: 'This number opted out of texts on Nov 3' }), body: '' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    await user().type(await screen.findByRole('textbox', { name: 'Text message' }), 'Hello');
    expect(await screen.findByText('This number opted out of texts on Nov 3')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'sms', body: 'Hello' });
  });

  it('an opt-out is said as soon as the box opens, before anything is typed, and again for the real text', async () => {
    const deny = { status: 200, body: { decision: decision({ id: null, phase: 'preview', outcome: 'deny', explanation: 'Opted out of texts' }), body: '' } };
    const fake = threadFake().on(`POST /contacts/${IDS.jane}/messages/preview`, deny);
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    expect(await screen.findByText('Opted out of texts')).toBeInTheDocument();
    expect(screen.getByText(/Won't send:/)).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`)[0]!.body).toEqual({ channel: 'sms', body: 'Hi' });
    await user().type(screen.getByRole('textbox', { name: 'Text message' }), 'Saturday?');
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`).at(-1)!.body).toEqual({ channel: 'sms', body: 'Saturday?' }));
    expect(await screen.findByText('Opted out of texts')).toBeInTheDocument();
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
    expect(await screen.findByText(/^Sends Wed, Nov 11, \d{1,2}:00 (AM|PM)\.$/)).toBeInTheDocument();
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
    expect(blocked).toContain('Not sent: blocked by an opt-out or a sending rule');
    expect(ok).not.toMatch(/Not sent|Not delivered/);
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
    expect(await screen.findByText('Sent to Jane.')).toBeInTheDocument();
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

  it('a pond or offer card has no thread until it is the agent’s lead', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${IDS.pat}`, { status: 200, body: { contact: { id: IDS.pat, view: 'card', displayName: 'Pat L.', intent: null, source: null, createdAt: iso(-1000), pondSummary: null, ownership: { state: 'in_pond', pondId: IDS.pond, pondName: 'Team', offerId: null, offerExpiresAt: null, offeredToMe: false, seq: 1 } } } });
    agentApp(fake, `/contacts/${IDS.pat}/thread`);
    expect(await screen.findByText('Not your lead yet')).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path.includes('/timeline'))).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
