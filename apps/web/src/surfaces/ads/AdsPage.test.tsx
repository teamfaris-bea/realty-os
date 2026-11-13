// The Google Ads page (module 55 item 10) in jsdom on the staff contract: every API sentence, the dark states (E667),
// role gating (E671), one-tap decisions through useAction that are never retried (E668, E669), the Owner's cap with
// its attestation (E670), Resume, the ledger's "Show older" and campaign linking. No raw code anywhere.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { navFor, pagesFor } from '../../shell/index.js';
import { sessionFixture } from '../../shell/testing/fakeApi.js';
import { ADS_IDS, NOT_CLEARED_SENTENCE, RAW, ROLES_WITHOUT_ADS, adsApp, adsFake, adsTable, darkOverview, ev, hold, overview, proposal, run, staffError } from './testing.js';

const user = () => userEvent.setup();
const mainText = () => screen.getByRole('main').textContent ?? '';
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('Google Ads page', () => {
  it('R-STAFF-1 R-STAFF-3: every API sentence shows as written, the pack through packName, totals against the cap and ceiling, and no raw code', async () => {
    const o = overview({
      uncheckedSentence: 'Google Ads spend was not checked for 3 hours.',
      doubleCount: { leadSourceIds: ['01900000-0000-7000-8000-0000000ad5c1'], sentence: '1 lead source has both a cost typed in by hand and Google Ads spend for 2026-11: the owner view counts both.' },
      unmanagedSentence: '$25.00 a day of budgets on campaigns not managed here.',
    });
    adsApp(adsFake(o));
    expect(await screen.findByRole('heading', { level: 1, name: 'Google Ads' })).toBeInTheDocument();
    await screen.findByText(o.stateSentence);
    for (const s of [o.stateSentence, o.packSentence, o.monthToDate.sentence, o.dailyTotal.sentence, o.overspendNote, o.uncheckedSentence!, o.unmanagedSentence, o.doubleCount!.sentence]) {
      expect(screen.getByText(s)).toBeInTheDocument();
    }
    expect(screen.getByText('Google Ads budget changes')).toBeInTheDocument();
    expect(screen.getByTestId('month-to-date')).toHaveTextContent('$1,234.56 of your $3,000.00 monthly cap');
    expect(screen.getByTestId('daily-total')).toHaveTextContent('$90.00 against your $120.00 daily ceiling');
    expect(screen.getByTestId('cap')).toHaveTextContent('$3,000.00 a month and $120.00 a day.');
    expect(screen.getByText(/^As reported by Google Ads at Nov 13/)).toBeInTheDocument();
    // campaigns: status words, why, budget and note, outcomes with their window and as-of, their ledger
    const lake = screen.getByRole('article', { name: 'Lakeside open houses' });
    expect(within(lake).getByText('Paused')).toBeInTheDocument();
    expect(within(lake).getByText('Paused on Google Ads.')).toBeInTheDocument();
    expect(within(lake).getByText('Daily budget $25.00 (shared budget).')).toBeInTheDocument();
    expect(within(lake).getByText(/Paused, \$25\.00 → \$0\.00 a day \(the monthly cap was reached\)\./)).toBeInTheDocument();
    const north = screen.getByRole('article', { name: 'North Shore homes' });
    expect(within(north).getByText('Managed here')).toBeInTheDocument();
    expect(within(north).getByText('6 agreements and 2 closings on $2,700.00 spent in 90 days, as of Nov 9, 2026.')).toBeInTheDocument();
    expect(within(north).getByText(/Changed on Google Ads, \$40\.00 → \$50\.00 a day \(Google Ads confirmed it\)\./)).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Budget changes' });
    await waitFor(() => expect(screen.getAllByText(/Lakeside open houses:/).length).toBeGreaterThan(0));
    expect(mainText()).not.toMatch(RAW);
    expect(mainText()).not.toMatch(/confiden|probab|%|score|grade|rank/i);
  });

  it('E667 R-STAFF-1 (verify 13): while platform:ads is not cleared the server sentence shows verbatim; stored spend and campaigns read-only; no Resume, proposal or Approve; the cap form and linking stay', async () => {
    const fake = adsFake(darkOverview());
    adsApp(fake);
    expect(await screen.findByText(NOT_CLEARED_SENTENCE)).toBeInTheDocument();
    expect(screen.getByText(/Shown as last read/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'North Shore homes' })).toBeInTheDocument();
    expect(screen.getByTestId('month-to-date')).toHaveTextContent('$1,234.56');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Budget proposal' })).toBeNull();
    expect(screen.getByLabelText('Monthly cap (dollars)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Change listing' })).toHaveLength(3);
    expect(mainText()).not.toMatch(RAW);
  });

  it('E667 R-STAFF-1: with reads off and nothing stored, the NOT_READ sentence and no campaigns (no ledger request)', async () => {
    const notRead = 'Budget changes and the pause at your monthly cap stay off until counsel review and the Google Ads check are complete. Until then Google Ads is not read, so no campaigns or spend are shown.';
    const fake = adsFake(darkOverview({ stateSentence: notRead, campaigns: [], pendingProposal: null, lastSyncedAt: null, asOf: null }));
    adsApp(fake);
    expect(await screen.findByText(notRead)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Campaigns' })).toBeNull();
    await settle();
    expect(fake.callsTo('GET /ads/ledger')).toHaveLength(0);
  });

  it('E671 R-STAFF-6: an agent, Team Lead, ISA or TC opening /ads by URL sees "Not available" and no /ads request is made', async () => {
    for (const role of ROLES_WITHOUT_ADS) {
      const fake = adsFake();
      const { view } = adsApp(fake, '/ads', role);
      expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
      await settle();
      expect(fake.calls.filter((c) => c.path.startsWith('/ads')), role).toEqual([]);
      view.unmount();
    }
  });

  it('R-STAFF-6: Google Ads is in the Team section for Owner and Admin only (More on a phone, 2 taps)', () => {
    const t = adsTable();
    for (const role of ['owner', 'admin'] as const) expect(navFor(pagesFor(t, role)).more.map((i) => i.label)).toContain('Google Ads');
    for (const role of ROLES_WITHOUT_ADS) expect(navFor(pagesFor(t, role)).more.map((i) => i.label)).not.toContain('Google Ads');
  });

  it('R-STAFF-4: an Admin decides proposals but has no cap form (the cap is the Owner’s)', async () => {
    adsApp(adsFake(), '/ads', 'admin');
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByText('Only the Owner sets the cap.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Monthly cap (dollars)')).toBeNull();
  });
});

