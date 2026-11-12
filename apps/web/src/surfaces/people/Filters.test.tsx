// The People filter builder (lane people-filters): the pure model (fields → clauses, chip labels, URL form,
// typed text and team lists) and the builder in jsdom against a scripted API (the definition it sends, the
// live count, chips, Clear all, Save as list refused for a team list with typed text, Edit filters → PATCH).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as peopleSurface } from './index.js';
import type { PersonView } from './api.js';
import {
  type Catalogs,
  EMPTY_VALUE,
  TEAM_TEXT_REFUSAL,
  buildClause,
  clauseLabel,
  clauseToDraft,
  decodeDefinition,
  definitionOf,
  encodeDefinition,
  fieldSpecs,
  hasFreeText,
  loosenText,
  withNameSearch,
} from './filters.js';
import { definitionOfSource, effectiveSource, sourceFromParams } from './PeoplePage.js';

const Z = '01900000-0000-7000-8000-00000000d001';
const W = '01900000-0000-7000-8000-00000000d002';
const ME = '01900000-0000-7000-8000-0000000000aa';
const AVERY = '01900000-0000-7000-8000-0000000000ab';
const DNC = '01900000-0000-7000-8000-0000000000b1';
const F_BUDGET = '01900000-0000-7000-8000-0000000000f1';
const L_MINE = '01900000-0000-7000-8000-0000000000e1';
const L_TEAM = '01900000-0000-7000-8000-0000000000e2';

const cat: Catalogs = {
  stageLabel: (k) => ({ active: 'Working', closed: 'Closed', lost: 'Lost', nurture: 'Nurture' })[k] ?? k,
  sources: [{ id: Z, name: 'Zillow', active: true }, { id: W, name: 'Website', active: true }],
  members: [{ userId: ME, name: 'Ava Agent', active: true }, { userId: AVERY, name: 'Avery', active: true }],
  tags: [{ id: DNC, name: 'DNC', protected: false }],
  fields: [{ id: F_BUDGET, key: 'budget', label: 'Budget', fieldType: 'number', options: [], annual: false, position: 0, origin: 'manual', archived: false }],
  meId: ME,
};

