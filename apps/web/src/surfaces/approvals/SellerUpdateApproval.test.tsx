// The seller-update approval card type (module 38): in the approvals inbox a listing-bound seller update renders
// the same card as the listing page (recipients before the tap, recommendation required), not the generic
// one-tap draft card, so Send is never one tap without the agent's recommendation (R-AST-17, R-SELL-3).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, agentApp, draftAction } from '../feed/lib/testing.js';
import type { ActionView } from '../feed/lib/types.js';

const ID = '01900000-0000-7000-8000-0000000a5e12';
const LISTING = '01900000-0000-7000-8000-0000000115a2';

describe('Approvals: the seller-update card type', () => {
  it('R-AST-17: a seller update in the inbox opens as the seller card, with Send off until the agent writes a recommendation', async () => {
    const a: ActionView = { ...draftAction(), id: ID, kind: 'seller_update_draft', category: 'seller_update', contactId: null, contactName: null, explanation: 'Update for 12 Oak St this week.' };
    const update = {
      id: ID, listingId: LISTING, address: '12 Oak St', status: 'proposed', canSend: true,
      period: { start: '2026-11-04T00:00:00Z', end: '2026-11-11T00:00:00Z', key: '2026-11-04', label: 'this week', text: 'Nov 4 – Nov 10, 2026' },
      assembledThrough: '2026-11-11T00:00:00Z', stale: false, sections: [], recommendation: '', excludedFeedbackIds: [],
      recipients: [{ contactId: '01900000-0000-7000-8000-00000000c103', name: 'Sam Ortiz', role: 'seller', channel: 'email', addressHint: 's•••@example.test', visible: true, ownedByYou: true, sendable: true, personDoNotContact: false, whyNot: null }],
      preview: { channel: 'email', subject: 's', body: 'b' }, sentAt: null, delivery: null,
    };
    const fake = new FakeFetch().on('GET /assistant/inbox', { status: 200, body: { items: [a] } }).on(`GET /seller-updates/${ID}`, { status: 200, body: { update } });
    agentApp(fake, '/approvals');
    const card = (await screen.findByRole('heading', { name: 'Seller update this week' })).closest('section')!;
    expect(within(card).getByRole('button', { name: 'Send to Sam Ortiz' })).toBeDisabled();
    expect(within(card).getByLabelText('Your recommendation (required)')).toHaveValue('');
    expect(fake.callsTo(`POST /assistant/actions/${ID}/approve`)).toHaveLength(0);
  });

  it('review fix: after Send the card stays on the page with each seller\'s outcome, though the update has left the pending inbox', async () => {
    const a: ActionView = { ...draftAction(), id: ID, kind: 'seller_update_draft', category: 'seller_update', contactId: null, contactName: null, explanation: 'Update for 12 Oak St this week.' };
    const SAM = '01900000-0000-7000-8000-00000000c103';
    const update = {
      id: ID, listingId: LISTING, address: '12 Oak St', status: 'proposed', canSend: true,
      period: { start: '2026-11-04T00:00:00Z', end: '2026-11-11T00:00:00Z', key: '2026-11-04', label: 'this week', text: 'Nov 4 – Nov 10, 2026' },
      assembledThrough: '2026-11-11T00:00:00Z', stale: false, sections: [], recommendation: 'Hold the price two more weeks, then revisit.', excludedFeedbackIds: [],
      recipients: [{ contactId: SAM, name: 'Sam Ortiz', role: 'seller', channel: 'email', addressHint: 's•••@example.test', visible: true, ownedByYou: true, sendable: true, personDoNotContact: false, whyNot: null }],
      preview: { channel: 'email', subject: 's', body: 'b' }, sentAt: null, delivery: null,
    };
    let sent = false;
    const fake = new FakeFetch()
      .on('GET /assistant/inbox', () => ({ status: 200, body: { items: sent ? [] : [a] } }))
      .on(`GET /seller-updates/${ID}`, { status: 200, body: { update } })
      .on(`POST /seller-updates/${ID}/send`, () => {
        sent = true;
        return { status: 200, body: { actionId: ID, status: 'approved', result: 'blocked', messageId: 'm1', recipients: [{ contactId: SAM, messageId: 'm1', result: 'blocked' }] } };
      });
    agentApp(fake, '/approvals');
    const card = (await screen.findByRole('heading', { name: 'Seller update this week' })).closest('section')!;
    const n = fake.callsTo('GET /assistant/inbox').length;
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Send to Sam Ortiz' }));
    await waitFor(() => expect(fake.callsTo('GET /assistant/inbox').length).toBeGreaterThan(n));
    expect(await screen.findByText('Sam Ortiz: Not sent: blocked when sending')).toBeInTheDocument();
  });
});
