// The team AI policy on the web (R-ISA-33, R-ISA-34; E910 to E916): the Owner's and Admin's team page (honest states,
// the form built from the validator's field list, the diff in words, the wider banner, the served texts) and the
// agent's read-only view with what changed since they confirmed.
import { DEFAULT_AI_ISA_CONTENT, type AiIsaContent } from '@realty/core/isa';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PolicyView } from './api.js';
import { FakeFetch, POLICY_IDS, adminView, isaApp, isaError, isaRequestViolations, isaResponseViolations, meView, optIn, policyDraft, policyVersion, policyView } from './testing.js';

const D = DEFAULT_AI_ISA_CONTENT;
const BOOKING: AiIsaContent = { ...D, capabilities: ['converse', 'book_appointments'] };
const FEWER: AiIsaContent = { ...D, channels: ['sms'] };
const team = (fake: FakeFetch, role: 'owner' | 'admin' = 'owner') => isaApp(fake.on('GET /admin/ai-isa', { status: 200, body: adminView() }).on('GET /me/ai-isa', { status: 200, body: meView() }), '/settings/ai-assistant/team', role);
const none = (): PolicyView => policyView({ state: 'none', sentence: 'Your team has no AI assistant policy yet. Nothing is sent by the assistant, and no agent can opt in, until one is approved.', approved: null, can: { create: true, saveDraft: false, approve: false, revoke: false } });
const draftOnly = (over: Partial<PolicyView> = {}): PolicyView => policyView({ state: 'draft_only', sentence: 'Version 1 is a draft. Nothing is sent by the assistant, and no agent can opt in, until the Owner approves it.', approved: null, draft: policyDraft(D, null),
  can: { create: false, saveDraft: true, approve: true, revoke: false }, ...over });
const withDraft = (c: AiIsaContent, over: Partial<PolicyView> = {}): PolicyView => policyView({ state: 'approved_with_draft', sentence: 'Version 1 is approved and in use. Version 2 is a draft: it changes nothing until the Owner approves it.', draft: policyDraft(c, D),
  can: { create: false, saveDraft: true, approve: true, revoke: true }, ...over });

describe('the fixtures say only what the API can (webContract.json)', () => {
  it('every policy state fits the response schema', () => {
    for (const v of [none(), draftOnly(), policyView(), withDraft(BOOKING), withDraft(FEWER), policyView({ state: 'revoked', approved: null, revoked: policyVersion(D) })]) expect(isaResponseViolations('GET /admin/ai-isa/policy', v)).toEqual([]);
    expect(isaResponseViolations('GET /me/ai-isa', meView())).toEqual([]);
  });
});

