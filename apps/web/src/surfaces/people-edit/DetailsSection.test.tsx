// The person's addresses in the Details section (module 57): Remove is one tap with an Undo toast (PARITY_PLAN §5).
// Every address's Remove and the toast's Undo share one action (usePersonAction). It used to hand any later call
// the pending request's answer: a second Remove while the first was in flight sent no DELETE yet said "Address
// removed" with the wrong Undo, and an Undo tapped during another request was swallowed. These tests hold a DELETE
// open to prove each tap is its own request, and that Undo restores exactly the address it removed (the server's
// restore of the deleted row, by the delete's token). jsdom against a scripted API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import type { Details } from './api.js';
import { DetailsSection } from './DetailsSection.js';
import { ToastProvider } from './hooks.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const A = '01900000-0000-7000-8000-0000000a0001';
const B = '01900000-0000-7000-8000-0000000a0002';
const addr = (id: string, line1: string) => ({ id, kind: 'home', line1, line2: null, city: 'Oakland', region: 'CA', postalCode: '94610', country: 'US' });
const details = (): Details => ({
  contactId: C,
  rowVersion: 1,
  doNotContact: false,
  stage: { stage: 'new', label: 'New', locked: [], lockedReason: null },
  stageLabels: {},
  addresses: [addr(A, '1 Alpha St'), addr(B, '2 Beta St')],
  collaborators: [],
  relationships: [],
  removedPoints: [],
  canEdit: true,
  canManageCollaborators: false,
});
const del = (id: string) => `DELETE /contacts/${C}/addresses/${id}`;
const restore = (id: string) => `POST /contacts/${C}/addresses/${id}/restore`;
const token = (id: string) => `sealed-token-for-${id}`;

/** A reply that waits until `release()` (a request held open in flight). */
function held<T>(reply: T): { handler: () => Promise<T>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((ok) => (release = ok));
  return { handler: async () => (await gate, reply), release };
}

