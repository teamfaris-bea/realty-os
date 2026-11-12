// D5b texting reactions in the thread against the REAL API (stack.ts: a fresh per-test Postgres database, the
// RLS-bound app_user, fake providers), on the phone (iPhone 13, 390 × 844) and desktop (1440 × 900) projects:
//   - E300: Sam's phone answers the team's text with `Loved “…”`: a line "Sam loved “…”" in place of a bubble, a ❤️
//     chip under the team's text whose accessible name is "Sam loved this text" (the glyph hidden), and the raw text
//     one tap away;
//   - E305: a later `Removed a heart from “…”` clears the chip and shows its own line;
//   - E301: a reaction quoting a team text that reads like an opt-out says plainly it was not read as one, and offers
//     the person-level do-not-contact (two taps).
// Synthetic people only; nothing leaves the process.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from 'playwright/test';
import { type InboxStack, type World, startInboxStack } from './stack.js';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-results/inbox');
async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}-${project}.png`), fullPage: false });
}

test.describe.configure({ mode: 'serial' });

interface Thread {
  id: string;
  name: string;
  phone: string;
  targetId: string;
}

let stack: InboxStack;
let world: World;
let loved: Thread;
let removed: Thread;
let narrowed: Thread;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startInboxStack();
  world = await stack.fixture<World>('/world');
  loved = await stack.fixture<Thread>('/reaction-thread', { teamText: 'See you at 3', reactions: ['Loved “{Q}”'] });
  removed = await stack.fixture<Thread>('/reaction-thread', { firstName: 'Ana', teamText: 'Offer is in', reactions: ['Loved “{Q}”', 'Removed a heart from “{Q}”'] });
  narrowed = await stack.fixture<Thread>('/reaction-thread', { firstName: 'Lee', teamText: 'No more texts about Oak St, I promise. Talk soon!', reactions: ['Loved “{Q}”'] });
});
test.afterAll(async () => {
  await stack?.stop();
});

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(world.email);
  await page.getByLabel('Password').fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('R-REACT-6 E300: the reaction is a line naming the team text, the chip sits under that bubble, and the raw text is one tap away', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${loved.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  const line = convo.locator('[data-reaction="add"]');
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line.locator('p').first()).toContainText('Sam loved “See you at 3');
  await expect(line.locator('[data-channel-tag]')).toHaveText('SMS');
  const target = convo.locator(`li[id="${loved.targetId}"]`);
  const chip = target.locator('[data-reacted-with="love"]');
  await expect(chip).toBeVisible();
  // the accessibility tree names the chip in words; the glyph itself is hidden
  const tree = await target.ariaSnapshot();
  expect(tree).toContain('Sam loved this text');
  expect(tree).not.toContain('❤');
  // the quote links to the bubble it names
  await expect(line.getByRole('link')).toHaveAttribute('href', `#${loved.targetId}`);
  await shot(page, 'reactions-loved', info.project.name);
  // one tap: what the phone actually sent
  await line.getByText('Show what they sent').click();
  await expect(line.getByText(/^Loved “See you at 3/)).toBeVisible();
  // a reaction is not the person's own words: no bubble for it
  await expect(convo.locator('li', { hasText: 'Show what they sent' })).toHaveCount(1);
});

test('R-REACT-6 E305: a removal clears the chip and shows its own line', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${removed.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo.locator('[data-reaction="remove"]')).toBeVisible({ timeout: 15_000 });
  await expect(convo.locator('[data-reaction="remove"] p').first()).toContainText('Ana removed a heart from “Offer is in');
  await expect(convo.locator('[data-reaction="add"]')).toHaveCount(1);
  await expect(convo.locator(`li[id="${removed.targetId}"] [data-reacted-with]`)).toHaveCount(0);
  await shot(page, 'reactions-removed', info.project.name);
});

test('R-REACT-3 E301: a narrowed reaction says it was not read as an opt-out and offers the do-not-contact in two taps', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${narrowed.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo.getByText('Not read as an opt-out or a wrong number: the words in quotes come from a text sent to Lee.')).toBeVisible({ timeout: 15_000 });
  const offer = convo.getByRole('button', { name: 'They asked not to be contacted…' });
  await expect(offer).toBeVisible();
  await shot(page, 'reactions-narrowed', info.project.name);
  await offer.click(); // tap 1
  const dialog = page.getByRole('dialog', { name: 'Did Lee ask not to be contacted?' });
  await expect(dialog).toBeVisible();
  await shot(page, 'reactions-narrowed-confirm', info.project.name);
  await dialog.getByRole('button', { name: 'No', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
