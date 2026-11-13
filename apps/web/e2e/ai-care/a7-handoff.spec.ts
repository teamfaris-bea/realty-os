// a7-handoff (J1 part; E521; R-ISA-14, R-ISA-30, R-ISA-7): start from the person page (2 taps) → the AI's message is
// labelled the AI assistant's with a verb its status supports → the person replies "AGENT" → the handoff card (why,
// what is unanswered, the deadline with its countdown) → Got it leaves the deadline running → the owner's own text plus
// the deadline sweep → "Done". The handback path ("Let the AI assistant continue") is covered by the component tests:
// this world has no first-response playbook to make a handback. Phone 390×844 and desktop 1440×900. Fakes only.
import { expect, test } from 'playwright/test';
import { shot } from '../journeys/helpers.js';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaLeadInfo, type IsaWorldInfo, axe, expectNoCode, isaLeadOf, isaWorldOf, press, runIsa, signInAs, startIsaStack } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let lead: IsaLeadInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
  lead = await isaLeadOf(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

test('J1 E521: start (2 taps) → the AI message is labelled → AGENT → the handoff card → Got it keeps the deadline → the owner texts → Done', async ({ page }, info) => {
  test.setTimeout(240_000);
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  const taps = { taps: 0 };
  await press(page, page.getByRole('button', { name: 'Start AI care' }), taps);
  await press(page, page.getByRole('dialog', { name: 'Start AI care' }).getByRole('button', { name: 'Start as a buyer' }), taps);
  await expect(page.getByTestId('start-result')).toContainText('AI care started');
  expect(taps.taps).toBe(2);
  await runIsa(stack);
  const ai = await stack.sql<{ id: string }>(`SELECT message_id AS id FROM ai_isa_turns WHERE contact_id = $1 AND message_id IS NOT NULL`, [lead.id]);
  expect(ai.length).toBeGreaterThan(0);
  await page.goto(`${stack.webUrl}/contacts/${lead.id}/thread`);
  for (const m of ai) {
    const li = page.locator(`li[id="${m.id}"]`);
    await expect(li).toContainText(/(Sent|Scheduled|Queued|Written) by .*AI assistant/);
    await expect(li).not.toContainText('Sent automatically');
  }
  // the person asks for a person: care ends with a handoff to the owner
  await stack.fixture('/isa-sms-in', { from: lead.phone, body: 'AGENT' });
  await runIsa(stack);
  await page.goto(`${stack.webUrl}/`);
  const card = page.getByTestId('ai-card-ai_isa_handoff').filter({ has: page.locator(`a[href="/contacts/${lead.id}"]`) });
  await expect(card).toContainText('They asked to talk to a person.');
  // what is unanswered comes from the frozen package: the holding line answered "AGENT" here, so nothing is listed
  const pkg = await stack.sql<{ n: number; lines: number }>(`SELECT jsonb_array_length(package->'unansweredInbound') AS n, jsonb_array_length(package->'commitments') AS lines FROM ai_isa_handoffs WHERE contact_id = $1`, [lead.id]);
  if (pkg[0]!.n > 0) await expect(card).toContainText(/message(s)? from them (has|have) no answer/);
  else await expect(card).not.toContainText('no answer');
  // batch 13 isa-4 F8: the holding line it wrote with the handoff is on the card, asserted unconditionally
  expect(pkg[0]!.lines, 'the handoff carries the line the AI wrote').toBeGreaterThan(0);
  await expect(card).toContainText(/Lines the AI wrote with this handoff.*“.+”/);
  await expect(card.getByRole('timer')).toBeVisible();
  await expect(card).toContainText("Got it doesn't meet the deadline: a call, text or email to Jane from you or a collaborator does.");
  await expectNoCode(page);
  await shot(page, info, 'ai-care', 'handoff-card');
  expect(await axe(page)).toEqual([]);
  const ack = { taps: 0 };
  await press(page, card.getByRole('button', { name: 'Got it' }), ack);
  expect(ack.taps).toBe(1);
  const sheet = page.getByRole('dialog', { name: 'Handoff seen' });
  await expect(sheet).toContainText(/Seen at .*\. The deadline still runs\./);
  await expect(sheet.getByRole('button', { name: /Cancel/ })).toHaveCount(0);
  await press(page, sheet.getByRole('button', { name: 'Close' }).first());
  const h1 = await stack.sql<{ met: string | null; ack: string | null }>(`SELECT sla_met_at AS met, acknowledged_at AS ack FROM ai_isa_handoffs WHERE contact_id = $1`, [lead.id]);
  expect(h1[0]!.ack).not.toBeNull();
  expect(h1[0]!.met).toBeNull();
  // the owner's own text meets it, through the deadline sweep
  await page.goto(`${stack.webUrl}/contacts/${lead.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Hi Jane, it is me. Happy to talk now.');
  await press(page, page.getByRole('button', { name: 'Send', exact: true }).last());
  await runIsa(stack);
  await expect.poll(async () => (await stack.sql<{ t: string | null }>(`SELECT last_human_touch_at AS t FROM contacts WHERE id = $1`, [lead.id]))[0]!.t, { timeout: 20_000 }).not.toBeNull();
  await stack.fixture('/isa-sla');
  await page.goto(`${stack.webUrl}/`);
  await expect(card).toContainText(/Done: Jane was reached at /);
  expect(await axe(page)).toEqual([]);
});
