// The People surface in jsdom (PARITY_PLAN module 61): rows only of people the viewer can see, the
// honest count, tag chip → everyone with the tag (1 tap), the list picker, select all and the bulk bar
// (module 64's sheets are stubbed: nothing is changed and the stub says so), a person's tag chips
// (add by typing, remove, the opt-out-looking tag prompt) and "Next person".
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as contactSurface } from '../contact/index.js';
import { surface as paritySurface } from '../admin/parity/index.js';
import { surface as peopleSurface } from './index.js';
import { ContactTags } from './ContactTags.js';
import type { PersonView } from './api.js';
import { startWork, stepOf, readWork } from './workList.js';
import { sourceFromParams } from './PeoplePage.js';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';

const T_BUYER = '01900000-0000-7000-8000-0000000000b1';
const T_VA = '01900000-0000-7000-8000-0000000000b2';
const L_HOT = '01900000-0000-7000-8000-0000000000e1';
const id = (n: number) => `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const person = (n: number, over: Partial<PersonView> = {}): PersonView => ({
  id: id(n),
  displayName: `Person ${n}`,
  stage: 'new',
  intent: 'buyer',
  contactType: 'lead',
  owner: { userId: '01900000-0000-7000-8000-0000000000aa', displayName: 'Ava Agent' },
  sourceName: null,
  lastActivityAt: null,
  createdAt: '2026-11-01T12:00:00Z',
  nextTaskDueAt: null,
  tags: n === 1 ? [{ id: T_BUYER, name: 'Buyer', color: 'blue' }] : [],
  ...over,
});
const page = (people: PersonView[], o: { nextCursor?: string | null; audienceProtected?: boolean } = {}) => ({ people, nextCursor: o.nextCursor ?? null, sort: 'last_activity_desc', list: null, scope: 'people_you_can_see', audienceProtected: o.audienceProtected ?? false });
const tags = { tags: [{ id: T_BUYER, name: 'Buyer', color: 'blue', protected: false, createdByKind: 'user', usage: null }, { id: T_VA, name: 'VA buyer', color: null, protected: true, createdByKind: 'user', usage: null }] };

function app(fake: FakeFetch, path = '/people', role: 'agent' | 'owner' | 'tc' = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: tableWith(peopleSurface, contactSurface, paritySurface) });
}

function base() {
  return new FakeFetch()
    .on('GET /smart-lists', { status: 200, body: { lists: [{ id: L_HOT, scope: 'team', mine: false, name: 'Hot buyers', definition: { v: 1 }, sort: 'last_activity_desc', position: 0, updatedAt: '2026-11-01T00:00:00Z', audienceProtected: false }] } })
    .on('GET /people', { status: 200, body: page(Array.from({ length: 30 }, (_, i) => person(i + 1))) })
    .on('GET /people/count', { status: 200, body: { count: 30, capped: false } })
    .on('GET /tags', { status: 200, body: tags });
}

afterEach(() => sessionStorage.clear());

describe('People page (module 61)', () => {
  it('R-PAR-28 E181: shows people you can see with an honest count; a count past 10,000 says "10,000+"', async () => {
    const fake = base().on('GET /people/count', { status: 200, body: { count: 10000, capped: true } });
    app(fake);
    expect(await screen.findByRole('heading', { level: 2, name: 'Everyone' })).toBeInTheDocument();
    expect(await screen.findByText(/10,000\+ people · Showing people you can see/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('Person '))).toHaveLength(30);
  });

  it('see everyone with a tag: tapping a chip is 1 tap and runs an unsaved tag list', async () => {
    const fake = base()
      .on('POST /people/query', { status: 200, body: page([person(1)]) })
      .on('POST /people/count', { status: 200, body: { count: 1, capped: false } });
    app(fake);
    const chip = await screen.findByRole('button', { name: 'Tag Buyer, show everyone with it' });
    await userEvent.setup().click(chip);
    expect(await screen.findByRole('heading', { level: 2, name: 'Tag: Buyer' })).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo('POST /people/query')[0]?.body).toEqual({ definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [T_BUYER] }] } }));
    expect(await screen.findByText('1 person · Showing people you can see')).toBeInTheDocument();
  });

  it('open a smart list in 1 tap from the People page (the list picker)', async () => {
    const fake = base().on(`GET /people?list=${L_HOT}`, { status: 200, body: { ...page([person(2)]), list: { id: L_HOT, name: 'Hot buyers', scope: 'team' } } }).on(`GET /people/count?list=${L_HOT}`, { status: 200, body: { count: 1, capped: false } });
    app(fake);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Hot buyers' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Hot buyers' })).toBeInTheDocument();
    expect(fake.callsTo(`GET /people?list=${L_HOT}`).length).toBeGreaterThanOrEqual(1);
  });

  it('bulk tag 30 from a list: Select all → Tag → tag opens the confirm sheet (module 64; stubbed, changes nothing) — 3 taps on the page', async () => {
    const fake = base();
    app(fake);
    const user = userEvent.setup();
    let taps = 0;
    await user.click(await screen.findByRole('checkbox', { name: /Select all/ }));
    taps++;
    const bar = await screen.findByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('30 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Tag' }));
    taps++;
    await user.click(await screen.findByRole('button', { name: 'Buyer' }));
    taps++;
    const sheet = await screen.findByRole('dialog', { name: 'Tag "Buyer" · 30 people' });
    expect(within(sheet).getByText(/Nothing was changed/)).toBeInTheDocument();
    expect(taps).toBe(3); // + People tab and the list = 5 on a phone (PARITY_PLAN §5)
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('R-PAR-8 E189: a protected tag is never applied in bulk and a protected list is never a bulk send audience (the sheet says so before anything)', async () => {
    const fake = base().on('GET /people', { status: 200, body: page([person(1), person(2)], { audienceProtected: true }) });
    app(fake);
    const user = userEvent.setup();
    expect(await screen.findByText(/This list uses a protected tag/)).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: /Select all/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Email' }));
    expect(await within(await screen.findByRole('dialog')).findByText(/cannot be the audience of a bulk email/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Tag' }));
    await user.click(await screen.findByRole('button', { name: /VA buyer/ }));
    expect(await screen.findByText(/added one person at a time, never in bulk/)).toBeInTheDocument();
  });

  it('a TC sees the list but gets no checkboxes and no bulk bar (TCs run no bulk actions)', async () => {
    app(base(), '/people', 'tc');
    expect(await screen.findByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('sourceFromParams: ?list, ?tag&name, or everyone', () => {
    expect(sourceFromParams(new URLSearchParams(`list=${L_HOT}`))).toEqual({ kind: 'list', listId: L_HOT });
    expect(sourceFromParams(new URLSearchParams(`tag=${T_BUYER}&name=Buyer`))).toMatchObject({ kind: 'definition', label: 'Tag: Buyer' });
    expect(sourceFromParams(new URLSearchParams(''))).toEqual({ kind: 'all' });
  });
});

describe('Next person (working a list)', () => {
  it('steps through the list order the People page recorded (ids only)', () => {
    startWork({ kind: 'all' }, [id(1), id(2), id(3)], 'c1');
    expect(stepOf(readWork(), id(2))).toEqual({ index: 1, next: id(3), prev: id(1) });
    expect(stepOf(readWork(), id(3))).toEqual({ index: 2, next: null, prev: id(2) });
    expect(stepOf(null, id(1))).toEqual({ index: -1, next: null, prev: null });
    expect(JSON.stringify(readWork())).not.toMatch(/Person/);
  });

  it('Next person is 1 tap from a person opened from the list', async () => {
    const fake = base();
    for (const n of [1, 2]) fake.on(`GET /contacts/${id(n)}`, { status: 200, body: { contact: { id: id(n), view: 'card', displayName: `Person ${n}`, intent: null, source: null, createdAt: '2026-11-01T00:00:00Z', pondSummary: null, ownership: { state: 'owned', pondId: null, pondName: null, offerId: null, offerExpiresAt: null, offeredToMe: false, seq: 1 } } } });
    app(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Person 1' }));
    expect(await screen.findByText(/1 of 30/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next person' }));
    expect(await screen.findByText(/2 of 30/)).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${id(2)}`).length).toBeGreaterThan(0));
  });
});

