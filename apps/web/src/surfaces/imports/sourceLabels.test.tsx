// b18 round 3 item 1 (owner boundary B18S-5; E728): an import's preview and summary list the source labels found, with
// the lead source each one means and whether that source has "No automated contact for leads from this source" on; the
// Owner maps a label there at import time, or later from the lead sources page (PUT /lead-sources/import-labels).
// Anyone else sees the words and who maps them. The labels and sources are made up ("a referral partner").
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp } from '../admin/lib/testing.js';
import type { ImportBatch, ImportCategory, ImportStage } from '../admin/lib/types.js';
import { OWNER_MAPS_LABELS, type ImportLabelView } from '../lead-sources/ImportLabels.js';
import { overview, source, sourcesApp, sourcesFake } from '../lead-sources/testing.js';
import type { ParityResponse } from './lib.js';

const SNAP = 'd'.repeat(64);
const BID = '01900000-0000-7000-8000-0000000b0028';
const MARKED = '01900000-0000-7000-8000-00000000528a';
const SEQ: Record<ImportCategory, number> = { contacts: 1, ownership: 2, notes: 3, messages: 4, call_recordings: 5, consent: 6 };
const LABEL = 'Referral partner (test)';

function stage(category: ImportCategory, status: string): ImportStage {
  return { id: `st-${category}`, category, seq: SEQ[category], status, counts: null, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null };
}

function batch(stages: ImportStage[]): ImportBatch {
  return {
    id: BID, source: 'fub_api', status: 'dry_run', sourceCounts: { contacts: 3 }, snapshotSha256: SNAP, snapshotAt: '2026-11-10T10:00:00.000Z', snapshotError: null,
    fileLabel: null, csv: null, createdAt: '2026-11-10T09:00:00.000Z', createdByUserId: 'u', revertedAt: null, stages, connectionTest: ['3 contacts found in Follow Up Boss.'],
  } as ImportBatch;
}

// the API's own sentence for an unmapped label since R-LSRC-9 (apps/api leads/importLabels.ts importLabelSentence)
const unmapped: ImportLabelView = { label: LABEL, people: 2, leadSourceId: null, leadSourceName: null, noAutomatedContact: false, sentence: `"${LABEL}" (2 people): not reviewed yet. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.` };
const mapped: ImportLabelView = {
  label: LABEL,
  people: 2,
  leadSourceId: MARKED,
  leadSourceName: 'Partner referrals (test)',
  noAutomatedContact: true,
  sentence: `"${LABEL}" (2 people): mapped to Partner referrals (test), which has "No automated contact for leads from this source" on, so nothing automatic reaches them.`,
};
const parity = (labels: ImportLabelView[]): ParityResponse => ({
  options: { stageMap: {}, keepStageAsTag: true, fields: {} },
  stages: [],
  tags: { distinct: 0, existing: 0, toCreate: 0, overLimit: 0, sourceLinks: 0, links: 0, protectedNew: 0, optOutTagged: 0, overLimitNames: [] },
  fields: [],
  existingFields: [],
  blockers: [],
  lines: ['No stages in Follow Up Boss.'],
  report: [],
  sourceLabels: labels,
});

function fake(b: ImportBatch, labels: ImportLabelView[]) {
  return new FakeFetch()
    .on(`GET /imports/${BID}`, { status: 200, body: { batch: b } })
    .on(`GET /imports/${BID}/report`, { status: 200, body: { source: 'Follow Up Boss', categories: [], parity: null, sourceLabels: labels } })
    .on(`GET /imports/${BID}/user-mappings`, { status: 200, body: { users: [], ponds: [], unmapped: 0, complete: true } })
    .on(`GET /imports/${BID}/parity`, { status: 200, body: parity(labels) })
    .on('GET /lead-sources/overview', { status: 200, body: overview([source({ id: MARKED, name: 'Partner referrals (test)', noAiCare: true, noAiCareSentence: 'on' })]) })
    .on('GET /members', { status: 200, body: { members: [], invites: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } });
}

describe('E728 imported source labels on the import page and the lead sources page (b18 round 3 item 1)', () => {
  it('E728: the preview lists each label with its people; the Owner maps it to the marked source at import time and the page then says it is marked', async () => {
    let labels = [unmapped];
    const f = fake(batch([stage('contacts', 'pending')]), labels);
    f.on(`GET /imports/${BID}/parity`, () => ({ status: 200, body: parity(labels) }));
    f.on('PUT /lead-sources/import-labels', () => {
      labels = [mapped];
      return { status: 200, body: { label: mapped, pausing: 0, stopping: 0 } };
    });
    leadAdminApp(f, `/imports/${BID}`, 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Lead sources in this import' });
    expect(within(section).getByText(unmapped.sentence)).toBeInTheDocument();
    const pick = await within(section).findByLabelText(`Lead source for "${LABEL}"`);
    await within(section).findByRole('option', { name: 'Partner referrals (test) (no automated contact)' });
    await u.selectOptions(pick, MARKED);
    await waitFor(() => expect(f.callsTo('PUT /lead-sources/import-labels')).toHaveLength(1));
    expect(f.callsTo('PUT /lead-sources/import-labels')[0]!.body).toEqual({ label: LABEL, leadSourceId: MARKED });
    expect(await within(section).findByText(mapped.sentence)).toBeInTheDocument();
  });

  it('E728: the summary lists the labels with which are marked; an Admin sees the words and who maps them, with no choice', async () => {
    leadAdminApp(fake(batch([stage('contacts', 'verified')]), [mapped]), `/imports/${BID}`, 'admin', { reauthenticatedAt: new Date().toISOString() });
    const section = await screen.findByRole('region', { name: 'Lead sources in this import' });
    expect(within(section).getByText(mapped.sentence)).toBeInTheDocument();
    expect(within(section).getByText(OWNER_MAPS_LABELS)).toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).toBeNull();
  });

  it('E728: afterwards, the lead sources page lists every imported label in the CRM, and the Owner maps one there', async () => {
    const f = sourcesFake(overview([source({ id: MARKED, name: 'Partner referrals (test)', noAiCare: true, noAiCareSentence: 'on' })]));
    let labels = [{ ...unmapped, label: 'From a file (test)', people: 1, sentence: '"From a file (test)" (1 person): not reviewed yet. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.' }];
    f.on('GET /lead-sources/import-labels', () => ({ status: 200, body: { labels, canChange: true } }));
    f.on('PUT /lead-sources/import-labels', () => {
      labels = [{ ...mapped, label: 'From a file (test)', people: 1, sentence: '"From a file (test)" (1 person): mapped to Partner referrals (test), which has "No automated contact for leads from this source" on, so nothing automatic reaches them.' }];
      return { status: 200, body: { label: labels[0], pausing: 0, stopping: 1, withdrawn: 2 } };
    });
    sourcesApp(f, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Imported source labels' });
    await within(section).findByRole('option', { name: 'Partner referrals (test) (no automated contact)' });
    await u.selectOptions(within(section).getByLabelText('Lead source for "From a file (test)"'), MARKED);
    await waitFor(() => expect(f.callsTo('PUT /lead-sources/import-labels')).toHaveLength(1));
    // b18 round 3 items 3 and 4: one plan reads as one plan, and the drafts withdrawn are counted
    expect(await screen.findByText(/ 1 plan running for its leads will stop\. 2 drafts a plan or an alert wrote for them were withdrawn\.$/)).toBeInTheDocument();
    await waitFor(() => expect(within(within(section).getByRole('list')).getByText(/mapped to Partner referrals \(test\), which has/)).toBeInTheDocument());
  });
});
