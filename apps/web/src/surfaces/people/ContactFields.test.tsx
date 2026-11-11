// A person's custom field values on their page (PARITY_PLAN §5; journey bug: imported values were served by GET
// /contacts/:id/fields and shown nowhere): in the Details slot of module 58's registry, each value in its field's
// own terms; editable only when the details say the viewer may edit the person (contact.edit), saving exactly
// what module 60's PUT /contacts/:id/fields/:fieldId accepts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { DetailsSlots } from '../contact/slots.js';
import { ContactSections, contactSections } from '../contact/sections.js';
import { AgentSheetsProvider } from '../feed/lib/AgentSheets.js';
import { fullContact } from '../feed/lib/testing.js';
import { ContactFields, type FieldValueView, fieldValueText, valueOfDraft } from './ContactFields.js';
import type { FieldDefView } from './api.js';
import { surface as peopleSurface } from './index.js';

const C = '01900000-0000-7000-8000-0000000c0009';
const F = (n: number) => `01900000-0000-7000-8000-0000000f000${n}`;
const def = (n: number, over: Partial<FieldDefView>): FieldDefView => ({ id: F(n), key: `k${n}`, label: `Field ${n}`, fieldType: 'text', options: [], annual: false, position: n, origin: 'fub_import', archived: false, ...over });
const DEFS = [
  def(1, { key: 'fub_lead_score', label: 'Lead score', fieldType: 'number' }),
  def(2, { key: 'fub_closing_date', label: 'Closing date', fieldType: 'date' }),
  def(3, { key: 'fub_timeline', label: 'Timeline', fieldType: 'single_select', options: [{ id: 'o1', label: '0-3 months', archived: false }, { id: 'o2', label: '3-6 months', archived: false }] }),
  def(4, { key: 'fub_interests', label: 'Interests', fieldType: 'multi_select', options: [{ id: 'p1', label: 'Pool', archived: false }, { id: 'g1', label: 'Garage', archived: false }] }),
  def(5, { key: 'notes_field', label: 'Old field', fieldType: 'text', archived: true }),
];
const val = (n: number, over: Partial<FieldValueView>): FieldValueView => ({ fieldId: F(n), text: null, number: null, date: null, optionIds: null, updatedByKind: 'import', updatedAt: '2026-11-10T12:00:00Z', ...over });
const VALUES = [val(1, { number: 87 }), val(2, { date: '2026-12-15' }), val(3, { optionIds: ['o1'] }), val(4, { optionIds: ['p1', 'g1'] }), val(5, { text: 'archived value' })];

function fake() {
  return new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on('GET /custom-fields', { status: 200, body: { fields: DEFS, liveCount: 4, limit: 50 } })
    .on(`GET /contacts/${C}/fields`, { status: 200, body: { values: VALUES } });
}

function mount(f: FakeFetch, node: React.ReactNode) {
  const api = new ApiClient({ fetch: f.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith(peopleSurface)}>
        <MemoryRouter>{node}</MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
}

describe("a person's custom fields (PARITY_PLAN §5, R-PAR-17..20)", () => {
  it('says each value in its field\'s own terms, and maps an edit to what the API accepts', () => {
    expect(fieldValueText(DEFS[0]!, VALUES[0])).toBe('87');
    expect(fieldValueText(DEFS[1]!, VALUES[1])).toBe('Dec 15, 2026');
    expect(fieldValueText(DEFS[1]!, val(2, { date: '2026-12-15T00:00:00.000Z' }))).toBe('Dec 15, 2026');
    expect(fieldValueText(DEFS[2]!, VALUES[2])).toBe('0-3 months');
    expect(fieldValueText(DEFS[3]!, VALUES[3])).toBe('Pool, Garage');
    expect(fieldValueText(DEFS[0]!, undefined)).toBeNull();
    expect(valueOfDraft({ fieldType: 'number' }, '1,250')).toBe(1250);
    expect(valueOfDraft({ fieldType: 'text' }, '   ')).toBeNull();
    expect(valueOfDraft({ fieldType: 'multi_select' }, [])).toEqual([]);
  });

  it('read-only for someone who may not edit the person: the live fields with values, no Edit', async () => {
    const f = fake();
    mount(f, <ContactFields contactId={C} name="Ana Imported" canEdit={false} />);
    expect(await screen.findByText('Lead score')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();
    expect(screen.getByText('Dec 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('0-3 months')).toBeInTheDocument();
    expect(screen.getByText('Pool, Garage')).toBeInTheDocument();
    // an archived field is not shown
    expect(screen.queryByText('Old field')).toBeNull();
    expect(screen.queryByText('archived value')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit fields/ })).toBeNull();
  });

  it('editable for someone who may edit the person: Save sends only the changed values, each as module 60 accepts it', async () => {
    const f = fake().on(`PUT /contacts/${C}/fields/${F(1)}`, { status: 200, body: { value: val(1, { number: 90 }), changed: true } }).on(`PUT /contacts/${C}/fields/${F(4)}`, { status: 200, body: { value: val(4, { optionIds: ['p1'] }), changed: true } });
    mount(f, <ContactFields contactId={C} name="Ana Imported" canEdit />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit fields of Ana Imported' }));
    const sheet = screen.getByRole('dialog', { name: 'Fields for Ana Imported' });
    const score = within(sheet).getByLabelText('Lead score');
    await user.clear(score);
    await user.type(score, '90');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Garage' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(f.callsTo(`PUT /contacts/${C}/fields/${F(4)}`)).toHaveLength(1));
    expect(f.callsTo(`PUT /contacts/${C}/fields/${F(1)}`)[0]!.body).toEqual({ value: 90 });
    expect(f.callsTo(`PUT /contacts/${C}/fields/${F(4)}`)[0]!.body).toEqual({ value: ['p1'] });
    for (const n of [2, 3]) expect(f.callsTo(`PUT /contacts/${C}/fields/${F(n)}`)).toHaveLength(0);
  });

  it("is registered through module 58's registry in the Details slot: the person's page shows the values inside Details", async () => {
    expect(contactSections.find((s) => s.id === 'fields')).toMatchObject({ slot: 'details' });
    const details = { contactId: C, rowVersion: 1, doNotContact: false, stage: { stage: 'active', label: 'Active', locked: [], lockedReason: null }, stageLabels: {}, addresses: [], collaborators: [], relationships: [], removedPoints: [], canEdit: false, canManageCollaborators: false };
    const f = fake().on(`GET /contacts/${C}/details`, { status: 200, body: { details } });
    mount(
      f,
      <AgentSheetsProvider>
        <ContactSections contact={fullContact({ id: C, displayName: 'Ana Imported', firstName: 'Ana', lastName: 'Imported' })} />
      </AgentSheetsProvider>,
    );
    const region = await screen.findByRole('region', { name: 'Details' });
    expect(await within(region).findByText('Lead score')).toBeInTheDocument();
    expect(within(region).getByText('87')).toBeInTheDocument();
    expect(within(region).getByText('0-3 months')).toBeInTheDocument();
    // read-only here (the details say the viewer may not edit the person)
    expect(within(region).queryByRole('button', { name: /Edit fields/ })).toBeNull();
    // the slot renders nothing outside a registry tree
    expect(typeof DetailsSlots).toBe('function');
  });
});
