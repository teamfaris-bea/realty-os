// a8-policy (R-ISA-33, R-ISA-34; E1000, E1001, E1003): the team starts with NO AI policy. The Owner creates it from the
// defaults and approves it with the served text (the password); an agent opts in and starts AI care for one lead by
// hand; the Owner edits the policy so the assistant may do more, reads the banner, and approves; AI care is paused and
// the agent is asked to re-confirm, with what was added; after they do, care is on again. Nothing reaches a client at
// any step of it. Phone 390×844 and desktop 1440×900. Fakes only; no row of the policy is written by the superuser.
import { expect, test } from 'playwright/test';
import { shot } from '../journeys/helpers.js';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, confirmPassword, expectNoCode, isaLeadOf, isaWorldOf, press, runIsa, signInAs, startIsaStack, strip } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let lead: IsaLeadInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack, { policy: false });
  lead = await isaLeadOf(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

interface PolicyApi { state: string; draft: { approvalText: string | null; versionNo: number } | null; approved: { versionNo: number } | null }
const policy = async () => (await stack.api<PolicyApi>('i.owner', 'GET', '/admin/ai-isa/policy')).body;
const outbound = async () => Number((await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE tenant_id = $1 AND direction = 'outbound'`, [w.tenantId]))[0]!.n);
const care = async () => (await stack.sql<{ paused: boolean; reason: string | null; ended: boolean }>(`SELECT paused_at IS NOT NULL AS paused, pause_reason AS reason, ended_at IS NOT NULL AS ended FROM ai_isa_assignments
  WHERE contact_id = $1 ORDER BY started_at DESC LIMIT 1`, [lead.id]))[0]!;

test('E1000 E1001: the Owner creates the policy from the defaults and approves it with the served text', async ({ page }) => {
  test.setTimeout(240_000);
  expect((await stack.sql(`SELECT 1 FROM playbooks WHERE tenant_id = $1 AND kind = 'ai_isa'`, [w.tenantId])).length).toBe(0);
  await signInAs(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  const card = page.getByRole('region', { name: 'Team policy' });
  await expect(card).toContainText('Your team has no AI assistant policy yet. Nothing is sent by the assistant, and no agent can opt in, until one is approved.');
  await expect(card.getByRole('button', { name: /Approve|Revoke/ })).toHaveCount(0);
  await shot(page, test.info(), 'ai-care', 'policy-none');
  await press(page, card.getByRole('button', { name: 'Create the policy from the defaults' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('policy-draft'));
  const draft = page.getByTestId('policy-draft');
  await expect(card).toContainText('Version 1 is a draft. Nothing is sent by the assistant, and no agent can opt in, until the Owner approves it.');
  await expect(draft).toContainText('Talk with leads by text and email.');
  await expect(draft).toContainText('Nothing is approved yet, so approving this pauses nothing.');
  expect(await axe(page)).toEqual([]);
  await press(page, draft.getByRole('button', { name: 'Approve version 1' }));
  const d = page.getByRole('dialog', { name: 'Approve version 1' });
  expect(await d.getByTestId('policy-attestation').innerText()).toBe((await policy()).draft!.approvalText);
  await expect(d.getByRole('button', { name: 'Approve version 1' })).toBeDisabled();
  await d.getByLabel('I have read this and agree').check();
  expect(await axe(page)).toEqual([]);
  await shot(page, test.info(), 'ai-care', 'policy-approve');
  await press(page, d.getByRole('button', { name: 'Approve version 1' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('policy-line'));
  await expect(page.getByTestId('policy-line')).toHaveText('Approved. Agents can now opt in. Nothing was sent to anyone.');
  await expect(page.getByTestId('policy-approved')).toContainText('Approved version 1');
  await expect(card).toContainText('Version 1 is approved and in use.');
  const rows = await stack.sql<{ decision: string; decided_by_user_id: string; decided_by_role: string }>(`SELECT a.decision, a.decided_by_user_id, a.decided_by_role FROM playbook_approvals a WHERE a.tenant_id = $1`, [w.tenantId]);
  expect(rows).toEqual([{ decision: 'approve', decided_by_user_id: w.owner.userId, decided_by_role: 'owner' }]);
  await expectNoCode(page);
});

test('E1001: an agent reads the approved policy, opts in, and starts AI care for one lead by hand', async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/settings/ai-assistant`);
  const mine = page.getByTestId('my-policy');
  await expect(mine).toContainText('Approved version 1 of your team’s AI rules.');
  await expect(mine).toContainText('Talk with leads by text and email.');
  await expect(mine.getByRole('button')).toHaveCount(0);
  await page.getByLabel('I have read this and agree').check();
  await press(page, page.getByRole('button', { name: 'Save' }));
  await confirmPassword(page, stack, w.agents[0]!, page.getByTestId('optin-line'));
  await expect(page.getByTestId('optin-line')).toHaveText('You are opted in.');
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await press(page, page.getByRole('button', { name: 'Start AI care' }).first());
  await press(page, page.getByRole('dialog', { name: 'Start AI care' }).getByRole('button', { name: 'Start as a buyer' }));
  await expect(page.getByTestId('start-result')).toContainText('AI care started');
  await runIsa(stack);
  expect(await care()).toMatchObject({ paused: false, ended: false });
});

