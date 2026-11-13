// Playbook editor with approval attestation, in jsdom. The approval rules (R-AST-4: hash binding,
// who approves, frozen versions) are enforced by api/assistant and the DB; these tests prove the page
// approves exactly the reviewed version (its contentSha256) with the attestation the approver saw,
// blocks approval while there are problems or unsaved edits, saves edits as a new draft without
// dropping fields it does not show, and offers approval only to the people allowed to approve.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, leadAdminApp } from '../admin/lib/testing.js';
import type { Playbook, PlaybookStepView, PlaybookVersion } from '../admin/lib/types.js';
import { err } from '../../shell/testing/fakeApi.js';
import { applyDraft } from './PlaybooksPage.js';
import { ALERTS_HEADING, ISA_POLICY_ELSEWHERE, KIND_LABEL, READ_ONLY_ALERTS, isReadOnlyPlaybook, stepsOf, approvalAttestation, autoEnrollRefusal, delayText, mayApprove, placeholdersIn, playbookState, splitDelay, workingVersion } from './playbooks.js';

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
    expect(text).toBe('I reviewed the message in “Stay in touch” version 1. The assistant may send it on its own to contacts who have not opted out, signed as the assistant, and must stop when a client replies.');
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

describe('R-PAR-16 "Start this plan when a person enters stage …" (PARITY_PLAN §1 action plan on stage change)', () => {
  const LABEL = 'Start this plan when a person enters stage';
  const STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'];
  const NAMES: Record<string, string> = { new: 'New', attempting: 'Attempting', connected: 'Connected', nurture: 'Nurture', active: 'Active buyer', under_contract: 'Under contract', closed: 'Closed', lost: 'Lost' };
  const labels = { status: 200, body: { labels: { active: 'Active buyer' }, stages: STAGES.map((key) => ({ key, label: NAMES[key]! })) } };
  const team = (over: Partial<Playbook> = {}) => playbook({ scope: 'team', ownerUserId: null, name: 'Buyer plan', approvedVersionId: 'v1', versions: [version({ status: 'approved' })], ...over });
  /** the page's fake API, with the setting kept like the server keeps it (GET answers what the last PUT saved) */
  function world(p: Playbook, o: { stage?: string | null; canChange: boolean; put?: (body: { stage: string | null }, n: number) => ReturnType<typeof err> | null }) {
    let stage = o.stage ?? null;
    const fake = fakeFor(p)
      .on('GET /stage-labels', labels)
      .on(`GET /playbooks/${p.id}/auto-enroll-stage`, () => ({ status: 200, body: { playbook: { id: p.id, name: p.name, scope: p.scope, autoEnrollStage: stage }, canChange: o.canChange } }))
      .on(`PUT /playbooks/${p.id}/auto-enroll-stage`, (c, n) => {
        const body = c.body as { stage: string | null };
        const refused = o.put?.(body, n) ?? null;
        if (refused) return refused;
        stage = body.stage;
        return { status: 200, body: { playbook: { id: p.id, name: p.name, scope: p.scope, autoEnrollStage: stage } } };
      });
    return fake;
  }

  it('an Owner picks the stage of a team playbook from the tenant\'s stage labels; the saved stage is what the page shows', async () => {
    const p = team();
    const fake = world(p, { canChange: true });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'owner');
    const u = userEvent.setup();
    const select = (await screen.findByLabelText(LABEL)) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['No stage', 'New', 'Attempting', 'Connected', 'Nurture', 'Active buyer', 'Under contract', 'Closed', 'Lost']));
    expect(select.value).toBe('');
    const section = select.closest('section')!;
    expect(within(section).getByRole('heading', { name: 'Start on a stage change' })).toBeInTheDocument();
    expect(within(section).getByText(/only from its approved version, never while they are in another plan or can't be reached, and never for a stage set by an import/)).toBeInTheDocument();
    const save = within(section).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await u.selectOptions(select, 'active');
    await u.click(save);
    expect(await screen.findByText('Saved. This playbook now starts when a person enters “Active buyer”.')).toBeInTheDocument();
    expect(fake.callsTo('PUT /playbooks/pb1/auto-enroll-stage').map((c) => c.body)).toEqual([{ stage: 'active' }]);
    await waitFor(() => expect(fake.callsTo('GET /playbooks/pb1/auto-enroll-stage').length).toBeGreaterThanOrEqual(2));
    expect((screen.getByLabelText(LABEL) as HTMLSelectElement).value).toBe('active');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('409 AUTO_ENROLL_STAGE_TAKEN is said in plain words with the stage\'s label and a link to the playbook that holds it', async () => {
    const p = team();
    const fake = world(p, { canChange: true, put: () => err(409, 'AUTO_ENROLL_STAGE_TAKEN', { playbookId: 'pb9' }) });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'admin');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText(LABEL), 'active');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another team playbook already starts when a person enters “Active buyer”. Clear the stage on that playbook first, or pick another one.');
    expect(within(alert).getByRole('link', { name: 'Open that playbook' })).toHaveAttribute('href', '/settings/playbooks/pb9');
    expect(alert.textContent).not.toMatch(/[A-Z]{2,}_[A-Z_]+/); // never a raw code
    expect((screen.getByLabelText(LABEL) as HTMLSelectElement).value).toBe('active'); // the pick stays, to change it
    expect(screen.queryByText(/^Saved\./)).toBeNull();
  });

  it('the 422 refusals (an instant reply to new leads, a stage not in the list) and a retired playbook come back in plain words', async () => {
    const replies = [err(422, 'AUTO_ENROLL_NOT_ALLOWED'), err(422, 'VALIDATION_FAILED'), err(409, 'PLAYBOOK_RETIRED')];
    const p = team();
    const fake = world(p, { canChange: true, put: (_b, n) => replies[n - 1] ?? null });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'owner');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText(LABEL), 'nurture');
    for (const sentence of ["An instant reply to new leads starts when a lead arrives, so it can't also start on a stage change.", 'Pick one of the stages in the list, or “No stage”.', "This playbook was retired, so it can't start on a stage change."]) {
      await u.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    }
    expect(fake.callsTo('PUT /playbooks/pb1/auto-enroll-stage')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: 'Open that playbook' })).toBeNull();
  });

  it('an agent sets their own personal playbook (it covers only people they own); "No stage" clears it; a plan with no approved version says nothing starts yet', async () => {
    const p = playbook(); // personal, the agent's own, draft only
    const fake = world(p, { canChange: true, stage: 'nurture' });
    leadAdminApp(fake, '/settings/playbooks/pb1', 'agent');
    const u = userEvent.setup();
    const select = (await screen.findByLabelText(LABEL)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('nurture'));
    expect(screen.getByText(/It covers only people you own\./)).toBeInTheDocument();
    expect(screen.getByText('No version of this playbook is approved yet, so nobody starts it until one is.')).toBeInTheDocument();
    await u.selectOptions(select, '');
    expect(screen.queryByText(/nobody starts it until one is/)).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. This playbook no longer starts on a stage change.')).toBeInTheDocument();
    expect(fake.callsTo('PUT /playbooks/pb1/auto-enroll-stage').map((c) => c.body)).toEqual([{ stage: null }]);
  });

  it('whoever may not change it (a Team Lead on a team playbook) reads the stage it starts on, with no control; with no stage there is nothing to read', async () => {
    const p = team();
    leadAdminApp(world(p, { canChange: false, stage: 'active' }), '/settings/playbooks/pb1', 'team_lead');
    expect(await screen.findByText(/Starts on its own when a person enters “Active buyer”\./)).toBeInTheDocument();
    expect(screen.getByText('An Owner or Admin can change this.')).toBeInTheDocument();
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Start on a stage change' })).toBeNull();
  });

  it('nothing is shown when the stage is unset and the viewer may not change it, or the setting is not visible to them', async () => {
    const p = playbook({ ownerUserId: ID.ava }); // someone else's personal playbook
    const fake = world(p, { canChange: false });
    const first = leadAdminApp(fake, '/settings/playbooks/pb1', 'owner');
    expect(await screen.findByRole('heading', { name: 'Versions' })).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo('GET /playbooks/pb1/auto-enroll-stage').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    expect(screen.queryByText(/Starts on its own/)).toBeNull();
    first.view.unmount();
    const hidden = fakeFor(p).on('GET /playbooks/pb1/auto-enroll-stage', err(404, 'NOT_FOUND'));
    leadAdminApp(hidden, '/settings/playbooks/pb1', 'isa');
    expect(await screen.findByRole('heading', { name: 'Versions' })).toBeInTheDocument();
    await waitFor(() => expect(hidden.callsTo('GET /playbooks/pb1/auto-enroll-stage').length).toBeGreaterThan(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an instant reply to new leads never starts on a stage change: the Owner is told so instead of offered a control', async () => {
    const p = team({ kind: 'new_lead_response', name: 'Instant reply to new leads' });
    leadAdminApp(world(p, { canChange: true }), '/settings/playbooks/pb1', 'owner');
    expect(await screen.findByText("An instant reply to new leads starts when a lead arrives, so it can't also start on a stage change.")).toBeInTheDocument();
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  it('autoEnrollRefusal: plain words for every refusal of the PUT, never a code', () => {
    expect(autoEnrollRefusal('AUTO_ENROLL_STAGE_TAKEN', { stageLabel: 'Active', scope: 'agent' })).toBe('Another of your playbooks already starts when a person enters “Active”. Clear the stage on that playbook first, or pick another one.');
    expect(autoEnrollRefusal('AUTO_ENROLL_STAGE_TAKEN', { stageLabel: null, scope: 'team' })).toBe('Another playbook already starts on that stage. Clear the stage on that playbook first, or pick another one.');
    for (const code of ['AUTO_ENROLL_NOT_ALLOWED', 'PLAYBOOK_RETIRED', 'VALIDATION_FAILED', 'NOT_FOUND', 'SOMETHING_NEW']) expect(autoEnrollRefusal(code, { stageLabel: 'Lost', scope: 'team' })).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
  });
});

// ---- batch 7 interaction review ui/F2: module 26 trigger playbooks (object content, no web editor yet) ----------

const triggerContent = { kind: 'triggers', triggers: [{ key: 'price_drop' }], digestWindowMinutes: 120 };
const triggerPlaybook = (over: Partial<Playbook> = {}): Playbook =>
  playbook({ id: 'pbT', kind: 'trigger', name: 'Behavior alerts', templateKey: 'behavior_alerts', versions: [version({ id: 'vT', steps: triggerContent as unknown as unknown[] })], ...over });

describe('b7 ui/F2: trigger playbooks are read-only here (R-AST-4)', () => {
  it('b7 ui/F2: stepsOf and approvalAttestation never throw or say "undefined" on object content', () => {
    const v = version({ steps: triggerContent as unknown as unknown[] });
    expect(stepsOf(v)).toEqual([]);
    expect(approvalAttestation({ name: 'Behavior alerts' }, v)).not.toMatch(/undefined/);
    expect(KIND_LABEL['trigger']).toBeTruthy();
    expect(isReadOnlyPlaybook(triggerPlaybook())).toBe(true);
    expect(isReadOnlyPlaybook(playbook({ kind: 'voice_answering' }))).toBe(true);
    expect(isReadOnlyPlaybook(playbook())).toBe(false);
  });

  it('b7 ui/F2: opening a trigger playbook shows it read-only, with no editor, approve, stop or stage', async () => {
    const p = triggerPlaybook();
    leadAdminApp(fakeFor(p), '/settings/playbooks/pbT', 'agent');
    expect(await screen.findByRole('heading', { name: 'Behavior alerts' })).toBeInTheDocument();
    expect(screen.getByText(READ_ONLY_ALERTS)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and run' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/undefined|\btrigger\b/);
  });

  it('b12 review ui-3 (R-ISA-2): the assistant\'s ISA team policy is never listed or opened here as a playbook: no raw kind, no editor or revoke, never beside the "stops the moment a client replies" notice', async () => {
    const isa = playbook({ id: 'pbI', kind: 'ai_isa', scope: 'team', ownerUserId: null, name: 'AI assistant', templateKey: null, approvedVersionId: 'v1', versions: [version({ status: 'approved', steps: { kind: 'ai_isa' } as never })] });
    const fake = new FakeFetch().on('GET /playbooks', { status: 200, body: { playbooks: [playbook(), isa] } });
    leadAdminApp(fake, '/settings/playbooks', 'owner');
    expect(await screen.findByRole('link', { name: /Stay in touch/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ai_isa|AI assistant/);
    cleanup();
    leadAdminApp(fakeFor(isa), '/settings/playbooks/pbI', 'owner');
    expect(await screen.findByText(ISA_POLICY_ELSEWHERE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and run' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revoke|Stop/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/ai_isa|stops the moment a client replies/);
  });

  it('b7 ui/F2: the list puts trigger playbooks under their own read-only heading with a label, never the raw kind', async () => {
    const fake = new FakeFetch().on('GET /playbooks', { status: 200, body: { playbooks: [playbook(), triggerPlaybook()] } });
    leadAdminApp(fake, '/settings/playbooks', 'agent');
    const alerts = await screen.findByRole('heading', { name: ALERTS_HEADING });
    expect(alerts).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Behavior alerts/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\btrigger\b/);
  });
});
