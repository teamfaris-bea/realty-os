// The seller-update card (module 38, 2B) in jsdom on a scripted API: R-SELL-2 (every figure sourced and
// dated), R-SELL-3 / E88 (the recommendation is required and never prefilled), R-SELL-4 (stale data says so
// and offers one tap to refresh), R-SELL-5 (an opted-out seller is shown before the tap, never after),
// E89 (feedback verbatim, removable, a named person flagged). The real API runs in e2e/seller-updates.
import { screen, waitFor, within } from '@testing-library/react';
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
});
