// Owner view (module 40; R-OWNER-1…5; E107–E109): every number with its denominator and method, a desktop table and
// phone cards, the deals left out by name, velocity and the forecast with their exclusions, cost entry (and its
// error sentences), Owner/Admin only in nav; no confidence or percentage anywhere.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { navFor, pagesFor } from '../../shell/index.js';
import { centsToDollarsWords, monthsOf, rangeQuery, shiftYm } from './OwnerPage.js';
import { ZILLOW, err, insightsApp, insightsTable, ownerFake } from './testing.js';

describe('Owner view', () => {
  it('R-OWNER-1 R-OWNER-2: the sources table shows each number with its denominator and the section’s method; E108 says "— (0 closings)"', async () => {
    insightsApp(ownerFake(), '/owner');
    expect(await screen.findByRole('heading', { level: 1, name: 'Owner view' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Dollars by lead source/ });
    const z = within(table).getByRole('row', { name: /Zillow/ });
    expect(within(z).getByText('$15,000.50')).toBeInTheDocument();
    expect(within(z).getByText('from 2 of 3 closings with a commission entered')).toBeInTheDocument();
    expect(within(z).getByText('$900.00 over 1 monthly entry')).toBeInTheDocument();
    expect(within(z).getByText('$300.00 per closing (3 closings)')).toBeInTheDocument();
    const b = within(table).getByRole('row', { name: /Billboard/ });
    expect(within(b).getByText('— (0 closings)')).toBeInTheDocument();
    expect(screen.getByText(/summed by the lead source each deal was created with/)).toBeInTheDocument();
    // phone cards carry the same words
    const cards = screen.getByRole('list', { name: 'Dollars by source' });
    expect(within(cards).getAllByRole('article')).toHaveLength(2);
    expect(within(cards).getByText(/Cost per closing: — \(0 closings\)/)).toBeInTheDocument();
    // the only percent on the page is the forecast method's "80% Wilson range" (how the range is made, not a figure)
    const text = screen.getByRole('main').textContent!.replace(/80% Wilson range/g, '');
    expect(text).not.toMatch(/confiden|probab|%|score|grade/i);
  });

  it('E107: deals left out of the dollars are counted and named, with a link to each deal', async () => {
    insightsApp(ownerFake(), '/owner');
    const note = await screen.findByText('Left out of the dollars');
    const box = note.closest('[role="status"]') as HTMLElement;
    expect(within(box).getByText(/1 closed deal with no commission entered/)).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Lee purchase' })).toHaveAttribute('href', expect.stringMatching(/\/deals\//));
    expect(within(box).getByText(/1 closed deal with no lead source/)).toBeInTheDocument();
  });

  it('R-OWNER-3 E109: velocity with n, thin stages listed; the forecast range, its method sentence, k of n per counted stage and the stages left out', async () => {
    insightsApp(ownerFake(), '/owner');
    expect(await screen.findByText('median 10 days (n=6)')).toBeInTheDocument();
    expect(screen.getByText(/Not enough history \(fewer than 5 moves\): Active \(n=1\)/)).toBeInTheDocument();
    expect(screen.getByTestId('forecast-closings')).toHaveTextContent('7.4–11.1 closings');
    expect(screen.getByTestId('forecast-commission_cents')).toHaveTextContent('$6,000.00–$9,500.00');
    expect(screen.getAllByText(/80% Wilson range/)).toHaveLength(2);
    expect(screen.getAllByText('Under contract: 8 of 10 closed within 90 days')).toHaveLength(2);
    expect(screen.getAllByText('Not enough history: Prospect, Agreement signed, Active.')).toHaveLength(2);
  });

  it('R-OWNER-5: Enter cost saves the amount in cents for the chosen month and says so; a future month is said in words', async () => {
    let n = 0;
    const q = rangeQuery('this');
    const fake = ownerFake().on('PUT /lead-source-costs', () => (++n === 1 ? err(422, 'COST_MONTH_IN_FUTURE') : { status: 200, body: { cost: { id: 'x', month: q.to, closedMonth: false, previousCents: 90_000, amountCents: 123_456 } } }));
    insightsApp(fake, '/owner');
    const u = userEvent.setup();
    // the desktop table and the phone card each have one (CSS shows one of them)
    await screen.findByRole('table');
    await u.click(screen.getAllByRole('button', { name: 'Enter cost for Zillow' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Enter cost' });
    const amount = within(dialog).getByLabelText('Amount (dollars)');
    expect(amount).toHaveValue('900.00');
    await u.clear(amount);
    await u.type(amount, '1,234.56');
    await u.click(within(dialog).getByRole('button', { name: 'Save cost' }));
    expect(await within(dialog).findByText(/That month has not started yet/)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Save cost' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.callsTo('PUT /lead-source-costs')[1]!.body).toEqual({ leadSourceId: ZILLOW, month: q.to, amountCents: 123_456, note: 'Premier Agent' });
    expect(await screen.findByText(/Cost saved for Zillow/)).toBeInTheDocument();
  });

  it('R-OWNER-1: only the Owner and Admin see Owner view in navigation; nobody else can open it', () => {
    const table = insightsTable();
    for (const role of ['owner', 'admin'] as const) expect(pagesFor(table, role).map((p) => p.path)).toContain('/owner');
    for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) {
      expect(pagesFor(table, role).map((p) => p.path)).not.toContain('/owner');
      expect(JSON.stringify(navFor(pagesFor(table, role)))).not.toContain('Owner view');
    }
  });

  it('money words are exact cents and the period helpers are consistent; axe finds nothing on the page with the dialog open', async () => {
    expect(centsToDollarsWords(1_500_050)).toBe('$15,000.50');
    expect(centsToDollarsWords(5)).toBe('$0.05');
    expect(shiftYm('2026-01', -1)).toBe('2025-12');
    expect(monthsOf('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    insightsApp(ownerFake(), '/owner');
    await screen.findByRole('table');
    const u = userEvent.setup();
    await u.click(screen.getAllByRole('button', { name: 'Enter cost' })[0]!);
    await screen.findByRole('dialog', { name: 'Enter cost' });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
