// Fixtures for the CMA surface's component tests (imported by *.test.tsx only). Shapes follow apps/api/src/cma/schemas.ts
// field by field; every value is synthetic (no real person, team, MLS or brokerage).
import type { ReactElement } from 'react';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { AGENT_SURFACES, fullContact } from '../feed/lib/testing.js';
import { HomeValueSection } from './HomeValueSection.js';
import type { CmaSummary, CmaView, CompView, SharePreview } from './lib.js';
import { surface as cmaSurface } from './index.js';

export const CMA_ID = '01900000-0000-7000-8000-0000000c3a01';
export const CONTACT = '01900000-0000-7000-8000-00000000c001';
export const ME = '01900000-0000-7000-8000-0000000000aa';
export const OTHER = '01900000-0000-7000-8000-0000000000bb';
export const POINT = '01900000-0000-7000-8000-0000000p0002';
export const POINT2 = '01900000-0000-7000-8000-0000000p0003';
export const CO_SELLER = '01900000-0000-7000-8000-00000000c009';
export const SHA = 'a'.repeat(64);
export const RSHA = 'b'.repeat(64);

export function comp(i: number, over: Partial<CompView> = {}): CompView {
  return {
    listingId: `01900000-0000-7000-8000-0000000c0${String(100 + i)}`,
    saleListingId: `01900000-0000-7000-8000-0000000c0${String(100 + i)}`,
    sourceLabel: 'MLS',
    mlsNumber: `S-${i}`,
    listingBrokerageName: 'Sample Brokerage (test)',
    address: { line1: `${200 + i} Sample Ave`, line2: null, city: 'Oakland', region: 'CA', postalCode: '94110' },
    closePriceCents: 51_000_000 + i * 1_000_000,
    closeDate: '2026-09-14',
    contractDate: '2026-08-15',
    distanceM: 640 + i * 100,
    tier: 'subdivision',
    facts: { propertyType: 'single_family', sqft: 1450, sizeSource: 'living_area', beds: 3, bathsX10: 20, yearBuilt: 1960, lotSqft: 5000, daysOnMarket: 20, concessionsCents: null },
    adjustments: [
      { feature: 'time', subjectValue: null, compValue: null, rate: 30, amountCents: 1_250_000, support: { kind: 'sales_months', first: 40, second: 12, pairs: 0 }, sentence: 'Prices rose about 0.3% a month since this sale (40 local sales over 12 months).' },
      { feature: 'size', subjectValue: 1500, compValue: 1450, rate: 35_000, amountCents: 1_750_000, support: { kind: 'above_below', first: 20, second: 20, pairs: 400 }, sentence: '50 sq ft smaller than the home, at $350 a sq ft from 40 local sales.' },
    ],
    adjustedPriceCents: 54_000_000 + i * 1_000_000,
    grossAdjustmentBps: 600,
    weightBasisBps: 3300,
    weightBps: 3400 - i * 100,
    why: ['Same subdivision', 'Sold in the last 3 months'],
    labels: ['Closest'],
    saleConditions: [],
    includedByAgent: false,
    ...over,
  };
}

export function view(over: Partial<CmaView> = {}): CmaView {
  const fact = <T,>(value: T | null, source: 'mls' | 'team' | 'agent' | null = value === null ? null : 'mls') => ({ value, source });
  return {
    id: CMA_ID,
    contactId: CONTACT,
    status: 'draft',
    purpose: 'listing_price',
    inspection: 'none',
    inspectedOn: null,
    disclosure: { intendedUsers: null, agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null },
    notes: null,
    createdByUserId: ME,
    mine: true,
    canEdit: true,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    sharedAt: null,
    valuationDate: '2026-11-12',
    mlsDataAsOf: '2026-11-12T09:00:00.000Z',
    mlsDataAsOfSentence: 'MLS data as of Nov 12, 2026, 9:00 AM.',
    methodVersion: 'cma/1',
    subject: {
      kind: 'contact_address',
      listingId: null,
      contactAddressId: '01900000-0000-7000-8000-0000000add01',
      address: { line1: '100 Sample Ave', line2: null, city: 'Oakland', region: 'CA', postalCode: '94110' },
      state: 'CA',
      sizeSentence: 'Size: 1,500 sq ft of living area, from MLS sales.',
      factSentences: [],
      facts: {
        propertyType: fact('single_family'),
        sqft: fact(1500),
        agentEnteredSqft: null,
        beds: fact(3),
        bathsX10: fact(20),
        yearBuilt: fact(1958),
        lotSqft: fact(null),
        garageSpacesX10: fact(null),
        storiesX10: fact(10, 'team'),
        poolPrivate: fact(null),
        subdivision: fact('Sample Heights'),
        mapLocation: { known: true, source: 'mls' },
      },
      saleHistory: [{ listingId: '01900000-0000-7000-8000-0000000c0999', mlsNumber: 'S-old', status: 'sold', closeDate: '2022-11-01', closePriceCents: 45_000_000, listingBrokerageName: null }],
      include: [],
      exclude: [],
      nearMatchDismissed: [],
    },
    result: {
      available: true,
      reason: null,
      sentence: 'Estimated from 3 comparable sales.',
      sentences: ['Estimated from 3 comparable sales.'],
      valueCents: 54_500_000,
      lowCents: 52_000_000,
      highCents: 57_000_000,
      closeDateSpan: { earliest: '2026-06-01', latest: '2026-09-14' },
      distanceSpanM: { min: 640, max: 900 },
    },
    comps: [comp(1), comp(2), comp(3, { distanceM: null, labels: [], includedByAgent: true })],
    notUsed: [
      { listingId: '01900000-0000-7000-8000-0000000c0201', mlsNumber: 'S-9', address: '300 Sample Ave, Oakland, CA 94110', reason: 'SALE_CONDITION', conditions: ['short_sale'], distanceM: 800, sentence: 'A short sale: not a standard sale.', includable: true },
      { listingId: '01900000-0000-7000-8000-0000000c0202', mlsNumber: 'S-10', address: '301 Sample Ave, Oakland, CA 94110', reason: 'LEASE', conditions: [], distanceM: 900, sentence: 'A lease, not a sale.', includable: false },
    ],
    notUsedTotal: 2,
    subjectSales: [],
    context: [{ listingId: '01900000-0000-7000-8000-0000000c0301', sourceLabel: 'MLS', mlsNumber: 'A-1', listingBrokerageName: null, status: 'active', listPriceCents: 59_900_000, beds: 3, bathsX10: 20, sqft: 1500, address: '400 Sample Ave, Oakland, CA 94110', why: ['Active nearby'] }],
    contextSentence: '1 active or pending listings nearby, shown for the market only: they are not sales and are not used in the value.',
    area: { tier: 'subdivision', lookbackMonths: 12, tiersSkipped: [], reads: [], recordsLeftOut: 0, sentences: ['Comparable sales from the same subdivision, sold in the last 12 months.'] },
    market: { poolTier: 'city', poolMonths: 24, poolSales: 40, rates: [], sentences: [] },
    backtest: { salesTested: 20, notValued: 1, medianMissBps: 420, within10PctBps: 8000, windowStart: '2026-05-12', sentence: 'Tried on 20 recent local sales: half were within 4.2% of their sold price.' },
    nearMatches: [],
    contentSha256: SHA,
    disclosureMissing: [],
    share: null,
    pdfAvailable: false,
    clientShare: { ready: false, sharingAvailable: false, sentence: 'ignored V1 wording', estimateSentence: 'This is an estimate, not an appraisal.', blockers: [] },
    ...over,
  };
}

