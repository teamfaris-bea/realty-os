// The homeowner panel (module 79; D10; R-HOME-8, R-HOME-10): each sentence, safe links, hidden when not recognised,
// no export or send control, and axe. The fixtures are core homeownerView outputs (what the API serializes).
import { homeownerView, type HomeownerView, type ViewInput, type ViewProfile } from '@realty/core/homeowner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { contactSections } from '../contact/sections.js';
import { fullContact } from '../feed/lib/testing.js';
import { surface as peopleSurface } from '../people/index.js';
import { HomeownerPanel } from './HomeownerPanel.js';
import * as T from './copy.js';

const SRC = 'Beaufort County GIS parcel layer';
const BEAUFORT = { line1: '10 Sample Lane', line2: null, city: 'Exampleton', region: 'SC', postalCode: '29902' };
const profile = (p: Partial<ViewProfile> = {}): ViewProfile => ({ status: 'matched', matchDetail: null, source: SRC, checkedOn: '2026-11-10', lastFailureOn: null, lastFailureCode: null, nextCheckOn: '2026-12-10', facts: {}, ...p });
const MATCHED = profile({
  facts: {
    last_transfer_date: { value: '2015-06-01', source: SRC, asOf: null },
    last_transfer_price_cents: { value: 25_000_000, source: SRC, asOf: '2026-10-01' },
    owner_mailing_address: { value: 'PO BOX 1, EXAMPLETON SC 29902', source: SRC, asOf: null },
  },
});
const view = (homes: ViewInput['homes'], o: Partial<ViewInput> = {}): HomeownerView =>
  homeownerView({ today: '2026-11-12', configured: true, test: false, statusText: 'x', reasons: [{ reason: 'seller_intent', since: null }], homes, outreachClearanceOn: null, ...o });

const contact = fullContact({ firstName: 'Jane' });