describe('AI assistant (ISA): the team policy (/settings/ai-assistant/team)', () => {
  it('E910 no policy yet: the page says so and the Owner creates it from the defaults; nothing claims it is approved', async () => {
    const fake = new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: none() }).on('POST /admin/ai-isa/policy', { status: 201, body: { created: true, policy: draftOnly() } });
    team(fake);
    expect(await screen.findByText('Your team has no AI assistant policy yet. Nothing is sent by the assistant, and no agent can opt in, until one is approved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    fake.on('GET /admin/ai-isa/policy', { status: 200, body: draftOnly() });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create the policy from the defaults' }));
    expect(await screen.findByText('Version 1 is a draft. Nothing is sent by the assistant, and no agent can opt in, until the Owner approves it.')).toBeInTheDocument();
    expect(fake.callsTo('POST /admin/ai-isa/policy')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/not built yet/);
  });

  it('E910 draft only: what it may and may not do, by section; the Owner approves with the served text in full, ticked, sent verbatim', async () => {
    const v = draftOnly();
    const approved = policyView({ approved: policyVersion(D) });
    const fake = new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: v })
      .on('POST /admin/ai-isa/policy/approve', { status: 200, body: { effect: 'first', careContinues: true, pausedCare: 0, agentsToReconfirm: 0, sentence: 'Approved. Agents can now opt in. Nothing was sent to anyone.', replayed: false, policy: approved } });
    team(fake);
    const draft = within(await screen.findByTestId('policy-draft'));
    expect(draft.getByRole('heading', { name: 'What it may do' })).toBeInTheDocument();
    expect(draft.getByText('Talk with leads by text and email.')).toBeInTheDocument();
    expect(draft.getByText('Propose appointment times and book them on the agent’s calendar.').closest('[data-may]')).toHaveAttribute('data-may', 'no');
    expect(draft.getByText('Nothing is approved yet, so approving this pauses nothing. Agents can opt in once it is approved.')).toBeInTheDocument();
    expect(screen.queryByTestId('policy-wider')).toBeNull();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Approve version 1' }));
    const d = within(await screen.findByRole('dialog', { name: 'Approve version 1' }));
    expect(d.getByTestId('policy-attestation').textContent).toBe(v.draft!.approvalText);
    const go = d.getByRole('button', { name: 'Approve version 1' });
    expect(go).toBeDisabled();
    await u.click(d.getByLabelText('I have read this and agree'));
    fake.on('GET /admin/ai-isa/policy', { status: 200, body: approved });
    await u.click(go);
    await waitFor(() => expect(screen.getByTestId('policy-line').textContent).toBe('Approved. Agents can now opt in. Nothing was sent to anyone.'));
    const sent = fake.callsTo('POST /admin/ai-isa/policy/approve')[0]!.body;
    expect(sent).toEqual({ versionId: POLICY_IDS.v1, contentSha256: v.draft!.contentSha256, attestation: v.draft!.approvalText });
    expect(isaRequestViolations('POST /admin/ai-isa/policy/approve', sent)).toEqual([]);
  });

  it('R-ISA-34: an Admin may edit and revoke but gets no Approve, and reads why', async () => {
    team(new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: withDraft(FEWER, { can: { create: false, saveDraft: true, approve: false, revoke: true }, approveOwnerOnly: true }) }), 'admin');
    expect(await screen.findByText('Only the account owner can approve a version.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit the draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('E913 a WIDER draft: the diff in words, the banner before any tap, and an approve that says it pauses AI care', async () => {
    const v = withDraft(BOOKING);
    const fake = new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: v })
      .on('POST /admin/ai-isa/policy/approve', { status: 200, body: { effect: 'wider', careContinues: false, pausedCare: 2, agentsToReconfirm: 1, sentence: 'Approved. AI care is paused for 2 people until their agent re-confirms. Nothing was sent to anyone.', replayed: false, policy: policyView() } });
    team(fake);
    const draft = within(await screen.findByTestId('policy-draft'));
    expect(draft.getByText('Adds: may propose appointment times and book them on the agent’s calendar.')).toBeInTheDocument();
    expect(within(screen.getByTestId('policy-wider')).getByText('This version lets the assistant do more than the approved one: it may now propose appointment times and book them on the agent’s calendar. Approving it pauses AI care for every lead until each agent re-confirms.')).toBeInTheDocument();
    // the approved version is still shown as the one in use
    expect(within(screen.getByTestId('policy-approved')).getByText(/^Approved version 1/)).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Approve version 2 and pause AI care' }));
    const d = within(await screen.findByRole('dialog', { name: 'Approve version 2' }));
    expect(d.getByTestId('policy-attestation').textContent).toContain('AI care pauses for every lead until each agent re-confirms');
    expect(d.getByText('AI care is on for 2 people now. Approving pauses it for all of them until each agent re-confirms. Nothing is sent to anyone.')).toBeInTheDocument();
    await u.click(d.getByLabelText('I have read this and agree'));
    await u.click(d.getByRole('button', { name: 'Approve version 2 and pause AI care' }));
    await waitFor(() => expect(screen.getByTestId('policy-line').textContent).toBe('Approved. AI care is paused for 2 people until their agent re-confirms. Nothing was sent to anyone.'));
  });

  it('E912 a NARROWER draft: what it removes, no banner, and a plain approve', async () => {
    team(new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: withDraft(FEWER) }));
    const draft = within(await screen.findByTestId('policy-draft'));
    expect(draft.getByText('Removes: no longer writes by email.')).toBeInTheDocument();
    expect(draft.getByText('This version lets the assistant do no more than the approved one. AI care continues under it at once.')).toBeInTheDocument();
    expect(screen.queryByTestId('policy-wider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve version 2' })).toBeInTheDocument();
    expect(draft.queryByText(/^Adds:/)).toBeNull();
  });

  it('R-ISA-33 Edit: the form is the validator’s field list; a locked choice cannot be unticked; a save sends the whole content; a refusal lands on its field in words', async () => {
    const v = policyView();
    const saved = withDraft({ ...D, caps: { ...D.caps, ai24h: 2 } });
    const fake = new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: v })
      .on('PUT /admin/ai-isa/policy/draft', isaError('AI_ISA_POLICY_INVALID', { issues: [{ code: 'CAP_ABOVE_CEILING', field: 'caps.ai24h', sentence: 'At most 3: the platform’s limit.' }] }));
    team(fake);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(await screen.findByRole('form', { name: 'Edit the team policy' }));
    // every field of the list is a control with its label
    for (const f of v.fields) expect(form.getAllByText(f.label).length, f.key).toBeGreaterThan(0);
    const converse = form.getByLabelText('Talk with leads by text and email');
    expect(converse).toBeChecked();
    expect(converse).toBeDisabled();
    expect(form.getByLabelText('No follow-ups on US federal holidays')).toBeDisabled();
    const cap = form.getByLabelText('AI messages per person in 24 hours') as HTMLInputElement;
    expect(cap).toHaveAttribute('min', '0');
    expect(cap).toHaveAttribute('max', '3');
    expect((form.getByLabelText('Earliest time it writes, in the person’s own time') as HTMLInputElement).value).toBe('09:00');
    await u.clear(cap);
    await u.type(cap, '9');
    await u.click(form.getByRole('button', { name: 'Save as a draft' }));
    expect(await form.findByText('At most 3: the platform’s limit.')).toBeInTheDocument();
    expect(cap).toHaveAttribute('aria-invalid', 'true');
    expect(document.body.textContent).not.toMatch(/CAP_ABOVE_CEILING|AI_ISA_POLICY_INVALID/);
    fake.on('PUT /admin/ai-isa/policy/draft', { status: 200, body: saved }).on('GET /admin/ai-isa/policy', { status: 200, body: saved });
    await u.clear(cap);
    await u.type(cap, '2');
    await u.click(form.getByLabelText('Share listings that fit their search'));
    await u.click(form.getByLabelText('Share listings that fit their search'));
    await u.click(form.getByRole('button', { name: 'Save as a draft' }));
    expect(await screen.findByText('Removes: at most 2 AI messages per person in 24 hours (was 3).')).toBeInTheDocument();
    const sent = fake.callsTo('PUT /admin/ai-isa/policy/draft').at(-1)!.body as { content: AiIsaContent };
    expect(sent.content).toEqual({ ...D, caps: { ...D.caps, ai24h: 2 } });
    expect(isaRequestViolations('PUT /admin/ai-isa/policy/draft', sent)).toEqual([]);
    expect(screen.queryByRole('form', { name: 'Edit the team policy' })).toBeNull();
  });

  it('E914 Revoke: the confirm says what stops, shows the served text, and sends it verbatim', async () => {
    const v = policyView();
    const revoked = policyView({ state: 'revoked', sentence: 'Version 1 was revoked. AI care is paused for every lead. Save and approve a new version to let agents re-confirm.', approved: null, revoked: policyVersion(D, { decidedByRole: 'Admin' }),
      can: { create: false, saveDraft: true, approve: false, revoke: false } });
    const fake = new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: v })
      .on('POST /admin/ai-isa/policy/revoke', { status: 200, body: { pausedCare: 2, sentence: 'Revoked. AI care is paused for 2 people, and the assistant sends nothing more. Nothing was sent to anyone about this.', replayed: false, policy: revoked } });
    team(fake, 'admin');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Revoke' }));
    const d = within(await screen.findByRole('dialog', { name: 'Revoke version 1' }));
    expect(d.getByText('AI care pauses for 2 people now, and the assistant sends nothing more to anyone.')).toBeInTheDocument();
    expect(d.getByText('It starts again only after a new version is approved and each of the 3 agents who opted in re-confirms.')).toBeInTheDocument();
    expect(d.getByText('Nothing is sent to any client about this.')).toBeInTheDocument();
    expect(d.getByTestId('policy-attestation').textContent).toBe(v.revokeText);
    const go = d.getByRole('button', { name: 'Revoke version 1' });
    expect(go).toBeDisabled();
    await u.click(d.getByLabelText('I have read this and agree'));
    fake.on('GET /admin/ai-isa/policy', { status: 200, body: revoked });
    await u.click(go);
    await waitFor(() => expect(screen.getByTestId('policy-line').textContent).toBe('Revoked. AI care is paused for 2 people, and the assistant sends nothing more. Nothing was sent to anyone about this.'));
    expect(fake.callsTo('POST /admin/ai-isa/policy/revoke')[0]!.body).toEqual({ versionId: POLICY_IDS.v1, contentSha256: v.approved!.contentSha256, attestation: v.revokeText });
    expect(await screen.findByText('Version 1 was revoked. AI care is paused for every lead. Save and approve a new version to let agents re-confirm.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(within(screen.getByTestId('policy-revoked')).getByText(/^Revoked version 1/)).toBeInTheDocument();
  });

  it('approved: who approved it, each section marked VERIFY WITH COUNSEL, and no control the server would refuse', async () => {
    team(new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: policyView({ can: { create: false, saveDraft: false, approve: false, revoke: false } }) }));
    const a = within(await screen.findByTestId('policy-approved'));
    expect(a.getByText('Approved version 1, by Olive Owner (Owner).', { exact: false })).toBeInTheDocument();
    expect(a.getAllByText('Engineering defaults. VERIFY WITH COUNSEL.').length).toBe(1);
    for (const name of ['Edit', 'Revoke', 'Create the policy from the defaults']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText('Editing and approving the team policy is not built yet.')).toBeNull();
  });

  it('a version whose stored content cannot be read says so instead of showing words', async () => {
    team(new FakeFetch().on('GET /admin/ai-isa/policy', { status: 200, body: policyView({ approved: policyVersion(D, { content: null, sections: [] }) }) }));
    expect(await screen.findByText("This version can't be shown here.")).toBeInTheDocument();
  });
});

