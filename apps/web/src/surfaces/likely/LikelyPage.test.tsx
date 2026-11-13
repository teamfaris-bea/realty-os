// The Likely to move page in jsdom on a scripted API (module 55; R-PRED-3..6, R-STAFF-3, R-STAFF-6, R-STAFF-7, E677).
// GET /likely is not in the staff contract: the fixtures below follow apps/api/src/predict/routes.ts LikelyResponse
// exactly (strict objects, the same keys), and StaffFake passes the route through.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { StaffFake } from '../../test/staffContract.js';
import { surface } from './index.js';
import type { LikelyView } from './types.js';

type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

const C1 = '01900000-0000-7000-8000-00000000c001';
const C2 = '01900000-0000-7000-8000-00000000c002';
const C3 = '01900000-0000-7000-8000-00000000c003';

const NO_MODEL_SENTENCE = 'No likely-to-move model is approved on this deployment. A model is used only after counsel has reviewed it and it carries a platform back-test.';
const READY_SENTENCE = 'People you own whom an approved model flags as likely to move. Each line says why. Open a contact to decide what to do.';
const BAND = { likely_90d: 'Scorecard band: may move in the next 90 days', watch: 'Scorecard band: worth keeping an eye on' } as const;

const noModel = (): LikelyView => ({ state: 'no_model', sentence: NO_MODEL_SENTENCE, models: [], items: [], more: false });

const ready = (over: Partial<LikelyView> = {}): LikelyView => ({
  state: 'ready',
  sentence: READY_SENTENCE,
  models: [
    { version: 'scorecard-a', backtest: { flagged: 40, transacted: 12, windowDays: 90 }, sentence: 'Of 40 people flagged in the back-test, 12 transacted within 90 days.' },
    { version: 'scorecard-b', backtest: { flagged: 1, transacted: 0, windowDays: 90 }, sentence: 'Of 1 person flagged in the back-test, 0 transacted within 90 days.' },
  ],
  // the API's order (band, then name); deliberately not alphabetical across bands
  items: [
    { contactId: C2, contactName: 'Zora Pine', modelVersion: 'scorecard-a', band: 'likely_90d', bandWords: BAND.likely_90d, reasons: ['Owned the home 9 years', 'Asked about a home value last month'] },
    { contactId: C1, contactName: 'Abel Cove', modelVersion: 'scorecard-a', band: 'watch', bandWords: BAND.watch, reasons: ['Owned the home 7 years'] },
    { contactId: C3, contactName: 'Mira Lane', modelVersion: 'scorecard-b', band: 'watch', bandWords: BAND.watch, reasons: [] },
  ],
  more: false,
  ...over,
});

function app(fake: StaffFake, role: Role = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path: '/likely', table: tableWith(surface) });
}

const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;

const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => v.id);
};

