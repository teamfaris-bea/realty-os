// Module 64: the bulk confirm sheet tells the truth before Confirm (everyone selected is counted, skips by
// reason, one send per address, nothing to pre-tick), and the batch-text page shows the counsel text and
// lets only the Owner turn it on after re-auth and the typed attestation (R-PAR-33..R-PAR-42).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as batchTextSurface } from '../settings/batch-text/index.js';
import type { BulkActionView } from './api.js';
import { surface as bulkSurface } from './index.js';

const C = ['01900000-0000-7000-8000-00000000c001', '01900000-0000-7000-8000-00000000c002', '01900000-0000-7000-8000-00000000c003'];
const ACTION = '01900000-0000-7000-8000-0000000ba001';

function app(fake: FakeFetch, path: string, role: 'owner' | 'admin' | 'agent' = 'agent', reauthenticatedAt: string | null = null) {
  const s = sessionFixture({ reauthenticatedAt });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: tableWith(bulkSurface, batchTextSurface) });
}

const draft = (over: Partial<BulkActionView> = {}): BulkActionView => ({
  id: ACTION,
  kind: 'email',
  status: 'draft',
  mine: true,
  selected: 412,
  targetCount: 398,
  preflight: { RECIPIENT_OPTED_OUT: 9, NO_ADDRESS: 4, SHARED_ADDRESS: 1 },
  sharedAddresses: 1,
  counts: { selected: 412, done: 0, skipped: 14, blocked: 0, failed: 0, canceled: 0, pending: 398, byReason: { RECIPIENT_OPTED_OUT: 9, NO_ADDRESS: 4, SHARED_ADDRESS: 1 } },
  templateId: '01900000-0000-7000-8000-0000000071a1',
  templateVersion: 3,
  subject: 'New homes for {{contact.first_name}}',
  body: 'Hi {{contact.first_name}}, three new listings this week.',
  failureCode: null,
  createdAt: '2026-11-10T10:00:00Z',
  confirmedAt: null,
  finishedAt: null,
  ...over,
});

const templates = { status: 200, body: { templates: [{ id: '01900000-0000-7000-8000-0000000071a1', scope: 'team', mine: false, channel: 'email', name: 'New listings', subject: 'New homes', body: 'Hi', version: 3, mergeFields: [], archived: false, editable: false, updatedAt: '2026-11-10T10:00:00Z' }] } };

describe('R-PAR-33 R-PAR-38 R-PAR-41 the bulk confirm sheet', () => {
  it('R-PAR-41 template → Confirm: the counts by reason are shown before Confirm, and Confirm says exactly how many (2 taps in the sheet)', async () => {
    const fake = new FakeFetch()
      .on('GET /templates?channel=email', templates)
      .on('POST /bulk-actions', { status: 201, body: { action: draft() } })
      .on(`POST /bulk-actions/${ACTION}/confirm`, { status: 200, body: { action: draft({ status: 'confirmed', confirmedAt: '2026-11-10T10:01:00Z' }) } })
      .on(`GET /bulk-actions/${ACTION}`, { status: 200, body: { action: draft({ status: 'running' }) } });
    app(fake, `/bulk/new?kind=email&contacts=${C.join(',')}`);
    const u = userEvent.setup();
    let taps = 0;
    await u.click(await screen.findByRole('button', { name: /New listings/ }));
    taps += 1;
    const sheet = await screen.findByRole('dialog', { name: 'Email 398 of 412?' });
    const left = within(sheet).getByRole('region', { name: 'Left out (14)' });
    expect(within(left).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['9 opted out', '4 have no address for this', '1 share an address with someone already included (one message per address)']);
    expect(within(sheet).getByText('2 people share an address, so they get one email between them.')).toBeInTheDocument();
    expect(within(sheet).getByText(/an unsubscribe link are added/)).toBeInTheDocument();
    expect(within(sheet).getByText('Nobody who opted out can be included. Bulk messages don\'t count as touches on a lead.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('checkbox')).toBeNull(); // nothing to pre-tick
    const body = fake.callsTo('POST /bulk-actions')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'email', selection: { contactIds: C }, templateId: '01900000-0000-7000-8000-0000000071a1' });
    expect(typeof body['idempotencyKey']).toBe('string');
    await u.click(within(sheet).getByRole('button', { name: 'Email 398 people' }));
    taps += 1;
    await waitFor(() => expect(fake.callsTo(`POST /bulk-actions/${ACTION}/confirm`)).toHaveLength(1));
    expect(taps).toBe(2);
  });

  it('R-PAR-38 when everyone is left out there is nothing to confirm (the button is off and says why)', async () => {
    const fake = new FakeFetch().on('GET /templates?channel=email', templates).on('POST /bulk-actions', { status: 201, body: { action: draft({ targetCount: 0, selected: 2, preflight: { RECIPIENT_OPTED_OUT: 2 } }) } });
    app(fake, `/bulk/new?kind=email&contacts=${C.slice(0, 2).join(',')}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /New listings/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Email 0 of 2?' });
    expect(within(sheet).getByRole('button', { name: 'Email 0 people' })).toBeDisabled();
    expect(within(sheet).getByText('Everyone selected is left out, so there is nothing to email.')).toBeInTheDocument();
  });

  it('R-PAR-8 R-PAR-40 refusals come back in plain words (a protected audience; batch text off)', async () => {
    const fake = new FakeFetch().on('GET /templates?channel=sms', { status: 200, body: { templates: [{ ...templates.body.templates[0]!, channel: 'sms' }] } }).on('POST /bulk-actions', err(409, 'BATCH_TEXT_DISABLED'));
    app(fake, `/bulk/new?kind=text&contacts=${C[0]}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /New listings/ }));
    expect(await screen.findByText('Batch text is off. Only the Owner can turn it on, in Settings.')).toBeInTheDocument();
  });

  it('R-PAR-42 the progress page counts by reason and Cancel stops the rest', async () => {
    const running = draft({ status: 'running', counts: { selected: 412, done: 120, skipped: 14, blocked: 1, failed: 0, canceled: 0, pending: 277, byReason: { RECIPIENT_OPTED_OUT: 10, NO_ADDRESS: 4, SHARED_ADDRESS: 1 } } });
    const fake = new FakeFetch()
      .on(`GET /bulk-actions/${ACTION}`, { status: 200, body: { action: running } })
      .on(`POST /bulk-actions/${ACTION}/cancel`, { status: 200, body: { action: { ...running, status: 'canceled', counts: { ...running.counts, canceled: 277, pending: 0 } } } });
    app(fake, `/bulk/${ACTION}`);
    expect(await screen.findByRole('heading', { name: 'Emailed 120 of 412' })).toBeInTheDocument();
    expect(screen.getByText(/277 still to go/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Why people were left out' })).getAllByRole('listitem')[0]!.textContent).toBe('10 opted out');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel the rest' }));
    expect(await screen.findByText('Canceled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel the rest' })).toBeNull();
  });
});

