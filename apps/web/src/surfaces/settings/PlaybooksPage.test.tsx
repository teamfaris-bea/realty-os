// Playbook editor with approval attestation, in jsdom. The approval rules (R-AST-4: hash binding,
// who approves, frozen versions) are enforced by api/assistant and the DB; these tests prove the page
// approves exactly the reviewed version (its contentSha256) with the attestation the approver saw,
// blocks approval while there are problems or unsaved edits, saves edits as a new draft without
// dropping fields it does not show, and offers approval only to the people allowed to approve.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, leadAdminApp } from '../admin/lib/testing.js';
import type { Playbook, PlaybookStepView, PlaybookVersion } from '../admin/lib/types.js';
import { applyDraft } from './PlaybooksPage.js';
import { approvalAttestation, delayText, mayApprove, placeholdersIn, playbookState, splitDelay, workingVersion } from './playbooks.js';

const SHA = 'a'.repeat(64);
const step: PlaybookStepView = {
  stepKey: 'check_in_1',
  channel: 'sms',
  delay: { anchor: 'enrollment', offsetSeconds: 0 },
  purpose: 'marketing',
  category: 'nurture_step',
  intent: 'check_in',
  template: 'Hi {{first_name}}, just checking in.',
  personalization: 'none',
  slots: ['first_name'],
  maxLength: 480,
  stopIf: ['appointment_booked'],
};
const version = (over: Partial<PlaybookVersion> = {}): PlaybookVersion => ({ id: 'v1', versionNo: 1, status: 'draft', contentSha256: SHA, steps: [step], tone: {}, issues: [], createdAt: '2026-11-01T00:00:00.000Z', ...over });
const playbook = (over: Partial<Playbook> = {}): Playbook => ({ id: 'pb1', kind: 'nurture', scope: 'agent', ownerUserId: ID.me, name: 'Stay in touch', templateKey: 'nurture', approvedVersionId: null, versions: [version()], ...over });

const fakeFor = (p: Playbook) => new FakeFetch().on(`GET /playbooks/${p.id}`, { status: 200, body: { playbook: p } }).on('GET /playbooks', { status: 200, body: { playbooks: [p] } });

describe('playbook helpers', () => {
  it('approval is offered to the right people: team playbooks to Owner/Admin, personal ones to their agent', () => {
    expect(mayApprove({ scope: 'team', ownerUserId: null }, { userId: 'x', role: 'admin' })).toBe(true);
    expect(mayApprove({ scope: 'team', ownerUserId: null }, { userId: 'x', role: 'team_lead' })).toBe(false);
    expect(mayApprove({ scope: 'agent', ownerUserId: 'a' }, { userId: 'a', role: 'agent' })).toBe(true);
    expect(mayApprove({ scope: 'agent', ownerUserId: 'a' }, { userId: 'b', role: 'owner' })).toBe(false);
  });

  it('delays and placeholders read in plain words', () => {
    expect(delayText({ anchor: 'enrollment', offsetSeconds: 0 })).toBe('Right away');
    expect(delayText({ anchor: 'previous_step', offsetSeconds: 30 * 86_400 })).toBe('30 days after the previous message');
    expect(delayText({ anchor: 'event', offsetSeconds: -86_400 })).toBe('1 day before the event');
    expect(delayText({ anchor: 'enrollment', offsetSeconds: 3600 })).toBe('1 hour after the contact starts this playbook');
    expect(splitDelay(5400)).toEqual({ amount: 90, unit: 'minutes' });
    expect(placeholdersIn('Hi {{first_name}}{{#va_question}} VA?{{/va_question}} {{ team_name }}')).toEqual(['first_name', 'va_question', 'team_name']);
  });

  it('the working version is the newest draft, else the running one; the state line says what runs', () => {
    const p = playbook({ approvedVersionId: 'v1', versions: [version({ status: 'approved' }), version({ id: 'v2', versionNo: 2 })] });
    expect(workingVersion(p)?.id).toBe('v2');
    expect(playbookState(p).text).toBe('Running version 1 · a newer draft waits for approval');
    expect(playbookState(playbook()).text).toBe('Not running · draft waits for approval');
  });

  it('an edit keeps every field the editor does not show, and declares placeholders it starts using', () => {
    const next = applyDraft(step, { channel: 'email', amount: '2', unit: 'days', subject: 'Hello', template: 'Hi {{first_name}}, from {{agent_first_name}} {{nope}}' });
    expect(next).toEqual({ ...step, channel: 'email', subject: 'Hello', delay: { anchor: 'enrollment', offsetSeconds: 172_800 }, template: 'Hi {{first_name}}, from {{agent_first_name}} {{nope}}', slots: ['first_name', 'agent_first_name'] });
    expect('subject' in applyDraft({ ...step, channel: 'email', subject: 'x' }, { channel: 'sms', amount: '0', unit: 'minutes', subject: 'x', template: 't' })).toBe(false);
  });
});

