// axe-core over every lead-admin page rendered with realistic data (WCAG 2.2 AA rules axe can check in
// jsdom; color contrast needs layout and is checked in the Playwright screenshots run).
import { screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, ID, POLICY_DEFAULTS, board, exceptionItem, leadAdminApp, member, queue, settings } from './lib/testing.js';

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const range = { key: '7d', from: '2026-11-03T08:00:00.000Z', to: '2026-11-10T08:00:00.000Z', days: 7, zone: 'UTC' };
const v1 = { ...POLICY_DEFAULTS, id: '01900000-0000-7000-8000-0000000000p1', versionNo: 1, attested: false, createdByUserId: null, createdAt: '2026-10-01T00:00:00.000Z', active: true };
const stage = { id: 's1', category: 'contacts', seq: 1, status: 'dry_run_ready', counts: { source: 3, willImport: 2, imported: null, needsReview: 1, rejected: 0, duplicate: 0 }, dryRunSha256: null, dryRunCompletedAt: null, blockers: [], approvedAt: null, approvedByUserId: null, committedAt: null, verifiedAt: null, verifiedByUserId: null, revert: null };
const batch = { id: '01900000-0000-7000-8000-0000000b0001', source: 'csv', status: 'dry_run', sourceCounts: { contacts: 3 }, snapshotSha256: 'c'.repeat(64), snapshotAt: '2026-11-10T00:00:00.000Z', snapshotError: null, fileLabel: 'leads.csv', csv: { headers: ['Name', 'Phone'], mapping: [{ field: 'full_name' }, { field: 'phone' }] }, createdAt: '2026-11-10T00:00:00.000Z', createdByUserId: 'u', revertedAt: null, stages: [stage], connectionTest: ['3 contacts in your file'] };

function fake() {
  return new FakeFetch()
    .on('GET /team/exceptions?state=live&limit=200', { status: 200, body: queue([exceptionItem(), exceptionItem({ dedupeKey: 'send:x', itemType: 'failed_send', conditionClearedAt: new Date().toISOString() })]) })
    .on('GET /team/scoreboard?range=7d', { status: 200, body: { range, members: [board()] } })
    .on('GET /team/momentum', { status: 200, body: { rule: { factor: 1.5, minSample: 5, windowDays: 180 }, norms: [], agents: [] } })
    .on('GET /members', { status: 200, body: { members: [member(), member({ userId: ID.owner, displayName: 'Olive Owner', role: 'owner' })], invites: [{ id: 'i1', email: 'new@example.test', role: 'agent', invitedByUserId: ID.me, createdAt: '', expiresAt: '2026-11-17T00:00:00.000Z' }] } })
    .on('GET /teams', { status: 200, body: { teams: [{ id: 't1', name: 'Harbor', isDefault: true, members: [] }] } })
    .on('GET /routing-rules', { status: 200, body: { rules: [] } })
    .on('GET /ponds', { status: 200, body: { ponds: [] } })
    .on('GET /lead-sources', { status: 200, body: { sources: [] } })
    .on('GET /settings', { status: 200, body: { settings } })
    .on('GET /numbers', { status: 200, body: { numbers: [] } })
    .on('GET /compliance-policies', { status: 200, body: { activePolicyId: v1.id, versions: [v1], defaults: POLICY_DEFAULTS, attestationText: 'I am the Owner.', counsel: { allReviewed: false, packs: [] } } })
    .on('GET /playbooks', { status: 200, body: { playbooks: [] } })
    .on('GET /imports', { status: 200, body: { batches: [batch] } })
    .on(`GET /imports/${batch.id}`, { status: 200, body: { batch } })
    .on(`GET /imports/${batch.id}/report`, { status: 200, body: { source: 'your file', categories: [] } });
}

const PAGES: [string, string, RegExp][] = [
  ['/team', 'Needs attention', /Untouched lead/],
  ['/team/scoreboard', 'Scoreboard', /12 of 14/],
  ['/admin/members', 'Members', /Olive Owner/],
  ['/admin/routing', 'Lead routing', /Lead timers/],
  ['/admin/numbers', 'Phone and email', /There are no numbers yet/],
  ['/settings/compliance', 'Compliance', /In force now/],
  ['/settings/team', 'Brokerage and team', /Brokerage legal name/],
  ['/settings/playbooks', 'Playbooks', /No playbooks yet/],
  ['/imports', 'Imports', /leads\.csv/],
  [`/imports/${batch.id}`, 'Import', /1\. Contacts/],
];

describe('accessibility (axe-core)', () => {
  for (const [path, title, ready] of PAGES) {
    it(`${title} (${path}) has no axe violations`, async () => {
      leadAdminApp(fake(), path, 'owner', { reauthenticatedAt: new Date().toISOString() });
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect((await screen.findAllByText(ready)).length).toBeGreaterThan(0);
      expect(await violations()).toEqual([]);
    });
  }
});