describe('R-PAR-40 the batch-text settings page', () => {
  const page = (enabled = false) => ({
    status: 200,
    body: { batchText: { enabled, counselText: 'Batch text sends one marketing text.\n\nRealty OS does not check consent before a text.\n\nSome state laws, for example Florida\'s FTSA and Oklahoma\'s act, regulate automated texts.', attestation: 'I have reviewed batch texting with counsel and accept responsibility', maxRecipients: 200 } },
  });

  it('R-PAR-40 shows the counsel text before the switch; the Owner types the attestation; a stale session is asked to re-authenticate', async () => {
    let n = 0;
    const fake = new FakeFetch().on('GET /batch-text', page()).on('PUT /batch-text', () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : page(true)));
    app(fake, '/settings/batch-text', 'owner');
    expect(await screen.findByRole('heading', { name: 'Batch text is off' })).toBeInTheDocument();
    expect(screen.getByText(/Florida's FTSA and Oklahoma's act/)).toBeInTheDocument();
    expect(screen.getByText('Realty OS does not check consent before a text.')).toBeInTheDocument();
    expect(screen.getByText('This note is not legal advice. Confirm it with your counsel.')).toBeInTheDocument();
    const on = screen.getByRole('button', { name: 'Turn batch text on' });
    expect(on).toBeDisabled();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/To turn it on, type/), 'i have reviewed batch texting with counsel and accept responsibility');
    expect(on).toBeEnabled();
    await u.click(on);
    // R-PERM-13: the server asked for a fresh password; the shell's prompt opens
    expect(await screen.findByRole('dialog', { name: /Confirm it's you|password/i })).toBeInTheDocument();
    expect(fake.callsTo('PUT /batch-text')[0]!.body).toEqual({ enabled: true, attestation: 'i have reviewed batch texting with counsel and accept responsibility' });
  });

  it('R-PAR-40 an Admin reads the same text and can only turn it off', async () => {
    const fake = new FakeFetch().on('GET /batch-text', page(false));
    app(fake, '/settings/batch-text', 'admin');
    expect(await screen.findByText('Only the Owner can turn batch text on.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn batch text on' })).toBeNull();
    const fake2 = new FakeFetch().on('GET /batch-text', page(true)).on('PUT /batch-text', page(false));
    app(fake2, '/settings/batch-text', 'admin');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Turn batch text off' }));
    await waitFor(() => expect(fake2.callsTo('PUT /batch-text')[0]!.body).toEqual({ enabled: false }));
  });
});