describe('Playbook editor', () => {
  it('approving sends the exact attestation shown and the version fingerprint it was reviewed at', async () => {
    const p = playbook();
    const fake = fakeFor(p).on('POST /playbook-versions/v1/approve', { status: 200, body: { playbook: { ...p, approvedVersionId: 'v1', versions: [version({ status: 'approved' })] } } });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'agent');
    const u = userEvent.setup();
    const approve = await screen.findByRole('button', { name: 'Approve and run' });
    expect(approve).toBeDisabled();
    const text = approvalAttestation(p, version());
    expect(text).toBe('I reviewed the message in “Stay in touch” version 1. The assistant may send it on its own to contacts who allow it, signed as the assistant, and must stop when a client replies.');
    await u.click(screen.getByLabelText(text));
    await u.click(approve);
    expect(await screen.findByText('Version 1 approved and running')).toBeInTheDocument();
    expect(fake.callsTo('POST /playbook-versions/v1/approve')[0]!.body).toEqual({ attestation: text, contentSha256: SHA });
  });

  it('problems are listed per message in words and block approval', async () => {
    const p = playbook({ versions: [version({ issues: [{ index: 0, stepKey: 'check_in_1', code: 'TEMPLATE_ALWAYS_HUMAN_TOPIC' }] })] });
    leadAdminApp(fakeFor(p), '/settings/playbooks/pb1', 'agent');
    expect(await screen.findByText('This mentions money, offers, commission or contracts. Those always need a person to send them.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and run' })).toBeDisabled();
    expect(screen.getByLabelText(/I reviewed the message/)).toBeDisabled();
  });

  it('editing saves a new draft (approval waits for the save) and keeps the hidden fields', async () => {
    const p = playbook();
    const fake = fakeFor(p).on('POST /playbooks/pb1/versions', { status: 200, body: { playbook: p } });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'agent');
    const u = userEvent.setup();
    const msg = await screen.findByLabelText('Message');
    await u.clear(msg);
    await u.type(msg, 'Hi {{{{first_name}}, still looking?');
    expect(screen.getByText('Save your edits first. Approval is for the exact words that were saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and run' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Save as new draft' }));
    await waitFor(() => expect(fake.callsTo('POST /playbooks/pb1/versions')).toHaveLength(1));
    expect(fake.callsTo('POST /playbooks/pb1/versions')[0]!.body).toEqual({ steps: [{ ...step, template: 'Hi {{first_name}}, still looking?' }], tone: {} });
  });

  it('a team playbook is read-only for a Team Lead and says who approves it', async () => {
    const p = playbook({ scope: 'team', ownerUserId: null, kind: 'new_lead_response', name: 'Instant reply to new leads' });
    leadAdminApp(fakeFor(p), '/settings/playbooks/pb1', 'team_lead');
    expect(await screen.findByText('An Owner or Admin approves team playbooks. You can read it here.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve and run' })).toBeNull();
  });

  it('stopping a running version needs its own confirmation and sends the running version fingerprint', async () => {
    const running = version({ status: 'approved' });
    const p = playbook({ approvedVersionId: 'v1', versions: [running] });
    const fake = fakeFor(p).on('POST /playbook-versions/v1/revoke', { status: 200, body: { playbook: p } });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Stop this playbook' }));
    const stop = screen.getByRole('button', { name: 'Stop playbook' });
    expect(stop).toBeDisabled();
    await u.click(screen.getByLabelText(/I am stopping “Stay in touch” version 1/));
    await u.click(stop);
    await waitFor(() => expect(fake.callsTo('POST /playbook-versions/v1/revoke')).toHaveLength(1));
    expect(fake.callsTo('POST /playbook-versions/v1/revoke')[0]!.body).toEqual({ attestation: 'I am stopping “Stay in touch” version 1. Its messages that have not gone out yet will not be sent.', contentSha256: SHA });
  });

  it('the list groups team and personal playbooks; an agent can only start personal ones', async () => {
    const team = playbook({ id: 'pb2', scope: 'team', ownerUserId: null, name: 'Instant reply to new leads', approvedVersionId: 'v1', versions: [version({ status: 'approved' })] });
    const fake = new FakeFetch().on('GET /playbooks', { status: 200, body: { playbooks: [team, playbook()] } });
    leadAdminApp(fake, '/settings/playbooks', 'agent');
    const teamSection = (await screen.findByRole('heading', { name: 'Team playbooks' })).closest('section')!;
    expect(within(teamSection).getByText('Running version 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your playbooks' })).toBeInTheDocument();
    const opts = [...(screen.getByLabelText('Start from') as HTMLSelectElement).options].map((o) => o.value);
    expect(opts).toEqual(['nurture', 'post_closing']);
  });
});
