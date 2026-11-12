// Contact page in jsdom: the pond/offer card view (R-PERM-6), the full view's one-tap Call / Text,
// starting a deal from a contact in 2 taps (A7d attribution is copied by the server from one call),
// and 404 for an invisible contact (R-PERM-5 display: the same sentence as for a missing one).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, draftAction, err, fullContact, iso, pondCard, reachability, stopReason } from '../feed/lib/testing.js';

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
  // Batch 6 review ui-compose/F7: a merged-away record offered Call, Text and Email, which the API refuses
  // (CONTACT_MERGED), and only its history said "Merged into another contact", with no way to the person.
  it('R-OWN-24: a record merged into another says so with a link to the current record, and offers no Call, Text or Email', async () => {
    const merged = fullContact({ merged: true, mergedIntoContactId: IDS.pat });
    agentApp(fullFake(merged).on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane) } }), `/contacts/${IDS.jane}`);
    expect(await screen.findByText(/This record was merged into another contact\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the current record' })).toHaveAttribute('href', `/contacts/${IDS.pat}`);
    for (const name of ['Call', 'Text', 'Email']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  // Review of that fix (R2): the API names the record the person lives on now only to whoever may open it (R-PERM-5: the
  // loser's collaborator is not told about the survivor), so the page says so without a link that would answer 404.
  it('R-OWN-24 R-PERM-5: a merged record whose current record the viewer cannot open says so, with no link and no Call, Text or Email', async () => {
    const merged = fullContact({ merged: true, mergedIntoContactId: null });
    agentApp(fullFake(merged).on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane) } }), `/contacts/${IDS.jane}`);
    expect(await screen.findByText("This record was merged into another contact you can't open. Ask its owner or an Admin.")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the current record' })).toBeNull();
    for (const name of ['Call', 'Text', 'Email']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  // R3: a call refused because the record was merged meanwhile (CONTACT_MERGED) read "The call didn't go through. Check
  // your connection", which is false, and gave no way to the person although the API names their current record.
  it('R-OWN-24: a call refused because the record was merged meanwhile says so, and links to the current record only when the API names it', async () => {
    for (const details of [{ mergedInto: IDS.pat }, {}]) {
      const fake = fullFake().on(`POST /contacts/${IDS.jane}/calls`, err(409, 'CONTACT_MERGED', details));
      const { view } = agentApp(fake, `/contacts/${IDS.jane}`);
      await user().click(await screen.findByRole('button', { name: 'Call' }));
      const dialog = await screen.findByRole('dialog', { name: 'Call Jane Doe' });
      expect(await within(dialog).findByText(/This record was merged into another one, so nothing was done here\./)).toBeInTheDocument();
      expect(within(dialog).queryByText(/Check your connection/)).toBeNull();
      const link = within(dialog).queryByRole('link', { name: 'Open their current record' });
      if ('mergedInto' in details) expect(link).toHaveAttribute('href', `/contacts/${IDS.pat}`);
      else expect(link).toBeNull();
      view.unmount();
    }
  });

  it('Owen: STOP disables Text with "Texted STOP on Nov 10"; Email and Call stay enabled; no stand-in preview is sent', async () => {
    const fake = fullFake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAccessibleDescription('Texted STOP on Nov 10');
    expect(screen.getByRole('button', { name: 'Email' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Call' })).toBeEnabled();
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/messages/preview`)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/consent|quiet hours|anyway/i);
  });

  it('E77 E154 (finding UXA-5): the lead card shows the phone or email the visitor typed in the website chat, marked typed in chat, not verified (never as a point to call or text)', async () => {
    const sam = fullContact({ phones: [], emails: [], typedInChat: [{ kind: 'email', address: 'sam.rivera@example.com', typedAt: iso(-60_000) }, { kind: 'phone', address: '+14155550123', typedAt: iso(-3_600_000) }] });
    agentApp(fullFake(sam), `/contacts/${IDS.jane}`);
    const email = await screen.findByText('sam.rivera@example.com');
    expect(email.closest('li')!.textContent).toMatch(/typed in chat, not verified/);
    const phone = screen.getByText('(415) 555-0123');
    expect(phone.closest('li')!.textContent).toMatch(/typed in chat, not verified/);
    // still nothing on file to call or text: Call, Text and Email say there is no number or address
    for (const name of ['Call', 'Text', 'Email']) {
      const b = screen.queryByRole('button', { name });
      if (b) expect(b).toBeDisabled();
    }
  });

  it('an agent-recorded do-not-call disables Call and says who recorded it and when', async () => {
    const dnc = stopReason({ source: 'agent_recorded', keyword: null, at: new Date(new Date().getFullYear(), 9, 3, 12).toISOString(), recordedBy: { userId: IDS.me, displayName: 'Avery Brooks' } });
    const fake = fullFake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { voice: [dnc] }) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    expect(await screen.findByText('Asked not to be called (recorded by Avery Brooks on Oct 3)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Text' })).toBeEnabled();
  });

  it('while the summary is unknown (failed), nothing is disabled: the send-time check still decides', async () => {
    const fake = fullFake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 500, body: { error: { code: 'INTERNAL', requestId: 'r' } } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    expect(await screen.findByRole('button', { name: 'Text' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Call' })).toBeEnabled();
  });

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

  it('the first-contact countdown is announced politely as it crosses a milestone, naming the contact', async () => {
    const c = fullContact();
    const fake = fullFake({ ...c, ownership: { ...c.ownership, firstTouchAt: null, firstTouchDueAt: iso(31_500) } });
    agentApp(fake, `/contacts/${IDS.jane}`);
    await screen.findByRole('timer');
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent('First contact with Jane Doe: 30 seconds left'), { timeout: 3000 });
  });

  it('R-PAR-7: the full view shows the person\'s tag chips under the name (module 61\'s section in the registry), editable when the details allow it', async () => {
    const c = fullContact();
    const details = { contactId: c.id, rowVersion: 1, doNotContact: false, stage: { stage: 'new', label: 'New', locked: [], lockedReason: null }, stageLabels: {}, addresses: [], collaborators: [], relationships: [], removedPoints: [], canEdit: true, canManageCollaborators: false };
    const fake = fullFake(c)
      .on(`GET /contacts/${c.id}/tags`, { status: 200, body: { tags: [{ id: '01900000-0000-7000-8000-0000000000b1', name: 'Buyer', color: 'blue', protected: false }] } })
      .on(`GET /contacts/${c.id}/details`, { status: 200, body: { details } });
    agentApp(fake, `/contacts/${c.id}`);
    const tags = await screen.findByRole('region', { name: 'Tags' });
    expect(within(tags).getByRole('button', { name: 'Tag Buyer, show everyone with it' })).toBeInTheDocument();
    expect(await within(tags).findByRole('button', { name: 'Tag Buyer, remove' })).toBeInTheDocument();
    expect(within(tags).getByRole('button', { name: 'Add a tag' })).toBeInTheDocument();
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