function mount(body: unknown, status = 200) {
  const f = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${contact.id}/homeowner`, { status, body });
  const api = new ApiClient({ fetch: f.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith(peopleSurface)}>
        <MemoryRouter>
          <main>
            <HomeownerPanel contact={contact} />
          </main>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
}
const panel = () => screen.findByRole('heading', { name: T.HEADER });

describe('the homeowner panel (R-HOME-8)', () => {
  it('R-HOME-8: registered once on the full contact view, id homeowner, order 30', () => {
    expect(contactSections.filter((s) => s.id === 'homeowner')).toEqual([{ id: 'homeowner', order: 30, component: HomeownerPanel }]);
  });

  it('R-HOME-8 R-HOME-4 E561: a matched home says it is internal, why it is shown, and each value with its source and date', async () => {
    mount(view([{ address: BEAUFORT, kind: 'home', profile: MATCHED }], { reasons: [{ reason: 'seller_intent', since: null }, { reason: 'past_buyer', since: '2024-05-01' }] }));
    await panel();
    expect(screen.getByText(T.INTERNAL)).toBeTruthy();
    expect(screen.getByText('Shown because this person is marked as a seller, bought a home with the team (closed May 1, 2024).')).toBeTruthy();
    expect(screen.getByText('Checked Nov 10, 2026 · next check due Dec 10, 2026')).toBeTruthy();
    expect(screen.getByText('$250,000')).toBeTruthy();
    expect(screen.getByText(`Source: ${SRC} · as of Oct 1, 2026`)).toBeTruthy();
    expect(screen.getAllByText(`Source: ${SRC} · read on Nov 10, 2026`)).toHaveLength(2);
    expect(screen.getByText(`Owned 11 years: since the transfer on Jun 1, 2015 (source: ${SRC})`)).toBeTruthy();
    expect(screen.getByText(T.TAX_MAIL_ELSEWHERE)).toBeTruthy();
    expect(screen.getAllByText('Not available: the county record read does not include it', { exact: false }).length).toBeGreaterThan(0);
    // b11 ownership-data/F8, api-ui/F7: CMA V1 built the MLS sold data and the in-house value; they are not wired here yet
    expect(screen.getAllByText(T.D9_NOT_SHOWN)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/once .* is built/);
    expect(screen.getByText(`${T.LOANS}:`, { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Beaufort County millage rates/ }).getAttribute('href')).toBe('https://beaufortcountysc.gov/auditor/millage-info.html');
    expect(screen.getByText(T.FOOTER)).toBeTruthy();
    expect(screen.getByText('Not for outreach: these records never address or trigger messages. Outreach use: not built; counsel clearance not recorded for this deployment.')).toBeTruthy();
    // the only mention of an estimate is the footer saying none is made
    expect(document.body.textContent!.replace(T.FOOTER, '')).not.toMatch(/investor|score|confidence|%|estimat|equity|balance/i);
  });

  it('R-HOME-1: a seller inquiry reason shows the date of the latest one (owner question 16)', async () => {
    mount(view([{ address: BEAUFORT, kind: 'home', profile: MATCHED }], { reasons: [{ reason: 'seller_inquiry', since: '2019-04-02' }, { reason: 'homeowner_tag', since: null }] }));
    await panel();
    expect(screen.getByText('Shown because this person is asked about selling or a home value (last on Apr 2, 2019), tagged as a homeowner.')).toBeTruthy();
  });

  it('R-HOME-4 E582: with no county transfer date, years owned names the team closing it counts from', async () => {
    mount(view([{ address: BEAUFORT, kind: 'home', profile: profile({ facts: {} }), teamClosingOn: '2021-03-15' }]));
    await panel();
    expect(screen.getByText("Owned 5 years: since the team's closing on Mar 15, 2021 (source: the team's closed deal in this CRM)")).toBeTruthy();
  });

  it('R-HOME-3 E562 E563 E564: each not-matched detail and ambiguous say so in words', async () => {
    mount(view([
      { address: BEAUFORT, kind: 'home', profile: profile({ status: 'not_matched', matchDetail: 'owner_name_mismatch' }) },
      { address: { ...BEAUFORT, line1: '11 Sample Lane' }, kind: 'home', profile: profile({ status: 'not_matched', matchDetail: 'missing_data' }) },
      { address: { ...BEAUFORT, line1: '12 Sample Lane' }, kind: 'home', profile: profile({ status: 'not_matched', matchDetail: 'address_mismatch' }) },
      { address: { ...BEAUFORT, line1: '13 Sample Lane' }, kind: 'home', profile: profile({ status: 'ambiguous' }) },
    ]));
    await panel();
    expect(screen.getByText('The county record for this address does not name Jane as the owner (checked Nov 10, 2026). Nothing else from that record is kept.')).toBeTruthy();
    expect(screen.getByText('The county record does not name a person as owner (checked Nov 10, 2026). Nothing was kept.')).toBeTruthy();
    expect(screen.getByText('The county record found has a different address; nothing was kept.')).toBeTruthy();
    expect(screen.getByText('More than one county record matches this address; nothing was kept.')).toBeTruthy();
  });

  it('R-HOME-7 E572 E573 E574: failures, not checked yet and not configured are said in words', async () => {
    mount(view([
      { address: BEAUFORT, kind: 'home', profile: { ...MATCHED, lastFailureOn: '2026-11-11', lastFailureCode: 'timeout' } },
      { address: { ...BEAUFORT, line1: '11 Sample Lane' }, kind: 'home', profile: profile({ status: 'failed', checkedOn: null, lastFailureOn: '2026-11-11', lastFailureCode: 'unavailable' }) },
      { address: { ...BEAUFORT, line1: '12 Sample Lane' }, kind: 'home', profile: null },
    ]));
    await panel();
    expect(screen.getByText("Couldn't reach the county records on Nov 11, 2026; showing what was read on Nov 10, 2026")).toBeTruthy();
    expect(screen.getByText("Couldn't reach the county records on Nov 11, 2026; nothing has been read yet")).toBeTruthy();
    expect(screen.getByText(T.NOT_CHECKED)).toBeTruthy();
  });

  it('E574: when public records are not set up the platform status text is shown verbatim', async () => {
    mount(view([{ address: BEAUFORT, kind: 'home', profile: null }], { configured: false, statusText: 'Public records are not set up on this platform' }));
    await panel();
    expect(screen.getByText('Public records are not set up on this platform')).toBeTruthy();
  });

  it('R-HOME-4 R-HOME-5: on a test public-records source each home says no county was asked (b11 api-ui/F5)', async () => {
    const TEST = 'This deployment uses test public records: no county was asked, and these answers are test data.';
    mount(view([
      { address: BEAUFORT, kind: 'home', profile: MATCHED },
      { address: { ...BEAUFORT, line1: '11 Sample Lane' }, kind: 'home', profile: profile({ status: 'not_available' }) },
    ], { test: true, statusText: TEST }));
    await panel();
    expect(screen.getAllByText(TEST)).toHaveLength(2);
  });

  it('R-HOME-2 E576: a Jasper home offers the county lookup; links open in a new tab with noopener noreferrer, and an unsafe URL is never a link', async () => {
    const v = view([{ address: { ...BEAUFORT, postalCode: '29936' }, kind: 'home', profile: null }]);
    const home = v.homes[0]!;
    mount({ ...v, homes: [{ ...home, loansLink: { label: 'Bad link', url: 'javascript:alert(1)' } }] });
    await panel();
    expect(screen.getByText(T.JASPER, { exact: false })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Jasper County Assessor/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    expect(link.getAttribute('href')).not.toMatch(/Sample|29936/);
    expect(screen.queryByRole('link', { name: /Bad link/ })).toBeNull();
    expect(screen.getByText('Bad link')).toBeTruthy();
  });

  it('R-HOME-10: no copy-all, export, send, list or check-now control exists; the outreach clearance date shows once recorded', async () => {
    mount(view([{ address: BEAUFORT, kind: 'home', profile: MATCHED }], { outreachClearanceOn: '2026-11-12' }));
    await panel();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/\b(copy all|export|send|text them|add to list|check now)\b/i);
    expect(screen.getByText('Not for outreach: these records never address or trigger messages. Outreach use: not built; counsel clearance recorded on Nov 12, 2026 for this deployment.')).toBeTruthy();
  });

  // b11 reconciliation homeowner-4: "No home or property address is recorded" was false with an incomplete one on file
  it('R-HOME-2 R-HOME-5 E560: a recognised person with no home to look up is asked for the home address', async () => {
    mount(view([]));
    await panel();
    expect(screen.getByText('Add the home address to build the profile.')).toBeTruthy();
    expect(screen.queryByText(/No home or property address is recorded/)).toBeNull();
  });

  // b11 reconciliation homeowner-5: "County records for this area are not read automatically." suggested a manual source
  it('R-HOME-5 E577: an address outside South Carolina or the listed ZIPs says there is no county source, with no link', async () => {
    mount(view([{ address: { ...BEAUFORT, region: 'GA', postalCode: '31401' }, kind: 'home', profile: null }]));
    await panel();
    expect(screen.getByText('No county source for this address.')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toEqual([]);
    expect(screen.queryByText(/not read automatically/)).toBeNull();
  });

  it('R-HOME-8 E585: hidden when the person is not recognised or the viewer cannot read it', async () => {
    const a = mount(view([], { reasons: [] }));
    await waitFor(() => expect(a.container.querySelector('main')!.childElementCount).toBe(0));
    a.unmount();
    const b = mount({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.container.querySelector('main')!.childElementCount).toBe(0);
    expect(screen.queryByText(T.HEADER)).toBeNull();
  });

  it('a11y: axe finds no violations in the matched, mismatch and Jasper states', async () => {
    mount(view([
      { address: BEAUFORT, kind: 'home', profile: MATCHED },
      { address: { ...BEAUFORT, line1: '11 Sample Lane' }, kind: 'home', profile: profile({ status: 'not_matched', matchDetail: 'owner_name_mismatch' }) },
      { address: { ...BEAUFORT, postalCode: '29936' }, kind: 'home', profile: null },
    ]));
    await panel();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