describe('Resume', () => {
  it('R-STAFF-4 E669: Resume is one tap, one request with no command id; a pending result says it waits and Resume goes away', async () => {
    const fake = adsFake().on(`POST /ads/campaigns/${ADS_IDS.paused}/resume`, { status: 200, body: { actionId: ADS_IDS.newer, status: 'approved', runId: ADS_IDS.run, rows: [{ campaignId: ADS_IDS.paused, fromDailyCents: 0, toDailyCents: 2_500, reasonCode: 'RESUMED', outcome: 'pending', outcomeCode: null, providerRef: null }] } });
    adsApp(fake);
    const lake = await screen.findByRole('article', { name: 'Lakeside open houses' });
    expect(within(screen.getByRole('article', { name: 'North Shore homes' })).queryByRole('button', { name: 'Resume' })).toBeNull();
    await user().click(within(lake).getByRole('button', { name: 'Resume' }));
    expect(await within(lake).findByText('Resumed. Waiting for Google Ads to confirm; checked hourly.')).toBeInTheDocument();
    expect(within(lake).queryByRole('button', { name: 'Resume' })).toBeNull();
    const calls = fake.callsTo(`POST /ads/campaigns/${ADS_IDS.paused}/resume`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({});
  });

  it('R-STAFF-4: a 502 on Resume sends exactly one request and says the outcome is not known; ADS_MONTHLY_CAP_REACHED is said in words', async () => {
    const fake = adsFake().on(`POST /ads/campaigns/${ADS_IDS.paused}/resume`, { status: 502 });
    adsApp(fake);
    const lake = await screen.findByRole('article', { name: 'Lakeside open houses' });
    await user().click(within(lake).getByRole('button', { name: 'Resume' }));
    expect(await within(lake).findByText(/could not tell whether your tap reached the server/)).toBeInTheDocument();
    await settle();
    expect(fake.callsTo(`POST /ads/campaigns/${ADS_IDS.paused}/resume`)).toHaveLength(1);

    const fake2 = adsFake().on(`POST /ads/campaigns/${ADS_IDS.paused}/resume`, staffError('ADS_CAMPAIGN_NOT_ELIGIBLE', { blockers: ['CREATIVE_NOT_APPROVED'] }));
    document.body.innerHTML = '';
    adsApp(fake2);
    const lake2 = await screen.findByRole('article', { name: 'Lakeside open houses' });
    await user().click(within(lake2).getByRole('button', { name: 'Resume' }));
    expect(await within(lake2).findByText('This campaign cannot be resumed here: its creative is not approved. Resume it in Google Ads.')).toBeInTheDocument();
  });
});

describe('the Owner’s cap', () => {
  it('R-STAFF-4: dollars are sent as cents with the attestation sentence exactly as the API rebuilds it, after re-auth', async () => {
    let n = 0;
    const s = sessionFixture();
    const fake = adsFake()
      .on('POST /ads/caps', () => (++n === 1 ? staffError('REAUTH_REQUIRED') : { status: 201, body: { cap: { id: ADS_IDS.cap, versionNo: 2, monthlyCapCents: 250_050, dailyCeilingCents: 10_000, effectiveFrom: '2026-11-13T10:00:00.000Z' }, reconcileQueued: false } }))
      .on('POST /auth/reauth', { status: 200, body: { session: { ...s, tenant: { ...s.tenant!, role: 'owner' } } } });
    adsApp(fake);
    const u = user();
    const monthly = await screen.findByLabelText('Monthly cap (dollars)');
    await u.clear(monthly);
    await u.type(monthly, '2,500.50');
    const daily = screen.getByLabelText('Daily ceiling (dollars)');
    await u.clear(daily);
    await u.type(daily, '100');
    const sentence = 'I approve a Google Ads cap of $2,500.50 a month and $100.00 a day.';
    expect(screen.getByRole('button', { name: 'Save cap' })).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: sentence }));
    await u.click(screen.getByRole('button', { name: 'Save cap' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const calls = fake.callsTo('POST /ads/caps');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.body).toEqual({ monthlyCapCents: 250_050, dailyCeilingCents: 10_000, attestation: sentence });
  });

  it('E670 R-STAFF-4: ATTESTATION_REQUIRED shows details.expected verbatim; the Owner confirms that exact sentence', async () => {
    const expected = 'I approve a Google Ads cap of $2,000.00 a month and $80.00 a day, as worded by counsel.';
    let n = 0;
    const fake = adsFake().on('POST /ads/caps', () => (++n === 1 ? staffError('ATTESTATION_REQUIRED', { expected }) : { status: 201, body: { cap: { id: ADS_IDS.cap, versionNo: 2, monthlyCapCents: 200_000, dailyCeilingCents: 8_000, effectiveFrom: '2026-11-13T10:00:00.000Z' }, reconcileQueued: true } }));
    adsApp(fake, '/ads', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = user();
    const monthly = await screen.findByLabelText('Monthly cap (dollars)');
    await u.clear(monthly);
    await u.type(monthly, '2000');
    const daily = screen.getByLabelText('Daily ceiling (dollars)');
    await u.clear(daily);
    await u.type(daily, '80');
    await u.click(screen.getByRole('checkbox', { name: 'I approve a Google Ads cap of $2,000.00 a month and $80.00 a day.' }));
    await u.click(screen.getByRole('button', { name: 'Save cap' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(fake.callsTo('POST /ads/caps')).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Confirm and save' }));
    expect(await screen.findByText(/Month-to-date spend is already at or above this cap/)).toBeInTheDocument();
    const calls = fake.callsTo('POST /ads/caps');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ monthlyCapCents: 200_000, dailyCeilingCents: 8_000, attestation: expected });
    expect(mainText()).not.toMatch(RAW);
  });

  it('R-STAFF-4: a daily ceiling above the cap is refused in words before any request; a 502 sends exactly one request', async () => {
    const fake = adsFake().on('POST /ads/caps', { status: 502 });
    adsApp(fake, '/ads', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = user();
    const monthly = await screen.findByLabelText('Monthly cap (dollars)');
    await u.clear(monthly);
    await u.type(monthly, '100');
    const daily = screen.getByLabelText('Daily ceiling (dollars)');
    await u.clear(daily);
    await u.type(daily, '200');
    expect(screen.getByText('The daily ceiling cannot be above the monthly cap.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await u.clear(daily);
    await u.type(daily, '50');
    await u.click(screen.getByRole('checkbox', { name: /I approve a Google Ads cap/ }));
    await u.click(screen.getByRole('button', { name: 'Save cap' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await settle();
    expect(fake.callsTo('POST /ads/caps')).toHaveLength(1);
  });
});

describe('ledger and linking', () => {
  it('R-STAFF-3: the ledger’s "Show older" asks for the page before the last event shown', async () => {
    const fake = adsFake()
      .on('GET /ads/ledger', { status: 200, body: { events: [ev(1)], next: ev(1).id } })
      .on(`GET /ads/ledger?before=${ev(1).id}`, { status: 200, body: { events: [ev(3, { occurredAt: '2026-10-01T15:00:00.000Z', reasonCode: 'OUTCOME_UNKNOWN', kind: 'failed' })], next: null } });
    adsApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Show older' }));
    expect(await screen.findByText(/Not changed, \$40\.00 → \$50\.00 a day \(Google Ads never confirmed it within a day\)\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(fake.callsTo(`GET /ads/ledger?before=${ev(1).id}`)).toHaveLength(1);
  });

  it('R-STAFF-5: linking picks a listing and one of its approved or published pieces, and sends only the two ids', async () => {
    const piece = (id: string, status: string, versionNo: number) => ({ id, listingId: ADS_IDS.listing, kind: 'social_post', versionNo, status, statusLabel: status === 'draft' ? 'Draft' : 'Approved', prose: {}, contentSha256: 'x', timezone: 'Etc/UTC', preview: null, assets: [], guard: { approvable: true, reasons: [] } });
    const fake = adsFake()
      .on('GET /listings?limit=200', { status: 200, body: { listings: [{ id: ADS_IDS.listing, addressLine1: '12 Harbor Way', city: 'Bayview' }] } })
      .on(`GET /listings/${ADS_IDS.listing}/marketing`, { status: 200, body: { pieces: [piece(ADS_IDS.piece, 'approved', 2), piece('01900000-0000-7000-8000-0000000ad0f3', 'draft', 3)], targets: [], publishingCleared: false, fairHousingReviewSentence: '' } })
      .on(`PATCH /ads/campaigns/${ADS_IDS.south}`, { status: 200, body: { campaign: { id: ADS_IDS.south, status: 'draft', listingId: ADS_IDS.listing, creativePieceId: ADS_IDS.piece, dailyBudgetCents: 4_000 } } });
    adsApp(fake, '/ads', 'admin');
    const south = await screen.findByRole('article', { name: 'South Bay condos' });
    const u = user();
    await u.click(within(south).getByRole('button', { name: 'Change listing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a listing' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '12 Harbor Way, Bayview' })).toBeInTheDocument());
    await u.selectOptions(within(dialog).getByLabelText('Listing'), ADS_IDS.listing);
    const pieceSelect = await within(dialog).findByLabelText('Approved marketing piece');
    await waitFor(() => expect(within(pieceSelect).getAllByRole('option')).toHaveLength(2));
    expect(within(dialog).queryByRole('option', { name: /version 3/ })).toBeNull();
    await u.selectOptions(pieceSelect, ADS_IDS.piece);
    await u.click(within(dialog).getByRole('button', { name: 'Save link' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const calls = fake.callsTo(`PATCH /ads/campaigns/${ADS_IDS.south}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ listingId: ADS_IDS.listing, creativePieceId: ADS_IDS.piece });
  });
});

describe('the weekly proposal on the Ads page', () => {
  it('R-STAFF-3: the hold shows its explanation and its counts with their window', async () => {
    adsApp(adsFake(overview({ pendingProposal: null, latestHold: hold() })));
    expect(await screen.findByText(hold().explanation)).toBeInTheDocument();
    expect(screen.getByText(/: 6 agreements \(5 needed\) and 2 closings on \$2,700\.00 in 90 days\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(mainText()).not.toMatch(RAW);
  });

  it('E668 R-STAFF-4: a superseded proposal answers ACTION_NOT_PENDING: words, the page refetches and shows the newer one beside it', async () => {
    const newer = proposal({ id: ADS_IDS.newer, explanation: 'A newer proposal for this week.' });
    let tapped = false;
    const fake = adsFake(() => overview({ pendingProposal: tapped ? newer : proposal() }))
      .on(`POST /ads/proposals/${ADS_IDS.proposal}/approve`, () => {
        tapped = true;
        return staffError('ACTION_NOT_PENDING', { status: 'superseded' });
      });
    adsApp(fake);
    await user().click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('A newer proposal replaced this one. The page now shows the current one.')).toBeInTheDocument();
    expect(await screen.findByText('A newer proposal for this week.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(fake.callsTo(`POST /ads/proposals/${ADS_IDS.proposal}/approve`)).toHaveLength(1);
    expect(fake.callsTo(`POST /ads/proposals/${ADS_IDS.newer}/approve`)).toHaveLength(0);
  });

  it('E669 R-STAFF-4: keeps the approved result on screen after the refetch drops the proposal', async () => {
    let tapped = false;
    const fake = adsFake(() => overview({ pendingProposal: tapped ? null : proposal() }))
      .on(`POST /ads/proposals/${ADS_IDS.proposal}/approve`, () => {
        tapped = true;
        return { status: 200, body: run('applied') };
      });
    adsApp(fake);
    const c = await screen.findByRole('article', { name: 'Budget proposal' });
    await user().click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await within(c).findByText('Approved.')).toBeInTheDocument();
    const before = fake.callsTo('GET /ads').length;
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'This week’s proposal' })).toBeInTheDocument());
    await settle();
    expect(fake.callsTo('GET /ads').length).toBeGreaterThanOrEqual(before);
    expect(screen.getByText(proposal().explanation)).toBeInTheDocument();
    expect(screen.getByText(/: \$50\.00 → \$60\.00 a day\. Changed on Google Ads\./)).toBeInTheDocument();
  });
});
