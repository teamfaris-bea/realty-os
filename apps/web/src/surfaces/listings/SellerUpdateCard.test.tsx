// The seller-update card (module 38, 2B) in jsdom on a scripted API: R-SELL-2 (every figure sourced and
// dated), R-SELL-3 / E88 (the recommendation is required and never prefilled), R-SELL-4 (stale data says so
// and offers one tap to refresh), R-SELL-5 (an opted-out seller is shown before the tap, never after),
// E89 (feedback verbatim, removable, a named person flagged). The real API runs in e2e/seller-updates.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, err, iso } from '../feed/lib/testing.js';
import type { SellerUpdateView } from './SellerUpdateCard.js';

const user = () => userEvent.setup();
const LISTING = '01900000-0000-7000-8000-0000000115a1';
const UPDATE = '01900000-0000-7000-8000-0000000a5e11';
const SAM = '01900000-0000-7000-8000-00000000c101';
const ALEX = '01900000-0000-7000-8000-00000000c102';
const FB1 = '01900000-0000-7000-8000-0000000fb001';
const FB2 = '01900000-0000-7000-8000-0000000fb002';
const REC = 'Hold the price two more weeks, then revisit.';

function listing() {
  return { id: LISTING, source: 'team', mlsNumber: null, status: 'active', addressLine1: '12 Oak St', addressLine2: null, city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85_000_000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family', listingAgentUserId: IDS.me, description: null, listDate: '2026-10-01', editable: true, createdAt: iso(-1), priceHistory: [], contacts: [], showings: { total: 2, completed: 2, withFeedback: 2 } };
}

function update(over: Partial<SellerUpdateView> = {}): SellerUpdateView {
  return {
    id: UPDATE,
    listingId: LISTING,
    address: '12 Oak St',
    status: 'proposed',
    canSend: true,
    period: { start: iso(-7 * 86_400_000), end: iso(0), key: '2026-11-04', label: 'this week', text: 'Nov 4 – Nov 11, 2026' },
    assembledThrough: iso(-60_000),
    stale: false,
    sections: [
      { kind: 'showings', title: 'Showings', state: 'has_data', statement: 'Showings are logged by hand in Realty OS; no showing service is connected.', lines: [{ text: '2 showings logged in Realty OS this week', feedback: null }], sources: [{ text: '2 showings logged in Realty OS this week', evidence: [{ sourceType: 'showing', sourceId: 's1', label: 'Showing log: completed' }, { sourceType: 'showing', sourceId: 's2', label: 'Showing log: completed' }] }] },
      {
        kind: 'feedback',
        title: 'Feedback',
        state: 'has_data',
        statement: 'Feedback exactly as it was logged. Check each item: you can remove any of it before you send.',
        lines: [
          { text: 'Morgan Quill said the place is a dump.', feedback: { feedbackId: FB1, namesPerson: true, excluded: false } },
          { text: 'Bright and quiet.', feedback: { feedbackId: FB2, namesPerson: false, excluded: false } },
        ],
        sources: [{ text: '2 feedback items logged in Realty OS this week', evidence: [{ sourceType: 'showing_feedback', sourceId: FB1, label: 'Feedback log: Morgan Quill said the place is a dump.' }] }],
      },
      { kind: 'marketing', title: 'Marketing', state: 'none_logged', statement: 'From pieces published …', lines: [{ text: 'No marketing activity logged in Realty OS this week', feedback: null }], sources: [{ text: 'No marketing activity logged in Realty OS this week', evidence: [{ sourceType: 'listing', sourceId: LISTING, label: 'Listing record: 0 logged' }] }] },
      { kind: 'competing', title: 'Competing listings', state: 'unavailable', statement: 'Competing listings unavailable: no MLS feed connected', lines: [{ text: 'Competing listings unavailable: no MLS feed connected', feedback: null }], sources: [] },
    ],
    recommendation: '',
    excludedFeedbackIds: [],
    recipients: [
      { contactId: SAM, name: 'Sam Ortiz', role: 'seller', channel: 'email', addressHint: 's•••@example.test', visible: true, ownedByYou: true, sendable: true, personDoNotContact: false, whyNot: null },
      { contactId: ALEX, name: 'Alex Ortiz', role: 'co_seller', channel: 'sms', addressHint: '•••4567', visible: true, ownedByYou: true, sendable: false, personDoNotContact: false, whyNot: 'Not sent: their phone texted STOP.' },
    ],
    preview: { channel: 'email', subject: 'Weekly update: 12 Oak St', body: '…' },
    sentAt: null,
    delivery: null,
    ...over,
  };
}

const RANGE = 'Estimated value $590,000 to $640,000 as of Nov 10, 2026.';
function valueSection(): SellerUpdateView['sections'][number] {
  return {
    kind: 'value',
    title: 'Home value',
    state: 'has_data',
    statement: 'An estimate from comparable recent MLS sales, not an appraisal. MLS data as of Nov 10, 2026.',
    lines: [{ text: RANGE, feedback: null }, { text: 'Comparable closed sales:', feedback: null }, { text: '14 Oak St, Oakland: sold Oct 2, 2026 for $612,000, listed by Sample Realty', feedback: null }],
    sources: [{ text: 'A value range from 1 comparable closed MLS sale', evidence: [{ sourceType: 'listing', sourceId: 'mls:1', label: 'MLS sale: 14 Oak St' }] }],
  };
}

function app(u: SellerUpdateView, extra: (f: FakeFetch) => FakeFetch = (f) => f) {
  const fake = extra(
    new FakeFetch()
      .on(`GET /listings/${LISTING}`, { status: 200, body: { listing: listing() } })
      .on(`GET /listings/${LISTING}/showings`, { status: 200, body: { showings: [] } })
      .on(`GET /listings/${LISTING}/seller-update`, { status: 200, body: { update: u, nextDueAt: null } })
      .on(`PATCH /seller-updates/${UPDATE}`, (c) => ({ status: 200, body: { update: { ...u, ...(c.body as object) } } })),
  );
  agentApp(fake, `/listings/${LISTING}`);
  return fake;
}

const card = async () => (await screen.findByRole('heading', { name: 'Seller update this week' })).closest('section')!;

describe('Seller update card (module 38)', () => {
  it('R-SELL-2: each section says where its data stands, and every figure has its sources and the time the data was read', async () => {
    app(update());
    const c = await card();
    expect(within(c).getByText('Showings are logged by hand in Realty OS; no showing service is connected.')).toBeInTheDocument();
    expect(within(c).getByText('2 showings logged in Realty OS this week', { selector: 'li' })).toBeInTheDocument();
    expect(within(c).getAllByText(/^Sources · as of /)).toHaveLength(3);
    expect(within(c).getAllByText('Showing log: completed')).toHaveLength(2);
    expect(within(c).getByText('Listing record: 0 logged')).toBeInTheDocument();
    expect(within(c).getByText(/data as of/)).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/confidence|page views?|email opens?|\d+\s?%/i);
  });

  it('R-SELL-5: an opted-out seller is shown before the tap, with why; Send names only who will receive it', async () => {
    app(update());
    const c = await card();
    const goes = within(c).getByRole('list', { name: 'Goes to' });
    expect(within(goes).getByText('Not sent: their phone texted STOP.')).toBeInTheDocument();
    expect(within(goes).getByText(/Email s•••@example.test/)).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Send to Sam Ortiz' })).toBeInTheDocument();
  });

  it('E88 / R-SELL-3: the recommendation is empty (never prefilled) and Send stays off until it has 20 characters; Send carries it with the recipients shown', async () => {
    const fake = app(update(), (f) => f.on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'sent', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'sent' }] } }));
    const c = await card();
    const box = within(c).getByLabelText('Your recommendation (required)');
    expect(box).toHaveValue('');
    const sendBtn = within(c).getByRole('button', { name: 'Send to Sam Ortiz' });
    expect(sendBtn).toBeDisabled();
    expect(within(c).getByText('Write your recommendation: 20 more characters needed.')).toBeInTheDocument();
    await user().type(box, 'Hold.');
    expect(sendBtn).toBeDisabled();
    await user().clear(box);
    await user().type(box, REC);
    expect(sendBtn).toBeEnabled();
    await user().click(sendBtn);
    expect(await within(c).findByText('Sam Ortiz: Sent')).toBeInTheDocument();
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ recommendation: REC, recipientIds: [SAM], excludedFeedbackIds: [] });
  });

  it('E89: feedback is verbatim, a named person is flagged, and each item can be removed before sending', async () => {
    const fake = app(update());
    const c = await card();
    const item = within(c).getByText('“Morgan Quill said the place is a dump.”').closest('li')!;
    expect(within(item).getByText('Names a person. Check it before you send.')).toBeInTheDocument();
    await user().click(within(item).getByRole('button', { name: 'Remove from update' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)[0]!.body).toEqual({ excludedFeedbackIds: [FB1] });
  });

  it('R-SELL-4: stale data says so, Send is off, and one tap refreshes the update', async () => {
    const fake = app(update({ stale: true, recommendation: REC }), (f) => f.on(`POST /seller-updates/${UPDATE}/reassemble`, { status: 200, body: { update: update({ recommendation: REC }) } }));
    const c = await card();
    expect(within(c).getByText('New data since this was put together')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: /^Send to/ })).toBeDisabled();
    await user().click(within(c).getByRole('button', { name: 'Refresh the update' }));
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/reassemble`)).toHaveLength(1));
  });

  it('a send refused because the data moved or the recipients changed says so in words (nothing was sent)', async () => {
    app(update({ recommendation: REC }), (f) => f.on(`POST /seller-updates/${UPDATE}/send`, err(409, 'SELLER_UPDATE_RECIPIENTS_CHANGED')));
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Send to Sam Ortiz' }));
    expect(await within(c).findByText('Who can receive this update changed since you opened it. Check the list again. Nothing was sent.')).toBeInTheDocument();
  });

  it('nobody reachable: Send is off and says why; another member sees the update read-only', async () => {
    app(update({ recommendation: REC, recipients: [update().recipients[1]!] }));
    const c = await card();
    expect(within(c).getByText('None of the sellers can receive this update.')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Send to 0 sellers' })).toBeDisabled();
  });

  it('read-only for someone who is not the listing agent', async () => {
    app(update({ canSend: false }));
    const c = await card();
    expect(within(c).queryByLabelText('Your recommendation (required)')).toBeNull();
    expect(within(c).getByText('Only the listing agent can send this update.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Remove from update' })).toBeNull();
  });

  it('review fix: a removed feedback item stays removed in the Send even while the refetch of the update is still on its way', async () => {
    let patched = false;
    const fake = app(update({ recommendation: REC }), (f) =>
      f
        .on(`PATCH /seller-updates/${UPDATE}`, () => {
          patched = true;
          return { status: 200, body: { update: update({ recommendation: REC, excludedFeedbackIds: [FB1] }) } };
        })
        // the refetch after the PATCH never answers (a slow network): the card still holds the old server copy
        .on(`GET /listings/${LISTING}/seller-update`, () => (patched ? new Promise(() => undefined) : { status: 200, body: { update: update({ recommendation: REC }), nextDueAt: null } }))
        .on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'sent', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'sent' }] } }),
    );
    const c = await card();
    const item = within(c).getByText('“Morgan Quill said the place is a dump.”').closest('li')!;
    await user().click(within(item).getByRole('button', { name: 'Remove from update' }));
    expect(await within(item).findByText('Removed: the seller will not see this.')).toBeInTheDocument();
    await user().click(within(c).getByRole('button', { name: 'Send to Sam Ortiz' }));
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ excludedFeedbackIds: [FB1] });
  });

  it('review fix: an approved update whose message never went out says "Not sent yet" (never "Sent") and offers to try again', async () => {
    const fake = app(update({ status: 'approved', canSend: false, recommendation: REC, sentAt: iso(-60_000), delivery: [{ contactId: SAM, name: 'Sam Ortiz', channel: 'email', status: 'not_queued' }] }), (f) =>
      f.on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'sent', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'sent' }] } }),
    );
    const c = await card();
    expect(within(c).getByText('Not sent yet')).toBeInTheDocument();
    expect(within(c).queryByText(/^Sent /)).toBeNull();
    expect(within(c).getByText('Sam Ortiz: Not sent: no address to send to')).toBeInTheDocument();
    await user().click(within(c).getByRole('button', { name: 'Try sending again' }));
    expect(await within(c).findByText('Sam Ortiz: Sent')).toBeInTheDocument();
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ recipientIds: [SAM] });
  });

  it('b13 audit V2B-3 E632 R-CMA-7: a send the value-range re-check blocked before it was queued shows its own reason, never "no address to send to", and offers no "Try sending again" that could not send it', async () => {
    const why = 'Not sent: the value range can no longer be shown to clients (Value ranges wait for counsel review of in-house values (platform:cma). Nothing is shown to the seller.).';
    const fake = app(update({ status: 'approved', canSend: false, recommendation: REC, sentAt: iso(-60_000), delivery: [{ contactId: SAM, name: 'Sam Ortiz', channel: 'email', status: 'not_queued', reason: why }] }));
    const c = await card();
    expect(within(c).getByText('Not sent yet')).toBeInTheDocument();
    expect(within(c).getByText(`Sam Ortiz: ${why}`)).toBeInTheDocument();
    expect(within(c).queryByText(/no address to send to/)).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Try sending again' })).toBeNull();
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(0);
  });

  it('b13 audit V2B-3 E632: a retry the re-check blocks shows the reason from the send\'s answer and takes the retry away', async () => {
    const why = 'Not sent: the value range can no longer be shown to clients (The MLS data is out of date.).';
    const fake = app(update({ status: 'approved', canSend: false, recommendation: REC, sentAt: iso(-60_000), delivery: [{ contactId: SAM, name: 'Sam Ortiz', channel: 'email', status: 'not_queued', reason: null }] }), (f) =>
      f.on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'blocked', messageId: null, recipients: [{ contactId: SAM, messageId: null, result: 'not_queued', reason: why }] } }),
    );
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Try sending again' }));
    expect(await within(c).findByText(`Sam Ortiz: ${why}`)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Try sending again' })).toBeNull();
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1);
  });

  it('b13 audit V2B-7 E630 R-CMA-10: before the tap the card says, in the API\'s words, that sellers who get the update by text won\'t see the value range', async () => {
    const note = 'Sellers who get this by text won’t see the value range.';
    app(update({ valueNote: note } as Partial<SellerUpdateView>));
    const c = await card();
    expect(within(c).getByText(note)).toBeInTheDocument();
  });

  it('b13 audit V2B-7 E629 R-SELL-4: the stale banner names the value range among what can change; with no note from the API the card says nothing about texts', async () => {
    app(update({ stale: true }));
    const c = await card();
    expect(within(c).getByText(/Showings, feedback, marketing, competing listings or the value range changed after /)).toBeInTheDocument();
    expect(within(c).queryByText(/won’t see the value range/)).toBeNull();
  });

  it('E631 R-CMA-10: the listing agent removes the value range before sending and can put it back; the card says the seller will not see it and Send carries the choice', async () => {
    const fake = app(update({ recommendation: REC, sections: [...update().sections, valueSection()] }));
    const c = await card();
    const value = within(c).getByRole('group', { name: 'Home value' });
    expect(within(value).getByText(RANGE)).toBeInTheDocument();
    expect(within(value).queryByText('Removed: the seller will not see the value range.')).toBeNull();
    await user().click(within(value).getByRole('button', { name: 'Remove the value range' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)[0]!.body).toEqual({ valueRemoved: true });
    expect(await within(value).findByText('Removed: the seller will not see the value range.')).toBeInTheDocument();
    expect(within(value).queryByRole('button', { name: 'Remove the value range' })).toBeNull();
    // the send carries the removal even while the refetch of the update is still on its way
    await user().click(within(c).getByRole('button', { name: 'Send to Sam Ortiz' }));
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ valueRemoved: true, recipientIds: [SAM] });
  });

  it('E797 R-CMA-10: Send is off while the removal of the value range is still saving (the PATCH unanswered); once it is saved Send is on again and carries valueRemoved', async () => {
    let answer!: () => void;
    const unanswered = new Promise<void>((r) => { answer = r; });
    const u = update({ recommendation: REC, sections: [...update().sections, valueSection()] });
    const fake = app(u, (f) => f
      .on(`PATCH /seller-updates/${UPDATE}`, async (c) => { await unanswered; return { status: 200, body: { update: { ...u, ...(c.body as object) } } }; })
      .on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'sent', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'sent' }] } }));
    const c = await card();
    const value = within(c).getByRole('group', { name: 'Home value' });
    const sendBtn = within(c).getByRole('button', { name: 'Send to Sam Ortiz' });
    expect(sendBtn).toBeEnabled();
    await user().click(within(value).getByRole('button', { name: 'Remove the value range' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1));
    // the save is on its way: the seller would still get the value range, so nothing can be sent yet
    expect(sendBtn).toBeDisabled();
    expect(within(c).getByText('Saving your change. Send is back in a moment.')).toBeInTheDocument();
    await user().click(sendBtn);
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(0);
    answer();
    expect(await within(value).findByText('Removed: the seller will not see the value range.')).toBeInTheDocument();
    await waitFor(() => expect(sendBtn).toBeEnabled());
    expect(within(c).queryByText('Saving your change. Send is back in a moment.')).toBeNull();
    await user().click(sendBtn);
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ valueRemoved: true, recipientIds: [SAM] });
  });

  it('E797: Send is off while a removed feedback item is still saving, and back on when it is saved', async () => {
    let answer!: () => void;
    const unanswered = new Promise<void>((r) => { answer = r; });
    const u = update({ recommendation: REC });
    const fake = app(u, (f) => f.on(`PATCH /seller-updates/${UPDATE}`, async (c) => { await unanswered; return { status: 200, body: { update: { ...u, ...(c.body as object) } } }; }));
    const c = await card();
    const sendBtn = within(c).getByRole('button', { name: 'Send to Sam Ortiz' });
    expect(sendBtn).toBeEnabled();
    await user().click(within(c).getAllByRole('button', { name: /^Remove/ })[0]!);
    await waitFor(() => expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1));
    expect(sendBtn).toBeDisabled();
    answer();
    await waitFor(() => expect(sendBtn).toBeEnabled());
  });

  it('E797: typing the recommendation and going straight to Send still sends in one tap (the save on leaving the box does not switch Send off: the send carries the recommendation itself)', async () => {
    let answer!: () => void;
    const unanswered = new Promise<void>((r) => { answer = r; });
    const u = update();
    const fake = app(u, (f) => f
      .on(`PATCH /seller-updates/${UPDATE}`, async (c) => { await unanswered; return { status: 200, body: { update: { ...u, ...(c.body as object) } } }; })
      .on(`POST /seller-updates/${UPDATE}/send`, { status: 200, body: { actionId: UPDATE, status: 'approved', result: 'sent', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'sent' }] } }));
    const c = await card();
    await user().type(within(c).getByLabelText('Your recommendation (required)'), REC);
    await user().click(within(c).getByRole('button', { name: 'Send to Sam Ortiz' }));
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).toMatchObject({ recommendation: REC, recipientIds: [SAM] });
    answer();
  });

  it('E631: a removed value range can be put back, and a send then leaves the choice to the saved update', async () => {
    const fake = app(update({ recommendation: REC, valueRemoved: true, sections: [...update().sections, valueSection()] }));
    const c = await card();
    const value = within(c).getByRole('group', { name: 'Home value' });
    expect(within(value).getByText('Removed: the seller will not see the value range.')).toBeInTheDocument();
    await user().click(within(value).getByRole('button', { name: 'Put the value range back' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)[0]!.body).toEqual({ valueRemoved: false });
    expect(await within(value).findByRole('button', { name: 'Remove the value range' })).toBeInTheDocument();
    expect(within(value).queryByText('Removed: the seller will not see the value range.')).toBeNull();
    await user().click(within(c).getByRole('button', { name: 'Send to Sam Ortiz' }));
    await waitFor(() => expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)).toHaveLength(1));
    expect(fake.callsTo(`POST /seller-updates/${UPDATE}/send`)[0]!.body).not.toHaveProperty('valueRemoved');
  });

  it('E631: when the server refuses the removal the card says why, in words, and the value range stays in the update', async () => {
    const fake = app(update({ sections: [...update().sections, valueSection()] }), (f) => f.on(`PATCH /seller-updates/${UPDATE}`, err(409, 'ACTION_NOT_PENDING')));
    const c = await card();
    const value = within(c).getByRole('group', { name: 'Home value' });
    await user().click(within(value).getByRole('button', { name: 'Remove the value range' }));
    expect(await within(value).findByText('This update was already handled.')).toBeInTheDocument();
    expect(fake.callsTo(`PATCH /seller-updates/${UPDATE}`)).toHaveLength(1);
    expect(within(value).getByRole('button', { name: 'Remove the value range' })).toBeInTheDocument();
    expect(within(value).queryByText('Removed: the seller will not see the value range.')).toBeNull();
  });

  it('E631: no remove control for someone who cannot send the update, nor when the value section holds nothing the seller would read', async () => {
    app(update({ canSend: false, sections: [...update().sections, valueSection()] }));
    const readOnly = within(await card()).getByRole('group', { name: 'Home value' });
    expect(within(readOnly).queryByRole('button', { name: 'Remove the value range' })).toBeNull();
    cleanup();
    app(update({ sections: [...update().sections, { kind: 'value', title: 'Home value', state: 'unavailable', statement: 'Value range off: the MLS display rules are not reviewed yet.', lines: [], sources: [] }] }));
    const agentOnly = within(await card()).getByRole('group', { name: 'Home value' });
    expect(within(agentOnly).getByText('Value range off: the MLS display rules are not reviewed yet.')).toBeInTheDocument();
    expect(within(agentOnly).queryByRole('button', { name: 'Remove the value range' })).toBeNull();
  });

  it('review fix: a failed refresh says why instead of leaving the agent stuck', async () => {
    app(update({ stale: true }), (f) => f.on(`POST /seller-updates/${UPDATE}/reassemble`, err(409, 'DRAFT_INVALIDATED')));
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Refresh the update' }));
    expect(await within(c).findByText('This listing has a different agent now, so this update was withdrawn. Nothing was sent.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    app(update());
    const c = await card();
    const r = await axe.run(c, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('has no axe violations with the value range shown and with it removed', async () => {
    app(update({ sections: [...update().sections, valueSection()] }));
    const c = await card();
    expect((await axe.run(c, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
    await user().click(within(c).getByRole('button', { name: 'Remove the value range' }));
    await within(c).findByText('Removed: the seller will not see the value range.');
    expect((await axe.run(c, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
  });
});