function mount(fake: FakeFetch) {
  fake
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on(`GET /contacts/${C}/points`, { status: 200, body: { points: [] } })
    .on(`GET /contacts/${C}/details`, { status: 200, body: { details: details() } })
    .on(restore(A), { status: 201, body: { address: addr(A, '1 Alpha St') } })
    .on(restore(B), { status: 201, body: { address: addr(B, '2 Beta St') } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <DetailsSection contact={{ id: C, displayName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', phones: [], emails: [] } as never} details={details()} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const removeButton = (line1: string) => screen.getByRole('button', { name: new RegExp(`^Remove address ${line1}`) });
const undo = () => screen.findByRole('button', { name: 'Undo' });

describe('Details: address Remove and Undo (module 57)', () => {
  it('two quick Removes send two DELETEs (the first held in flight); the toast that stays offers the second address’s Undo, which restores that address by its token and nothing else', async () => {
    const a = held({ status: 200, body: { ok: true, restoreToken: token(A) } });
    const fake = new FakeFetch().on(del(A), a.handler).on(del(B), { status: 200, body: { ok: true, restoreToken: token(B) } });
    const u = mount(fake);
    await u.click(removeButton('1 Alpha St'));
    await u.click(removeButton('2 Beta St'));
    await waitFor(() => expect(fake.callsTo(del(A))).toHaveLength(1));
    expect(fake.callsTo(del(B))).toHaveLength(0); // B waits for A, it is not handed A's answer
    a.release();
    await waitFor(() => expect(fake.callsTo(del(B))).toHaveLength(1));
    expect(await screen.findByText('Address removed')).toBeInTheDocument();
    await u.click(await undo());
    await waitFor(() => expect(fake.callsTo(restore(B))).toHaveLength(1));
    expect(fake.callsTo(restore(B))[0]!.body).toEqual({ restoreToken: token(B) });
    expect(fake.callsTo(restore(A))).toHaveLength(0);
    // the old Undo re-posted the fields shown: nothing is added through the add route any more
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === `/contacts/${C}/addresses`)).toHaveLength(0);
  });

  it('an Undo tapped while another Remove is in flight is not swallowed: it restores its own address once that request is done', async () => {
    const b = held({ status: 200, body: { ok: true, restoreToken: token(B) } });
    const fake = new FakeFetch().on(del(A), { status: 200, body: { ok: true, restoreToken: token(A) } }).on(del(B), b.handler);
    const u = mount(fake);
    await u.click(removeButton('1 Alpha St'));
    const undoA = await undo();
    await u.click(removeButton('2 Beta St'));
    await waitFor(() => expect(fake.callsTo(del(B))).toHaveLength(1));
    await u.click(undoA); // A's Undo, while B's DELETE is still open
    b.release();
    await waitFor(() => expect(fake.callsTo(restore(A))).toHaveLength(1));
    expect(fake.callsTo(restore(A))[0]!.body).toEqual({ restoreToken: token(A) });
    expect(fake.callsTo(restore(B))).toHaveLength(0);
  });

  it('a double tap on one Remove sends a single DELETE', async () => {
    const a = held({ status: 200, body: { ok: true, restoreToken: token(A) } });
    const fake = new FakeFetch().on(del(A), a.handler);
    const u = mount(fake);
    await u.click(removeButton('1 Alpha St'));
    await u.click(removeButton('1 Alpha St'));
    a.release();
    expect(await screen.findByText('Address removed')).toBeInTheDocument();
    expect(fake.callsTo(del(A))).toHaveLength(1);
  });

  it('an Undo after the window is refused in words (ADDRESS_RESTORE_EXPIRED), never the code', async () => {
    const fake = new FakeFetch().on(del(A), { status: 200, body: { ok: true, restoreToken: token(A) } });
    const u = mount(fake);
    fake.on(restore(A), err(409, 'ADDRESS_RESTORE_EXPIRED'));
    await u.click(removeButton('1 Alpha St'));
    await u.click(await undo());
    expect(await screen.findByText('It’s too late to undo that: the address was removed more than 10 minutes ago.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ADDRESS_RESTORE_EXPIRED');
  });
});

describe('Details: what a visitor typed in the website chat (E77, E154, finding UXA-5)', () => {
  it('shows it marked typed in chat, not verified, and Add as email makes it a point by the agent\'s own decision', async () => {
    const fake = new FakeFetch().on(`POST /contacts/${C}/points`, { status: 201, body: { point: { id: '01900000-0000-7000-8000-0000000ac0e1', kind: 'email', address: 'sam.rivera@example.com', label: 'other', status: 'active', isPrimary: true, wrongNumberReported: false }, removedPointId: null, duplicates: [] } });
    fake
      .on('GET /auth/session', { status: 200, body: sessionFixture() })
      .on(`GET /contacts/${C}/points`, { status: 200, body: { points: [] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const contact = { id: C, displayName: 'Sam Rivera', firstName: 'Sam', lastName: 'Rivera', phones: [], emails: [], typedInChat: [{ kind: 'email', address: 'sam.rivera@example.com', typedAt: '2026-11-11T17:00:00.000Z' }] };
    render(
      <QueryClientProvider client={qc}>
        <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
          <MemoryRouter>
            <ToastProvider>
              <DetailsSection contact={contact as never} details={details()} />
            </ToastProvider>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>,
    );
    const u = userEvent.setup();
    const row = (await screen.findByText('sam.rivera@example.com')).closest('li')!;
    expect(row.textContent).toMatch(/typed in chat, not verified/);
    await u.click(screen.getByRole('button', { name: 'Add sam.rivera@example.com as an email' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${C}/points`)).toHaveLength(1));
    expect(fake.callsTo(`POST /contacts/${C}/points`)[0]!.body).toEqual({ kind: 'email', address: 'sam.rivera@example.com', label: 'other' });
  });
});
