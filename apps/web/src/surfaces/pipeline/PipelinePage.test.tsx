// Pipeline board in jsdom: phone stage switcher (no matchMedia), move through the stage command,
// a locked stage says why, and a desktop drag drops onto another column.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAGES } from '@realty/core/parity/people';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { IDS } from '../feed/lib/testing.js';
import type { PersonView } from '../people/api.js';
import { surface as pipelineSurface } from './index.js';

const BLAKE = '01900000-0000-7000-8000-0000000000bb';

function person(over: Partial<PersonView> = {}): PersonView {
  return {
    id: IDS.jane,
    displayName: 'Jane Doe',
    stage: 'new',
    intent: 'buyer',
    contactType: 'lead',
    owner: { userId: IDS.me, displayName: 'Ava Agent' },
    sourceName: 'Zillow',
    lastActivityAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    nextTaskDueAt: null,
    tags: [],
    ...over,
  };
}

function counts(stage = 'new', n = 1) {
  return { counts: STAGES.map((s) => ({ stage: s, count: s === stage ? n : 0, capped: false })) };
}

function page(people: PersonView[]) {
  return { people, nextCursor: null, sort: 'last_activity_desc', list: null, scope: 'people_you_can_see', audienceProtected: false };
}

function stageOf(body: unknown): string | undefined {
  const all = (body as { definition?: { all?: { kind?: string; in?: string[] }[] } }).definition?.all ?? [];
  return all.find((c) => c.kind === 'stage')?.in?.[0];
}

function mount(locked: string[] = []) {
  const jane = person();
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: sessionFixture() })
    .on('GET /smart-lists', { status: 200, body: { lists: [{ id: '01900000-0000-7000-8000-0000000000c1', scope: 'personal', mine: true, name: 'Buyers', definition: { v: 1, all: [] }, sort: 'name_asc', position: 0, updatedAt: '2026-11-01T00:00:00.000Z', audienceProtected: false }] } })
    .on('GET /people/filter-options', { status: 200, body: { sources: [], members: [{ userId: BLAKE, name: 'Blake Chen', role: 'agent', active: true }] } })
    .on('GET /people/stage-counts', { status: 200, body: counts() })
    .on(`GET /people/stage-counts?owner=${BLAKE}`, { status: 200, body: counts('new', 0) })
    .on('POST /people/query', (call) => ({ status: 200, body: page(stageOf(call.body) === 'new' ? [jane] : []) }))
    .on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details: { stage: { locked } } } })
    .on(`POST /contacts/${IDS.jane}/stage`, { status: 200, body: { stage: { stage: 'connected', label: 'Connected' }, previousStage: 'new', rowVersion: 2, eventId: '01900000-0000-7000-8000-0000000000e9' } });
  renderApp({ fake, path: '/pipeline', table: tableWith(pipelineSurface) });
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pipeline', () => {
  it('on a phone, lists the selected stage and moves through the stage command; a locked stage says why', async () => {
    const fake = mount(['active', 'closed']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Pipeline' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Jane Doe' })).toBeInTheDocument();
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Agent'), BLAKE);
    await waitFor(() => expect(fake.callsTo(`GET /people/stage-counts?owner=${BLAKE}`).length).toBeGreaterThan(0));
    await u.selectOptions(screen.getByLabelText('Agent'), '');
    await u.click(screen.getByRole('button', { name: 'Move Jane Doe' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Jane Doe' });
    expect(await within(dialog).findByText(/Reach them first/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Active client/ })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: /^Connected/ }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)[0]!.body).toEqual({ stage: 'connected' }));
    expect(await screen.findByTestId('people-toast')).toHaveTextContent('Stage: Connected');
    await u.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`).at(-1)!.body).toEqual({ stage: 'new', undoOf: '01900000-0000-7000-8000-0000000000e9' }));
  });

  it('on a desktop, dropping a card on another stage asks for that stage', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(min-width: 768px)', media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const fake = mount();
    const card = (await screen.findByRole('link', { name: 'Jane Doe' })).closest('article')!;
    const target = await screen.findByRole('region', { name: /Connected, 0/ });
    fireEvent.dragStart(card);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/stage`)[0]!.body).toEqual({ stage: 'connected' }));
  });
});
