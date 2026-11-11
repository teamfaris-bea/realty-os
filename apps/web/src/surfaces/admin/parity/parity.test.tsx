// Admin parity pages in jsdom (module 61): the tag catalog commands (rename/color/protect, merge, delete),
// the custom field sheet (types, every-year dates, choices; the protected-trait refusal points at the
// self-reported details) and stage labels (module 57's GET/PUT /stage-labels).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { surface } from './index.js';

const T1 = '01900000-0000-7000-8000-0000000000b1';
const T2 = '01900000-0000-7000-8000-0000000000b2';
const tags = { tags: [{ id: T1, name: 'Hot', color: 'red', protected: false, createdByKind: 'user', usage: 12 }, { id: T2, name: 'A-Lead', color: null, protected: true, createdByKind: 'user', usage: 3 }] };

function app(fake: FakeFetch, path: string, role: 'owner' | 'admin' | 'agent' = 'admin') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: tableWith(surface) });
}

describe('Admin → Tags (R-PAR-9)', () => {
  it('R-PAR-9: merge "Hot" into "A-Lead" says what happens, posts the merge and reports the counts', async () => {
    const fake = new FakeFetch().on('GET /tags', { status: 200, body: tags }).on(`POST /tags/${T1}/merge`, { status: 200, body: { tag: tags.tags[1], moved: 12, alreadyTagged: 2, listsRewritten: 1 } });
    app(fake, '/admin/tags');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Merge Hot' }));
    const d = await screen.findByRole('dialog', { name: 'Merge "Hot"' });
    expect(d).toHaveTextContent(/lists that use "Hot" switch to it/);
    await user.selectOptions(within(d).getByLabelText('Merge into'), T2);
    await user.click(within(d).getByRole('button', { name: 'Merge into "A-Lead"' }));
    await waitFor(() => expect(fake.callsTo(`POST /tags/${T1}/merge`)[0]?.body).toEqual({ intoTagId: T2 }));
  });

  it('R-PAR-8: an Admin cannot lift a protection (the box is locked and says only the Owner can); the Owner can', async () => {
    const fake = new FakeFetch().on('GET /tags', { status: 200, body: tags });
    app(fake, '/admin/tags', 'admin');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit A-Lead' }));
    const d = await screen.findByRole('dialog');
    expect(within(d).getByRole('checkbox', { name: /Fair-housing protected/ })).toBeDisabled();
    expect(within(d).getByText('Only the Owner can lift a protection.')).toBeInTheDocument();
  });

  it('delete says how many people lose the tag', async () => {
    const fake = new FakeFetch().on('GET /tags', { status: 200, body: tags }).on(`DELETE /tags/${T1}`, { status: 200, body: { deleted: true, removedLinks: 12 } });
    app(fake, '/admin/tags');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Hot' }));
    expect(await screen.findByRole('dialog', { name: 'Delete "Hot"?' })).toHaveTextContent('It comes off 12 people.');
  });

  it('agents are not shown the admin pages', async () => {
    app(new FakeFetch(), '/admin/tags', 'agent');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
  });
});

describe('Admin → Custom fields (R-PAR-17, R-PAR-18)', () => {
  it('R-PAR-18 E175: "Military status" is refused with the pointer to the self-reported details', async () => {
    const fake = new FakeFetch().on('GET /custom-fields', { status: 200, body: { fields: [], liveCount: 0, limit: 50 } }).on('POST /custom-fields', err(422, 'CUSTOM_FIELD_PROTECTED', { path: '/label' }));
    app(fake, '/admin/fields');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New field' }));
    await user.type(await screen.findByLabelText('Name'), 'Military status');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(await screen.findByText(/Use the built-in self-reported details on the person instead/)).toBeInTheDocument();
  });

  it('R-PAR-17 R-PAR-20: a date can repeat every year; choices are one per line', async () => {
    const fake = new FakeFetch().on('GET /custom-fields', { status: 200, body: { fields: [], liveCount: 0, limit: 50 } }).on('POST /custom-fields', { status: 201, body: { field: {} } });
    app(fake, '/admin/fields');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New field' }));
    await user.type(await screen.findByLabelText('Name'), 'Birthday');
    await user.selectOptions(screen.getByLabelText('Type'), 'date');
    await user.click(screen.getByRole('checkbox', { name: /Repeats every year/ }));
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(fake.callsTo('POST /custom-fields')[0]?.body).toEqual({ label: 'Birthday', fieldType: 'date', annual: true }));
  });

  it('R-PAR-17: at the limit, New field is disabled and the page shows "50 of 50"', async () => {
    const fake = new FakeFetch().on('GET /custom-fields', { status: 200, body: { fields: [], liveCount: 50, limit: 50 } });
    app(fake, '/admin/fields');
    expect(await screen.findByText(/50 of 50 fields in use/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New field' })).toBeDisabled();
  });
});

describe('Admin → Stage labels (R-PAR-13)', () => {
  const stages = (labels: Record<string, string>) => ({
    labels,
    stages: ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'].map((key) => ({ key, label: labels[key] ?? key })),
  });

  it('R-PAR-13: reads module 57\'s GET /stage-labels and saves the whole set with PUT /stage-labels (an emptied field goes back to the default)', async () => {
    const fake = new FakeFetch().on('GET /stage-labels', { status: 200, body: stages({ nurture: 'Long term' }) }).on('PUT /stage-labels', (c) => ({ status: 200, body: stages((c.body as { labels: Record<string, string> }).labels) }));
    app(fake, '/admin/stage-labels');
    const user = userEvent.setup();
    const nurture = await screen.findByLabelText('Nurture');
    expect(nurture).toHaveValue('Long term');
    await user.clear(nurture);
    await user.type(screen.getByLabelText('New'), '  Fresh lead ');
    await user.click(screen.getByRole('button', { name: 'Save labels' }));
    await waitFor(() => expect(fake.callsTo('PUT /stage-labels')[0]?.body).toEqual({ labels: { new: 'Fresh lead' } }));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Stage labels saved'));
    expect(screen.queryByText(/can't be saved yet/)).toBeNull();
    expect(fake.callsTo('GET /settings/stage-labels')).toHaveLength(0);
  });

  it('R-PAR-13: a refused label says why in plain words', async () => {
    const fake = new FakeFetch().on('GET /stage-labels', { status: 200, body: stages({}) }).on('PUT /stage-labels', err(422, 'STAGE_LABEL_INVALID'));
    app(fake, '/admin/stage-labels');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Lost'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save labels' }));
    expect(await screen.findByText('Each stage label is 1 to 24 characters.')).toBeInTheDocument();
  });
});
