// Priority Feed in jsdom on a scripted API: the pinned band and its live countdown, one-tap actions
// with tap counts (ARCHITECTURE §1 benchmarks), honest error sentences for ownership races, the
// reasons-not-scores display (R-AST-13) and denominators (R-ACC-4). The same jobs run against the
// real API in e2e/agent/jobs.spec.ts.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, findToast, IDS, agentApp, card, decision, draftAction, err, feed, fullContact, iso, offerCard, reachability, stopReason, timelineItem } from './lib/testing.js';

const user = () => userEvent.setup();

describe('Priority Feed', () => {
  it('opens on the feed: pinned "Due now" band first, then "Next up" (0 taps to see what is due)', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard()], [card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } })]) });
    agentApp(fake);
    expect(await screen.findByRole('heading', { level: 2, name: 'Due now' })).toBeInTheDocument();
    const bands = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(bands).toEqual(['Due now', 'Next up']);
    expect(screen.getByRole('heading', { level: 3, name: 'Pat L.' })).toBeInTheDocument();
  });

  it('the offer countdown is live: it ticks every second from the deadline the server sent', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard(125_000)]) });
    agentApp(fake);
    const timer = await screen.findByRole('timer');
    const first = timer.textContent;
    expect(first).toMatch(/^2:0[45] left$/);
    expect(timer).toHaveAccessibleName(/2 minutes \d+ seconds left/);
    await waitFor(() => expect(screen.getByRole('timer').textContent).not.toBe(first), { timeout: 2500 });
  });

  it('accepting a lead offer is 1 tap from the feed card and sends one command with a command id', async () => {
    const fake: FakeFetch = new FakeFetch();
    fake
      .on('GET /feed', () => ({ status: 200, body: fake.callsTo(`POST /leads/${IDS.pat}/accept`).length === 0 ? feed([offerCard()]) : feed() }))
      .on(`POST /leads/${IDS.pat}/accept`, { status: 200, body: { result: { contactId: IDS.pat, replayed: false, events: [], projection: null } } });
    agentApp(fake);
    const u = user();
    const accept = await screen.findByRole('button', { name: 'Accept' });
    await u.click(accept); // tap 1
    await findToast('Pat L. is yours now.');
    const calls = fake.callsTo(`POST /leads/${IDS.pat}/accept`);
    expect(calls).toHaveLength(1);
    const feedsBefore = fake.callsTo('GET /feed').length;
    expect(calls[0]!.body).toMatchObject({ offerId: IDS.offer, commandId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // the feed is refetched after the command settles, and the accepted offer card is gone
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
    expect(fake.callsTo('GET /feed').length).toBeGreaterThanOrEqual(feedsBefore);
  });

  it('a double tap on Accept still sends exactly one command', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard()]) }).on(`POST /leads/${IDS.pat}/accept`, async () => {
      await gate;
      return { status: 200, body: { result: { contactId: IDS.pat, replayed: false, events: [], projection: null } } };
    });
    agentApp(fake);
    const accept = await screen.findByRole('button', { name: 'Accept' });
    act(() => {
      accept.click();
      accept.click();
    });
    release();
    await findToast('Pat L. is yours now.');
    expect(fake.callsTo(`POST /leads/${IDS.pat}/accept`)).toHaveLength(1);
  });

  it('an offer whose countdown has ended says so and disables Accept (no invented grace period)', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard(-1000)]) });
    agentApp(fake);
    expect(await screen.findByText('Offer ended')).toBeInTheDocument();
    expect(screen.getByText('This offer ended. The lead is going to the next agent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('a late accept rejected by the server (LEAD_OFFER_EXPIRED) is said in words, never as a code', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard()]) }).on(`POST /leads/${IDS.pat}/accept`, err(409, 'LEAD_OFFER_EXPIRED', { observedSeq: 3 }));
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Accept' }));
    // said through the announcer (seen in the toast, heard once), where it outlives the card the refresh removes
    expect(await findToast(/^This offer ended before your tap reached us\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('LEAD_OFFER_EXPIRED');
  });

  it('losing a pond claim race (LEAD_ALREADY_CLAIMED) tells the loser only that someone else got it', async () => {
    const pond = card({ itemType: 'pond_new', contact: { id: IDS.pat, name: 'Pat L.' }, reasons: [{ code: 'POND_NEW', label: 'New in the pond; first to claim gets it' }], primaryAction: { kind: 'claim', label: 'Claim', contactId: IDS.pat, pondId: IDS.pond } });
    // once the late claim was answered, the refresh no longer has the card (the lead is someone else's now)
    let lost = false;
    const fake = new FakeFetch()
      .on('GET /feed', () => ({ status: 200, body: lost ? feed([], []) : feed([], [pond]) }))
      .on(`POST /leads/${IDS.pat}/claim`, () => {
        lost = true;
        return err(409, 'LEAD_ALREADY_CLAIMED', { observedSeq: 7 });
      });
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await findToast('Someone else claimed this lead just now.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)[0]!.body).toMatchObject({ pondId: IDS.pond });
    // journey J2: the card goes away with the refresh, and the reason is still there to read
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull());
    expect(within(screen.getByTestId('toast')).getByText('Someone else claimed this lead just now.')).toBeVisible();
    expect(document.body.textContent).not.toContain('LEAD_ALREADY_CLAIMED');
  });

  it('R-AST-13: the feed shows reasons, never a score or confidence, even if a response carried one', async () => {
    const c = { ...card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane }, reasons: [{ code: 'CLIENT_WAITING', label: 'Waiting for your reply' }, { code: 'WAITING_OVER_1H', label: 'Waiting over 1 h' }] }), score: 87, confidence: 0.92, points: 50 };
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [c as never]) });
    agentApp(fake);
    await screen.findByText('Waiting for your reply');
    expect(screen.getAllByText('Waiting for your reply')).toHaveLength(1);
    await user().click(screen.getByRole('button', { name: 'Why this' }));
    const why = screen.getByRole('list', { name: 'Why this is in your feed' });
    expect(within(why).getByText('Waiting over 1 h')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    for (const banned of ['87', '0.92', '92%', 'confidence', 'Confidence', 'score', '50 points']) expect(text).not.toContain(banned);
  });

  it('R-ACC-4: when the feed is capped the count shows its denominator ("48 of 63 items shown")', async () => {
    const scored = Array.from({ length: 48 }, (_, i) => card({ contact: { id: IDS.jane, name: `Lead ${i}` }, primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } }));
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], scored, 63) });
    agentApp(fake);
    expect(await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '48 of 63 items shown')).toBeInTheDocument();
  });

  it('a failed refresh keeps the feed on screen and says it may be out of date', async () => {
    const scored = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const fake: FakeFetch = new FakeFetch();
    fake
      .on('GET /feed', () => (fake.callsTo(`POST /feed/${scored.id}/dismiss`).length === 0 ? { status: 200, body: feed([offerCard()], [scored]) } : err(503, 'INTERNAL_ERROR')))
      .on(`POST /feed/${scored.id}/dismiss`, { status: 200, body: { item: { id: scored.id, state: 'dismissed', snoozedUntil: null } } });
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Dismiss' })); // invalidates the feed → the refetch fails
    expect(await screen.findByText(/^Couldn't refresh just now\. This is your feed as of /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('an empty feed says plainly that nothing is due (no fake activity)', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed() });
    agentApp(fake);
    expect(await screen.findByText("You're caught up")).toBeInTheDocument();
  });

  it('approving an assistant draft from its card is 1 tap (Send)', async () => {
    const c = card({ itemType: 'assistant_draft', assistantActionId: IDS.draft, reasons: [{ code: 'DRAFT_READY', label: 'Draft ready for you' }], primaryAction: { kind: 'send_draft', label: 'Send', actionId: IDS.draft }, alternatives: [{ kind: 'edit_draft', label: 'Edit', actionId: IDS.draft }] });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Send' })); // tap 1
    expect(await findToast('Sent to Jane Doe.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1);
  });

  it.each([["DATE_MOVED", "The deal date in this update moved since it was drafted, so it can't be sent as written; the new date gets its own update if the team's update plan covers it. Dismiss it in Approvals."], ["DATE_NO_LONGER_DRIVES", "The deal date in this update was completed or waived, so this update won't be sent. Dismiss it in Approvals."], ["DATE_GONE", "The deal date in this update no longer exists, so this update won't be sent. Dismiss it in Approvals."]] as [string, string][])('R-TXN-5 E557: a card whose deal date changed (%s) says why and to dismiss it in Approvals, with no thread jump and no re-tap', async (reason, text) => {
    const c = card({ itemType: 'assistant_draft', assistantActionId: IDS.draft, reasons: [{ code: 'DRAFT_READY', label: 'Draft ready for you' }], primaryAction: { kind: 'send_draft', label: 'Send', actionId: IDS.draft } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, err(409, 'DRAFT_STALE', { reason, dealDateId: IDS.draft, boundDueVersion: 1, currentDueVersion: 2 }));
    const { router } = agentApp(fake);
    const before = router.state.location.pathname;
    await user().click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(before);
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
    expect(screen.queryByText(/replied since this was drafted/)).toBeNull();
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1);
  });

  it('a draft approval the send-time check blocks says why, and there is no way past it', async () => {
    const c = card({ itemType: 'assistant_draft', primaryAction: { kind: 'send_draft', label: 'Send', actionId: IDS.draft } });
    const blocked = decision({ outcome: 'deny', explanation: 'Opted out of texts' });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'blocked', messageId: IDS.message, decision: blocked } });
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Send' }));
    expect(await findToast('Not sent: Opted out of texts')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /anyway/ })).toBeNull();
    expect(fake.calls.some((x) => x.path.endsWith('/send'))).toBe(false);
  });

  it('R-INBOX-4 (review ui-compose/F3): Send on a web-chat draft is judged by the chat: a STOP on their phone does not disable it; once the chat ended it is disabled with the summary\'s reason', async () => {
    const c = card({ itemType: 'assistant_draft', assistantActionId: IDS.draft, reasons: [{ code: 'DRAFT_READY', label: 'Chat reply drafted for you' }], primaryAction: { kind: 'send_draft', label: 'Send', actionId: IDS.draft } });
    const chatDraft = draftAction({ draft: { channel: 'web_chat', subject: null, body: 'Happy to help with Elm!' } });
    for (const [chat, disabled, why] of [['open', false, null], ['ended', true, 'The chat has ended: they left the page']] as const) {
      const fake = new FakeFetch()
        .on('GET /feed', { status: 200, body: feed([], [c]) })
        .on('GET /assistant/inbox', { status: 200, body: { items: [chatDraft] } })
        .on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, { sms: [stopReason()] }, chat)] } });
      const { view } = agentApp(fake);
      const send = await screen.findByRole('button', { name: 'Send' });
      await waitFor(() => expect(fake.callsTo('GET /assistant/inbox').length).toBeGreaterThan(0));
      if (disabled) {
        await waitFor(() => expect(send).toBeDisabled());
        expect(send).toHaveAccessibleDescription(why!);
      } else {
        await new Promise((r) => setTimeout(r, 50));
        expect(send).toBeEnabled();
        expect(document.body.textContent).not.toContain('Texted STOP');
      }
      view.unmount();
    }
  });

  it('review chat-R2 of batch 6: Send of a suggested text to a lead with no phone on file (a chat-only lead) is disabled before the tap and says why; the approval is never sent', async () => {
    const c = card({ itemType: 'handback', assistantActionId: IDS.draft, reasons: [{ code: 'HANDBACK', label: 'Replied to the assistant; follow-ups paused' }], primaryAction: { kind: 'send_draft', label: 'Send', actionId: IDS.draft }, alternatives: [{ kind: 'edit_draft', label: 'Edit', actionId: IDS.draft }] });
    const hb = draftAction({ kind: 'handback', draft: { channel: 'sms', subject: null, body: 'Does tomorrow afternoon work for a quick call?' } });
    const none = { hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [] };
    const open = reachability(IDS.jane, {}, 'open');
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on('GET /assistant/inbox', { status: 200, body: { items: [hb] } })
      .on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [{ ...open, channels: { ...open.channels, sms: none, voice: none, email: none } }] } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, err(422, 'CONTACT_POINT_MISSING'));
    agentApp(fake);
    const send = await screen.findByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeDisabled());
    expect(send).toHaveAccessibleDescription("There's no phone number on file to text");
    await user().click(send);
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(0);
  });

  it('texting a lead is 2 taps: Text → the thread opens with the assistant draft prefilled → Send', async () => {
    const c = card({ primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane, draftActionId: IDS.draft } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [timelineItem()], nextCursor: null } })
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: allowPreview(), body: '' } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    const { router } = agentApp(fake);
    const u = user();
    let taps = 0;
    await u.click(await screen.findByRole('button', { name: 'Text' }));
    taps += 1;
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.jane}/thread`));
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    expect(screen.getByText('Drafted by the assistant.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Send' }));
    taps += 1;
    await waitFor(() => expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1));
    expect(taps).toBe(2);
    // unchanged draft: approved as is (no edited payload)
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)[0]!.body).toEqual({ commandId: expect.any(String) });
  });

  it('calling a lead is 1 tap (dial-time gate checked by the server) and the post-call outcome is 1 more tap', async () => {
    const c = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } })
      .on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'no_answer', recordedAs: 'call' } });
    agentApp(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Call' })); // tap 1: dials
    const sheet = await screen.findByRole('dialog', { name: 'Call Jane Doe' });
    expect(await within(sheet).findByText("Your phone will ring first. Answer it and you're connected to Jane.")).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/calls`)).toHaveLength(1);
    await u.click(within(sheet).getByRole('button', { name: 'No answer' })); // outcome: 1 tap
    expect(await findToast('Call outcome saved.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /calls/${IDS.call}/outcome`)[0]!.body).toEqual({ outcome: 'no_answer' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a call outcome saved after a mid-call reassignment says it became a task for the new owner', async () => {
    const c = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } })
      .on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'connected', recordedAs: 'task_for_current_owner' } });
    agentApp(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Call' }));
    await u.click(await screen.findByRole('button', { name: 'Talked' }));
    expect(await findToast('Jane was reassigned during the call, so your outcome was saved as a task for the new owner.')).toBeInTheDocument();
  });

  it('a call the dial-time check blocks (asked not to be called) shows the sentence, dials nothing and offers no way past it', async () => {
    const c = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const deny = decision({ outcome: 'deny', explanation: 'Asked not to be called', id: null });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'gate', callId: null, bridgeToken: null, reason: null, decision: deny } });
    agentApp(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Call' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Asked not to be called')).toBeInTheDocument();
    expect(within(sheet).getByText(/Won't call:/)).toBeInTheDocument();
    expect(within(sheet).getByText('Nothing was dialed.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /anyway/ })).toBeNull();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/calls`)).toHaveLength(1);
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/calls`)[0]!.body).toEqual({});
  });

  it('logging an appointment outcome from its card is 1 tap on an outcome chip', async () => {
    const c = card({ itemType: 'appointment_outcome', primaryAction: { kind: 'log_outcome', label: 'Log outcome', appointmentId: IDS.appt } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /appointments/${IDS.appt}/outcome`, { status: 200, body: { appointment: {} } });
    agentApp(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Log outcome' }));
    await u.click(await screen.findByRole('button', { name: 'Signed' }));
    expect(await findToast('Outcome saved.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /appointments/${IDS.appt}/outcome`)[0]!.body).toEqual({ result: 'agreement_signed' });
  });

  it('a card shows at most 3 alternatives inline and no "Open" button when the name already links to the contact', async () => {
    const c = card({
      primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane },
      alternatives: [
        { kind: 'call', label: 'Call', contactId: IDS.jane },
        { kind: 'email', label: 'Email', contactId: IDS.jane },
        { kind: 'open_contact', label: 'Open', contactId: IDS.jane },
        { kind: 'complete_task', label: 'Done', taskId: IDS.task },
        { kind: 'open_deal', label: 'Open deal', dealId: IDS.deal },
      ],
    });
    agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [c]) }));
    await screen.findByRole('button', { name: 'Text' });
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Jane Doe' })).toHaveAttribute('href', `/contacts/${IDS.jane}`);
    expect(screen.queryByRole('button', { name: 'Open deal' })).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Why this' }));
    expect(screen.getByRole('button', { name: 'Open deal' })).toBeInTheDocument();
  });

  it('a task card says the task itself (its title), with the person and when it is due; a task without a person is headed by its title', async () => {
    const withPerson = card({ itemType: 'task_due', subjectType: 'task', subjectId: IDS.task, task: { id: IDS.task, title: 'Send the pre-approval letter' }, reasons: [{ code: 'TASK_DUE', label: 'Due in 2 h' }], primaryAction: { kind: 'complete_task', label: 'Done', taskId: IDS.task } });
    const alone = card({ itemType: 'task_due', contact: null, subjectType: 'task', subjectId: IDS.deal, task: { id: IDS.deal, title: 'Order the yard sign' }, reasons: [{ code: 'TASK_DUE', label: 'Due today' }], primaryAction: { kind: 'complete_task', label: 'Done', taskId: IDS.deal } });
    agentApp(new FakeFetch().on('GET /feed', { status: 200, body: feed([], [withPerson, alone]) }));
    const first = await screen.findByRole('article', { name: 'Jane Doe' });
    expect(within(first).getByText('Send the pre-approval letter')).toBeInTheDocument();
    expect(within(first).getByText('Due in 2 h')).toBeInTheDocument();
    const second = screen.getByRole('article', { name: 'Order the yard sign' });
    expect(within(second).getByRole('heading', { name: 'Order the yard sign' })).toBeInTheDocument();
    expect(within(second).getByText('Due today')).toBeInTheDocument();
  });

  it('the feed query never resolves without a feed: an empty answer is an error the page says, not undefined data', async () => {
    const qcErrors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      qcErrors.push(a);
    };
    try {
      // a 200 with no body (what a swallowed body read used to resolve to)
      agentApp(new FakeFetch().on('GET /feed', { status: 200 }));
      expect(await screen.findByText("Can't load your feed")).toBeInTheDocument();
      expect(JSON.stringify(qcErrors)).not.toContain('Query data cannot be undefined');
    } finally {
      console.error = orig;
    }
  });

  it('an optional hint on an action is shown under its button before the tap', async () => {
    const c = card({ primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane, note: 'Read their last reply first' } });
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [c]) });
    agentApp(fake);
    expect(await screen.findByText('Read their last reply first')).toBeInTheDocument();
  });

  it('scored cards can be snoozed or dismissed; deadline cards cannot', async () => {
    const scored = card({ primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([offerCard()], [scored]) })
      .on(`POST /feed/${scored.id}/snooze`, { status: 200, body: { item: { id: scored.id, state: 'snoozed', snoozedUntil: iso(3_600_000) } } });
    agentApp(fake);
    await screen.findByRole('button', { name: 'Accept' });
    expect(screen.getAllByRole('button', { name: 'Later' })).toHaveLength(1);
    await user().click(screen.getByRole('button', { name: 'Later' }));
    expect(await findToast('Snoozed for 3 hours.')).toBeInTheDocument();
    const body = fake.callsTo(`POST /feed/${scored.id}/snooze`)[0]!.body as { until: string };
    expect(Date.parse(body.until) - Date.now()).toBeGreaterThan(2.9 * 3_600_000);
  });

  it('has no axe violations (structure, names, roles)', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard()], [card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } })]) });
    agentApp(fake);
    await screen.findByRole('button', { name: 'Accept' });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

