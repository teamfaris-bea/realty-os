// "My AI assistant" and "AI assistant (ISA)" (R-ISA-32; E517, E522, E524; V11, V19; Q2, Q5, Q6, Q8, Q13), plus the
// CompliancePage notice, the playbooks pointer and the bulk notice.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_AI_ISA_CONTENT } from '@realty/core/isa';
import { describe, expect, it } from 'vitest';
import { err } from '../../shell/testing/fakeApi.js';
import { FakeFetch, IDS, ISA_IDS, adminView, isaApp, meView, optIn } from './testing.js';
import { ON_ATTESTATION, capAttestation, holdLines } from './TeamAssistantPage.js';

describe('My AI assistant (/settings/ai-assistant)', () => {
  it('R-ISA-32 Q6 (b13 review B13S-2): capabilities are unchecked except the required one; built ones (the API\'s list) can be ticked; one the API does not list is disabled and says so; booking without a calendar links to it', async () => {
    const v = isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView() }), '/settings/ai-assistant', 'agent');
    const req = await screen.findByLabelText('Talk with them by text and email (required)');
    expect(req).toBeChecked();
    expect(req).toBeDisabled();
    const listings = screen.getByLabelText('Share listings that fit their search');
    expect(listings).not.toBeChecked();
    expect(listings).toBeEnabled();
    expect(screen.queryByText('Not available yet on this deployment')).toBeNull();
    expect(screen.getByLabelText('Book appointments on your calendar')).toBeDisabled();
    expect(screen.getByText('Connect your calendar first')).toBeInTheDocument();
    v.view.unmount();
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ builtCapabilities: ['converse'] }) }), '/settings/ai-assistant', 'agent');
    expect(await screen.findByLabelText('Share listings that fit their search')).toBeDisabled();
    expect(screen.getAllByText('Not available yet on this deployment').length).toBeGreaterThan(0);
    // ISA-2b wired DKIM verdicts (EMAIL_SENDER_CHECKS): the old "email replies come to you for now" note is gone
    expect(screen.queryByText(/Their email replies pause AI care and come to you for now/)).toBeNull();
    expect((screen.getByLabelText('Your time zone') as HTMLSelectElement).value).toBeTruthy();
  });

  it('R-ISA-32: Save waits for the tick, and shows the server attestation verbatim', async () => {
    const me = meView();
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: me }), '/settings/ai-assistant', 'agent');
    expect((await screen.findByTestId('attestation')).textContent).toBe(me.attestationText);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.setup().click(screen.getByLabelText('I have read this and agree'));
    expect(save).toBeEnabled();
  });

  it('V19 Q13: editing while care is on asks first, with the count', async () => {
    const fake = new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), underCare: 3, sentence: 'You are opted in.' }) }).on('PUT /me/ai-isa/opt-in', { status: 200, body: { optInId: ISA_IDS.optin, change: 'narrowed' } });
    isaApp(fake, '/settings/ai-assistant', 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('I have read this and agree'));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const d = await screen.findByRole('dialog', { name: 'Save your opt-in' });
    expect(within(d).getByText('Saving any change ends AI care for your 3 leads under AI care. Each comes back to you with a handoff, and you can start them again.')).toBeInTheDocument();
    expect(fake.callsTo('PUT /me/ai-isa/opt-in')).toHaveLength(0);
    await u.click(within(d).getByRole('button', { name: 'Save and end that care' }));
    await waitFor(() => expect(screen.getByTestId('optin-line').textContent).toBe('Narrowed.'));
  });

  it('E524: an opt-in on an old version shows the re-attest banner and the new attestation; results name the leads and say codes in words', async () => {
    const me = meView({ optIn: optIn({ versionId: '01900000-0000-7000-8000-0000000be000' }), needsReattest: true, underCare: 1 });
    const fake = new FakeFetch()
      .on('GET /me/ai-isa', { status: 200, body: me })
      .on('GET /ai-isa/assignments?scope=mine&state=any', { status: 200, body: { rows: [{ assignmentId: ISA_IDS.assignment, contactId: IDS.jane, name: 'Jane Doe', side: 'buyer', chip: { kind: 'paused', sentence: 'Paused: policy updated (nobody is following up)' }, lastAction: null, nextTouchAt: null, capsSentence: '', inactivityReleaseAt: null, ownerUserId: IDS.me, ownerName: 'Ava Agent', handoffOverdue: false }], holdSentence: null } })
      .on('POST /me/ai-isa/re-attest', { status: 200, body: { continued: [{ contactId: IDS.jane, assignmentId: ISA_IDS.assignment2 }], notContinued: [{ contactId: IDS.pat, code: 'AI_ISA_FIRST_TOUCH_PENDING', sentence: 'Not continued: AI_ISA_FIRST_TOUCH_PENDING.' }] } });
    isaApp(fake, '/settings/ai-assistant', 'agent');
    expect(await screen.findByText(/Your team approved a new version of the AI rules\. Re-attest to start AI care on new leads\./)).toBeInTheDocument();
    expect(screen.getByTestId('attestation').textContent).toBe(me.attestationText);
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('I have read this and agree'));
    await u.click(screen.getByRole('button', { name: 'Re-attest' }));
    expect(await screen.findByText('Continued: Jane Doe.')).toBeInTheDocument();
    expect(screen.getByText("a lead. Not continued: Text or call them yourself first. AI messages don't count as your first contact.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/AI_ISA_/);
  });

  it('R-ISA-32: no policy, no form; pause all and turn off say what they do', async () => {
    const v = isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ policy: null, attestationText: null, sentence: 'Your team has no approved AI assistant policy yet.' }) }), '/settings/ai-assistant', 'agent');
    expect(await screen.findByText('Your team has no approved AI assistant policy yet. Nothing is sent for your leads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    v.view.unmount();
    const fake = new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), underCare: 2, sentence: 'You are opted in.' }) }).on('POST /me/ai-isa/pause-all', { status: 200, body: { paused: 2 } });
    isaApp(fake, '/settings/ai-assistant', 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Pause all my leads' }));
    expect(await screen.findByText('Paused 2. Resume each lead from its page.', { ignore: '[data-testid="announcer"], script, style' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Turn off for all my leads' }));
    expect(within(await screen.findByRole('dialog')).getByText('This ends AI care for your 2 leads now and withdraws your opt-in. Each comes back to you with a handoff.')).toBeInTheDocument();
  });

  it('booking with a live calendar can be ticked (b13 review B13S-2: ISA-2b builds it)', async () => {
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ calendarLive: true }) }), '/settings/ai-assistant', 'agent');
    const box = await screen.findByLabelText('Book appointments on your calendar');
    expect(box).toBeEnabled();
    await userEvent.setup().click(box);
    expect(box).toBeChecked();
    expect(screen.queryByText('Connect your calendar first')).toBeNull();
  });
});

