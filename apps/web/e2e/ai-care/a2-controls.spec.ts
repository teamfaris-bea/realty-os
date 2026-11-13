// a2-controls (J3; E496, E513; R-ISA-15): Pause from the list in 1 tap; the team lead sees Pause but no Resume and the
// owner resumes in 1 tap; Take over → Undo within 10 s → paused; Take over, then the finalize job → "AI care ended" and
// the handoff card; End (2 taps) with Undo; a hand-typed text shows the warning before Send and the Resume toast
// after. Real API on a fresh database, fakes only. Phone 390×844 and desktop 1440×900; taps are counted.
import { expect, test } from 'playwright/test';
import { pollSql } from '../journeys/helpers.js';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaWorldInfo, axe, expectNoCode, isaLeadOf, isaWorldOf, press, runIsa, signInAs, startIsaStack, strip } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack);
});
test.afterAll(async () => {
  await stack?.stop();
});

async function liveLead() {
  const l = await isaLeadOf(stack);
  const s = await stack.api('i.agent0', 'POST', `/contacts/${l.id}/ai-isa/start`, { side: 'buyer' });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  await runIsa(stack);
  return l;
}
const state = (id: string) => stack.sql<{ paused_at: string | null; ended_at: string | null; end_reason: string | null; finalize_at: string | null }>(`SELECT paused_at, ended_at, end_reason, finalize_at FROM ai_isa_assignments WHERE contact_id = $1 ORDER BY started_at DESC LIMIT 1`, [id]);

test('J3 R-ISA-15: Pause from the list in 1 tap; the team lead sees Pause but no Resume; the owner resumes in 1 tap', async ({ page }) => {
  test.setTimeout(180_000);
  const l = await liveLead();
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/ai-care`);
  const row = page.locator('article').filter({ has: page.locator(`a[href="/contacts/${l.id}"]`) });
  const taps = { taps: 0 };
  await press(page, row.getByRole('button', { name: 'Pause' }), taps);
  // the row leaves the Live filter as the list refetches; the result is said through the one Announcer
  await expect(page.getByTestId('announcer')).toContainText('Paused: nobody is following up automatically.');
  expect(taps.taps).toBe(1);
  await pollSql(stack, `SELECT paused_at FROM ai_isa_assignments WHERE contact_id = $1`, [l.id], (r: { paused_at: string | null }[]) => r[0]?.paused_at != null);
  // the team lead: the paused strip names the owner who can resume, and offers no Resume
  await signInAs(page, stack, w.lead!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}`);
  await expect(strip(page)).toContainText('Paused: nobody is following up automatically');
  await expect(strip(page)).toContainText(/can resume\./);
  await expect(strip(page).getByRole('button', { name: 'Resume AI care' })).toHaveCount(0);
  await expectNoCode(page);
  expect(await axe(page)).toEqual([]);
  // the owner resumes in one tap
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}`);
  const t2 = { taps: 0 };
  await press(page, strip(page).getByRole('button', { name: 'Resume AI care' }), t2);
  await expect(strip(page).getByTestId('ai-control-line')).toHaveText('AI care resumed.');
  expect(t2.taps).toBe(1);
  expect((await state(l.id))[0]!.paused_at).toBeNull();
});

test('J3 E496: Take over → Undo within 10 s → paused, never live; the compose box waits for the toast', async ({ page }) => {
  test.setTimeout(180_000);
  const l = await liveLead();
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}`);
  const taps = { taps: 0 };
  await press(page, strip(page).getByRole('button', { name: 'Take over' }).first(), taps);
  await expect(page).toHaveURL(new RegExp(`/contacts/${l.id}/thread\\?compose=sms`));
  const toast = page.getByTestId('ai-undo-toast');
  await expect(toast).toContainText('You took over. AI care ends in 10 seconds; Undo keeps it paused instead.');
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeFocused();
  expect(await axe(page)).toEqual([]);
  await press(page, toast.getByRole('button', { name: 'Undo' }), taps);
  await expect(toast).toBeHidden();
  expect(taps.taps).toBe(2); // Take over 1, Undo 1
  const s = (await state(l.id))[0]!;
  expect(s.paused_at).not.toBeNull();
  expect(s.ended_at).toBeNull();
  expect(s.finalize_at).toBeNull();
  await expect(page.getByTestId('ai-thread-banner')).toContainText('Paused: nobody is following up automatically');
});

test('J3 E496: Take over, then the finalize job → "AI care ended" and the handoff card in the feed', async ({ page }) => {
  test.setTimeout(180_000);
  const l = await liveLead();
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}/thread`);
  await press(page, page.getByTestId('ai-thread-banner').getByRole('button', { name: 'Take over' }));
  await expect(page.getByTestId('ai-undo-toast')).toBeVisible();
  await stack.fixture('/isa-window-past', { contactId: l.id });
  await runIsa(stack);
  await expect(page.getByTestId('ai-after-toast')).toContainText(/AI care ended\. (The handoff is in your feed\.|.* gets the handoff\.|The handoff went to the team leads and Owner\/Admin\.)/, { timeout: 30_000 });
  expect((await state(l.id))[0]!.end_reason).toBe('taken_over');
  await page.goto(`${stack.webUrl}/`);
  const card = page.getByTestId('ai-card-ai_isa_handoff').filter({ has: page.locator(`a[href="/contacts/${l.id}"]`) });
  await expect(card).toContainText('Someone on the team took over.');
  await expect(card.getByRole('button', { name: 'Review' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('J3 E496: End takes 2 taps (More, End AI care) and Undo keeps it paused', async ({ page }) => {
  test.setTimeout(180_000);
  const l = await liveLead();
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}`);
  const taps = { taps: 0 };
  const s = strip(page).getByTestId('ai-controls').first();
  await press(page, s.getByRole('button', { name: 'More' }), taps);
  await press(page, s.getByRole('button', { name: 'End AI care' }), taps);
  expect(taps.taps).toBe(2);
  const toast = page.getByTestId('ai-undo-toast');
  await expect(toast).toContainText('AI care ends in 10 seconds. Undo keeps it paused instead.');
  await press(page, toast.getByRole('button', { name: 'Undo' }));
  await expect(toast).toBeHidden();
  const st = (await state(l.id))[0]!;
  expect(st.ended_at).toBeNull();
  expect(st.paused_at).not.toBeNull();
});

test('J3 R-ISA-3: a hand-typed text shows the warning first, then the Resume toast for the owner', async ({ page }) => {
  test.setTimeout(180_000);
  const l = await liveLead();
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${l.id}/thread?compose=sms`);
  await expect(page.getByTestId('ai-compose-note')).toHaveText('Sending or scheduling this pauses AI care for Jane now. You can resume it.');
  await page.getByRole('textbox', { name: 'Text message' }).first().fill('Hi Jane, this is me in person.');
  await press(page, page.getByRole('button', { name: 'Send', exact: true }).last());
  const t = page.getByTestId('ai-resume-toast');
  await expect(t).toContainText('AI care for Jane is paused because you messaged them.');
  const resume = t.getByRole('button', { name: 'Resume AI care' });
  await expect(resume).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await press(page, resume);
  await expect(t).toContainText('AI care resumed.');
  expect((await state(l.id))[0]!.paused_at).toBeNull();
});