test('E1003: the Owner edits the policy so the assistant may do more, reads the banner, approves; AI care pauses and nothing is sent', async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  const card = page.getByRole('region', { name: 'Team policy' });
  await press(page, card.getByRole('button', { name: 'Edit', exact: true }));
  const form = page.getByRole('form', { name: 'Edit the team policy' });
  await expect(form.getByLabel('Talk with leads by text and email')).toBeDisabled();
  await form.getByLabel('Share listings that fit their search').check();
  expect(await axe(page)).toEqual([]);
  await shot(page, test.info(), 'ai-care', 'policy-edit');
  await press(page, form.getByRole('button', { name: 'Save as a draft' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('policy-draft'));
  const draft = page.getByTestId('policy-draft');
  await expect(draft).toContainText('Adds: may share listings that fit their search.');
  await expect(page.getByTestId('policy-wider')).toContainText('This version lets the assistant do more than the approved one: it may now share listings that fit their search. Approving it pauses AI care for every lead until each agent re-confirms.');
  // a draft changes nothing: care is still on
  expect(await care()).toMatchObject({ paused: false, ended: false });
  await shot(page, test.info(), 'ai-care', 'policy-wider');
  const before = await outbound();
  await press(page, draft.getByRole('button', { name: 'Approve version 2 and pause AI care' }));
  const d = page.getByRole('dialog', { name: 'Approve version 2' });
  await expect(d).toContainText('AI care is on for 1 person now. Approving pauses it for all of them until each agent re-confirms. Nothing is sent to anyone.');
  await d.getByLabel('I have read this and agree').check();
  await press(page, d.getByRole('button', { name: 'Approve version 2 and pause AI care' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('policy-line'));
  await expect(page.getByTestId('policy-line')).toHaveText('Approved. AI care is paused for 1 person until their agent re-confirms. Nothing was sent to anyone.');
  await runIsa(stack);
  expect(await care()).toMatchObject({ paused: true, reason: 'policy_updated', ended: false });
  expect(await outbound()).toBe(before);
  await expectNoCode(page);
});

test('E1003: the agent is asked to re-confirm, with what was added; care shows paused until they do, then it is on again', async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await expect(strip(page)).toContainText('The team changed the AI rules.');
  await page.goto(`${stack.webUrl}/settings/ai-assistant`);
  const change = page.getByTestId('my-policy-change');
  await expect(change).toContainText('Changed since version 1, which you confirmed');
  await expect(change).toContainText('Adds: may share listings that fit their search.');
  await expect(change).toContainText('AI care for your leads is paused until you confirm it.');
  await expect(page.getByRole('heading', { name: 'Re-attest' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await shot(page, test.info(), 'ai-care', 'policy-reattest');
  expect(await care()).toMatchObject({ paused: true });
  await page.getByLabel('I have read this and agree').check();
  await press(page, page.getByRole('button', { name: 'Re-attest' }));
  await confirmPassword(page, stack, w.agents[0]!, page.getByText(/^Continued: /));
  await expect(page.getByText(/^Continued: /)).toBeVisible();
  expect(await care()).toMatchObject({ paused: false, ended: false });
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await expect(strip(page)).not.toContainText('The team changed the AI rules.');
  await expectNoCode(page);
});