describe('AI assistant (ISA) (/settings/ai-assistant/team)', () => {
  it('E517: every hold condition gets its own line, not only the first', () => {
    const lines = holdLines(adminView({ packCleared: false, liveSends: false, sentToday: 100, dailyCap: 100, aiEnabled: false }));
    expect(lines.map((l) => l.key)).toEqual(['counsel', 'live', 'cap', 'ai']);
    expect(lines[0]!.text).toBe('Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.');
    expect(lines[1]!.text).toBe('AI assistant sending is off on this deployment.');
  });

  it('R-ISA-32 Q2 Q8: the Owner turns it on with the confirmation in full, ticked, sent verbatim (allowed while counsel review is pending)', async () => {
    const fake = new FakeFetch().on('GET /admin/ai-isa', { status: 200, body: adminView({ enabled: false, packCleared: false }) }).on('PUT /admin/ai-isa', { status: 200, body: adminView({ packCleared: false }) }).on('GET /playbooks', { status: 200, body: { playbooks: [] } }).on('GET /me/ai-isa', { status: 200, body: meView({ policy: null }) });
    isaApp(fake, '/settings/ai-assistant/team', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Turn on' }));
    const d = await screen.findByRole('dialog', { name: 'Turn on the AI assistant' });
    expect(within(d).getByText(ON_ATTESTATION)).toBeInTheDocument();
    const go = within(d).getByRole('button', { name: 'Turn on' });
    expect(go).toBeDisabled();
    await u.click(within(d).getByLabelText('I have read this and agree'));
    await u.click(go);
    await waitFor(() => expect(fake.callsTo('PUT /admin/ai-isa')).toHaveLength(1));
    expect(fake.callsTo('PUT /admin/ai-isa')[0]!.body).toEqual({ enabled: true, dailyCap: 100, attestation: ON_ATTESTATION });
  });

  it('R-ISA-32 (batch 13 isa-4 F13): an Admin gets no Turn on (off only) and reads why; raising the cap reads the cap\'s own OWNER_REQUIRED sentence', async () => {
    const fake = new FakeFetch().on('GET /admin/ai-isa', { status: 200, body: adminView({ enabled: false }) }).on('PUT /admin/ai-isa', err(403, 'OWNER_REQUIRED')).on('GET /playbooks', { status: 200, body: { playbooks: [] } }).on('GET /me/ai-isa', { status: 200, body: meView() });
    isaApp(fake, '/settings/ai-assistant/team', 'admin');
    const u = userEvent.setup();
    expect(await screen.findByText('Only the account owner can turn this on.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    const cap = screen.getByLabelText(/Most AI messages a day/);
    await u.clear(cap);
    await u.type(cap, '200');
    await u.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(screen.getByTestId('ai-team-line').textContent).toBe('Only the account owner can raise the limit.'));
    expect(fake.callsTo('PUT /admin/ai-isa')).toHaveLength(1);
    expect(fake.callsTo('PUT /admin/ai-isa')[0]!.body).toEqual({ enabled: false, dailyCap: 200 });
  });

  it('R-ISA-32 E522: the Owner raising the cap ticks its own sentence; off confirms with the count', async () => {
    const fake = new FakeFetch().on('GET /admin/ai-isa', { status: 200, body: adminView({ underCare: 4 }) }).on('PUT /admin/ai-isa', { status: 200, body: adminView() }).on('GET /playbooks', { status: 200, body: { playbooks: [] } }).on('GET /me/ai-isa', { status: 200, body: meView() });
    isaApp(fake, '/settings/ai-assistant/team', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText('3 AI messages counted today.')).toBeInTheDocument();
    const cap = screen.getByLabelText(/Most AI messages a day/);
    await u.clear(cap);
    await u.type(cap, '150');
    const save = screen.getByRole('button', { name: 'Save limit' });
    expect(save).toBeDisabled();
    await u.click(screen.getByLabelText(capAttestation(150)));
    await u.click(save);
    await waitFor(() => expect(fake.callsTo('PUT /admin/ai-isa')[0]!.body).toEqual({ enabled: true, dailyCap: 150, attestation: capAttestation(150) }));
    await u.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(within(await screen.findByRole('dialog', { name: 'Turn off the AI assistant' })).getByText('This ends AI care for 4 people now. Each owner gets a handoff.')).toBeInTheDocument();
  });

  it('Q5 V11: the team policy reads in words with VERIFY WITH COUNSEL, the changed fields, and "not built yet"', async () => {
    const v1 = { id: '01900000-0000-7000-8000-0000000be000', versionNo: 1, status: 'superseded', contentSha256: 'b', steps: { ...DEFAULT_AI_ISA_CONTENT, cadence: '7d' }, tone: {}, issues: [], createdAt: '' };
    const v2 = { id: ISA_IDS.version, versionNo: 2, status: 'approved', contentSha256: 'a', steps: DEFAULT_AI_ISA_CONTENT, tone: {}, issues: [], createdAt: '' };
    const fake = new FakeFetch()
      .on('GET /admin/ai-isa', { status: 200, body: adminView({ overdueHandoffs: 2 }) })
      .on('GET /me/ai-isa', { status: 200, body: meView() })
      .on('GET /playbooks', { status: 200, body: { playbooks: [{ id: 'p1', kind: 'ai_isa', scope: 'team', ownerUserId: null, name: 'AI assistant', templateKey: null, approvedVersionId: ISA_IDS.version, versions: [v2, v1] }] } });
    isaApp(fake, '/settings/ai-assistant/team', 'owner');
    expect(await screen.findByText(/^Sends only between 9:00 AM and 8:00 PM/)).toBeInTheDocument();
    expect(screen.getAllByText('VERIFY WITH COUNSEL').length).toBeGreaterThan(3);
    expect(screen.getByText('Changed since version 1: follow-up pace.')).toBeInTheDocument();
    expect(screen.getByText('Editing and approving the team policy is not built yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 handoffs are past their deadline' })).toHaveAttribute('href', '/ai-care?filter=overdue');
    expect(document.body.textContent).not.toMatch(/pause/i);
  });

  it('Q5: an unparsable policy says it cannot be shown here', async () => {
    const bad = { id: ISA_IDS.version, versionNo: 1, status: 'approved', contentSha256: 'a', steps: { nonsense: true }, tone: {}, issues: [], createdAt: '' };
    const fake = new FakeFetch().on('GET /admin/ai-isa', { status: 200, body: adminView() }).on('GET /me/ai-isa', { status: 200, body: meView() }).on('GET /playbooks', { status: 200, body: { playbooks: [{ id: 'p1', kind: 'ai_isa', scope: 'team', ownerUserId: null, name: 'AI', templateKey: null, approvedVersionId: ISA_IDS.version, versions: [bad] }] } });
    isaApp(fake, '/settings/ai-assistant/team', 'owner');
    expect(await screen.findByText("This policy can't be shown here.")).toBeInTheDocument();
  });

  it('Q5 (with b12 review ui-3): the playbooks list never shows a kind ai_isa playbook; its detail shows only the "elsewhere" notice and the pointer', async () => {
    const pb = { id: '01900000-0000-7000-8000-0000000bb001', kind: 'ai_isa', scope: 'team', ownerUserId: null, name: 'AI assistant', templateKey: null, approvedVersionId: null, versions: [] };
    const fake = new FakeFetch().on('GET /playbooks', { status: 200, body: { playbooks: [pb] } }).on(`GET /playbooks/${pb.id}`, { status: 200, body: { playbook: pb } });
    const v = isaApp(fake, '/settings/playbooks', 'owner');
    // batch 13 merge: batch 12's review keeps the ISA policy off this list entirely (never beside the playbook notice)
    expect(await screen.findByText('No playbooks yet')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-policy-notice')).toBeNull();
    expect(screen.queryByText('AI assistant', { selector: 'p.font-semibold' })).toBeNull();
    v.view.unmount();
    isaApp(fake, `/settings/playbooks/${pb.id}`, 'owner');
    expect((await screen.findByTestId('ai-policy-notice')).textContent).toBe('The AI assistant policy is under Settings, AI assistant (ISA).');
    expect(screen.queryByRole('heading', { name: 'AI assistant' })).toBeNull();
  });
});
