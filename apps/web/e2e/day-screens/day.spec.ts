// The three screens an agent was missing: add a task from the contact page, the stage board, and promises.
// Phone and desktop. Synthetic data only.
import { existsSync, mkdirSync } from 'node:fs';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type DayStack, type DayWorld, startDayStack } from './stack.js';

const SHOTS = '/opt/cursor/artifacts/day-screens';

// Use the system Chrome when Playwright's own Chromium is not installed (local cloud agents).
if (existsSync('/opt/google/chrome/chrome')) test.use({ launchOptions: { executablePath: '/opt/google/chrome/chrome' } });

test.describe.configure({ mode: 'serial' });

let stack: DayStack;
let world: DayWorld;
let sam: { id: string; name: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  stack = await startDayStack();
  world = await stack.fixture<DayWorld>('/world');
  sam = await stack.fixture('/contact', { firstName: 'Sam', lastName: 'Lee' });
  await stack.fixture('/promise', { contactId: sam.id, title: 'Send the comps', dueInMs: -3_600_000 });
  await stack.fixture('/promise', { contactId: sam.id, title: 'Call about the listing', dueInMs: 2 * 86_400_000 });
  const riley = await stack.fixture<{ id: string }>('/contact', { as: 'other', firstName: 'Riley', lastName: 'Nguyen' });
  await stack.fixture('/promise', { as: 'other', contactId: riley.id, title: 'Blake owes a tour', dueInMs: -60_000 });
});

test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  await target.scrollIntoViewIfNeeded();
  await target.click();
  counter.taps += 1;
}

async function shot(page: Page, name: string) {
  const kind = isPhone(page) ? 'phone' : 'desktop';
  await page.screenshot({ path: `${SHOTS}/${kind}-${name}.png`, fullPage: true });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

async function openMore(page: Page, label: string) {
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    await page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: label, exact: true }).tap();
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click();
  }
}

test('add a promise from the contact page in 3 taps; it shows on the timeline and on Tasks; a wrong assignee is refused', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.email, world.password);
  await page.goto(`${stack.webUrl}/contacts/${sam.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sam Lee' })).toBeVisible();
  const n = { taps: 0 };
  await tap(page, page.getByRole('region', { name: 'Tasks' }).getByRole('button', { name: 'Add a task' }), n);
  const dialog = page.getByRole('dialog', { name: 'Add a task for Sam Lee' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('What').fill('Drop off the keys');
  await tap(page, dialog.locator('label').filter({ hasText: /^Promise$/ }), n);
  await shot(page, 'add-task');
  await tap(page, dialog.getByRole('button', { name: 'Add' }), n);
  expect(n.taps).toBe(3);
  await expect(page.getByTestId('toast').getByText('Promise saved: Drop off the keys')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Promise: Drop off the keys' })).toBeVisible();
  await expect(page.getByText('Promise: Drop off the keys').first()).toBeVisible();
  await shot(page, 'contact-task');
  await page.goto(`${stack.webUrl}/tasks`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('Drop off the keys')).toBeVisible();

  await page.goto(`${stack.webUrl}/contacts/${sam.id}`);
  await page.getByRole('region', { name: 'Tasks' }).getByRole('button', { name: 'Add a task' }).click();
  const again = page.getByRole('dialog', { name: 'Add a task for Sam Lee' });
  await again.getByLabel('What').fill('Not for Blake');
  await again.getByLabel('Assign to').selectOption({ label: 'Blake Chen' });
  await again.getByRole('button', { name: 'Add' }).click();
  await expect(again.getByRole('alert')).toHaveText("That person can't be assigned this task.");
});

test('the pipeline board shows stage counts, filters by agent, and a move writes the stage', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.email, world.password);
  await openMore(page, 'Pipeline');
  await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sam Lee' })).toBeVisible();
  await expect(page.getByText('Showing people you can see.')).toBeVisible();
  await shot(page, 'pipeline');
  if (isPhone(page)) {
    await page.getByRole('tab', { name: /New lead/ }).tap();
    await page.getByRole('button', { name: 'Move Sam Lee' }).tap();
  } else {
    await page.getByRole('button', { name: 'Move Sam Lee' }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Move Sam Lee' });
  await dialog.getByRole('button', { name: /^Connected/ }).click();
  await expect(page.getByTestId('people-toast').getByText('Stage: Connected')).toBeVisible();
  await page.getByLabel('Agent').selectOption({ label: 'Blake Chen' });
  await expect(page.getByRole('link', { name: 'Sam Lee' })).toHaveCount(0);
});

test('promises lists the overdue one first and Done removes it', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.email, world.password);
  await openMore(page, 'Promises');
  await expect(page.getByRole('heading', { level: 1, name: 'Promises' })).toBeVisible();
  const overdue = page.getByRole('heading', { level: 2, name: 'Overdue' });
  const upcoming = page.getByRole('heading', { level: 2, name: 'Upcoming' });
  await expect(overdue).toBeVisible();
  await expect(upcoming).toBeVisible();
  const overdueBox = await overdue.boundingBox();
  const upcomingBox = await upcoming.boundingBox();
  expect(overdueBox && upcomingBox && overdueBox.y < upcomingBox.y).toBe(true);
  await expect(page.getByText('Send the comps')).toBeVisible();
  await shot(page, 'promises');
  const row = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Overdue' }) });
  if (isPhone(page)) await row.getByRole('button', { name: 'Done' }).first().tap();
  else await row.getByRole('button', { name: 'Done' }).first().click();
  await expect(page.getByTestId('toast').getByText('Done: Send the comps')).toBeVisible();
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Overdue' }) })).toHaveCount(0);
});

test('a team lead sees a teammate’s promise and not another team’s', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.lead.email, world.lead.password);
  await openMore(page, 'Promises');
  await expect(page.getByText('Blake owes a tour')).toBeVisible();
  await expect(page.getByText('Call about the listing')).toBeVisible();
  await page.getByLabel('Agent').selectOption({ label: 'Blake Chen' });
  await expect(page.getByText('Blake owes a tour')).toBeVisible();
  await expect(page.getByText('Call about the listing')).toHaveCount(0);
});
