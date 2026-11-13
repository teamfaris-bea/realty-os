// The CMA screen (module 72) in jsdom on a scripted API, in every honest state: loading, an error with retry, the agent
// gate's refusals in words (R-CMA-6, E371), no value, a stale feed (E369), read only (someone else's, shared,
// superseded), the shared email's status and the PDF link, a research or listing CMA (never shared from here), and the
// draft's edits: Remove and Use (R-CMA-2), the near match (E370), the facts editor (E373) and the purpose (R-CMA-9).
// The real API runs in e2e/cma.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { CMA_ID, FakeFetch, NOT_CLEARED, cmaApp, comp, err, preview, view } from './testing.js';
import type { CmaView } from './lib.js';

const user = () => userEvent.setup();
const PREVIEW = `GET /cma/${CMA_ID}/share-preview`;

function fake(v: CmaView = view(), p = preview(NOT_CLEARED)) {
  return new FakeFetch().on(`GET /cma/${CMA_ID}`, { status: 200, body: { cma: v } }).on(PREVIEW, { status: 200, body: { preview: p } });
}

describe('CMA screen: the draft', () => {
  it('R-CMA-2 R-CMA-3 R-AVM-1: the range, the estimate line and the source; every comp with its sold price, date, distance or "distance not known", why and labels, expanding to adjustments, adjusted price and weight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    cmaApp(
      fake().on(`GET /cma/${CMA_ID}`, async () => {
        await gate;
        return { status: 200, body: { cma: view() } };
      }),
    );
    expect(await screen.findByText('Loading the CMA')).toBeInTheDocument();
    release();
    expect(await screen.findByRole('heading', { name: 'Estimated range' })).toBeInTheDocument();
    expect(screen.getByText('$520,000 to $570,000')).toBeInTheDocument();
    expect(screen.getByText('Middle of the range: $545,000')).toBeInTheDocument();
    expect(screen.getByText('This is an estimate, not an appraisal.')).toBeInTheDocument();
    expect(screen.getByText(/^Source: MLS sales/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'CMA: 100 Sample Ave' })).toBeInTheDocument();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    const first = within(cards[0]!);
    expect(first.getByRole('heading', { name: '201 Sample Ave' })).toBeInTheDocument();
    expect(first.getByText('Sold $520,000 on Sep 14, 2026')).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('0.5 mi');
    expect(cards[2]).toHaveTextContent('distance not known');
    expect(within(cards[2]!).getByText('Added by you')).toBeInTheDocument();
    expect(first.getByText('Same subdivision')).toBeInTheDocument();
    expect(first.getByText('Closest')).toBeInTheDocument();
    // collapsed until asked
    expect(first.getByText(/^Adjusted price/)).not.toBeVisible();
    await user().click(first.getByRole('button', { name: 'Show adjustments' }));
    expect(first.getByRole('button', { name: 'Hide adjustments' })).toHaveAttribute('aria-expanded', 'true');
    expect(first.getByText('Market change since the sale')).toBeVisible();
    expect(first.getByText('+$12,500')).toBeVisible();
    expect(first.getByText('50 sq ft smaller than the home, at $350 a sq ft from 40 local sales.')).toBeVisible();
    expect(first.getByText('Adjusted price: $550,000')).toBeVisible();
    expect(first.getByText('Counts for 33% of the estimate')).toBeVisible();
    // the rest of the screen
    expect(screen.getByRole('heading', { name: 'For context; not used in the value' })).toBeInTheDocument();
    expect(screen.getByText('400 Sample Ave, Oakland, CA 94110')).toBeInTheDocument();
    expect(screen.getByText('MLS data as of Nov 12, 2026, 9:00 AM.')).toBeInTheDocument();
    expect(screen.getByText('Comparable sales from the same subdivision, sold in the last 12 months.')).toBeInTheDocument();
    expect(screen.getByText('Tried on 20 recent local sales: half were within 4.2% of their sold price.')).toBeInTheDocument();
    expect(screen.getByText('A short sale: not a standard sale.', { exact: false })).toBeInTheDocument();
    // the facts with their sources
    expect(screen.getByText('Sample Heights')).toBeInTheDocument();
    expect(screen.getAllByText("(from the home's MLS record)").length).toBeGreaterThan(3);
    expect(screen.getByText("(from the team's listing)")).toBeInTheDocument();
    // V1's sharing words are never shown (the share preview says what holds)
    expect(document.body.textContent).not.toContain('ignored V1 wording');
  });

  it('a11y: the screen passes axe (no violations)', async () => {
    cmaApp(fake());
    await screen.findByRole('heading', { name: 'Estimated range' });
    await screen.findByText(NOT_CLEARED.blockers[0]!.sentence);
    const r = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('R-CMA-2: Remove sends the comp in exclude; Use on an includable sale sends it in include; a sale that can not be included has no Use', async () => {
    const v = view();
    const f = fake(v).on(`PATCH /cma/${CMA_ID}`, (c) => ({ status: 200, body: { cma: { ...v, updatedAt: '2026-11-12T10:05:00.000Z', subject: { ...v.subject, ...(c.body as object) } } } }));
    cmaApp(f);
    await screen.findByRole('heading', { name: 'Estimated range' });
    await user().click(screen.getByRole('button', { name: 'Remove 201 Sample Ave from the comparable sales' }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)).toHaveLength(1));
    expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[0]!.body).toEqual({ exclude: [comp(1).listingId], include: [] });
    await user().click(screen.getByRole('button', { name: 'Use 300 Sample Ave, Oakland, CA 94110 as a comparable sale' }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)).toHaveLength(2));
    expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[1]!.body).toEqual({ include: ['01900000-0000-7000-8000-0000000c0201'], exclude: [comp(1).listingId] });
    expect(screen.queryByRole('button', { name: /^Use 301 Sample Ave/ })).toBeNull();
    expect(screen.getByText('2 of 2 sales not used are listed')).toBeInTheDocument();
  });

  it('E370: a near match asks "It\'s a different home"; the tap sends nearMatchDismissed, and a dismissed one says so', async () => {
    const near = { listingId: '01900000-0000-7000-8000-0000000c0401', mlsNumber: 'L-1', address: '100 Sample Avenue, Oakland, CA 94110', status: 'active', listingBrokerageName: null, avmDisplayAllowed: true, dismissed: false };
    const v = view({ nearMatches: [near] });
    const f = fake(v).on(`PATCH /cma/${CMA_ID}`, { status: 200, body: { cma: { ...v, updatedAt: '2026-11-12T10:06:00.000Z', nearMatches: [{ ...near, dismissed: true }] } } });
    cmaApp(f);
    await user().click(await screen.findByRole('button', { name: "100 Sample Avenue, Oakland, CA 94110: it's a different home" }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[0]?.body).toEqual({ nearMatchDismissed: [near.listingId] }));
    expect(await screen.findByText('You confirmed this is a different home.')).toBeInTheDocument();
  });

  it('E373: the facts editor sends only what changed, in the API units (tenths for baths), and refuses a size out of range without a request', async () => {
    const v = view();
    const f = fake(v).on(`PATCH /cma/${CMA_ID}`, { status: 200, body: { cma: { ...v, updatedAt: '2026-11-12T10:07:00.000Z' } } });
    cmaApp(f);
    await user().click(await screen.findByRole('button', { name: "Edit the home's facts" }));
    const size = screen.getByLabelText('Size (sq ft)');
    await user().clear(size);
    await user().type(size, '50');
    await user().click(screen.getByRole('button', { name: 'Save and re-run' }));
    expect(screen.getByText('Enter a whole number in range, or leave it empty.')).toBeInTheDocument();
    expect(f.callsTo(`PATCH /cma/${CMA_ID}`)).toHaveLength(0);
    await user().clear(size);
    await user().type(size, '1620');
    await user().clear(screen.getByLabelText('Bathrooms'));
    await user().type(screen.getByLabelText('Bathrooms'), '2.5');
    await user().selectOptions(screen.getByLabelText('Private pool'), 'yes');
    await user().click(screen.getByRole('button', { name: 'Save and re-run' }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)).toHaveLength(1));
    expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[0]!.body).toEqual({ subjectFacts: { sqft: 1620, bathsX10: 25, poolPrivate: true } });
    expect(await screen.findByRole('button', { name: "Edit the home's facts" })).toBeInTheDocument();
  });

  it("R-CMA-9 E606: the purpose chips are one tap each; the five disclosure items appear only for 'other', with what is missing marked", async () => {
    const v = view();
    const other = view({ purpose: 'other', updatedAt: '2026-11-12T10:08:00.000Z', disclosureMissing: ['intendedUsers', 'agentInterest', 'conflicts', 'valueDefinition', 'limitingConditions'] });
    const f = fake(v).on(`PATCH /cma/${CMA_ID}`, (c) => ({ status: 200, body: { cma: (c.body as { purpose?: string }).purpose ? other : { ...other, updatedAt: '2026-11-12T10:09:00.000Z', disclosureMissing: [] } } }));
    cmaApp(f);
    await screen.findByRole('heading', { name: 'Purpose' });
    expect(screen.getByRole('button', { name: 'Listing price' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Who the report is for')).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[0]?.body).toEqual({ purpose: 'other' }));
    const who = await screen.findByLabelText('Who the report is for');
    expect(screen.getAllByText('Needed before sharing.')).toHaveLength(5);
    await user().type(who, 'The sellers');
    await user().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(f.callsTo(`PATCH /cma/${CMA_ID}`)).toHaveLength(2));
    expect(f.callsTo(`PATCH /cma/${CMA_ID}`)[1]!.body).toEqual({ disclosure: { intendedUsers: 'The sellers' } });
  });

  it('an edit refused CMA_NOT_DRAFT says so in words and shows the CMA as it is now', async () => {
    const shared = view({ status: 'shared', canEdit: false, sharedAt: '2026-11-12T11:00:00.000Z', share: { sharedByUserId: 'x', message: { id: 'm', status: 'sent', statusReason: null, sentence: 'Sent.' } } });
    let patched = false;
    const f = new FakeFetch()
      .on(`GET /cma/${CMA_ID}`, () => ({ status: 200, body: { cma: patched ? shared : view() } }))
      .on(PREVIEW, { status: 200, body: { preview: preview(NOT_CLEARED) } })
      .on(`PATCH /cma/${CMA_ID}`, () => {
        patched = true;
        return err(409, 'CMA_NOT_DRAFT', { status: 'shared' });
      });
    cmaApp(f);
    await user().click(await screen.findByRole('button', { name: 'Remove 201 Sample Ave from the comparable sales' }));
    expect(await screen.findByText(/This CMA was shared or replaced, so it no longer changes/)).toBeInTheDocument();
    expect(await screen.findByText('Sent.')).toBeInTheDocument();
  });
});