describe('the filter model (lane people-filters)', () => {
  it('E194: each field and operator builds one v1 clause; "is not" builds not_in', () => {
    const v = (o: Partial<typeof EMPTY_VALUE>) => ({ ...EMPTY_VALUE, ...o });
    expect(buildClause('stage', 'not_in', v({ choices: ['closed', 'lost'] }))).toEqual({ ok: true, clause: { kind: 'stage', not_in: ['closed', 'lost'] } });
    expect(buildClause('source', 'in', v({ choices: [Z] }))).toEqual({ ok: true, clause: { kind: 'source', in: [Z] } });
    expect(buildClause('owner', 'not_in', v({ choices: [AVERY] }))).toEqual({ ok: true, clause: { kind: 'owner', not_in: [AVERY] } });
    expect(buildClause('owner', 'none', v({}))).toEqual({ ok: true, clause: { kind: 'owner', is: 'none' } });
    expect(buildClause('tag', 'none', v({ choices: [DNC] }))).toEqual({ ok: true, clause: { kind: 'tag', op: 'none', tagIds: [DNC] } });
    expect(buildClause('last_activity', 'never', v({}))).toEqual({ ok: true, clause: { kind: 'last_activity', op: 'never' } });
    expect(buildClause('created', 'within_days', v({ days: '7' }))).toEqual({ ok: true, clause: { kind: 'created', op: 'within_days', days: 7 } });
    expect(buildClause('next_task', 'due_within_days', v({ days: '3' }))).toEqual({ ok: true, clause: { kind: 'next_task', op: 'due_within_days', days: 3 } });
    expect(buildClause(`field:${F_BUDGET}`, 'num_gte', v({ number: '1,500,000' }))).toEqual({ ok: true, clause: { kind: 'field', fieldId: F_BUDGET, op: 'num_gte', value: 1500000 } });
    // honest refusals in plain words, never a half-built clause
    expect(buildClause('stage', 'in', v({}))).toEqual({ ok: false, message: 'Pick at least one.' });
    expect(buildClause('created', 'within_days', v({ days: '0' })).ok).toBe(false);
    expect(buildClause('created', 'within_days', v({ days: '99999' })).ok).toBe(false);
    expect(buildClause('name', 'contains', v({ text: '   ' })).ok).toBe(false);
  });

  it('E194: every clause the builder makes reads back into the builder unchanged (edit a saved filter)', () => {
    const clauses = [
      { kind: 'stage', not_in: ['lost'] },
      { kind: 'source', in: [Z] },
      { kind: 'owner', is: 'me' },
      { kind: 'owner', not_in: [AVERY] },
      { kind: 'tag', op: 'all', tagIds: [DNC] },
      { kind: 'last_activity', op: 'older_than_days', days: 30 },
      { kind: 'next_task', op: 'overdue' },
      { kind: 'name', contains: 'jane' },
      { kind: 'field', fieldId: F_BUDGET, op: 'num_lt', value: 5 },
    ];
    for (const c of clauses) {
      const d = clauseToDraft(c)!;
      expect(buildClause(d.field, d.op, d.value), JSON.stringify(c)).toEqual({ ok: true, clause: c });
    }
  });

  it('E195 E197: chip labels use the team\'s own names and say "is not" plainly', () => {
    expect(clauseLabel({ kind: 'stage', not_in: ['closed', 'lost'] }, cat)).toBe('Stage is not Closed, Lost');
    expect(clauseLabel({ kind: 'stage', in: ['active'] }, cat)).toBe('Stage is Working'); // the team's stage label
    expect(clauseLabel({ kind: 'source', not_in: [Z] }, cat)).toBe('Source is not Zillow');
    expect(clauseLabel({ kind: 'owner', not_in: [AVERY] }, cat)).toBe('Owner is not Avery');
    expect(clauseLabel({ kind: 'owner', in: [ME] }, cat)).toBe('Owner is Ava Agent (me)');
    expect(clauseLabel({ kind: 'tag', op: 'none', tagIds: [DNC] }, cat)).toBe('Tags has none of DNC');
    expect(clauseLabel({ kind: 'tag', op: 'any', tagIds: ['01900000-0000-7000-8000-0000000000ff'] }, cat)).toBe('Tags has any of a deleted tag');
    expect(clauseLabel({ kind: 'field', fieldId: F_BUDGET, op: 'num_gte', value: 1500000 }, cat)).toBe('Budget is at least 1500000');
  });

  // Batch 6 review ownership-sla/F6: "Owner is unassigned" compiles to owner_user_id IS NULL, which also holds for leads
  // in a pond, on offer to an agent, and closed people (the engine's states with no owner): the words said less.
  it('E197 R-PAR-29: "no owner" is named for what it matches (unassigned, in a pond, on offer or closed), in the field\'s operator list and on its chip', () => {
    expect(clauseLabel({ kind: 'owner', is: 'none' }, cat)).toBe('Owner: nobody (unassigned, in a pond, on offer or closed)');
    expect(fieldSpecs([]).find((f) => f.field === 'owner')!.operators.find((o) => o.op === 'none')!.label).toBe('is nobody (unassigned, in a pond, on offer or closed)');
  });

  it('R-PAR-27: typed text (a name, a text field value) is detected anywhere in a definition; the refusal is the owner\'s sentence', () => {
    expect(hasFreeText({ v: 1, all: [{ kind: 'stage', not_in: ['lost'] }] })).toBe(false);
    expect(hasFreeText(withNameSearch({ v: 1, all: [] }, 'jane'))).toBe(true);
    expect(hasFreeText({ v: 1, any: [{ kind: 'stage', in: ['new'] }, { kind: 'field', fieldId: F_BUDGET, op: 'text_contains', value: 'x' }] })).toBe(true);
    expect(TEAM_TEXT_REFUSAL).toBe("Team lists can't include typed text. Remove the name search or save it as your own list.");
    // the Name field is the only text field among the built-in ones and is marked so the builder can refuse it on a team list
    expect(fieldSpecs([]).find((f) => f.field === 'name')!.operators.every((o) => o.freeText)).toBe(true);
  });

  it('E198: an OR group of one joins the AND list; the URL form round-trips; junk in the URL is "no filter"', () => {
    const a = { kind: 'stage', in: ['new'] };
    const b = { kind: 'source', in: [Z] };
    expect(definitionOf([a], [b])).toEqual({ v: 1, all: [a, b] });
    expect(definitionOf([a], [a, b])).toEqual({ v: 1, all: [a], any: [a, b] });
    const d = { v: 1 as const, all: [a], any: [a, b] };
    expect(decodeDefinition(encodeDefinition(d))).toEqual(d);
    for (const junk of ['{', '[]', '{"v":2}', '{"v":1,"all":"x"}', '{"v":1,"all":[1]}', null]) expect(decodeDefinition(junk)).toBeNull();
  });

  it('a name search narrows any source into an unsaved definition; a saved list keeps its own filters under it', () => {
    const list = { id: L_MINE, scope: 'personal' as const, mine: true, name: 'Mine', definition: { v: 1 as const, all: [{ kind: 'stage', in: ['active'] }] }, sort: 'last_activity_desc' as const, position: 0, updatedAt: '', audienceProtected: false };
    expect(effectiveSource({ kind: 'list', listId: L_MINE }, '', [list], 'Mine')).toEqual({ kind: 'list', listId: L_MINE });
    expect(effectiveSource({ kind: 'list', listId: L_MINE }, 'jane', [list], 'Mine')).toEqual({ kind: 'definition', label: 'Mine', definition: { v: 1, all: [{ kind: 'stage', in: ['active'] }, { kind: 'name', contains: 'jane' }] } });
    expect(effectiveSource({ kind: 'all' }, 'jane', [], 'Everyone')).toEqual({ kind: 'definition', label: 'Everyone', definition: { v: 1, all: [{ kind: 'name', contains: 'jane' }] } });
    expect(definitionOfSource({ kind: 'list', listId: 'missing' }, [list])).toBeNull();
    expect(sourceFromParams(new URLSearchParams({ f: encodeDefinition({ v: 1, all: [{ kind: 'stage', not_in: ['lost'] }] }) }))).toMatchObject({ kind: 'definition', label: 'Filtered people' });
    expect(loosenText(['Stage is Closed', 'Name contains “x”'])).toBe('No one you can see matches all of these filters. Try removing Stage is Closed or Name contains “x”.');
  });
});

