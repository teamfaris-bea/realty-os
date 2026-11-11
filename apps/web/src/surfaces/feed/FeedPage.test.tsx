// Priority Feed in jsdom on a scripted API: the pinned band and its live countdown, one-tap actions
// with tap counts (ARCHITECTURE §1 benchmarks), honest error sentences for ownership races, the
// reasons-not-scores display (R-AST-13) and denominators (R-ACC-4). The same jobs run against the
// real API in e2e/agent/jobs.spec.ts.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, card, decision, draftAction, err, feed, fullContact, iso, offerCard, reachability, stopReason, timelineItem } from './lib/testing.js';

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
    await screen.findByText('Pat L. is yours now.');
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
    await screen.findByText('Pat L. is yours now.');
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
    expect(await screen.findByRole('alert')).toHaveTextContent('This offer ended before your tap reached us.');
    expect(document.body.textContent).not.toContain('LEAD_OFFER_EXPIRED');
  });

  it('losing a pond claim race (LEAD_ALREADY_CLAIMED) tells the loser only that someone else got it', async () => {
    const pond = card({ itemType: 'pond_new', contact: { id: IDS.pat, name: 'Pat L.' }, reasons: [{ code: 'POND_NEW', label: 'New in the pond; first to claim gets it' }], primaryAction: { kind: 'claim', label: 'Claim', contactId: IDS.pat, pondId: IDS.pond } });
    const fake = new FakeFetch().on('GET /feed', { status: 200, body: feed([], [pond]) }).on(`POST /leads/${IDS.pat}/claim`, err(409, 'LEAD_ALREADY_CLAIMED', { observedSeq: 7 }));
    agentApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else claimed this lead just now.');
    expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)[0]!.body).toMatchObject({ pondId: IDS.pond });
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
    expect(await screen.findByText('Sent to Jane Doe.')).toBeInTheDocument();
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
    expect(await screen.findByText('Not sent: Opted out of texts')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /anyway/ })).toBeNull();
    expect(fake.calls.some((x) => x.path.endsWith('/send'))).toBe(false);
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
    expect(await screen.findByText('Call outcome saved.')).toBeInTheDocument();
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
    expect(await screen.findByText('Jane was reassigned during the call, so your outcome was saved as a task for the new owner.')).toBeInTheDocument();
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
    expect(await screen.findByText('Outcome saved.')).toBeInTheDocument();
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
    expect(await screen.findByText('Snoozed for 3 hours.')).toBeInTheDocument();
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
});

