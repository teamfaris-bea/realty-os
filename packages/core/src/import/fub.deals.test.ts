// FUB deals and appointments (B7 reversed 2026-11-21). Synthetic shapes follow the public API.
import { describe, expect, it } from 'vitest';
import type { ContactId } from '../foundation/index.js';
import { buildExistingIndex, dryRun, fubDollarsToCents, mapDealStage, mapFub } from './index.js';
import { AGENT_A, T0, USERS, emptyIndexInput, existingContact } from './testing/fixtures.js';

const CONTACT = '00000000-0000-7000-8000-0000000c00d1' as ContactId;
const NOW = T0;

const deal = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: '12 Oak St',
  status: 'Active',
  price: 450000,
  stageName: 'Under Contract',
  pipelineName: 'Buyers',
  enteredStageAt: '2026-10-01T15:00:00Z',
  projectedCloseDate: '2026-12-01',
  mutualAcceptanceDate: '2026-10-15',
  possessionDate: '2026-12-02',
  earnestMoneyDueDate: '2026-10-20',
  dueDiligenceDate: '2026-10-25',
  finalWalkThroughDate: '2026-11-28',
  commissionValue: 13500,
  agentCommission: 9450,
  teamCommission: 4050,
  people: [{ id: 1001, name: 'Jane Doe' }],
  users: [{ id: 11, name: 'Alex Agent' }],
  description: 'Not stored: deals have no description column',
  customField1: 'Not stored',
  ...over,
});

const appt = (over: Record<string, unknown> = {}) => ({
  id: 9,
  created: '2026-01-01T00:00:00Z',
  createdById: 11,
  title: 'Buyer consult',
  description: 'Bring the pre-approval',
  start: '2026-01-02T15:00:00Z',
  end: '2026-01-02T16:00:00Z',
  allDay: false,
  location: '12 Oak St',
  type: 'Buyer Consultation',
  outcome: null,
  invitees: [{ userId: 11, name: 'Alex' }, { personId: 1001, name: 'Jane' }],
  externalEventLink: 'https://example.test/secret-token',
  ...over,
});

function index() {
  return buildExistingIndex(emptyIndexInput({
    contacts: [existingContact({ contactId: CONTACT, ownerUserId: AGENT_A })],
    externalRefs: [{ entityType: 'contact', externalId: '1001', entityId: CONTACT }],
  }));
}

describe('FUB deals', () => {
  it('maps stage, pipeline, price, dates, people and commission onto the deals model', () => {
    const o = mapFub('deals', deal(), USERS, { now: NOW });
    expect(o.status).toBe('valid');
    expect(o.record).toMatchObject({
      category: 'deals',
      name: '12 Oak St',
      side: 'buy',
      stage: 'under_contract',
      stageLabel: 'Under Contract',
      primaryPersonRef: '1001',
      ownerUserId: AGENT_A,
      priceCents: 45_000_000,
      expectedCloseDate: '2026-12-01',
      lostReason: null,
      financials: { grossCommissionCents: 1_350_000, commissionRateBps: 300, agentSplitBps: 7000, teamSplitBps: 3000, referralFeeCents: null },
    });
    expect(o.record && o.record.category === 'deals' ? o.record.dates.map((d) => d.kind) : []).toEqual(['acceptance', 'closing', 'possession', 'custom', 'custom', 'custom']);
    expect(fubDollarsToCents('450000')).toBe(45_000_000);
    expect(JSON.stringify(o.record)).not.toContain('secret');
    expect(JSON.stringify(o.record)).not.toContain('customField1');
    expect(JSON.stringify(o.record)).not.toContain('Not stored');
  });

  it('an unknown stage waits in review and is not guessed; an admin map places it', () => {
    const raw = deal({ id: 2, stageName: 'Waiting On Lender' });
    const unknown = mapFub('deals', raw, USERS, { now: NOW });
    expect(unknown.status).toBe('needs_review');
    expect(unknown.record).toMatchObject({ stage: null, stageLabel: 'Waiting On Lender' });
    expect(unknown.issues).toContainEqual({ code: 'STAGE_UNMAPPED', severity: 'review', field: 'stageName' });
    expect(mapDealStage('Waiting On Lender')).toBeNull();
    const mapped = mapFub('deals', raw, USERS, { now: NOW, dealStageMap: { 'Waiting On Lender': 'active' } });
    expect(mapped.record).toMatchObject({ stage: 'active' });
    expect(mapped.issues.some((i) => i.code === 'STAGE_UNMAPPED')).toBe(false);
  });

  it('an unknown person waits in review and does not fail the stage; a re-run is a duplicate', () => {
    const known = mapFub('deals', deal(), USERS, { now: NOW });
    const missing = mapFub('deals', deal({ id: 3, people: [{ id: 404 }], peopleIds: [404] }), USERS, { now: NOW });
    const mystery = mapFub('deals', deal({ id: 4, stageName: 'Waiting On Lender' }), USERS, { now: NOW });
    const dry = dryRun('deals', [known, missing, mystery], index());
    expect(dry.blockers).toEqual([]);
    expect(dry.counts).toMatchObject({ source: 3, will_import: 1, needs_review: 2, rejected: 0 });
    expect(dry.records.find((r) => r.sourceRef === 'fub:deals/3')!.issues).toContainEqual({ code: 'PARENT_NOT_FOUND', severity: 'review' });
    const again = dryRun('deals', [known], buildExistingIndex(emptyIndexInput({
      externalRefs: [
        { entityType: 'contact', externalId: '1001', entityId: CONTACT },
        { entityType: 'deal', externalId: '1', entityId: '00000000-0000-7000-8000-00000000de01' },
      ],
    })));
    expect(again.records[0]).toMatchObject({ outcome: 'duplicate' });
    expect(again.records[0]!.issues).toContainEqual({ code: 'ALREADY_IMPORTED', severity: 'info' });
  });

  it('an unmapped deal user does not block the stage when the person already has an owner', () => {
    const raw = deal({ id: 5, users: [{ id: 99 }], userIds: [99] });
    const o = mapFub('deals', raw, USERS, { now: NOW });
    expect(o.issues).toContainEqual({ code: 'ASSIGNEE_UNMAPPED', severity: 'review', field: 'users' });
    const dry = dryRun('deals', [o, mapFub('deals', deal(), USERS, { now: NOW })], index());
    expect(dry.blockers).toEqual([]);
    expect(dry.records.find((r) => r.sourceRef === 'fub:deals/5')!.outcome).toBe('will_import');
    expect(dry.records.find((r) => r.sourceRef === 'fub:deals/5')!.action).toMatchObject({ kind: 'insert_deal', ownerUserId: AGENT_A });
  });
});

