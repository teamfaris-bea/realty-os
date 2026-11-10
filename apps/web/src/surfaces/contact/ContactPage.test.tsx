// Contact page in jsdom: the pond/offer card view (R-PERM-6), the full view's one-tap Call / Text,
// starting a deal from a contact in 2 taps (A7d attribution is copied by the server from one call),
// and 404 for an invisible contact (R-PERM-5 display: the same sentence as for a missing one).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, draftAction, err, fullContact, iso, pondCard } from '../feed/lib/testing.js';

const user = () => userEvent.setup();

function fullFake(contact = fullContact()) {
  return new FakeFetch()
    .on(`GET /contacts/${contact.id}`, { status: 200, body: { contact } })
    .on(`GET /contacts/${contact.id}/timeline?limit=100`, { status: 200, body: { items: [], nextCursor: null } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [] } })
    .on(`GET /tasks?contactId=${contact.id}&scope=visible&status=open`, { status: 200, body: { tasks: [] } })
    .on(`GET /deals?contactId=${contact.id}`, { status: 200, body: { deals: [] } })
    .on(`GET /contacts/${contact.id}/saved-searches`, { status: 200, body: { searches: [] } });
}

describe('Contact: card view', () => {
  it('R-PERM-6: a pond card shows only the card and Claim, and the web requests nothing else about the contact', async () => {
    const fake = new FakeFetch()
      .on(`GET /contacts/${IDS.pat}`, { status: 200, body: { contact: pondCard() } })
      .on(`POST /leads/${IDS.pat}/claim`, { status: 200, body: { result: { contactId: IDS.pat, replayed: false, events: [], projection: null } } });
    agentApp(fake, `/contacts/${IDS.pat}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Pat L.' })).toBeInTheDocument();
    expect(screen.getByText('Buyer · 94110 · $600k–$800k')).toBeInTheDocument();
    expect(screen.getByText('In the Team pond pond')).toBeInTheDocument();
    expect(screen.getByText('Phone, email and history show once the lead is yours.')).toBeInTheDocument();
    // no detail surfaces: no call/text buttons, no timeline, tasks, deals, saved searches, inbox
    for (const name of ['Call', 'Text', 'Email']) expect(screen.queryByRole('button', { name })).toBeNull();
    for (const title of ['Conversation', 'Tasks', 'Deals', 'Saved searches']) expect(screen.queryByRole('heading', { level: 2, name: title })).toBeNull();
    const paths = [...new Set(fake.calls.map((c) => `${c.method} ${c.path}`).filter((k) => k !== 'GET /auth/session'))];
    expect(paths).toEqual([`GET /contacts/${IDS.pat}`]);
    await user().click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)).toHaveLength(1));
    expect(fake.callsTo(`POST /leads/${IDS.pat}/claim`)[0]!.body).toMatchObject({ pondId: IDS.pond, commandId: expect.any(String) });
  });

  it('R-PERM-6: an offer card shows the live countdown with Accept and Decline, and no contact details', async () => {
    const offer = pondCard({ ownership: { state: 'offered', pondId: null, pondName: null, offerId: IDS.offer, offerExpiresAt: iso(240_000), offeredToMe: true, seq: 2 }, pondSummary: null });
    const fake = new FakeFetch().on(`GET /contacts/${IDS.pat}`, { status: 200, body: { contact: offer } });
    agentApp(fake, `/contacts/${IDS.pat}`);
    expect(await screen.findByRole('timer')).toHaveTextContent(/^[34]:\d\d left$/);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+1\d{10}|@example/);
  });
});

describe('Contact: full view', () => {
  it('calling from the contact is 1 tap', async () => {
    const fake = fullFake().on(`POST /contacts/${IDS.jane}/calls`, { status: 200, body: { result: 'dialing', callId: IDS.call, bridgeToken: 'b', reason: null, decision: decision({}) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    await user().click(await screen.findByRole('button', { name: 'Call' }));
    expect(await screen.findByRole('dialog', { name: 'Call Jane Doe' })).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/calls`)).toHaveLength(1);
  });

  it('Text opens the conversation with the compose box focused', async () => {
    const fake = fullFake().on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ phase: 'preview' }), body: '' } });
    const { router } = agentApp(fake, `/contacts/${IDS.jane}`);
    await user().click(await screen.findByRole('button', { name: 'Text' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.jane}/thread`));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Text message' })).toHaveFocus());
  });

  it('texting from the contact is 2 taps when the assistant has a reply ready: Text → (prefilled) Send', async () => {
    const fake = fullFake()
      .on('GET /assistant/inbox', { status: 200, body: { items: [draftAction()] } })
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ phase: 'preview' }), body: '' } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Text' })); // tap 1
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    await u.click(screen.getByRole('button', { name: 'Send' })); // tap 2
    await waitFor(() => expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1));
  });

  it('a suggested draft never overwrites what the agent already started typing', async () => {
    let releaseInbox!: () => void;
    const inboxReady = new Promise<void>((r) => (releaseInbox = r));
    const fake = fullFake()
      .on('GET /assistant/inbox', async () => {
        await inboxReady;
        return { status: 200, body: { items: [draftAction()] } };
      })
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ phase: 'preview' }), body: '' } });
    agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
    const u = user();
    const box = await screen.findByRole('textbox', { name: 'Text message' });
    await u.type(box, 'My own words');
    releaseInbox();
    await waitFor(() => expect(fake.callsTo('GET /assistant/inbox').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(box).toHaveValue('My own words');
    expect(fake.callsTo(`GET /assistant/actions/${IDS.draft}`)).toHaveLength(0);
  });

  it('starting a deal from a contact is 2 taps and one API call (the server copies the attribution)', async () => {
    const deal = { id: IDS.deal, name: 'Jane Doe · buy', side: 'buy', stage: 'prospect' };
    const fake = fullFake()
      .on('POST /deals', { status: 201, body: { deal } })
      .on(`GET /deals/${IDS.deal}`, { status: 404, body: { error: { code: 'NOT_FOUND', requestId: 'r' } } });
    const { router } = agentApp(fake, `/contacts/${IDS.jane}`);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Start a deal' })); // tap 1
    await u.click(within(screen.getByRole('group', { name: 'Start a deal with Jane Doe' })).getByRole('button', { name: 'Buying' })); // tap 2
    await waitFor(() => expect(router.state.location.pathname).toBe(`/deals/${IDS.deal}`));
    expect(fake.callsTo('POST /deals')).toHaveLength(1);
    expect(fake.callsTo('POST /deals')[0]!.body).toEqual({ primaryContactId: IDS.jane, side: 'buy' });
  });

  it('shows the first-contact deadline as a live countdown while it is due', async () => {
    const c = fullContact();
    const fake = fullFake({ ...c, ownership: { ...c.ownership, firstTouchAt: null, firstTouchDueAt: iso(600_000) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    expect(await screen.findByRole('timer')).toHaveTextContent(/^(9|10):\d\d left$/);
  });

  it('an invisible or missing contact reads as not available, the same either way', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${IDS.pat}`, err(404, 'NOT_FOUND'));
    agentApp(fake, `/contacts/${IDS.pat}`);
    expect(await screen.findByRole('alert')).toHaveTextContent("This isn't available. It may have moved, or you may not have access to it.");
  });

  it('has no axe violations', async () => {
    agentApp(fullFake(), `/contacts/${IDS.jane}`);
    await screen.findByRole('button', { name: 'Start a deal' });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
