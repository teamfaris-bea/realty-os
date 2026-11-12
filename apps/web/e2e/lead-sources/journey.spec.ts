// Lead sources end to end, against the REAL API (stack.ts: api/platform's harness on a fresh per-test Postgres
// database, RLS-bound app_user, fake providers, an https public base URL), on the phone (iPhone 13) and desktop
// (1440 px) projects. Taps are counted the way the other specs count them (one real touch tap on the phone, one click
// on desktop; typing and picking from a select are not taps):
//   (a) the Owner opens More → Lead sources (2 taps on a phone, 1 on desktop), adds "Home value form" arriving by
//       Google Ads lead form (the kind defaults to Ads), lands on its Google setup, picks Home value and turns it on:
//       the webhook URL and the key are shown, with copy buttons;
//   (b) Google's test delivery (posted with that key exactly as Google posts it) shows "Test lead received ... (no one
//       was added)" and adds no one; a real lead then shows "Last lead"; the list card says "Last lead ... · 1 in the
//       last 30 days";
//   (c) a tracking number bought on the source's page credits it: a stranger's text to that number is an inquiry of
//       this source (asserted in the database);
// then axe (contrast included) on the list and the source in light and dark, no sideways scroll on a phone and 44 px
// targets. LEAD_SOURCES_SHOTS=<dir> also saves screenshots of the list and the source.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type LeadSourcesStack, type SourceFacts, type World, startLeadSourcesStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const NAME = 'Home value form';
const SHOTS = process.env.LEAD_SOURCES_SHOTS;

test.describe.configure({ mode: 'serial' });

