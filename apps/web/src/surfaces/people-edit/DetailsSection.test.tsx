// R-PAR-12's one exception on the person's page (journey gap J3.3): "Remove as a wrong number" is offered
// exactly where module 57's remove route accepts reason wrong_number, on a point whose wrong-number report is on
// the consent ledger (GET /contacts/:id/points wrongNumberReported). Anywhere else the sheet says why it is not
// offered, and the one-tap Remove stays an ordinary removal (reason old, with Undo). A wrong-number removal has
// no Undo (a confirmed wrong number is never added back).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { fullContact } from '../feed/lib/testing.js';
import type { Details, PointDetail } from './api.js';
import { DetailsSection, wrongNumberNotOffered } from './DetailsSection.js';
import { ToastProvider } from './hooks.js';
import { surface as peopleEditSurface } from './index.js';

const C = '01900000-0000-7000-8000-0000000c0031';
const WRONG = '01900000-0000-7000-8000-0000000d0001';
const REAL = '01900000-0000-7000-8000-0000000d0002';
const MAIL = '01900000-0000-7000-8000-0000000d0003';
const point = (id: string, over: Partial<PointDetail>): PointDetail => ({ id, kind: 'phone', address: '+14155550100', label: 'mobile', status: 'active', isPrimary: false, wrongNumberReported: false, ...over });
const POINTS: PointDetail[] = [
  point(WRONG, { address: '+14155550111', status: 'wrong_number', isPrimary: true, wrongNumberReported: true }),
  point(REAL, { address: '+14155550122' }),
  point(MAIL, { kind: 'email', address: 'wes@example.test', label: 'other', isPrimary: true }),
];
const DETAILS = { contactId: C, rowVersion: 3, doNotContact: false, stage: { stage: 'active', label: 'Active', locked: [], lockedReason: null }, stageLabels: {}, addresses: [], collaborators: [], relationships: [], removedPoints: [], canEdit: true, canManageCollaborators: false } as unknown as Details;
const CONTACT = fullContact({ id: C, displayName: 'Wes Wrong', firstName: 'Wes', lastName: 'Wrong' });
const removed = { points: [], removed: [] };

function mount(f: FakeFetch) {
  const api = new ApiClient({ fetch: f.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith(peopleEditSurface)}>
        <MemoryRouter>
          <ToastProvider>
            <DetailsSection contact={CONTACT} details={DETAILS} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
}

const fake = () =>
  new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on(`GET /contacts/${C}/points`, { status: 200, body: { points: POINTS } })
    .on(`POST /contacts/${C}/points/${WRONG}/remove`, { status: 200, body: removed })
    .on(`POST /contacts/${C}/points/${REAL}/remove`, { status: 200, body: removed });

async function openSheet() {
  const user = userEvent.setup();
  await screen.findByText(/\(415\) 555-0122|415.*555.*0122/);
  await user.click(screen.getByRole('button', { name: 'Edit details of Wes Wrong' }));
  return { user, sheet: screen.getByRole('dialog', { name: 'Edit Wes Wrong' }) };
}

/** The sheet's group for one saved point (its address field and its buttons), named by the point. */
const rowOf = (sheet: HTMLElement, label: RegExp, value: RegExp) => within(sheet).getAllByRole('group').find((g) => label.test(g.getAttribute('aria-label') ?? '') && value.test(g.getAttribute('aria-label') ?? ''))!;

describe('R-PAR-12: removing a point as a confirmed wrong number (only where the ledger holds the report)', () => {
  it('offers "Remove as a wrong number" only on the reported number; every other point says why it is not offered', async () => {
    mount(fake());
    const { sheet } = await openSheet();
    const wrongRow = rowOf(sheet, /^Phone/, /0111/);
    const realRow = rowOf(sheet, /^Phone/, /0122/);
    const mailRow = rowOf(sheet, /^Email/, /wes@example\.test/);
    expect(within(wrongRow).getByRole('button', { name: 'Remove as a wrong number' })).toBeInTheDocument();
    expect(within(wrongRow).queryByText(wrongNumberNotOffered('phone'))).toBeNull();
    // the person's own number: no wrong-number removal, and the reason it is not offered
    expect(within(realRow).queryByRole('button', { name: 'Remove as a wrong number' })).toBeNull();
    expect(within(realRow).getByText(wrongNumberNotOffered('phone'))).toBeInTheDocument();
    expect(within(mailRow).queryByRole('button', { name: /wrong/ })).toBeNull();
    expect(within(mailRow).getByText(wrongNumberNotOffered('email'))).toBeInTheDocument();
    expect(wrongNumberNotOffered('phone')).toMatch(/nobody has reported this number as a wrong number yet/);
  });

  it('a phone being added has no history to report: no wrong-number removal and no hint on it', async () => {
    mount(fake());
    const { user, sheet } = await openSheet();
    const hints = () => within(sheet).queryAllByText(/isn’t offered/).length;
    expect(hints()).toBe(2);
    await user.click(within(sheet).getByRole('button', { name: 'Add phone' }));
    expect(within(sheet).getAllByRole('textbox', { name: /^Phone/ })).toHaveLength(3);
    expect(hints()).toBe(2);
    expect(within(sheet).getAllByRole('button', { name: 'Remove as a wrong number' })).toHaveLength(1);
  });

  it('the wrong-number removal sends reason wrong_number and offers no Undo (a confirmed wrong number is never added back)', async () => {
    const f = fake();
    mount(f);
    const { user, sheet } = await openSheet();
    await user.click(within(rowOf(sheet, /^Phone/, /0111/)).getByRole('button', { name: 'Remove as a wrong number' }));
    await waitFor(() => expect(f.callsTo(`POST /contacts/${C}/points/${WRONG}/remove`)).toHaveLength(1));
    expect(f.callsTo(`POST /contacts/${C}/points/${WRONG}/remove`)[0]!.body).toEqual({ reason: 'wrong_number' });
    const toast = screen.getByTestId('people-toast');
    expect(await within(toast).findByText('Number removed as a wrong number')).toBeInTheDocument();
    expect(within(toast).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(f.callsTo(`POST /contacts/${C}/points/${REAL}/remove`)).toHaveLength(0);
  });

  it('the one-tap Remove stays an ordinary removal (reason old) with Undo, also on the reported number', async () => {
    const f = fake();
    mount(f);
    const { user, sheet } = await openSheet();
    await user.click(within(rowOf(sheet, /^Phone/, /0122/)).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(f.callsTo(`POST /contacts/${C}/points/${REAL}/remove`)).toHaveLength(1));
    expect(f.callsTo(`POST /contacts/${C}/points/${REAL}/remove`)[0]!.body).toEqual({ reason: 'old' });
    const toast = screen.getByTestId('people-toast');
    expect(await within(toast).findByText('Number removed')).toBeInTheDocument();
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await user.click(within(rowOf(sheet, /^Phone/, /0111/)).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(f.callsTo(`POST /contacts/${C}/points/${WRONG}/remove`)).toHaveLength(1));
    expect(f.callsTo(`POST /contacts/${C}/points/${WRONG}/remove`)[0]!.body).toEqual({ reason: 'old' });
  });
});
