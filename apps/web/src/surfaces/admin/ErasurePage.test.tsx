// Erasing a contact (R-DATA-4, E59) in jsdom against a scripted API. The rules themselves (refusal
// while the person is on any deal, Owner-only removal of a deal link, DEAL_STILL_OPEN for the primary
// contact of an open deal, R-PERM-13 re-auth) are enforced and proven by api/admin erasure.test.ts and
// the database; these tests prove the page explains the refusal, offers only what the viewer may do,
// asks for an explicit confirmation naming the person, and words every refusal. VERIFY WITH COUNSEL.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, ID, err, leadAdminApp } from './lib/testing.js';

const C = ID.pat;
const DEAL = '01900000-0000-7000-8000-0000000d0001';
const PATH = `/admin/erasure?contact=${C}`;
const closedDeal = { id: DEAL, name: 'Maple St purchase', stage: 'closed', link: 'primary_and_party', closed: true };
const onDeal = { contactId: C, erasable: false, deals: [closedDeal] };
const free = { contactId: C, erasable: true, deals: [] };

/** The server's current answer to GET /erasure; a POST handler changes it the way the server would. */
function erasureFake(state: { preview: unknown }) {
  return new FakeFetch()
    .on(`GET /contacts/${C}`, { status: 200, body: { contact: { id: C, view: 'full', displayName: 'Rosa Diaz' } } })
    .on(`GET /contacts/${C}/erasure`, () => ({ status: 200, body: state.preview }));
}

