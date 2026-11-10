// Compliance policy page in jsdom. The loosening rules and the Owner + re-auth + attestation checks
// are the server's (api/admin policy.test.ts, R-PERM-3); these tests prove the page tells the truth
// about counsel review, shows the exact attestation before a looser save, never lets an Admin submit
// a looser policy, and sends only the delta.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, POLICY_DEFAULTS as DEFAULTS, err, leadAdminApp } from '../admin/lib/testing.js';
import type { PoliciesResponse, PolicyVersion } from '../admin/lib/types.js';

const ATTEST = 'I am the Owner of this team. These compliance settings are looser than our current policy or the platform defaults, and I accept responsibility for using them.';
const v1: PolicyVersion = { ...DEFAULTS, id: '01900000-0000-7000-8000-0000000000p1', versionNo: 1, attested: false, createdByUserId: null, createdAt: '2026-10-01T00:00:00.000Z', active: true };

function policies(over: Partial<PoliciesResponse> = {}): PoliciesResponse {
  return { activePolicyId: v1.id, versions: [v1], defaults: DEFAULTS, widestWindow: { start: '08:00', end: '21:00' }, attestationText: ATTEST, counsel: { allReviewed: false, packs: [{ key: 'ca', version: '2026.1', reviewedByCounselAt: null }] }, ...over };
}

const created = (n: number) => ({ status: 201, body: { id: '01900000-0000-7000-8000-0000000000p2', versionNo: n, loosening: false, loosenedFields: [], active: true } });

describe('Compliance policy', () => {
  it('says plainly that the rules have not been reviewed by counsel, per pack', async () => {
    leadAdminApp(new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies() }), '/settings/compliance', 'owner');
    expect(await screen.findByText('Not reviewed by counsel')).toBeInTheDocument();
    expect(screen.getByText(/no lawyer has reviewed them for the states you work in/)).toBeInTheDocument();
    expect(screen.getByText('CA rules (version 2026.1): not reviewed by counsel')).toBeInTheDocument();
  });

  it('shows the reviewed state only when every pack has a counsel review date', async () => {
    const body = policies({ counsel: { allReviewed: true, packs: [{ key: 'ca', version: '2026.1', reviewedByCounselAt: '2026-11-01T00:00:00.000Z' }] } });
    leadAdminApp(new FakeFetch().on('GET /compliance-policies', { status: 200, body }), '/settings/compliance', 'owner');
    expect(await screen.findByText('Reviewed by counsel')).toBeInTheDocument();
    expect(screen.queryByText('Not reviewed by counsel')).toBeNull();
  });

  it('a stricter change needs no attestation and sends only the changed field', async () => {
    const fake = new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies() }).on('POST /compliance-policies', created(2));
    leadAdminApp(fake, '/settings/compliance', 'admin');
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('Email waits for contact hours too'));
    expect(screen.queryByText('This is looser than the policy in force')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText('Version 2 saved and in force')).toBeInTheDocument();
    expect(fake.callsTo('POST /compliance-policies')[0]!.body).toEqual({ emailQuietHours: true, activate: true });
  });

  it('a looser change by an Admin is explained and cannot be submitted', async () => {
    const strict = { ...v1, contactWindowEnd: '19:00' };
    const fake = new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies({ versions: [strict] }) });
    leadAdminApp(fake, '/settings/compliance', 'admin');
    const u = userEvent.setup();
    const end = await screen.findByLabelText('Contact hours end');
    await u.clear(end);
    await u.type(end, '20:00');
    expect(await screen.findByText('This is looser than the policy in force')).toBeInTheDocument();
    expect(screen.getByText('Only the Owner can make a looser change. You can still make any change that is stricter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled();
  });

  it('a looser change by the Owner shows the exact attestation and sends it verbatim once confirmed', async () => {
    const strict = { ...v1, autoSmsPer7d: 1 };
    const fake = new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies({ versions: [strict] }) }).on('POST /compliance-policies', created(2));
    leadAdminApp(fake, '/settings/compliance', 'owner');
    const u = userEvent.setup();
    const field = await screen.findByLabelText('Assistant texts per contact per week');
    await u.clear(field);
    await u.type(field, '3');
    const warn = await screen.findByText('This is looser than the policy in force');
    expect(within(warn.closest('[role="status"]')!).getByText('Looser: Assistant texts per week.')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save new version' });
    expect(save).toBeDisabled();
    await u.click(screen.getByLabelText(ATTEST));
    await u.click(save);
    await waitFor(() => expect(fake.callsTo('POST /compliance-policies')).toHaveLength(1));
    expect(fake.callsTo('POST /compliance-policies')[0]!.body).toEqual({ autoSmsPer7d: 3, activate: true, attestation: ATTEST });
  });

  it("when the server says an attestation is needed, the page shows it instead of an error code", async () => {
    const fake = new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies() }).on('POST /compliance-policies', err(403, 'ATTESTATION_REQUIRED'));
    leadAdminApp(fake, '/settings/compliance', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('Email waits for contact hours too'));
    await u.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByLabelText(ATTEST)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ATTESTATION_REQUIRED');
  });

  it('activating an older, looser version asks the Owner for the attestation first', async () => {
    const v2: PolicyVersion = { ...v1, id: '01900000-0000-7000-8000-0000000000p2', versionNo: 2, contactWindowEnd: '19:00', active: true };
    const old = { ...v1, active: false };
    const fake = new FakeFetch().on('GET /compliance-policies', { status: 200, body: policies({ activePolicyId: v2.id, versions: [old, v2] }) }).on(`POST /compliance-policies/${v1.id}/activate`, { status: 200, body: { activePolicyId: v1.id, loosening: true, changed: true } });
    leadAdminApp(fake, '/settings/compliance', 'owner');
    const u = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'Put version 1 in force' });
    expect(btn).toBeDisabled();
    const row = btn.closest('section')!;
    await u.click(within(row).getByLabelText(ATTEST));
    await u.click(btn);
    expect(await screen.findByText('Version 1 is in force')).toBeInTheDocument();
    expect(fake.callsTo(`POST /compliance-policies/${v1.id}/activate`)[0]!.body).toEqual({ attestation: ATTEST });
  });
});
