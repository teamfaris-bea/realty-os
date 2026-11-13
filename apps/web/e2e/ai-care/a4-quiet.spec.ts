// a4-quiet (J5; E511; R-ISA-29): a lead whose explicit zone is in quiet hours writes; the reply waits. The panel says
// "Next AI message planned for {viewer time} ({their time}, their time)" from the turn's not_before, in the viewer's
// zone (never UTC), and the thread labels the scheduled AI message "Scheduled by … for {time}" (both asserted, never
// behind an if: batch 13 isa-4 F8).
// Phone 390×844 and desktop 1440×900. Fakes only.
import { expect, test } from 'playwright/test';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, isaLeadOf, isaWorldOf, runIsa, signInAs, startIsaStack } from './isa.js';

test.describe.configure({ mode: 'serial' });
// the viewer sits in New York: every time on the page is theirs, with its short zone name
test.use({ timezoneId: 'America/New_York' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let lead: IsaLeadInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
  lead = await isaLeadOf(stack, { closed: true });
  expect((await stack.api('i.agent0', 'POST', `/contacts/${lead.id}/ai-isa/start`, { side: 'buyer' })).status).toBe(200);
  await runIsa(stack);
  await stack.fixture('/isa-sms-in', { from: lead.phone, body: 'Are you around tomorrow morning?' });
  await runIsa(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

test('J5 E511: the planned next AI message is said in the viewer\'s time with their time beside it; a scheduled AI message is labelled "Scheduled by"', async ({ page }) => {
  test.setTimeout(180_000);
  const t = await stack.sql<{ not_before: string | null; message_id: string | null }>(`SELECT not_before, message_id FROM ai_isa_turns WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`, [lead.id]);
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  const next = page.getByRole('region', { name: 'Next AI message' });
  // batch 13 isa-4 F8: the lead wrote inside closedZone(), so the reply waits: asserted, never skipped
  expect(t[0]?.not_before, 'the reply turn waits for the window').toBeTruthy();
  expect(Date.parse(t[0]!.not_before!)).toBeGreaterThan(Date.now());
  await expect(next).toContainText(/Next AI message planned for .+ \(.+, their time\)/);
  await expect(next).toContainText(/Next AI message planned for [^(]+ E[SD]T \(/);
  await expect(next).not.toContainText('UTC');
  await expect(page.locator('main')).toContainText(`Their time zone was set on the person: ${lead.zone}`);
  expect(await axe(page)).toEqual([]);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}/thread`);
  const scheduled = await stack.sql<{ id: string }>(`SELECT id FROM messages WHERE contact_id = $1 AND initiator = 'assistant' AND status = 'scheduled'`, [lead.id]);
  expect(scheduled.length, 'the AI reply is a scheduled message').toBeGreaterThan(0);
  await expect(page.locator(`li[id="${scheduled[0]!.id}"]`)).toContainText(/Scheduled by .*AI assistant for /);
  // every AI message the turns route covers reads as the AI assistant's, never as a person
  const ai = await stack.sql<{ id: string }>(`SELECT message_id AS id FROM ai_isa_turns WHERE contact_id = $1 AND message_id IS NOT NULL`, [lead.id]);
  for (const m of ai) await expect(page.locator(`li[id="${m.id}"]`)).toContainText(/(Sent|Scheduled|Queued|Written) by .*AI assistant/);
  expect(await axe(page)).toEqual([]);
});