function allowPreview() {
  return { id: null, outcome: 'allow', reasons: [], explanation: '', phase: 'preview' };
}

describe('Priority Feed: opt-outs said before the tap (lane optout-visibility)', () => {
  it('R-CONSENT-7: one reachability request for the whole feed; Text is disabled with "Texted STOP on Nov 10" while Call and Email stay enabled', async () => {
    const text = card({ primaryAction: { kind: 'text', label: 'Text', contactId: IDS.jane }, alternatives: [{ kind: 'call', label: 'Call', contactId: IDS.jane }, { kind: 'email', label: 'Email', contactId: IDS.jane }] });
    const other = card({ contact: { id: IDS.pat, name: 'Pat Lee' }, primaryAction: { kind: 'call', label: 'Call', contactId: IDS.pat } });
    const ids = [IDS.jane, IDS.pat].sort().join(',');
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [text, other]) })
      .on(`GET /reachability?contactIds=${ids}`, { status: 200, body: { reachability: [reachability(IDS.jane, { sms: [stopReason()] }), reachability(IDS.pat)] } });
    agentApp(fake);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    const textButton = screen.getByRole('button', { name: 'Text' });
    expect(textButton).toBeDisabled();
    expect(textButton).toHaveAccessibleDescription('Texted STOP on Nov 10');
    for (const b of screen.getAllByRole('button', { name: 'Call' })) expect(b).toBeEnabled();
    // the whole feed in one batch (React StrictMode may abort and repeat it); never one request per card, never a stand-in preview
    expect(fake.callsTo(`GET /reachability?contactIds=${ids}`).length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.filter((c) => /reachability|messages\/preview/.test(c.path) && c.path !== `/reachability?contactIds=${ids}`)).toEqual([]);
  });

  it('finding UXA-3: a lead waiting in the website chat is answered in 2 taps: Reply → the thread opens on web chat → Send; once the chat ended, Reply is disabled with the reason', async () => {
    const chatOnly = fullContact({ phones: [], emails: [] });
    const c = card({ reasons: [{ code: 'CLIENT_WAITING', label: 'They wrote in the website chat 1 min ago; no reply yet' }], primaryAction: { kind: 'reply_chat', label: 'Reply', contactId: IDS.jane }, alternatives: [{ kind: 'open_contact', label: 'Open', contactId: IDS.jane }] });
    const chatTimeline = [timelineItem({ id: '01900000-0000-7000-8000-0000000e5604', detail: 'web_chat:inbound', preview: 'Is the open house still on?', occurredAt: iso(-60_000) })];
    const sentChat = { status: 200, body: { message: { id: IDS.message, channel: 'web_chat', status: 'sent', statusReason: null, purpose: 'informational', body: 'Yes, 10 to 12', subject: null, scheduledFor: null, dispatchedAt: iso(0) }, decision: decision({}), result: 'sent' } };
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, {}, 'open')] } })
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, {}, 'open') } })
      .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: chatOnly } })
      .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: chatTimeline, nextCursor: null } })
      .on(`POST /contacts/${IDS.jane}/messages/preview`, (call) => ({ status: 200, body: { decision: allowPreview(), body: (call.body as { body: string }).body } }))
      .on(`POST /contacts/${IDS.jane}/messages`, sentChat);
    const { router } = agentApp(fake);
    const u = user();
    expect(await screen.findByText('They wrote in the website chat 1 min ago; no reply yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email' })).toBeNull();
    await u.click(await screen.findByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(router.state.location.search).toBe('?compose=web_chat'));
    const box = await screen.findByRole('textbox', { name: 'Web chat message' });
    await waitFor(() => expect(box).toHaveFocus());
    await u.type(box, 'Yes, 10 to 12');
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages`)[0]!.body).toMatchObject({ channel: 'web_chat', body: 'Yes, 10 to 12' });
  });

  it('finding UXA-3: Reply on a card whose chat has ended is disabled before the tap, with the reachability summary\'s reason', async () => {
    const c = card({ primaryAction: { kind: 'reply_chat', label: 'Reply', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, {}, 'ended')] } });
    agentApp(fake);
    const reply = await screen.findByRole('button', { name: 'Reply' });
    await waitFor(() => expect(reply).toBeDisabled());
    expect(reply).toHaveAccessibleDescription('The chat has ended: they left the page');
  });

  it('review ui-compose/F2: Reply on a card whose summary has no chat to answer is disabled before the tap and says why; it never opens a text box in its place', async () => {
    const c = card({ primaryAction: { kind: 'reply_chat', label: 'Reply', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, {}, 'none')] } });
    agentApp(fake);
    const reply = await screen.findByRole('button', { name: 'Reply' });
    await waitFor(() => expect(reply).toBeDisabled());
    expect(reply).toHaveAccessibleDescription("This website chat can't be answered from this record");
  });
});


describe('Priority Feed: heard, not only seen (lane a11y-optout-surfaces)', () => {
  const announcer = () => screen.getByTestId('announcer');

  it('the offer countdown is announced politely at milestones (here: 1 minute left), not every second', async () => {
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([offerCard(61_500)]) });
    agentApp(fake);
    const timer = await screen.findByRole('timer');
    // role="timer" is not a live region; the milestone already reached on mount is not said
    expect(timer).not.toHaveAttribute('aria-live');
    expect(announcer()).toHaveTextContent('');
    await waitFor(() => expect(announcer()).toHaveTextContent('Offer for Pat L.: 1 minute left'), { timeout: 3000 });
    expect(announcer()).toHaveAttribute('aria-live', 'polite');
  });

  it('a toast is seen in place and said through the one live region (the visible toast is not a second one)', async () => {
    const c = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } })
      .on(`POST /calls/${IDS.call}/outcome`, { status: 200, body: { callId: IDS.call, outcome: 'no_answer', recordedAs: 'call' } });
    agentApp(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Call' }));
    await u.click(await screen.findByRole('button', { name: 'No answer' }));
    const line = await findToast('Call outcome saved.');
    expect(line.closest('[aria-hidden="true"]')).not.toBeNull();
    const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].filter((e) => (e.textContent ?? '').includes('Call outcome saved.'));
    expect(live).toEqual([announcer()]);
  });

  it('the call sheet is the shared Dialog: the page behind is inert, Tab stays inside, Escape closes it and focus returns to Call', async () => {
    const c = card({ primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane } });
    const fake = new FakeFetch()
      .on('GET /feed', { status: 200, body: feed([], [c]) })
      .on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } });
    agentApp(fake);
    const u = user();
    const callButton = await screen.findByRole('button', { name: 'Call' });
    await u.click(callButton);
    const sheet = await screen.findByRole('dialog', { name: 'Call Jane Doe' });
    await within(sheet).findByRole('button', { name: 'No answer' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(callButton.closest('[inert]')).not.toBeNull();
    expect(sheet.closest('[inert]')).toBeNull();
    for (let i = 0; i < 12; i += 1) {
      await u.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
    // a visible way out for a phone (no Escape key there)
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callButton.closest('[inert]')).toBeNull();
    expect(callButton).toHaveFocus();
  });
});
