// The import page's stages / tags / custom fields section in jsdom (PARITY_PLAN module 65; R-PAR-46, R-PAR-18).
// The rules themselves (blocked approval, catalog, typed values, revert) are proven by api/imports against
// Postgres; these prove the page says what will happen before anything is written and sends the Admin's choices.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp } from '../admin/lib/testing.js';
import type { ImportBatch, ImportCategory, ImportStage } from '../admin/lib/types.js';
import type { ParityResponse } from './lib.js';

const SNAP = 'c'.repeat(64);
const BID = '01900000-0000-7000-8000-0000000b0009';
const SEQ: Record<ImportCategory, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6 };

function stage(category: ImportCategory, status: string): ImportStage {
  return { id: `st-${category}`, category, seq: SEQ[category], status, counts: null, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null };
}

function batch(stages: ImportStage[]): ImportBatch {
  return {
    id: BID, source: 'fub_api', status: 'dry_run', sourceCounts: { contacts: 4 }, snapshotSha256: SNAP, snapshotAt: '2026-11-10T10:00:00.000Z', snapshotError: null,
    fileLabel: null, csv: null, createdAt: '2026-11-10T09:00:00.000Z', createdByUserId: 'u', revertedAt: null, stages, connectionTest: ['4 contacts found in Follow Up Boss.'],
  } as ImportBatch;
}

const parity: ParityResponse = {
  options: { stageMap: {}, keepStageAsTag: true, fields: {} },
  stages: [
    { label: 'Waiting On Lender', people: 2, suggested: null, mapped: null },
    { label: 'Hot Prospect', people: 1, suggested: 'active', mapped: 'active' },
  ],
  tags: { distinct: 5, existing: 1, toCreate: 4, overLimit: 0, sourceLinks: 6, links: 6, protectedNew: 0, optOutTagged: 1, overLimitNames: [] },
  fields: [
    { sourceKey: 'customLeadScore', label: 'Lead Score', people: 3, suggestedType: 'number', protected: false, action: { action: 'skip' }, fit: 0, misfit: 0, options: [] },
    { sourceKey: 'customMilitaryStatus', label: 'Military Status', people: 2, suggestedType: 'text', protected: true, action: { action: 'skip' }, fit: 0, misfit: 0, options: [] },
  ],
  existingFields: [],
  blockers: ['STAGE_MAP_INCOMPLETE'],
  lines: ['2 stages in Follow Up Boss. 1 still needs a stage before you can approve.', '1 person has a tag like "DNC" or "Opted out". That is recorded as a real opt-out, not just a tag.'],
  report: [],
};

function fake(b: ImportBatch) {
  const reportParity = { phase: 'dry_run', rows: [{ category: 'stages', source: 3, imported: 1, needsReview: 2, rejected: 0, duplicate: 0 }, { category: 'tags', source: 6, imported: 6, needsReview: 0, rejected: 0, duplicate: 0 }, { category: 'custom_fields', source: 5, imported: 0, needsReview: 0, rejected: 5, duplicate: 0 }], lines: ['Tags: 6 links.'] };
  return new FakeFetch()
    .on(`GET /imports/${BID}`, { status: 200, body: { batch: b } })
    .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [], parity: reportParity } })
    .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } })
    .on(`GET /imports/${BID}/parity`, { status: 200, body: parity })
    .on(`PUT /imports/${BID}/parity`, { status: 200, body: { ...parity, blockers: [] } })
    .on('GET /members', { status: 200, body: { members: [], invites: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } });
}

describe('import stages, tags and custom fields', () => {
  it('R-PAR-46: every source stage is listed with its people; an unpicked stage is called out; the Admin\'s choices are sent as a stage map', async () => {
    const f = fake(batch([stage('contacts', 'pending')]));
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const lender = await screen.findByLabelText('Waiting On Lender (2 people)');
    expect(screen.getByText('1 stage still needs a match before the contacts can be approved.')).toBeInTheDocument();
    expect(screen.getByText(/recorded as a real opt-out, not just a tag/)).toBeInTheDocument();
    await u.selectOptions(lender, 'nurture');
    await u.selectOptions(screen.getByLabelText('Lead Score (3 values)'), 'create:number');
    await u.click(screen.getByRole('button', { name: 'Save stages, tags and fields' }));
    await waitFor(() => expect(f.callsTo(`PUT /imports/${BID}/parity`)).toHaveLength(1));
    expect(f.callsTo(`PUT /imports/${BID}/parity`)[0]!.body).toEqual({
      stageMap: { 'Waiting On Lender': 'nurture', 'Hot Prospect': 'active' },
      keepStageAsTag: true,
      fields: { customLeadScore: { action: 'create', type: 'number', label: 'Lead Score' }, customMilitaryStatus: { action: 'skip' } },
    });
  });

  it('R-PAR-18: a field that reads like a protected attribute can only be kept as text, and the page says why', async () => {
    leadAdminApp(fake(batch([stage('contacts', 'pending')])), `/imports/${BID}`, 'owner', { reauthenticatedAt: new Date().toISOString() });
    const sel = (await screen.findByLabelText('Military Status (2 values)')) as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect(sel.value).toBe('skip');
    expect(screen.getByText(/Reads like a protected attribute, so it stays as text on the person and never becomes a field./)).toBeInTheDocument();
  });

  it('R-PAR-46: the report has a stages / tags / custom fields table that reconciles, and the section is gone once contacts are imported', async () => {
    leadAdminApp(fake(batch([stage('contacts', 'committed')])), `/imports/${BID}`, 'owner', { reauthenticatedAt: new Date().toISOString() });
    const table = await screen.findByRole('table', { name: /Stages, tags and custom fields/ });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Custom fields' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save stages, tags and fields' })).toBeNull();
  });
});
