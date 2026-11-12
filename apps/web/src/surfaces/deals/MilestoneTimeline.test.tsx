// The milestone timeline and the TC board in jsdom (module 39; R-TXN-1, R-TXN-3, R-TXN-4, R-TXN-6, E95): the
// acceptance date and the proposed list on one screen, a Confirm chip per proposed date (1 tap), each date's rule,
// non-business-day note and "not reviewed by counsel", each recipient's update status, the risk status, and the queue's
// risk cards only when the server returns them.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, err, iso } from '../feed/lib/testing.js';
import type { DealDetailView } from '../feed/lib/types.js';
import { type DealMilestones, type MilestoneDate, reviewWarnings, statusLabel, updatesLine } from './milestones.js';

const D1 = '01900000-0000-7000-8000-0000000dd101';
const D2 = '01900000-0000-7000-8000-0000000dd102';

function deal(): DealDetailView {
  return {
    id: IDS.deal, name: 'Jane Doe · buy', side: 'buy', stage: 'under_contract', stageEnteredAt: iso(-1), primaryContact: { id: IDS.jane, name: 'Jane Doe' }, ownerUserId: IDS.me, listingId: null,
    priceCents: null, expectedCloseDate: null, agreementSignedAt: null, underContractAt: null, closedAt: null, lostReason: null,
    attribution: { leadSourceId: null, leadSourceName: null, campaignRef: null, adRef: null, sourceInquiryId: null }, rowVersion: 1, createdAt: iso(-1), dates: [], members: [], contacts: [], history: [],
  };
}

function date(over: Partial<MilestoneDate> = {}): MilestoneDate {
  return {
    id: D1, kind: 'inspection', label: 'Inspection', status: 'proposed', source: 'template', dueOn: '2027-03-06', dueAt: null, reminderAt: null, completedAt: null, responsible: 'buyer', dueVersion: 1, confirmedByUserId: null, drivesUpdates: false,
    basis: { kind: 'template', rule: '5 days after acceptance (2027-03-01)', nonBusinessDayNote: '2027-03-06 is not a business day in the default (Monday to Friday) calendar. The date was not moved; check the contract before confirming.', calendarNote: null, templateId: 't', templateVersion: 1, templateReviewed: false, calendarReviewed: null, anchorDate: '2027-03-01', zone: null, reminderDaysBefore: 2 },
    risk: null,
    updates: [{ contactId: IDS.jane, name: 'Jane Doe', roles: ['buyer'], status: 'not_planned', text: 'No update until a person confirms this date.', at: null }],
    ...over,
  };
}

function milestones(over: Partial<DealMilestones> = {}): DealMilestones {
  return {
    deal: { id: IDS.deal, name: 'Jane Doe · buy', side: 'buy', stage: 'under_contract', ownerUserId: IDS.me },
    acceptanceDate: '2027-03-01',
    templates: [{ id: 't', version: 1, name: 'Purchase', side: 'buy', jurisdiction: 'US', reviewed: false }],
    calendar: { note: 'Business days: Monday to Friday; holidays are not counted. Not reviewed by counsel.', reviewed: false },
    updates: { approved: true, roles: ['buyer', 'seller'], teamRoles: ['buyer', 'seller'], side: 'dual' },
    dates: [date()],
    riskItems: [],
    ...over,
  };
}

function app(m: DealMilestones, role: 'agent' | 'tc' | 'team_lead' = 'tc') {
  const fake = new FakeFetch()
    .on(`GET /deals/${IDS.deal}`, { status: 200, body: { deal: deal() } })
    .on(`GET /deals/${IDS.deal}/financials`, err(404, 'NOT_FOUND'))
    .on(`GET /deals/${IDS.deal}/milestones`, { status: 200, body: m })
    .on(`POST /deal-dates/${D1}/confirm`, { status: 200, body: m })
    .on(`POST /deals/${IDS.deal}/milestones/plan`, { status: 200, body: {} });
  agentApp(fake, `/deals/${IDS.deal}`, role);
  return fake;
}