describe('FUB appointments', () => {
  it('past appointments are history and future ones stay scheduled, with reminders off', () => {
    const past = mapFub('appointments', appt(), USERS, { now: NOW });
    const future = mapFub('appointments', appt({ id: 10, start: '2026-12-01T15:00:00Z', end: '2026-12-01T16:00:00Z', outcome: 'Follow up' }), USERS, { now: NOW });
    expect(past.record).toMatchObject({ status: 'held', kind: 'buyer_consult', personRef: '1001', organizerUserId: AGENT_A, remindersEnabled: false, location: '12 Oak St' });
    expect(future.record).toMatchObject({ status: 'scheduled', outcome: 'follow_up', remindersEnabled: false });
    expect(JSON.stringify(past.record)).not.toContain('secret-token');
    const dry = dryRun('appointments', [past, future], index());
    expect(dry.counts).toMatchObject({ will_import: 2, rejected: 0 });
    expect(dry.blockers).toEqual([]);
  });

  it('an unmapped organizer waits in review and blocks nothing else', () => {
    const mapped = mapFub('appointments', appt(), USERS, { now: NOW });
    const loose = mapFub('appointments', appt({ id: 11, createdById: 99, invitees: [{ personId: 1001 }] }), USERS, { now: NOW });
    expect(loose.issues).toContainEqual({ code: 'ASSIGNEE_UNMAPPED', severity: 'review', field: 'createdById' });
    const dry = dryRun('appointments', [mapped, loose], index());
    expect(dry.blockers).toEqual([]);
    expect(dry.records.find((r) => r.sourceRef === 'fub:appointments/9')!.outcome).toBe('will_import');
    // the contact's owner can still hold it, so the unmapped user does not drop the appointment
    expect(dry.records.find((r) => r.sourceRef === 'fub:appointments/11')!.outcome).toBe('will_import');
    expect(dry.records.find((r) => r.sourceRef === 'fub:appointments/11')!.action).toMatchObject({ organizerUserId: AGENT_A });
  });

  it('re-running the same appointment is a duplicate', () => {
    const o = mapFub('appointments', appt(), USERS, { now: NOW });
    const dry = dryRun('appointments', [o], buildExistingIndex(emptyIndexInput({
      externalRefs: [{ entityType: 'appointment', externalId: '9', entityId: '00000000-0000-7000-8000-00000000a901' }],
    })));
    expect(dry.records[0]!.outcome).toBe('duplicate');
  });
});
