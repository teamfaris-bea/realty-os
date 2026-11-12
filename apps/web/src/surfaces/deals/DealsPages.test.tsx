// Deals and listings in jsdom: stage moves carry the row version, attribution is shown as captured,
// commission is hidden when the server refuses it (R-PERM-10 display), and listing counts show
// their denominator (R-ACC-4 display half).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, err, iso } from '../feed/lib/testing.js';
import type { DealDetailView, ListingDetailView } from '../feed/lib/types.js';
import { nextStage } from './DealsPages.js';
import type { DealMilestones } from './milestones.js';

function deal(over: Partial<DealDetailView> = {}): DealDetailView {
  return {
    id: IDS.deal,
    name: 'Jane Doe · buy',
    side: 'buy',
    stage: 'agreement_signed',
    stageEnteredAt: iso(-86_400_000),
    primaryContact: { id: IDS.jane, name: 'Jane Doe' },
    ownerUserId: IDS.me,
    listingId: null,
    priceCents: 85_000_000,
    expectedCloseDate: '2026-12-15',
    agreementSignedAt: iso(-86_400_000),
    underContractAt: null,
    closedAt: null,
    lostReason: null,
    attribution: { leadSourceId: '01900000-0000-7000-8000-0000000500c1', leadSourceName: 'Zillow', campaignRef: 'fall-buyers', adRef: null, sourceInquiryId: null },
    rowVersion: 3,
    createdAt: iso(-86_400_000),
    dates: [{ id: '01900000-0000-7000-8000-0000000dd001', kind: 'inspection', label: null, dueOn: '2026-11-20', completedAt: null }],
    members: [],
    contacts: [],
    history: [],
    ...over,
  };
}

/** GET /deals/:id/milestones for the deal (module 39): no templates, no dates. */
function milestones(over: Partial<DealMilestones> = {}): DealMilestones {
  return {
    deal: { id: IDS.deal, name: 'Jane Doe · buy', side: 'buy', stage: 'agreement_signed', ownerUserId: IDS.me },
    acceptanceDate: null,
    templates: [],
    calendar: { note: 'Business days: Monday to Friday; holidays are not counted. Not reviewed by counsel.', reviewed: false },
    updates: { approved: false, roles: [], teamRoles: [], side: 'buy' },
    dates: [],
    riskItems: [],
    ...over,
  };
}

describe('Deals', () => {
  it('next stage follows the pipeline and ends at closed', () => {
    expect(nextStage('prospect')).toBe('agreement_signed');
    expect(nextStage('under_contract')).toBe('closed');
    expect(nextStage('closed')).toBeNull();
  });

  it('shows the captured lead source and moves the stage with the row version it read', async () => {
    const fake = new FakeFetch()
      .on(`GET /deals/${IDS.deal}`, { status: 200, body: { deal: deal() } })
      .on(`GET /deals/${IDS.deal}/financials`, err(404, 'NOT_FOUND'))
      .on(`GET /deals/${IDS.deal}/milestones`, { status: 200, body: milestones() })
      .on(`POST /deals/${IDS.deal}/stage`, { status: 200, body: { deal: deal({ stage: 'active', rowVersion: 4 }) } });
    agentApp(fake, `/deals/${IDS.deal}`);
    expect(await screen.findByText('Lead source: Zillow · Campaign fall-buyers')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Move to Active' }));
    await waitFor(() => expect(fake.callsTo(`POST /deals/${IDS.deal}/stage`)).toHaveLength(1));
    expect(fake.callsTo(`POST /deals/${IDS.deal}/stage`)[0]!.body).toEqual({ rowVersion: 3, stage: 'active' });
  });

  it('commission is hidden for someone the server does not let read it, and shown for one it does', async () => {
    const fake = new FakeFetch().on(`GET /deals/${IDS.deal}`, { status: 200, body: { deal: deal() } }).on(`GET /deals/${IDS.deal}/financials`, err(404, 'NOT_FOUND')).on(`GET /deals/${IDS.deal}/milestones`, { status: 200, body: milestones() });
    agentApp(fake, `/deals/${IDS.deal}`);
    await screen.findByText('Lead source: Zillow · Campaign fall-buyers');
    await waitFor(() => expect(fake.callsTo(`GET /deals/${IDS.deal}/financials`).length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'Commission' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a stage move that lost a race says so in words', async () => {
    const fake = new FakeFetch()
      .on(`GET /deals/${IDS.deal}`, { status: 200, body: { deal: deal() } })
      .on(`GET /deals/${IDS.deal}/financials`, { status: 200, body: { financials: null } })
      .on(`GET /deals/${IDS.deal}/milestones`, { status: 200, body: milestones() })
      .on(`POST /deals/${IDS.deal}/stage`, err(409, 'VERSION_CONFLICT'));
    agentApp(fake, `/deals/${IDS.deal}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Move to Active' }));
    expect(await screen.findByText(/Someone changed this while you were editing/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Commission' })).toBeInTheDocument();
  });
});

describe('Listings', () => {
  it('R-ACC-4: showing counts are shown with their denominators', async () => {
    const listing: ListingDetailView = {
      id: '01900000-0000-7000-8000-0000000115e1',
      source: 'team',
      mlsNumber: null,
      status: 'active',
      addressLine1: '12 Oak St',
      addressLine2: null,
      city: 'Oakland',
      region: 'CA',
      postalCode: '94610',
      listPriceCents: 85_000_000,
      beds: 3,
      bathsX10: 20,
      sqft: 1450,
      propertyType: 'single_family',
      listingAgentUserId: IDS.me,
      description: null,
      listDate: '2026-10-01',
      editable: true,
      createdAt: iso(-1),
      priceHistory: [],
      contacts: [],
      showings: { total: 5, completed: 4, withFeedback: 3 },
    };
    const fake = new FakeFetch().on(`GET /listings/${listing.id}`, { status: 200, body: { listing } }).on(`GET /listings/${listing.id}/showings`, { status: 200, body: { showings: [] } });
    agentApp(fake, `/listings/${listing.id}`);
    expect(await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '4 of 5 showings completed')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '3 of 4 completed showings have feedback')).toBeInTheDocument();
    expect(screen.getByText('$850,000 · 3 bd · 2 ba · 1,450 sq ft')).toBeInTheDocument();
  });
});