// ---- the builder in jsdom ----------------------------------------------------------------------------

const person = (n: number): PersonView => ({ id: `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`, displayName: `Person ${n}`, stage: 'active', intent: null, contactType: 'lead', owner: null, sourceName: null, lastActivityAt: null, createdAt: '2026-11-01T12:00:00Z', nextTaskDueAt: null, tags: [] });
const pageOf = (n: number) => ({ people: Array.from({ length: n }, (_, i) => person(i + 1)), nextCursor: null, sort: 'last_activity_desc', list: null, scope: 'people_you_can_see', audienceProtected: false });
const listView = (id: string, scope: 'team' | 'personal', name: string, definition: unknown) => ({ id, scope, mine: scope === 'personal', name, definition, sort: 'last_activity_desc', position: 0, updatedAt: '2026-11-01T00:00:00Z', audienceProtected: false });

function world(role: 'agent' | 'team_lead' = 'agent') {
  const fake = new FakeFetch()
    .on('GET /smart-lists', { status: 200, body: { lists: [listView(L_MINE, 'personal', 'Mine', { v: 1, all: [{ kind: 'stage', in: ['active'] }] }), listView(L_TEAM, 'team', 'Team open', { v: 1, all: [{ kind: 'stage', not_in: ['closed'] }] })] } })
    .on('GET /people', { status: 200, body: pageOf(12) })
    .on('GET /people/count', { status: 200, body: { count: 12, capped: false } })
    .on(`GET /people?list=${L_MINE}`, { status: 200, body: pageOf(4) })
    .on(`GET /people/count?list=${L_MINE}`, { status: 200, body: { count: 4, capped: false } })
    .on(`GET /people?list=${L_TEAM}`, { status: 200, body: pageOf(9) })
    .on(`GET /people/count?list=${L_TEAM}`, { status: 200, body: { count: 9, capped: false } })
    .on('POST /people/query', (c) => ({ status: 200, body: pageOf(JSON.stringify(c.body).includes('not_in') ? 7 : 4) }))
    .on('POST /people/count', (c) => ({ status: 200, body: { count: JSON.stringify(c.body).includes('not_in') ? 7 : 4, capped: false } }))
    .on('GET /tags', { status: 200, body: { tags: [{ id: DNC, name: 'DNC', color: null, protected: false, createdByKind: 'user', usage: null }] } })
    .on('GET /custom-fields', { status: 200, body: { fields: [], liveCount: 0, limit: 50 } })
    .on('GET /stage-labels', { status: 200, body: { labels: { active: 'Working' }, stages: [['new', 'New'], ['attempting', 'Attempting'], ['connected', 'Connected'], ['nurture', 'Nurture'], ['active', 'Working'], ['under_contract', 'Under contract'], ['closed', 'Closed'], ['lost', 'Lost']].map(([key, label]) => ({ key, label })) } })
    .on('GET /people/filter-options', { status: 200, body: { sources: [{ id: Z, name: 'Zillow', active: true }, { id: W, name: 'Website', active: true }], members: [{ userId: ME, name: 'Ava Agent', role: 'agent', active: true }] } });
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return fake;
}

