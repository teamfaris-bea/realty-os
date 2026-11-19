// A showing toast and the controls of the page (b19: the page's ONE stack of toasts, surfaces/people-edit/hooks.tsx,
// is a fixed element of the page and is declared as one while it shows a toast), against the REAL API
// (journeys/stack.ts), on a 390 × 844 and a 390 × 664 phone screen and on desktop:
//   - Today (Home): a webhook lead is offered, the agent accepts it from its card: the older announce toast
//     ("… is yours now."), now drawn inside the stack;
//   - the person's page: the agent changes the stage from the stage pill: the stage toast, with its Undo button.
// While each toast is on screen: the stack is marked data-sticky and its room is in the scroll padding, it overlaps
// no bar (so no control of the tab bar or of the person's working bar is ever under it), every control of the page
// can be brought wholly clear of it, the last one too (e2e/a11y/checks.ts toastProblems), and the phone layout check
// that failed on an unmarked stack is clean (phoneProblems). When the toast has gone the stack is no bar again.
// The approvals inbox has the same proof in marketing/marketing.spec.ts (its stack has the drafts to approve).
//
// What is NOT proven, and is not true: that nothing is under the toast before the page is scrolled. See the GAP test
// at the end of this file.
import { type Page, expect, test } from 'playwright/test';
import { phoneProblems, toastProblems, underToast } from '../a11y/checks.js';
import { feedCard, isPhone, signIn, tap, toast } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack();
  w = await stack.world({ agents: 1 });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** The phone project's own viewport is the page area of an iPhone 13 under the browser bar (390 × 664); 390 × 844 is its whole screen. */
const SIZES = [
  { name: '390 × 844', width: 390, height: 844 },
  { name: '390 × 664', width: 390, height: 664 },
];

async function expectToastClear(page: Page, where: string) {
  expect(await toastProblems(page), `${where}: the toast`).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page), `${where}: the phone layout check, with the toast on screen`).toEqual([]);
}

/** After the toast has gone the stack is no bar: not marked, nothing reserved. */
async function expectStackAtRest(page: Page) {
  await expect(page.getByTestId('toast-stack')).not.toHaveAttribute('data-sticky', /.*/, { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--toast-stack-h'))).toBe('');
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
}

/** A webhook lead, offered to the world's one agent. */
async function lead(name: string): Promise<string> {
  const { phone, email } = await stack.fixture<{ phone: string; email: string }>('/phone');
  const intake = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { body: { fullName: name, phones: [phone], emails: [email], message: 'Is 12 Oak St still available?', propertyText: '12 Oak St', postalCode: '94610' } });
  expect(intake.status).toBe(201);
  return intake.body.contactId;
}

/** Today: Accept the offer from its card; the announce toast is on screen when this returns. */
async function acceptOnToday(page: Page, name: string) {
  await signIn(page, stack, w.agents[0]!);
  const card = feedCard(page, name);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('toast-stack')).not.toHaveAttribute('data-sticky', /.*/);
  await tap(page, card.getByRole('button', { name: 'Accept' }));
  await expect(toast(page).getByText(`${name} is yours now.`)).toBeVisible({ timeout: 15_000 });
}

/** The person's page: New lead → Trying to reach from the stage pill; the stage toast (with Undo) is on screen when this returns. */
async function changeStage(page: Page, contactId: string, name: string) {
  await page.goto(`${stack.webUrl}/contacts/${contactId}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 15_000 });
  await tap(page, page.getByRole('button', { name: 'Stage: New lead. Change stage' }));
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /^Trying to reach/ }));
  await expect(page.getByTestId('people-toast').getByText(/^Stage: Trying to reach/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const size of SIZES) {
  test(`${size.name}: the announce toast on Today and the stage toast on the person's page are declared, sit on no bar, and every control can be brought clear of them`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const phone = info.project.name === 'phone';
    // desktop runs once, at its own size (the toast sits bottom centre there too)
    test.skip(!phone && size.height !== 844, 'desktop is checked once, at 1440 × 900');
    if (phone) await page.setViewportSize({ width: size.width, height: size.height });
    const name = `Tess ${phone ? `Phone${size.height}` : 'Desk'}`;
    const contactId = await lead(name);

    await acceptOnToday(page, name);
    await expectToastClear(page, 'Today');
    await expect(toast(page)).toBeEmpty({ timeout: 15_000 });
    await expectStackAtRest(page);

    await changeStage(page, contactId, name);
    const stageToast = page.getByTestId('people-toast');
    const undo = stageToast.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await expectToastClear(page, "the person's page");
    // the toast's own button is a real target, and a tap at its centre reaches it (nothing is over the toast either)
    const b = (await undo.boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    expect(await undo.evaluate((e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
    await expect(stageToast).toBeEmpty({ timeout: 15_000 });
    await expectStackAtRest(page);
  });
}

// GAP (low; a design question, not a regression of b19): a toast FLOATS over the scrolling page for its few seconds
// (5 s the announce toast, 8 s the stage toast), as every bar does. So a control that happens to be at the bottom of
// the screen when the toast shows is under it until the page is scrolled or the toast goes: nothing reserves that
// place before the scroll. Seen 2026-11-19: the person's page at 390 × 844 right after a stage change from the pill
// has "Add follow-up" under the stage toast; at 1440 × 900 the note box. (On Today after one Accept, nothing was
// under it at 390 × 844 or at 1440 × 900; 390 × 664 was not looked at this way.) Every such control can be brought
// clear by scrolling, and focus brings it clear (asserted above). Making this pass needs a toast that does not float
// over the page (an in-page line, or a bar the page makes room for), which is a product decision.
// Repro: run this test without fixme.
test.fixme('GAP: as the page stands when a toast shows, before anything is scrolled, no control of the page is under it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const name = `Gap ${phone ? 'Phone' : 'Desk'}`;
  const contactId = await lead(name);
  await acceptOnToday(page, name);
  expect(await underToast(page), 'Today').toEqual([]);
  await changeStage(page, contactId, name);
  expect(await underToast(page), "the person's page").toEqual([]);
});