describe("a person's tag chips (R-PAR-6, R-PAR-7)", () => {
  function mount(fake: FakeFetch) {
    const api = new ApiClient({ fetch: fake.fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fake.on('GET /auth/session', { status: 200, body: sessionFixture() });
    return render(
      <QueryClientProvider client={qc}>
        <ShellProvider api={api} table={tableWith(peopleSurface)}>
          <MemoryRouter>
            <ContactTags contactId={id(9)} contactName="Jane Doe" />
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>,
    );
  }

  it('R-PAR-7 E167: adding "DNC" saves the tag and says plainly that tags never stop messages; chips read "Tag Buyer, remove" to VoiceOver', async () => {
    const DNC = '01900000-0000-7000-8000-0000000000d9';
    const fake = new FakeFetch()
      .on(`GET /contacts/${id(9)}/tags`, { status: 200, body: { tags: [{ id: T_BUYER, name: 'Buyer', color: 'blue', protected: false }] } })
      .on('GET /tags', { status: 200, body: tags })
      .on(`POST /contacts/${id(9)}/tags`, { status: 200, body: { tags: [{ id: T_BUYER, name: 'Buyer', color: 'blue', protected: false }, { id: DNC, name: 'DNC', color: null, protected: false }], added: [DNC], optOutLike: [DNC] } });
    mount(fake);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'Tag Buyer, remove' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a tag' }));
    await user.type(await screen.findByLabelText('Tag'), 'DNC');
    await user.click(screen.getByRole('button', { name: 'Create "DNC"' }));
    expect(await screen.findByText("Tags don't stop messages")).toBeInTheDocument();
    expect(screen.getByText(/record "Do not contact" on Jane's page/)).toBeInTheDocument();
    expect(fake.callsTo(`POST /contacts/${id(9)}/tags`)[0]?.body).toEqual({ names: ['DNC'] });
  });

  it('R-PAR-6 E165: typing "buyer" picks the existing "Buyer" (2 taps: + then the tag)', async () => {
    let added = false;
    const fake = new FakeFetch()
      .on(`GET /contacts/${id(9)}/tags`, () => ({ status: 200, body: { tags: added ? [{ id: T_BUYER, name: 'Buyer', color: 'blue', protected: false }] : [] } }))
      .on('GET /tags', { status: 200, body: tags })
      .on(`POST /contacts/${id(9)}/tags`, () => ((added = true), { status: 200, body: { tags: [{ id: T_BUYER, name: 'Buyer', color: 'blue', protected: false }], added: [T_BUYER], optOutLike: [] } }));
    mount(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('button', { name: 'Buyer' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${id(9)}/tags`)[0]?.body).toEqual({ tagIds: [T_BUYER] }));
    expect(await screen.findByRole('button', { name: 'Tag Buyer, remove' })).toBeInTheDocument();
  });

  it('shows nothing for a card view (tags are detail-only, R-PAR-7)', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${id(9)}/tags`, err(404, 'NOT_FOUND'));
    const { container } = mount(fake);
    await waitFor(() => expect(fake.callsTo(`GET /contacts/${id(9)}/tags`).length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});