let stack: LeadSourcesStack;
let w: World;
let key = '';
let sourceUrl = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startLeadSourcesStack();
  w = await stack.fixture<World>('/world');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(w.owner.email);
  await page.getByLabel('Password').fill(w.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const { code } = await stack.fixture<{ code: string | null }>('/totp', { email: w.owner.email });
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

/** The shell's password prompt, if the server asks (typing is not counted; Confirm is one tap). */
async function confirmReauthIfAsked(page: Page, counter: { taps: number }) {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByLabel('Password').fill(w.owner.password);
  const { code } = await stack.fixture<{ code: string | null }>('/totp', { email: w.owner.email });
  if (code) await dialog.getByLabel('Authenticator code').fill(code);
  await tap(page, dialog.getByRole('button', { name: 'Confirm' }), counter);
  await expect(dialog).toHaveCount(0);
}

const google = (page: Page) => page.locator('details#google');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${isPhone(page) ? '390x844' : '1440x900'}.png`, fullPage: true });
}

test('(a) the Owner adds "Home value form" by Google Ads lead form and sees its URL and key', async ({ page }) => {
  // each project runs in its own worker with its own stack (beforeAll), so each adds the same source to its own team
  const name = NAME;
  await signIn(page);
  const nav = { taps: 0 };
  if (isPhone(page)) {
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }), nav);
    await tap(page, page.getByRole('main').getByRole('link', { name: 'Lead sources' }), nav);
  } else await tap(page, page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Lead sources' }), nav);
  await expect(page.getByRole('heading', { level: 1, name: 'Lead sources' })).toBeVisible();
  expect(nav.taps).toBe(isPhone(page) ? 2 : 1);

  const add = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Add a source' }), add);
  const sheet = page.getByRole('dialog', { name: 'Add a source' });
  await sheet.getByLabel('Name').fill(name);
  await tap(page, sheet.getByRole('radio', { name: 'Google Ads lead form' }), add);
  await expect(sheet.getByLabel('Kind')).toHaveValue('ads');
  await tap(page, sheet.getByRole('button', { name: 'Add source' }), add);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/admin\/lead-sources\/[0-9a-f-]{36}\?setup=google$/);
  sourceUrl = page.url().replace(/\?.*$/, '');

  const on = { taps: 0 };
  await expect(google(page)).toHaveAttribute('open', '');
  await google(page).getByLabel('What these leads are about').selectOption({ label: 'Home value' });
  await tap(page, google(page).getByRole('button', { name: 'Turn on the Google lead form' }), on);
  await confirmReauthIfAsked(page, on);
  const keyField = google(page).getByRole('textbox', { name: 'Key' });
  await expect(keyField).not.toHaveValue('', { timeout: 15_000 });
  await expect(google(page).getByRole('textbox', { name: 'Webhook URL' })).toHaveValue(/^https:\/\/.+\/api\/webhooks\/google-ads\/lead-form$/);
  await expect(google(page).getByRole('button', { name: 'Copy the key' })).toBeVisible();
  await expect(google(page).getByText("Google's test button may not reach us. A real lead from your own form is the check.")).toBeVisible();
  key = await keyField.inputValue();
  expect(key.length).toBeGreaterThan(20);
  expect(await page.locator('body').textContent()).not.toMatch(/REAUTH_REQUIRED|GOOGLE_LEAD|not_available|VERIFY/);
  test.info().annotations.push({ type: 'taps', description: `nav ${nav.taps}, add ${add.taps}, turn on ${on.taps}` });
});

test('(b) Google’s test delivery shows "Test lead received" and adds no one; a real lead shows "Last lead"', async ({ page }) => {
  expect(key).not.toBe('');
  await signIn(page);
  const before = (await stack.fixture<SourceFacts>('/source-facts', { name: NAME })).inquiries.length;
  expect((await stack.fixture<{ status: number }>('/google', { key, isTest: true })).status).toBe(200);
  await page.goto(sourceUrl);
  await expect(google(page).getByText(/^Test lead received .+ \(no one was added\)$/)).toBeVisible({ timeout: 15_000 });
  await expect(google(page).getByText('No lead from the form yet.')).toBeVisible();
  expect((await stack.fixture<SourceFacts>('/source-facts', { name: NAME })).inquiries.length).toBe(before);

  expect((await stack.fixture<{ status: number }>('/google', { key, name: 'Riley Example' })).status).toBe(200);
  await page.reload();
  await expect(google(page).getByText(/^Last lead /)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Last lead just now · 1 in the last 30 days$|^Last lead 1 minute ago · 1 in the last 30 days$/)).toBeVisible();
  await shot(page, 'detail');
  await page.goto(`${stack.webUrl}/admin/lead-sources`);
  const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: NAME }) });
  await expect(card.getByText(/^Last lead .+ · 1 in the last 30 days$/)).toBeVisible();
  await expect(card.getByText('Google Ads lead form: On')).toBeVisible();
  await shot(page, 'list');
});

test('(c) a tracking number bought on the source credits it: a stranger’s text there is an inquiry of this source', async ({ page }) => {
  const name = NAME;
  await signIn(page);
  await page.goto(`${sourceUrl}?setup=phone`);
  const phone = page.locator('details#phone');
  await expect(phone.getByText(/^New callers and texters become leads credited to this source/)).toBeVisible();
  const buy = { taps: 0 };
  await tap(page, phone.getByRole('button', { name: 'Get a tracking number' }), buy);
  await expect(phone.getByRole('status').filter({ hasText: `now credits ${name}` })).toBeVisible({ timeout: 15_000 });
  const f = await stack.fixture<SourceFacts>('/source-facts', { name });
  expect(f.numbers).toHaveLength(1);
  const before = f.inquiries.length;
  expect((await stack.fixture<{ status: number }>('/text', { to: f.numbers[0] })).status).toBeLessThan(300);
  await expect.poll(async () => (await stack.fixture<SourceFacts>('/source-facts', { name })).inquiries.length, { timeout: 15_000 }).toBe(before + 1);
  const last = (await stack.fixture<SourceFacts>('/source-facts', { name })).inquiries.at(-1)!;
  expect(last.channel).toBe('tracking_number');
  expect(last.outcome).toBe('new_contact');
  test.info().annotations.push({ type: 'taps', description: `get a tracking number ${buy.taps}` });
});

test('Lead sources and a source: axe (incl. contrast) in light and dark, no horizontal scroll on a phone, 44 px tap targets', async ({ page }) => {
  test.setTimeout(120_000);
  expect(sourceUrl).not.toBe('');
  await signIn(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [url, h1] of [
      [`${stack.webUrl}/admin/lead-sources`, 'Lead sources'],
      [sourceUrl, NAME],
    ] as const) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      // every path open, so everything in them is checked
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')));
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        const r = await (window as unknown as { axe: { run(n: Node, o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document.body, { resultTypes: ['violations'] });
        return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      });
      expect(violations, `${scheme} ${url}`).toEqual([]);
      if (isPhone(page)) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal scroll on ${url}`).toBeLessThanOrEqual(0);
      }
      const small = await page.locator('main button:visible, main summary:visible, main select:visible, main input:visible, main a:visible').evaluateAll((els) =>
        els
          // a link inside running text is an inline target (WCAG 2.5.8's exception), as e2e/a11y/checks.ts treats it
          .filter((e) => !(e.tagName === 'A' && getComputedStyle(e).display === 'inline' && (e.parentElement?.textContent ?? '').trim().length > (e.textContent ?? '').trim().length + 2))
          .map((e) => ({ t: (e.textContent ?? e.getAttribute('aria-label') ?? e.getAttribute('type') ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, tag: e.tagName, type: e.getAttribute('type') }))
          // a checkbox or radio is inside a 44 px label row (the row is the target)
          .filter((x) => !(x.tag === 'INPUT' && (x.type === 'checkbox' || x.type === 'radio')))
          .filter((x) => x.h < 44 || x.w < 44),
      );
      expect(small, `${scheme} ${url} tap targets`).toEqual([]);
    }
  }
});