describe('My AI assistant: the team policy, read-only (/settings/ai-assistant)', () => {
  it('an agent reads the approved policy by section and has no control over it', async () => {
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), sentence: 'You are opted in.' }) }), '/settings/ai-assistant', 'agent');
    const p = within(await screen.findByTestId('my-policy'));
    expect(p.getByText('Approved version 1 of your team’s AI rules.')).toBeInTheDocument();
    expect(p.getByText('Talk with leads by text and email.')).toBeInTheDocument();
    expect(p.getByText('Give value estimates or market statistics (not available to the assistant).')).toBeInTheDocument();
    expect(p.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('my-policy-change')).toBeNull();
  });

  it('E912 narrowed since they confirmed: what was removed, care continues, and no re-attest is demanded', async () => {
    const change = { state: 'narrowed' as const, fromVersionNo: 1, diff: { adds: [], removes: ['no longer writes by email'], rewords: [], wider: false },
      sentence: 'The team narrowed the AI rules since you confirmed them. AI care for your leads continues under the narrower rules. To start AI care for another lead, confirm the current version.' };
    const me = meView({ optIn: optIn({ versionId: POLICY_IDS.v1 }), needsReattest: false, policyChange: change, sentence: change.sentence, underCare: 2 });
    expect(isaResponseViolations('GET /me/ai-isa', me)).toEqual([]);
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: me }), '/settings/ai-assistant', 'agent');
    const c = within(await screen.findByTestId('my-policy-change'));
    expect(c.getByText('Changed since version 1, which you confirmed')).toBeInTheDocument();
    expect(c.getByText('Removes: no longer writes by email.')).toBeInTheDocument();
    expect(c.getByText(change.sentence)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Re-attest' })).toBeNull();
  });

  it('E913 widened since they confirmed: what was added, care is paused, and the re-attest card is there', async () => {
    const change = { state: 'widened' as const, fromVersionNo: 1, diff: { adds: ['may propose appointment times and book them on the agent’s calendar'], removes: [], rewords: [], wider: true },
      sentence: 'The team changed the AI rules since you confirmed them, and the new version lets the assistant do more. AI care for your leads is paused until you confirm it.' };
    isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn({ versionId: POLICY_IDS.v1 }), needsReattest: true, policyChange: change, sentence: change.sentence, underCare: 1 }) })
      .on('GET /ai-isa/assignments?scope=mine&state=any', { status: 200, body: { rows: [], holdSentence: null } }), '/settings/ai-assistant', 'agent');
    const c = within(await screen.findByTestId('my-policy-change'));
    expect(c.getByText('Adds: may propose appointment times and book them on the agent’s calendar.')).toBeInTheDocument();
    expect(c.getByText(change.sentence)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Re-attest' })).toBeInTheDocument();
  });
});
