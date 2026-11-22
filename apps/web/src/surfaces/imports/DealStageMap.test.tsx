// The import page's deal-stage screen in jsdom. The rules (held deals, no second deal, the audit row)
// are proven by api/imports against Postgres; these prove the page lists every stage with its deals,
// says how many are waiting, and sends the owner's choice, including "Don't import".
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp } from '../admin/lib/testing.js';
import type { ImportBatch, ImportCategory, ImportStage } from '../admin/lib/types.js';
import type { DealStagesResponse } from './lib.js';

const SNAP = 'd'.repeat(64);
const BID = '01900000-0000-7000-8000-0000000b0019';
const SEQ: Record<ImportCategory, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6, deals: 7, appointments: 8 };

function stage(category: ImportCategory, status: string): ImportStage {
  return { id: `st-${category}`, category, seq: SEQ[category], status, counts: null, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null };
}

function batch(): ImportBatch {
  return {
    id: BID, source: 'fub_api', status: 'committed', sourceCounts: { deals: 4 }, snapshotSha256: SNAP, snapshotAt: '2026-11-21T10:00:00.000Z', snapshotError: null,
    fileLabel: null, csv: null, createdAt: '2026-11-21T09:00:00.000Z', createdByUserId: 'u', revertedAt: null,
    stages: (['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals', 'appointments'] as const).map((c) => stage(c, c === 'deals' ? 'verified' : 'verified')),
    connectionTest: ['4 deals in Follow Up Boss.'],
  } as ImportBatch;
}

const saved: DealStagesResponse = {
  stages: [
    { label: 'Active', deals: 2, suggested: 'active', choice: null },
    { label: 'Waiting On Lender', deals: 1, suggested: null, choice: null },
    { label: 'Parked', deals: 1, suggested: null, choice: null },
  ],
  unmappedDeals: 2,
  dealStageMap: {},
  importedNow: 0,
  ignoredNow: 0,
  plannedNow: 0,
  approvalCleared: false,
};

function fake() {
  return new FakeFetch()
    .on(`GET /imports/${BID}`, { status: 200, body: { batch: batch() } })
    .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [] } })
    .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } })
    .on(`GET /imports/${BID}/parity`, { status: 200, body: { options: { stageMap: {}, keepStageAsTag: true, fields: {} }, stages: [], tags: { distinct: 0, existing: 0, toCreate: 0, overLimit: 0, sourceLinks: 0, links: 0, protectedNew: 0, optOutTagged: 0, overLimitNames: [] }, fields: [], existingFields: [], blockers: [], lines: [], report: [] } })
    .on(`GET /imports/${BID}/deal-stages`, { status: 200, body: saved })
    .on(`PUT /imports/${BID}/deal-stages`, { status: 200, body: { ...saved, unmappedDeals: 0, importedNow: 1, ignoredNow: 1, dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' } } });
}

describe('deal stages', () => {
  it('lists every Follow Up Boss stage with its deals, says how many are waiting, and sends the stage or ignore', async () => {
    const f = fake();
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Deal stages' });
    expect(section).toHaveTextContent('2 deals are waiting because the stage is not mapped.');
    expect(screen.getByLabelText('Active (2 deals)')).toHaveValue('');
    await u.selectOptions(screen.getByLabelText('Waiting On Lender (1 deal)'), 'active');
    await u.selectOptions(screen.getByLabelText('Parked (1 deal)'), 'ignore');
    await u.click(screen.getByRole('button', { name: 'Save deal stages' }));
    await waitFor(() => expect(f.callsTo(`PUT /imports/${BID}/deal-stages`)).toHaveLength(1));
    expect(f.callsTo(`PUT /imports/${BID}/deal-stages`)[0]!.body).toEqual({ dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' } });
    expect(await screen.findByText(/1 deal that was waiting is in/)).toBeInTheDocument();
  });
});