export function preview(over: Partial<SharePreview> = {}): SharePreview {
  return {
    cmaId: CMA_ID,
    contentSha256: SHA,
    reportSha256: RSHA,
    subject: 'Your home’s estimated value range',
    reportText: 'Estimated value range: $520,000 to $570,000\nThis is an estimate, not an appraisal.',
    body: 'Estimated value range: $520,000 to $570,000\nThis is an estimate, not an appraisal.\n\nAva Agent',
    recipients: [{ contactId: CONTACT, name: 'Jane Doe', firstName: 'Jane', relationship: 'self', emails: [{ id: POINT, address: 'jane@example.test', status: 'active' }] }],
    recipientContactId: CONTACT,
    toPointId: POINT,
    decision: { id: null, outcome: 'allow', reasons: [], explanation: '', phase: 'preview' },
    warnings: [],
    statement: { ok: true, part: null, reason: null, codePoints: [] },
    tooLong: null,
    disclosureMissing: [],
    fairHousing: { hard: [], soft: [] },
    blockers: [],
    stale: null,
    canShare: true,
    sentence: null,
    ...over,
  };
}

export const NOT_CLEARED = {
  canShare: false,
  sentence: 'This CMA can’t be shown to a client yet:',
  blockers: [{ code: 'PLATFORM_NOT_CLEARED', sentence: 'Client CMAs and seller value ranges wait for counsel review of the in-house CMA wording, which is not recorded.' }],
} satisfies Partial<SharePreview>;

export function summary(over: Partial<CmaSummary> = {}): CmaSummary {
  return {
    id: CMA_ID,
    contactId: CONTACT,
    status: 'draft',
    purpose: 'listing_price',
    valuationDate: '2026-11-12',
    mlsDataAsOf: '2026-11-12T09:00:00.000Z',
    valueCents: 54_500_000,
    lowCents: 52_000_000,
    highCents: 57_000_000,
    address: '100 Sample Ave, Oakland, CA 94110',
    createdByUserId: ME,
    mine: true,
    fromMergedRecord: false,
    canEdit: true,
    createdAt: '2026-11-12T10:00:00.000Z',
    ...over,
  };
}

type Role = 'agent' | 'owner' | 'team_lead' | 'tc' | 'isa' | 'admin';

function withSession(fake: FakeFetch, role: Role) {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
}

/** The CMA screen at /cma/:id on a scripted API. */
export function cmaApp(fake: FakeFetch, o: { role?: Role; path?: string } = {}) {
  withSession(fake, o.role ?? 'agent');
  return renderApp({ fake, path: o.path ?? `/cma/${CMA_ID}`, table: tableWith(...AGENT_SURFACES, cmaSurface) });
}

/** A stand-in contact page: the Home value section, and a Details heading as the real page has. */
function SectionHost(): ReactElement {
  return (
    <div>
      <HomeValueSection contact={fullContact({ id: CONTACT })} />
      <section aria-labelledby="details-h">
        <h2 id="details-h">Details</h2>
      </section>
    </div>
  );
}

export function sectionApp(fake: FakeFetch, role: Role = 'agent') {
  withSession(fake, role);
  const host = { pages: [{ path: '/host', title: 'Contact host', roles: 'all' as const, component: SectionHost }] };
  return renderApp({ fake, path: '/host', table: tableWith(host, cmaSurface) });
}

export { FakeFetch };
export { err } from '../../shell/testing/fakeApi.js';
