// a5-hold (J6; E517; R-ISA-1, R-ISA-22): with AI_ISA_LIVE_SENDS false (the default on this deployment) the shared
// hold sentence puts the banner on the list, the panel, the thread and the feed strip, without the replies clause
// (on fakes link 1 is 'ok', V3); with the team cap at 0 the panel's team link holds and the replies clause appears;
// the Owner raises the cap and the next turn runs with no click on the lead. Phone 390×844 and desktop 1440×900.
import { expect, test } from 'playwright/test';
import { isPhone, signIn, shot } from '../journeys/helpers.js';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, confirmPassword, expectNoCode, isaLeadOf, isaWorldOf, openFromNav, press, runIsa, signInAs, startIsaStack, strip } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let lead: IsaLeadInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
  lead = await isaLeadOf(stack);
  const s = await stack.api('i.agent0', 'POST', `/contacts/${lead.id}/ai-isa/start`, { side: 'buyer' });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  await runIsa(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

const HOLD = 'AI assistant sending is off on this deployment.';

test('J6 E517 V3: the deployment hold shows on the list, panel and thread without the replies clause, and never "answering"', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page, stack, w.agents[0]!);
  const taps = { taps: 0 };
  await openFromNav(page, 'AI care', taps);
  expect(taps.taps).toBe(isPhone(page) ? 2 : 1);
  await expect(page.getByRole('heading', { level: 1, name: 'Under AI care' })).toBeVisible();
  const banner = page.getByTestId('ai-hold');
  await expect(banner).toContainText(`${HOLD} Nothing reaches the people under AI care from this deployment.`);
  await expect(banner).not.toContainText('replies');
  await shot(page, info, 'ai-care', 'list');
  expect(await axe(page)).toEqual([]);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await expect(strip(page)).toContainText('AI assistant is handling this conversation');
  await expect(page.getByTestId('ai-hold')).toContainText(`${HOLD} Nothing reaches Jane from this deployment.`);
  await expect(page.getByTestId('ai-hold')).not.toContainText('replies');
  await shot(page, info, 'ai-care', 'person-live');
  await expectNoCode(page);
  expect(await axe(page)).toEqual([]);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}/thread`);
  await expect(page.getByTestId('ai-thread-banner').getByTestId('ai-hold')).toContainText(HOLD);
  await expect(page.locator('main')).not.toContainText(/answering/);
  await shot(page, info, 'ai-care', 'thread-live');
  expect(await axe(page)).toEqual([]);
});

test('J6 E517: with the team cap at 0 the team link holds: the panel adds the replies clause; raising the cap runs the next turn with no click', async ({ page }) => {
  test.setTimeout(180_000);
  await stack.fixture('/isa-reauth', { as: 'i.owner' });
  expect((await stack.api('i.owner', 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 0 })).status).toBe(200);
  await signIn(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await expect(page.getByTestId('ai-hold')).toContainText('Their replies come to you as usual.');
  // the Owner raises the cap on the team page (the confirmation, the tick, the password)
  await signInAs(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  await expect(page.getByTestId('ai-team-holds')).toContainText("The team's daily AI assistant limit is reached");
  const cap = page.getByLabel(/Most AI messages a day/);
  await cap.fill('50');
  await page.getByLabel("I raise the team's daily AI assistant limit to 50 messages and accept responsibility for that.").check();
  await press(page, page.getByRole('button', { name: 'Save limit' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('ai-team-line'));
  await expect(page.getByTestId('ai-team-line')).toHaveText('Daily limit set to 50.');
  expect(await axe(page)).toEqual([]);
  // a reply now takes its turn with no click on the lead
  const before = await stack.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ai_isa_turns WHERE contact_id = $1`, [lead.id]);
  await stack.fixture('/isa-sms-in', { from: lead.phone, body: 'We are looking in the spring' });
  await runIsa(stack);
  const after = await stack.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ai_isa_turns WHERE contact_id = $1`, [lead.id]);
  expect(after[0]!.n).toBeGreaterThan(before[0]!.n);
});