describe('milestone timeline', () => {
  it('R-TXN-1 E95 R-TXN-6: a proposed date is confirmed in 1 tap; its rule, the non-business-day note and "not reviewed by counsel" are on the same screen', async () => {
    const fake = app(milestones());
    const user = userEvent.setup();
    const chip = await screen.findByRole('button', { name: 'Confirm Inspection on Mar 6, 2027' });
    expect(screen.getByText('Rule: 5 days after acceptance (2027-03-01)')).toBeInTheDocument();
    expect(screen.getByText(/2027-03-06 is not a business day.*The date was not moved/)).toBeInTheDocument();
    expect(screen.getByText('Template not reviewed by counsel.')).toBeInTheDocument();
    expect(screen.getByText(/The template "Purchase" is not reviewed by counsel/)).toBeInTheDocument();
    await user.click(chip);
    await waitFor(() => expect(fake.callsTo(`POST /deal-dates/${D1}/confirm`)).toHaveLength(1));
    expect(fake.callsTo(`POST /deal-dates/${D1}/confirm`)[0]!.body).toEqual({});
  });

  it('the acceptance date (prefilled) and the template propose the list from the same screen', async () => {
    const fake = app(milestones({ dates: [] }));
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Acceptance date');
    expect(input).toHaveValue('2027-03-01');
    await user.click(screen.getByRole('button', { name: 'Propose dates' }));
    await waitFor(() => expect(fake.callsTo(`POST /deals/${IDS.deal}/milestones/plan`)).toHaveLength(1));
    expect(fake.callsTo(`POST /deals/${IDS.deal}/milestones/plan`)[0]!.body).toEqual({ acceptanceDate: '2027-03-01', templateId: 't', templateVersion: 1 });
  });

  it('R-TXN-6: no templates means no plan form, said honestly', async () => {
    app(milestones({ templates: [], dates: [] }));
    expect(await screen.findByText(/No milestone templates for this deal yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose dates' })).toBeNull();
  });

  it('R-TXN-3 R-TXN-4: a confirmed date shows its risk status and each recipient\'s update status; a TC sees no queue cards when the server returns none', async () => {
    app(milestones({
      dates: [
        date({ id: D2, status: 'confirmed', label: 'Closing', kind: 'closing', dueOn: '2027-03-30', drivesUpdates: true, risk: { state: 'overdue', text: 'Overdue', evidence: '…' }, basis: { ...date().basis, nonBusinessDayNote: null, rule: null, templateReviewed: null },
          updates: [
            { contactId: IDS.jane, name: 'Jane Doe', roles: ['buyer'], status: 'sent', text: 'Update sent.', at: iso(-1) },
            { contactId: IDS.pat, name: 'Pat Lender', roles: ['lender'], status: 'blocked', text: 'Not sent: The contact opted out of email.', at: iso(-1) },
          ] }),
      ],
    }));
    const row = await screen.findByRole('listitem', { name: /Closing · Mar 30, 2027/ });
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(within(row).getByText('Update sent.')).toBeInTheDocument();
    expect(within(row).getByText('Not sent: The contact opted out of email.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Mark Closing done' })).toBeInTheDocument();
    expect(screen.queryByText('In the Team Lead queue')).toBeNull();
  });

  it('R-ACC-6: the queue\'s risk cards show for a caller the server returns them to', async () => {
    app(milestones({ riskItems: [{ id: '01900000-0000-7000-8000-0000000ee001', dedupeKey: `milestone:${D1}:1`, dealDateId: D1, conditionCleared: false, detectedAt: iso(-1), text: 'Inspection deadline has passed and is not marked done' }] }), 'team_lead');
    expect(await screen.findByText('In the Team Lead queue')).toBeInTheDocument();
    expect(screen.getByText('Inspection deadline has passed and is not marked done')).toBeInTheDocument();
  });

  it('pure helpers: status chips, the updates line, review warnings', () => {
    expect(statusLabel({ status: 'confirmed', completedAt: iso(-1) })).toBe('Done');
    expect(statusLabel({ status: 'proposed', completedAt: null })).toBe('Proposed');
    expect(updatesLine({ approved: false, roles: [], teamRoles: [], side: 'buy' })).toMatch(/not approved, so no update is sent/);
    expect(updatesLine({ approved: true, roles: ['buyer', 'co_buyer'], teamRoles: ['buyer', 'co_buyer'], side: 'buy' })).toBe(
      "Client updates go to the buyer, co-buyer when a confirmed date's reminder comes due. The seller side is not this team's client on a buy deal, so they get none.",
    );
    expect(reviewWarnings(milestones(), 't')).toHaveLength(2);
    expect(reviewWarnings(milestones({ templates: [{ id: 't', version: 1, name: 'P', side: 'buy', jurisdiction: 'US', reviewed: true }] }), 't')).toEqual(['Business days: Monday to Friday; holidays are not counted. Not reviewed by counsel.']);
  });
});

describe('TC board', () => {
  it('lists open deals with their dates; a proposed date is confirmed from the board in 1 tap', async () => {
    const fake = new FakeFetch()
      .on('GET /transactions/board', { status: 200, body: { upcomingDays: 14, deals: [{ id: IDS.deal, name: 'Jane Doe · buy', side: 'buy', stage: 'under_contract', ownerUserId: IDS.me, proposed: 1, atRisk: 1, dates: [
        { id: D1, kind: 'inspection', label: 'Inspection', status: 'proposed', dueOn: '2027-03-06', dueAt: null, responsible: 'buyer', rule: '5 days after acceptance (2027-03-01)', nonBusinessDayNote: null, risk: null },
        { id: D2, kind: 'closing', label: 'Closing', status: 'confirmed', dueOn: '2027-03-01', dueAt: iso(-1), responsible: null, rule: null, nonBusinessDayNote: null, risk: { state: 'overdue', text: 'Overdue, nobody responsible', evidence: '…' } },
      ] }] } })
      .on(`POST /deal-dates/${D1}/confirm`, { status: 200, body: {} });
    agentApp(fake, '/transactions', 'tc');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Jane Doe · buy' })).toHaveAttribute('href', `/deals/${IDS.deal}`);
    expect(screen.getByText('1 proposed · 1 at risk')).toBeInTheDocument();
    expect(screen.getByText('Overdue, nobody responsible')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm Inspection on Mar 6, 2027' }));
    await waitFor(() => expect(fake.callsTo(`POST /deal-dates/${D1}/confirm`)).toHaveLength(1));
  });
});

describe('b8 deals ui/F1-K1 R-TXN-4: the updates line names only the team\'s side and says why the other side gets none', () => {
  it('sell, dual and lease', () => {
    expect(updatesLine({ approved: true, roles: ['buyer', 'seller', 'co_buyer', 'co_seller'], teamRoles: ['seller', 'co_seller'], side: 'sell' })).toBe(
      "Client updates go to the seller, co-seller when a confirmed date's reminder comes due. The buyer side is not this team's client on a sell deal, so they get none.",
    );
    expect(updatesLine({ approved: true, roles: ['buyer', 'seller'], teamRoles: ['buyer', 'seller'], side: 'dual' })).toMatch(/represents both sides/);
    expect(updatesLine({ approved: true, roles: ['buyer', 'seller'], teamRoles: [], side: 'lease' })).toBe('No automatic client updates on lease deals: nobody on this deal is sent milestone updates.');
  });
});
