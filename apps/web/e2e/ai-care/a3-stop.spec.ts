// a3-stop (J4; E498, E505; R-ISA-31, R-ISA-22): a STOP mid-conversation ends care as an opt-out; the person page says
// so in words, the block says AI care can't restart and offers no Lift, and Start is refused with the same words.
// D1 is untouched: the STOP blocks every send exactly as before. Phone 390×844 and desktop 1440×900. Fakes only.
import { expect, test } from 'playwright/test';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, expectNoCode, isaLeadOf, isaWorldOf, runIsa, signInAs, startIsaStack, strip } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let lead: IsaLeadInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
  lead = await isaLeadOf(stack);
  expect((await stack.api('i.agent0', 'POST', `/contacts/${lead.id}/ai-isa/start`, { side: 'buyer' })).status).toBe(200);
  await runIsa(stack);
  await stack.fixture('/isa-sms-in', { from: lead.phone, body: 'STOP' });
  await runIsa(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

test('J4 E498: STOP → "AI care ended: They opted out." with the block\'s words, Start refused, and no Lift', async ({ page }) => {
  test.setTimeout(180_000);
  const a = await stack.sql<{ end_reason: string }>(`SELECT end_reason FROM ai_isa_assignments WHERE contact_id = $1`, [lead.id]);
  expect(a[0]!.end_reason).toBe('opted_out');
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await expect(strip(page)).toContainText('AI care ended: They opted out.');
  await expect(page.getByTestId('ai-block')).toHaveText("They opted out. AI care can't restart for them.");
  await expect(page.getByRole('button', { name: /Lift/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lift the block' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start AI care' })).toHaveCount(0);
  await expectNoCode(page);
  expect(await axe(page)).toEqual([]);
  // the list says it in words too
  await page.goto(`${stack.webUrl}/ai-care?state=ended`);
  await expect(page.locator('article').filter({ has: page.locator(`a[href="/contacts/${lead.id}"]`) })).toContainText('Ended: They opted out.');
  // and the API refuses a start (D1 and the block both hold)
  const s = await stack.api<{ error: { code: string } }>('i.agent0', 'POST', `/contacts/${lead.id}/ai-isa/start`, { side: 'buyer' });
  expect(s.status).toBe(409);
});
