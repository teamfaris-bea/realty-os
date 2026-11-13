// a6-tenant-off (J7; E522; R-ISA-32, R-ISA-14): the Owner turns the team switch off from "AI assistant (ISA)"; the
// confirm says how many people it ends; every row of "Under AI care" reads ended for that reason; each owner gets the
// handoff card in their feed. Phone 390×844 and desktop 1440×900. Fakes only.
import { expect, test } from 'playwright/test';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, confirmPassword, isaLeadOf, isaWorldOf, press, runIsa, signInAs, startIsaStack } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let leads: IsaLeadInfo[];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
  leads = [await isaLeadOf(stack), await isaLeadOf(stack)];
  for (const l of leads) expect((await stack.api('i.agent0', 'POST', `/contacts/${l.id}/ai-isa/start`, { side: 'buyer' })).status).toBe(200);
  await runIsa(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

test('J7 E522: off → the confirm with the count → every row ends "the team turned the AI assistant off" → the owner\'s handoff cards', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  await press(page, page.getByRole('button', { name: 'Turn off' }));
  const d = page.getByRole('dialog', { name: 'Turn off the AI assistant' });
  await expect(d).toContainText('This ends AI care for 2 people now. Each owner gets a handoff.');
  expect(await axe(page)).toEqual([]);
  await press(page, d.getByRole('button', { name: 'Turn off for everyone' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('ai-team-line'));
  await expect(page.getByTestId('ai-team-line')).toContainText('Turned off.');
  await page.goto(`${stack.webUrl}/ai-care?state=any`);
  for (const l of leads) await expect(page.locator('article').filter({ has: page.locator(`a[href="/contacts/${l.id}"]`) })).toContainText('Ended: The team turned the AI assistant off.');
  expect(await axe(page)).toEqual([]);
  await signInAs(page, stack, w.agents[0]!);
  const cards = page.getByTestId('ai-card-ai_isa_handoff');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('The team turned the AI assistant off.');
  await expect(cards.first()).not.toContainText('Review');
  expect(await axe(page)).toEqual([]);
});