describe('CMA screen: honest states', () => {
  it('a failed load says so with Try again, and the retry loads the CMA', async () => {
    let up = false;
    const f = new FakeFetch().on(`GET /cma/${CMA_ID}`, () => (up ? { status: 200, body: { cma: view() } } : err(503, 'INTERNAL_ERROR'))).on(PREVIEW, { status: 200, body: { preview: preview(NOT_CLEARED) } });
    cmaApp(f);
    expect(await screen.findByText("Can't load this CMA")).toBeInTheDocument();
    up = true;
    await user().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Estimated range' })).toBeInTheDocument();
  });

  it("R-CMA-6: no live MLS feed is said in the server's sentence; E371: no recorded valuation use in this surface's words when the server sends none", async () => {
    cmaApp(new FakeFetch().on(`GET /cma/${CMA_ID}`, err(409, 'CMA_NO_MLS_CONNECTION', { sentence: 'No MLS feed is connected, so there are no sold homes to compare (server).' })));
    expect(await screen.findByText('No MLS feed is connected, so there are no sold homes to compare (server).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('E371: CMA_VALUATION_NOT_ALLOWED without a sentence names where the use is recorded', async () => {
    cmaApp(new FakeFetch().on(`GET /cma/${CMA_ID}`, err(409, 'CMA_VALUATION_NOT_ALLOWED')));
    expect(await screen.findByText(/An admin records it on the MLS page, under Valuation use\./)).toBeInTheDocument();
  });

  it('R-CMA-4: with no value the screen says why in the server sentence, and shows no number', async () => {
    const v = view({ result: { ...view().result, available: false, reason: 'INSUFFICIENT_COMPS', sentence: 'Not enough comparable sales to estimate a value: 2 found, 3 needed.', sentences: [], valueCents: null, lowCents: null, highCents: null }, comps: [] });
    cmaApp(fake(v));
    expect(await screen.findByRole('heading', { name: 'No value' })).toBeInTheDocument();
    expect(screen.getByText('Not enough comparable sales to estimate a value: 2 found, 3 needed.')).toBeInTheDocument();
    expect(screen.getByText('No sales are used in this CMA.')).toBeInTheDocument();
    expect(screen.queryByText(/^\$[\d,]+ to \$[\d,]+$/)).toBeNull();
    expect(screen.queryByText(/^Middle of the range/)).toBeNull();
  });

  it('E369: a FEED_STALE blocker shows the stale-feed banner with the as-of sentence', async () => {
    const v = view({ clientShare: { ...view().clientShare, blockers: [{ code: 'FEED_STALE', sentence: 'The MLS feed is out of date, so nothing from it could be shown to a client until it syncs again.' }] }, mlsDataAsOfSentence: 'MLS data as of Nov 9, 2026.' });
    cmaApp(fake(v));
    expect(await screen.findByText('The MLS feed is out of date')).toBeInTheDocument();
    expect(screen.getByText(/nothing from it could be shown to a client until it syncs again\. MLS data as of Nov 9, 2026\./)).toBeInTheDocument();
  });

  it("R-CMA-8: someone else's draft is read only: no Remove, Use, editor or share, and no share preview is asked for", async () => {
    const f = fake(view({ mine: false, canEdit: false, createdByUserId: '01900000-0000-7000-8000-0000000000bb' }));
    cmaApp(f, { role: 'team_lead' });
    expect(await screen.findByText('Prepared by someone else. You can read it but not change it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
    expect(screen.queryByRole('button', { name: "Edit the home's facts" })).toBeNull();
    expect(screen.getByRole('button', { name: 'Other' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Email/ })).toBeNull();
    expect(f.callsTo(PREVIEW)).toHaveLength(0);
  });

  it('R-CMA-9: a shared CMA says when, the email in the server sentence, and links the PDF only when it is available; nothing offers another way to send it', async () => {
    const shared = view({ status: 'shared', canEdit: false, sharedAt: '2026-11-12T11:00:00.000Z', pdfAvailable: true, share: { sharedByUserId: 'x', message: { id: 'm', status: 'sent', statusReason: null, sentence: 'Sent.' } } });
    const f = fake(shared);
    const { view: rendered } = cmaApp(f);
    expect(await screen.findByText('Shared on Nov 12, 2026.')).toBeInTheDocument();
    expect(screen.getByText('Sent.')).toBeInTheDocument();
    const pdf = screen.getByRole('link', { name: 'Download the PDF (to print or hand over)' });
    expect(pdf).toHaveAttribute('href', `/api/cma/${CMA_ID}/report.pdf`);
    expect(screen.queryByRole('button', { name: /^Email/ })).toBeNull();
    expect(f.callsTo(PREVIEW)).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/attach|forward|send it yourself/i);
    rendered.unmount();

    cmaApp(fake(view({ ...shared, pdfAvailable: false, share: { sharedByUserId: 'x', message: { id: 'm', status: 'blocked', statusReason: 'OPTED_OUT', sentence: 'The email was not sent: they replied STOP.' } } })));
    expect(await screen.findByText('The email was not sent: they replied STOP.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /PDF/ })).toBeNull();
  });

  it('R-CMA-8: a superseded CMA says so and is read only', async () => {
    cmaApp(fake(view({ status: 'superseded', canEdit: false })));
    expect(await screen.findByText('Superseded: a newer CMA of this home replaced it. It is kept as it was.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('owner question k: a research CMA and one of a listing have no Email button and say where to share from', async () => {
    const f = fake(view({ contactId: null }));
    const { view: r } = cmaApp(f);
    expect(await screen.findByText('To share, prepare it from the seller’s page.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Email/ })).toBeNull();
    expect(f.callsTo(PREVIEW)).toHaveLength(0);
    r.unmount();
    const g = fake(view({ subject: { ...view().subject, kind: 'listing', listingId: '01900000-0000-7000-8000-0000000115a1' } }));
    cmaApp(g);
    expect(await screen.findByText('To share, prepare it from the seller’s page.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Email/ })).toBeNull();
    expect(g.callsTo(PREVIEW)).toHaveLength(0);
  });
});