describe('the filter builder (lane people-filters)', () => {
  it('E194 E195: Filter → Source → is not → Zillow → "Show 7 people" runs exactly that definition; the chip removes it; the team\'s stage label is used', async () => {
    const fake = world();
    renderApp({ fake, path: '/people', table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add a filter' });
    expect(within(sheet).getByRole('button', { name: 'Stage' })).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Source' }));
    await user.click(within(screen.getByRole('dialog')).getByText('is not'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Zillow' }));
    await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Show 7 people' }));
    await screen.findByText(/^7 people · Showing people you can see/);
    const q = fake.callsTo('POST /people/query').at(-1)!;
    expect(q.body).toEqual({ definition: { v: 1, all: [{ kind: 'source', not_in: [Z] }] } });
    await user.click(screen.getByRole('button', { name: 'Remove filter Source is not Zillow' }));
    await screen.findByRole('heading', { level: 2, name: 'Everyone' });
    // the stage values carry the team's own labels
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stage' }));
    expect(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Working' })).toBeTruthy();
  });

  it('R-PAR-27: Save as list with a name search refuses "My team" in plain words before the tap; "Only me" saves', async () => {
    const fake = world('team_lead').on('POST /smart-lists', { status: 201, body: { list: listView(L_MINE, 'personal', 'Janes', {}) } });
    renderApp({ fake, path: `/people?f=${encodeURIComponent(encodeDefinition({ v: 1, all: [{ kind: 'stage', in: ['active'] }] }))}&q=jane`, table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Save as list' }));
    const dlg = await screen.findByRole('dialog', { name: 'Save as list' });
    await user.type(within(dlg).getByLabelText('Name'), 'Janes');
    await user.click(within(dlg).getByLabelText(/My team/));
    expect(within(dlg).getByText(TEAM_TEXT_REFUSAL)).toBeTruthy();
    expect((within(dlg).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dlg).getByLabelText('Only me'));
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.callsTo('POST /smart-lists')).toHaveLength(1));
    expect(fake.callsTo('POST /smart-lists')[0]!.body).toEqual({ scope: 'personal', name: 'Janes', definition: { v: 1, all: [{ kind: 'stage', in: ['active'] }, { kind: 'name', contains: 'jane' }] } });
  });

  it('Edit filters on my saved list: change the filter, "Save changes" PATCHes the list\'s definition', async () => {
    const fake = world().on(`PATCH /smart-lists/${L_MINE}`, { status: 200, body: { list: listView(L_MINE, 'personal', 'Mine', {}) } });
    renderApp({ fake, path: `/people?list=${L_MINE}`, table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await screen.findByText(/^4 people/);
    await user.click(await screen.findByRole('button', { name: /^Edit filters/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change filter Stage is Working' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Nurture' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes to “Mine”' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /smart-lists/${L_MINE}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /smart-lists/${L_MINE}`)[0]!.body).toEqual({ definition: { v: 1, all: [{ kind: 'stage', in: ['active', 'nurture'] }] } });
  });

  it('R-PAR-27: an agent may only apply a team list\'s filters (no Save changes); a Team Lead\'s Save changes refuses a name filter in plain words, Show still applies it', async () => {
    const fake = world();
    const first = renderApp({ fake, path: `/people?list=${L_TEAM}`, table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await screen.findByText(/^9 people/);
    await user.click(await screen.findByRole('button', { name: /^Edit filters/ }));
    expect(within(await screen.findByRole('dialog', { name: 'Filters' })).queryByRole('button', { name: /Save changes/ })).toBeNull();
    first.view.unmount();

    const tl = world('team_lead').on(`PATCH /smart-lists/${L_TEAM}`, { status: 200, body: { list: listView(L_TEAM, 'team', 'Team open', {}) } });
    renderApp({ fake: tl, path: `/people?list=${L_TEAM}`, table: tableWith(peopleSurface) });
    await screen.findByText(/^9 people/);
    await user.click(await screen.findByRole('button', { name: /^Edit filters/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Add filter' }));
    const nameField = within(screen.getByRole('dialog')).getByRole('button', { name: /^Name/ });
    expect(nameField.textContent).toContain("Can't be saved to a team list");
    await user.click(nameField);
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Name contains'), 'jane');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    const dlg = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(dlg).getByText(TEAM_TEXT_REFUSAL)).toBeTruthy();
    expect((within(dlg).getByRole('button', { name: 'Save changes to “Team open”' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dlg).getByRole('button', { name: /^Show / }) as HTMLButtonElement).disabled).toBe(false);
    expect(tl.callsTo(`PATCH /smart-lists/${L_TEAM}`)).toHaveLength(0);
  });

  it('review: focus moves into each new step of the builder (never to <body>)', async () => {
    const fake = world();
    renderApp({ fake, path: '/people', table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Add a filter' })).getByRole('button', { name: 'Source' }));
    await screen.findByRole('dialog', { name: 'Source' });
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Zillow' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Back' }));
    await screen.findByRole('dialog', { name: 'Add a filter' });
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('review: the live count is spoken (a status inside the sheet), and the button never shows an older count while the new one loads', async () => {
    let release: (() => void) | null = null;
    const fake = world().on('POST /people/count', (c) =>
      JSON.stringify(c.body).includes('not_in') ? new Promise((ok) => (release = () => ok({ status: 200, body: { count: 7, capped: false } }))) : { status: 200, body: { count: 12, capped: false } },
    );
    renderApp({ fake, path: '/people', table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Source' }));
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Show 12 people' });
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe('12 people match');
    await user.click(within(screen.getByRole('dialog')).getByText('is not'));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Zillow' }));
    // the count of the new draft is not back yet: no number is claimed
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Show people' });
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe('Counting…');
    await waitFor(() => expect(release).not.toBeNull());
    release!();
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Show 7 people' });
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe('7 people match');
  });

  it('review: typing a name counts once after the typing stops, not once per keystroke', async () => {
    const fake = world();
    renderApp({ fake, path: '/people', table: tableWith(peopleSurface) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Name' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Name contains'), 'johnson');
    await waitFor(() => expect(fake.callsTo('POST /people/count').some((c) => JSON.stringify(c.body).includes('johnson'))).toBe(true));
    const partial = fake.callsTo('POST /people/count').filter((c) => /"contains":"j[a-z]*"/.test(JSON.stringify(c.body)) && !JSON.stringify(c.body).includes('johnson'));
    expect(partial).toHaveLength(0);
  });

  it('review: with only "any of" filters the sheet does not say "No filters yet"; the sheet has a Close button', async () => {
    const fake = world();
    const def = { v: 1 as const, all: [], any: [{ kind: 'source', in: [Z] }, { kind: 'tag', op: 'any', tagIds: [DNC] }] };
    renderApp({ fake, path: `/people?f=${encodeURIComponent(encodeDefinition(def))}&filter=open`, table: tableWith(peopleSurface) });
    const dlg = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(dlg).getByRole('list', { name: 'Any of' })).toBeTruthy();
    expect(within(dlg).queryByText(/No filters yet/)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(dlg).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('review: more tags than a list may hold is refused in plain words before any request', () => {
    const many = Array.from({ length: 21 }, (_, i) => `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(buildClause('tag', 'any', { ...EMPTY_VALUE, choices: many })).toEqual({ ok: false, message: 'Pick at most 20 tags.' });
    expect(buildClause('source', 'not_in', { ...EMPTY_VALUE, choices: [...many, ...many, ...many] })).toEqual({ ok: false, message: 'Pick at most 50.' });
  });
});