describe('the Likely to move page', () => {
  it('R-STAFF-7 R-PRED-3: each model\'s back-test is said once, then its rows: the name opens the contact, the band in words, the reasons; axe finds nothing', async () => {
    app(new StaffFake().on('GET /likely', { status: 200, body: ready() }));
    expect(await screen.findByText(READY_SENTENCE)).toBeInTheDocument();
    const a = screen.getByRole('region', { name: 'Flagged by model 1 of 2' });
    const b = screen.getByRole('region', { name: 'Flagged by model 2 of 2' });
    // the back-test sentence once per model, never on a row
    expect(screen.getAllByText('Of 40 people flagged in the back-test, 12 transacted within 90 days.')).toHaveLength(1);
    expect(within(a).getByText('Of 40 people flagged in the back-test, 12 transacted within 90 days.')).toBeInTheDocument();
    expect(within(b).getByText('Of 1 person flagged in the back-test, 0 transacted within 90 days.')).toBeInTheDocument();
    const rowsA = within(within(a).getByRole('list', { name: 'Flagged by model 1 of 2' })).getAllByRole('listitem').filter((li) => li.parentElement?.getAttribute('aria-label') === 'Flagged by model 1 of 2');
    expect(rowsA.map((li) => within(li).getAllByRole('link')[0]!.textContent)).toEqual(['Zora Pine', 'Abel Cove']);
    expect(within(a).getByRole('link', { name: 'Zora Pine' })).toHaveAttribute('href', `/contacts/${C2}`);
    expect(within(rowsA[0]!).getByText(BAND.likely_90d)).toBeInTheDocument();
    expect(within(within(rowsA[0]!).getByRole('list', { name: 'Why Zora Pine is on this list' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual([
      'Owned the home 9 years',
      'Asked about a home value last month',
    ]);
    expect(within(b).getByRole('link', { name: 'Mira Lane' })).toHaveAttribute('href', `/contacts/${C3}`);
    expect(within(b).getByText(BAND.watch)).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    expect(await axeClean()).toEqual([]);
  });

  it('R-STAFF-7 R-PRED-4: the only action is opening the contact: no select-all, text, call, enroll or CMA control', async () => {
    const fake = new StaffFake().on('GET /likely', { status: 200, body: ready() });
    const { router } = app(fake);
    // the page itself (the shell's frame around it has its own links, such as Add person)
    const main = (await screen.findByText(READY_SENTENCE)).parentElement!;
    expect(within(main).queryAllByRole('button')).toEqual([]);
    expect(within(main).queryAllByRole('checkbox')).toEqual([]);
    expect(within(main).queryAllByRole('textbox')).toEqual([]);
    expect(within(main).queryAllByRole('combobox')).toEqual([]);
    for (const l of within(main).getAllByRole('link')) expect(l.getAttribute('href')).toMatch(/^\/contacts\/[0-9a-f-]+$/);
    expect(main.textContent).not.toMatch(/select all|send|text them|call|enroll|cma|comparative/i);
    await userEvent.setup().click(within(main).getByRole('link', { name: 'Abel Cove' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${C1}`));
    // only the read was made: nothing sends, enrolls or writes
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('R-STAFF-3: rows keep the API\'s order, nothing is re-sorted on the client', async () => {
    const items = ready().items.slice(0, 2).reverse();
    app(new StaffFake().on('GET /likely', { status: 200, body: ready({ items }) }));
    const a = await screen.findByRole('region', { name: 'Flagged by model 1 of 2' });
    expect(within(a).getAllByRole('link').map((l) => l.textContent)).toEqual(['Abel Cove', 'Zora Pine']);
  });

  it('E677 R-STAFF-7: with no approved model the page says so in the API\'s words, never "nobody is likely to move", and lists no one', async () => {
    app(new StaffFake().on('GET /likely', { status: 200, body: noModel() }));
    const main = (await screen.findByText(NO_MODEL_SENTENCE)).closest('section')!;
    expect(screen.getByRole('main').textContent).not.toMatch(/nobody|no one is likely|no one will move/i);
    expect(within(main).queryAllByRole('link')).toEqual([]);
    expect(within(main).queryByText(/back-test, \d+ transacted/)).toBeNull();
    expect(await axeClean()).toEqual([]);
  });

  it('E677: a model withdrawn while the page is open is gone on the next load (the API says no_model)', async () => {
    let withdrawn = false;
    const fake = new StaffFake().on('GET /likely', () => ({ status: 200, body: withdrawn ? noModel() : ready() }));
    const { qc } = app(fake);
    await screen.findByRole('link', { name: 'Zora Pine' });
    withdrawn = true;
    await qc.invalidateQueries({ queryKey: ['likely'] });
    expect(await screen.findByText(NO_MODEL_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Zora Pine' })).toBeNull();
  });

  it('R-STAFF-7: a model with no open card for the viewer still says its back-test, and that none is flagged', async () => {
    app(new StaffFake().on('GET /likely', { status: 200, body: ready({ items: [] }) }));
    expect(await screen.findByText('Of 40 people flagged in the back-test, 12 transacted within 90 days.')).toBeInTheDocument();
    expect(screen.getAllByText('None of your contacts has an open card from this model right now.')).toHaveLength(2);
    expect(screen.getByRole('main').textContent).not.toMatch(/nobody/i);
  });

  it('R-STAFF-7: "Showing the first 200" when the API says there are more', async () => {
    app(new StaffFake().on('GET /likely', { status: 200, body: ready({ more: true }) }));
    expect(await screen.findByText('Showing the first 200.')).toBeInTheDocument();
  });

  it('R-STAFF-3 R-PRED-3: no "%", raw code or ISO time in the rendered text; every back-test figure carries its denominator', async () => {
    app(new StaffFake().on('GET /likely', { status: 200, body: ready({ more: true }) }));
    await screen.findByText(READY_SENTENCE);
    const text = screen.getByRole('main').textContent ?? '';
    expect(text).not.toContain('%');
    expect(text).not.toMatch(RAW);
    expect(text).not.toMatch(/confidence|probab|score\b|points|percent|grade|rank/i);
    expect(text).not.toMatch(/likely_90d|scorecard-a|scorecard-b/);
    for (const m of text.matchAll(/(\d+) transacted/g)) expect(text).toMatch(new RegExp(`Of \\d+ (people|person) flagged in the back-test, ${m[1]} transacted within \\d+ days`));
  });

  it('R-STAFF-3 R-PRED-3: the view type carries no confidence, score, points or percentage key', () => {
    const v = ready();
    expect(Object.keys(v).sort()).toEqual(['items', 'models', 'more', 'sentence', 'state']);
    expect(Object.keys(v.models[0]!).sort()).toEqual(['backtest', 'sentence', 'version']);
    expect(Object.keys(v.models[0]!.backtest).sort()).toEqual(['flagged', 'transacted', 'windowDays']);
    expect(Object.keys(v.items[0]!).sort()).toEqual(['band', 'bandWords', 'contactId', 'contactName', 'modelVersion', 'reasons']);
    const keys = JSON.stringify(v).match(/"[A-Za-z]+":/g) ?? [];
    for (const k of keys) expect(k).not.toMatch(/confidence|probab|score|points|percent|rate|rank|grade/i);
  });

  it('a failed load says so in words, never the code', async () => {
    app(new StaffFake().on('GET /likely', { status: 500, body: { error: { code: 'INTERNAL', requestId: 'r' } } }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(RAW);
    expect(alert.textContent).not.toContain('INTERNAL');
  });

  it('R-STAFF-6: a TC opening /likely by URL sees "Not available" and the page never asks for the list', async () => {
    const fake = new StaffFake().on('GET /likely', { status: 200, body: ready() });
    app(fake, 'tc');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
    expect(fake.callsTo('GET /likely')).toHaveLength(0);
  });

  it('R-STAFF-6: every role that owns contacts opens the page', async () => {
    for (const role of ['owner', 'admin', 'team_lead', 'isa'] as const) {
      const fake = new StaffFake().on('GET /likely', { status: 200, body: noModel() });
      const v = app(fake, role);
      expect(await screen.findByText(NO_MODEL_SENTENCE)).toBeInTheDocument();
      expect(fake.callsTo('GET /likely').length).toBeGreaterThan(0);
      v.view.unmount();
    }
  });
});
