// Brokerage and team settings in jsdom. Identity and recording settings are Owner-only (R-PERM-3,
// enforced by the server's trigger and can()); the page shows them read-only to an Admin, and says
// plainly that marketing email is held while the postal address is missing (R-GATE-12 display half).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp, settings } from '../admin/lib/testing.js';

const fake = () => new FakeFetch().on('GET /settings', { status: 200, body: { settings } });

describe('Brokerage and team settings', () => {
  it('while the postal address is missing it says marketing email is on hold', async () => {
    leadAdminApp(fake(), '/settings/team', 'owner');
    expect(await screen.findByText('Marketing email is on hold')).toBeInTheDocument();
  });

  it('an Admin sees brokerage and recording settings read-only', async () => {
    leadAdminApp(fake(), '/settings/team', 'admin');
    expect(await screen.findByText('Harbor Realty LLC')).toBeInTheDocument();
    expect(screen.getAllByText('Only the Owner can change these.')).toHaveLength(2);
    expect(screen.queryByLabelText('Brokerage legal name')).toBeNull();
    expect(screen.queryByLabelText('Keep recordings for (days)')).toBeNull();
    expect(screen.getByLabelText('Use the assistant')).toBeInTheDocument();
  });

  it('the Owner saves only the changed identity fields with the settings version; the legal name cannot be blank', async () => {
    const f = fake().on('PATCH /settings/identity', { status: 200, body: { settings: { ...settings, version: 8 } } });
    leadAdminApp(f, '/settings/team', 'owner');
    const u = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Save brokerage details' });
    expect(save).toBeDisabled();
    await u.type(screen.getByLabelText('Brokerage postal address'), '1 Harbor Way, Oakland CA 94607');
    await u.click(save);
    await waitFor(() => expect(f.callsTo('PATCH /settings/identity')).toHaveLength(1));
    expect(f.callsTo('PATCH /settings/identity')[0]!.body).toEqual({ brokeragePostalAddress: '1 Harbor Way, Oakland CA 94607', version: 7 });
    await u.clear(screen.getByLabelText('Brokerage legal name'));
    expect(save).toBeDisabled();
  });

  it('turning the assistant off says what that means and sends aiEnabled: false', async () => {
    const f = fake().on('PATCH /settings', { status: 200, body: { settings: { ...settings, aiEnabled: false, version: 8 } } });
    leadAdminApp(f, '/settings/team', 'admin');
    const u = userEvent.setup();
    expect(await screen.findByText(/the assistant writes nothing and sends nothing/)).toBeInTheDocument();
    await u.click(screen.getByLabelText('Use the assistant'));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(f.callsTo('PATCH /settings')).toHaveLength(1));
    expect(f.callsTo('PATCH /settings')[0]!.body).toEqual({ aiEnabled: false, version: 7 });
  });
});