describe('Erase a contact', () => {
  it('E59 R-DATA-4: a contact on a closed deal is explained, not erasable; the Owner removes the deal link, then erasure is offered', async () => {
    const state = { preview: onDeal as unknown };
    const fake = erasureFake(state).on(`POST /contacts/${C}/deals/${DEAL}/remove`, () => {
      state.preview = free;
      return { status: 200, body: { removed: true } };
    });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText(/Rosa Diaz is on 1 deal, so they can't be erased yet/)).toBeInTheDocument();
    const deal = screen.getByText('Maple St purchase').closest('li')!;
    expect(within(deal).getByText(/Closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Erase/ })).toBeNull();
    await u.click(within(deal).getByRole('button', { name: 'Remove from this deal' }));
    await u.click(within(deal).getByRole('button', { name: 'Remove Rosa Diaz from Maple St purchase' }));
    expect(await screen.findByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
    expect(screen.getByText('Rosa Diaz was removed from Maple St purchase. The deal record stays.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${C}/deals/${DEAL}/remove`).map((c) => c.body)).toEqual([{ reason: 'PRIVACY_REQUEST' }]);
    expect(fake.callsTo(`POST /contacts/${C}/erase`)).toHaveLength(0);
  });

  it('E59 R-DATA-4: an Admin sees the same explanation, is told only the Owner can remove someone from a deal, and gets no button', async () => {
    leadAdminApp(erasureFake({ preview: onDeal }), PATH, 'admin');
    expect(await screen.findByText(/Rosa Diaz is on 1 deal, so they can't be erased yet/)).toBeInTheDocument();
    expect(screen.getByText('Maple St purchase')).toBeInTheDocument();
    expect(screen.getByText(/Only the account Owner can remove someone from a deal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from this deal' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Erase/ })).toBeNull();
  });

  it('E59 R-DATA-4: erasing needs an explicit confirmation naming the person, sends the reason, and says honestly that it is done', async () => {
    const fake = erasureFake({ preview: free }).on(`POST /contacts/${C}/erase`, { status: 200, body: { erased: true } });
    leadAdminApp(fake, PATH, 'admin');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText('Reason'), 'DUPLICATE_RECORD');
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    expect(fake.callsTo(`POST /contacts/${C}/erase`)).toHaveLength(0);
    const confirm = screen.getByRole('group', { name: 'Erase Rosa Diaz permanently?' });
    expect(within(confirm).getByText(/This can't be undone/)).toBeInTheDocument();
    await u.click(within(confirm).getByRole('button', { name: 'Yes, erase Rosa Diaz' }));
    expect(await screen.findByText('Rosa Diaz was erased.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${C}/erase`).map((c) => c.body)).toEqual([{ reason: 'DUPLICATE_RECORD' }]);
  });

  it('R-DATA-4: the page says before the tap that the duplicate records merged into the person are erased with them; nothing is said when there are none', async () => {
    leadAdminApp(erasureFake({ preview: { ...free, mergedRecords: 2 } }), PATH, 'owner');
    expect(await screen.findByText('2 duplicate records were merged into Rosa Diaz. Erasing Rosa Diaz erases them too.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
  });

  it('R-DATA-4: one merged duplicate is named in the singular', async () => {
    leadAdminApp(erasureFake({ preview: { ...free, mergedRecords: 1 } }), PATH, 'admin');
    expect(await screen.findByText('1 duplicate record was merged into Rosa Diaz. Erasing Rosa Diaz erases it too.')).toBeInTheDocument();
  });

  it('R-DATA-4: no merged records, no sentence about them', async () => {
    leadAdminApp(erasureFake({ preview: { ...free, mergedRecords: 0 } }), PATH, 'owner');
    expect(await screen.findByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
    expect(screen.queryByText(/duplicate record/)).toBeNull();
  });

  it('E59 R-DATA-4: cancelling the confirmation sends nothing', async () => {
    const fake = erasureFake({ preview: free });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Erase Rosa Diaz permanently?' })).toBeNull();
    expect(fake.callsTo(`POST /contacts/${C}/erase`)).toHaveLength(0);
  });

  it('E59 R-DATA-4: a CONTACT_ON_DEAL refusal from erase (a deal appeared meanwhile) shows the sentence and reloads the deal list', async () => {
    const state = { preview: free as unknown };
    const fake = erasureFake(state).on(`POST /contacts/${C}/erase`, () => {
      state.preview = onDeal; // a deal link appeared after the page loaded
      return err(409, 'CONTACT_ON_DEAL', { deals: [{ id: DEAL, stage: 'closed' }] });
    });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, erase Rosa Diaz' }));
    expect(await screen.findByText("This person is on a deal, so they can't be erased yet. The deal is a transaction record and stays; the Owner removes them from the deal first.")).toBeInTheDocument();
    expect(await screen.findByText('Maple St purchase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erase Rosa Diaz' })).toBeNull();
    expect(document.body.textContent).not.toContain('CONTACT_ON_DEAL');
  });

  it('D1 R-DATA-4: a PERSON_DO_NOT_CONTACT_UNCARRIED refusal (their do-not-contact cannot be kept on every address) says in words that nothing was erased, never the code; they are still there to erase later', async () => {
    const fake = erasureFake({ preview: free }).on(`POST /contacts/${C}/erase`, err(409, 'PERSON_DO_NOT_CONTACT_UNCARRIED'));
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, erase Rosa Diaz' }));
    expect(await screen.findByText("This person asked not to be contacted, and Realty OS can't keep that on every one of their addresses yet, so they weren't erased. Nothing was changed.")).toBeInTheDocument();
    expect(screen.queryByText('Rosa Diaz was erased.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PERSON_DO_NOT_CONTACT_UNCARRIED');
  });

  it('E59 R-DATA-4: DEAL_STILL_OPEN tells the Owner to change the primary contact on the deal first', async () => {
    const fake = erasureFake({ preview: onDeal }).on(`POST /contacts/${C}/deals/${DEAL}/remove`, err(409, 'DEAL_STILL_OPEN'));
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    const deal = (await screen.findByText('Maple St purchase')).closest('li')!;
    await u.click(within(deal).getByRole('button', { name: 'Remove from this deal' }));
    await u.click(within(deal).getByRole('button', { name: 'Remove Rosa Diaz from Maple St purchase' }));
    expect(await screen.findByText("This person is the primary contact of a deal that is still open. Change the primary contact on the deal first, then remove them here.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('DEAL_STILL_OPEN');
  });

  it('E59: on an open deal where the person is the primary contact, the page says so up front instead of offering a removal that would be refused', async () => {
    const open = { contactId: C, erasable: false, deals: [{ ...closedDeal, stage: 'under_contract', link: 'primary', closed: false }] };
    leadAdminApp(erasureFake({ preview: open }), PATH, 'owner');
    const deal = (await screen.findByText('Maple St purchase')).closest('li')!;
    expect(within(deal).getByText(/Under contract/)).toBeInTheDocument();
    expect(within(deal).getByText(/Change the primary contact on the deal first/)).toBeInTheDocument();
    expect(within(deal).queryByRole('button', { name: 'Remove from this deal' })).toBeNull();
    expect(within(deal).getByRole('link', { name: 'Open Maple St purchase' })).toHaveAttribute('href', `/deals/${DEAL}`);
  });

  it('E59 R-DATA-4 R-PERM-13: REAUTH_REQUIRED asks for the password once, then loads what erasing needs', async () => {
    let n = 0;
    const fake = new FakeFetch()
      .on(`GET /contacts/${C}`, { status: 200, body: { contact: { id: C, view: 'full', displayName: 'Rosa Diaz' } } })
      .on(`GET /contacts/${C}/erasure`, () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: onDeal }))
      .on('POST /auth/reauth', { status: 200, body: { session: { user: { id: ID.me, email: 'me@example.test', displayName: 'Me' }, tenant: { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role: 'owner' }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'csrf-2' } } });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Maple St purchase')).toBeInTheDocument();
    expect(fake.callsTo(`GET /contacts/${C}/erasure`).length).toBeGreaterThanOrEqual(2);
    expect(fake.callsTo('POST /auth/reauth')).toHaveLength(1);
  });

  it('E59 R-PERM-13: an erase that needs the password again asks once and sends the same request', async () => {
    let n = 0;
    const fake = erasureFake({ preview: free })
      .on(`POST /contacts/${C}/erase`, () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { erased: true } }))
      .on('POST /auth/reauth', { status: 200, body: { session: { user: { id: ID.me, email: 'me@example.test', displayName: 'Me' }, tenant: { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role: 'owner' }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'csrf-2' } } });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, erase Rosa Diaz' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Rosa Diaz was erased.')).toBeInTheDocument();
    const calls = fake.callsTo(`POST /contacts/${C}/erase`);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  // b11 review (module 42 documents meets erasure): db-public/F2, ownership-data/F4, api-ui/F3, ownership-data/F2, ownership-data/F5
  const SURVIVOR = '01900000-0000-7000-8000-0000000c0002';
  const DOC_HELD = '01900000-0000-7000-8000-0000000a0001';
  const DOC_KEPT = '01900000-0000-7000-8000-0000000a0002';
  const LISTING = '01900000-0000-7000-8000-0000000b0001';
  const retained = {
    ...free,
    erasable: false,
    retainedDocuments: [
      { id: DOC_HELD, contactId: C, legalHold: true, retentionUntil: null },
      { id: DOC_KEPT, contactId: C, legalHold: false, retentionUntil: '2030-11-12T12:00:00.000Z' },
    ],
  };

  it('R-DOC-4 R-DATA-4: a held or retained document is said before any tap: which documents, why, who can lift a hold, and that a retention date only moves; no erase step is offered', async () => {
    leadAdminApp(erasureFake({ preview: retained }), PATH, 'owner');
    expect(await screen.findByText(/Rosa Diaz can't be erased yet: 2 of their documents are on legal hold or inside their retention period/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Documents that keep Rosa Diaz' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['A document on legal hold', 'A document kept until Nov 12, 2030']);
    expect(screen.getByText(/An Owner or Admin can lift a legal hold\. A retention date can be moved to between 3 and 10 years after the file was uploaded, but not removed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Erase/ })).toBeNull();
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });

  it('R-DOC-4 R-DATA-4: a DOCUMENT_RETAINED refusal from erase (a hold placed meanwhile) says in words that nothing was erased and why, never the generic "try again", and reloads what erasing needs', async () => {
    const state = { preview: free as unknown };
    const fake = erasureFake(state).on(`POST /contacts/${C}/erase`, () => {
      state.preview = retained;
      return err(409, 'DOCUMENT_RETAINED', { documents: [{ id: DOC_HELD, legalHold: true, retentionUntil: null }] });
    });
    leadAdminApp(fake, PATH, 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Erase Rosa Diaz' }));
    await u.click(screen.getByRole('button', { name: 'Yes, erase Rosa Diaz' }));
    expect(await screen.findByText('A document of this person is on legal hold or inside its retention period, so nothing was erased. The documents are listed below.')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Documents that keep Rosa Diaz' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erase Rosa Diaz' })).toBeNull();
    expect(document.body.textContent).not.toContain('DOCUMENT_RETAINED');
    expect(document.body.textContent).not.toMatch(/Try again in a moment/);
  });

  it('R-DATA-4 R-DATA-7: a merged-away record says the person now lives on the record it was merged into, links there, and does not claim to erase what moved', async () => {
    leadAdminApp(erasureFake({ preview: { ...free, mergedInto: SURVIVOR } }), PATH, 'owner');
    expect(await screen.findByText(/Rosa Diaz is a duplicate record that was merged into another record\. Its messages, notes, tasks and appointments moved there, and its phones and emails were copied there: erasing this record leaves all of those in place/)).toBeInTheDocument();
    expect(screen.getByText(/To erase the person, erase the record it was merged into/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the record it was merged into' })).toHaveAttribute('href', `/admin/erasure?contact=${SURVIVOR}`);
    expect(screen.queryByText(/such as messages and call recordings/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
  });

  it('R-DATA-7: a seller\'s listing documents are said to stay after the erasure, by listing', async () => {
    leadAdminApp(erasureFake({ preview: { ...free, listingDocuments: [{ listingId: LISTING, address: '12 Harbor Rd', documents: 2 }] } }), PATH, 'admin');
    expect(await screen.findByText(/Rosa Diaz is a seller on a listing with documents, such as a listing agreement\. Those documents belong to the listing's records and stay after the erasure, readable by the people who work on that listing; they may name Rosa Diaz\./)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Listing documents that stay' })).getByText('12 Harbor Rd: 2 documents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
  });

  it('finds a contact by search and opens it on this page', async () => {
    const fake = erasureFake({ preview: free }).on('GET /search?q=Rosa', {
      status: 200,
      body: { contacts: [{ id: C, name: 'Rosa Diaz', view: 'full', ownershipState: 'owned', matchedOn: 'name' }], listings: [], deals: [], notes: [], messages: [], incomplete: [] },
    });
    leadAdminApp(fake, '/admin/erasure', 'owner');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Find the contact'), 'Rosa');
    await u.click(await screen.findByRole('button', { name: /Rosa Diaz/ }));
    expect(await screen.findByRole('button', { name: 'Erase Rosa Diaz' })).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${C}/erasure`).length).toBeGreaterThan(0));
  });
});
