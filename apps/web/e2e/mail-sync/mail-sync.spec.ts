// Module 69 (web/mail-sync, D2) against the REAL API (stack.ts: a fresh per-test Postgres database, the RLS-bound
// app_user, fake providers incl. FakeGmail), on the phone (iPhone 13, 390 × 844) and desktop (1440 × 900) projects:
//   - the Owner opens Admin → Gmail sync: the switch is disabled with the review sentence until platform:gmail is
//     cleared, then turns it on;
//   - the agent opens Settings → Gmail, reads the disclosure and taps Connect Gmail; the spec intercepts the
//     navigation to accounts.fake.invalid, reads state + code_challenge, has the fake Google issue a code and opens
//     the callback; back on the page the agent confirms their clients in ONE tap ("Sync these clients");
//     connect + confirm = 2 in-app taps (Google's consent screen is out of band), within the 3-tap budget;
//   - a later client is a one-tap "Sync"; "Stop syncing this address" removes it;
//   - a client's email delivered to the mailbox appears in that client's thread after one mail.sync pass, tagged
//     "Gmail (read-only)", with no reply button; personal mail (no client on it) is never copied;
//   - the agent removes that thread in 2 taps, and disconnects in 2 taps.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, expect, test } from 'playwright/test';

import { type MailStack, type MailWorld, startMailStack } from './stack.js';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-results/mail-sync');

test.describe.configure({ mode: 'serial' });

let stack: MailStack;
let w: MailWorld;
let jane: { id: string; name: string; email: string };
let omar: { id: string; name: string; email: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startMailStack();
  w = await stack.fixture<MailWorld>('/world');
  jane = await stack.fixture('/contact', { firstName: 'Jane', lastName: 'Doe' });
  omar = await stack.fixture('/contact', { firstName: 'Omar', lastName: 'Haddad' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** Counts every tap the person makes (tap on the phone, click on desktop). */
function tapper(page: Page) {
  let n = 0;
  return {
    async tap(l: Locator) {
      n += 1;
      if (isPhone(page)) await l.tap();
      else await l.click();
    },
    reset() {
      n = 0;
    },
    get count() {
      return n;
    },
  };
}

async function signIn(page: Page, who: { email: string; password: string; totpSecret?: string }) {
  await page.context().clearCookies();
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (who.totpSecret) {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email: who.email, secret: who.totpSecret });
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

async function openFromNav(page: Page, label: string) {
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    await page.getByRole('link', { name: label, exact: true }).tap();
  } else await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: label, exact: true }).click();
}

/** The shell's password prompt, when the API asks for a fresh re-auth (R-PERM-13). */
async function reauthIfAsked(page: Page, who: { email: string; password: string; totpSecret?: string }) {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  if (!(await dialog.isVisible({ timeout: 3_000 }).catch(() => false))) return;
  await dialog.getByLabel('Password').fill(who.password);
  if (who.totpSecret) {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email: who.email, secret: who.totpSecret });
    await dialog.getByLabel('Authenticator code').fill(code);
  }
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the Owner turns Gmail sync on once platform:gmail is cleared; the page shows no mailbox or sync state', async ({ page }) => {
  await signIn(page, w.owner);
  await openFromNav(page, 'Gmail sync (team)');
  await expect(page.getByRole('heading', { level: 1, name: 'Gmail sync (team)' })).toBeVisible();
  const on = page.getByRole('button', { name: 'Turn Gmail sync on' });
  // a fresh stack starts uncleared on the first project only if no earlier run cleared it: each project has its own stack
  await expect(on).toBeDisabled();
  await expect(page.getByText(/not reviewed by counsel/)).toBeVisible();
  await noSideScroll(page);

  await stack.fixture('/clear-gmail');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Turn Gmail sync on' })).toBeEnabled();
  await page.getByRole('button', { name: 'Turn Gmail sync on' }).click();
  await reauthIfAsked(page, w.owner);
  await expect(page.getByRole('heading', { level: 2, name: 'Gmail sync is on' })).toBeVisible();
  expect(await page.locator('main').textContent()).not.toContain('@');
});

test('the agent connects Gmail and confirms their clients in 2 in-app taps (budget 3)', async ({ page }) => {
  const t = tapper(page);
  await signIn(page, w.agent);
  await openFromNav(page, 'My Gmail');
  await expect(page.getByRole('heading', { level: 1, name: 'My Gmail' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Connect your Gmail (read-only)' })).toBeVisible();
  await expect(page.getByText('Read-only: Realty OS never sends, labels or deletes in your Gmail.')).toBeVisible();
  await noSideScroll(page);

  // Google's consent screen is out of band: the spec stands in for it
  let authorize: URL | null = null;
  await page.route('https://accounts.fake.invalid/**', async (route) => {
    authorize = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google (fake)</title><h1>Google (fake)</h1>' });
  });
  await t.tap(page.getByRole('button', { name: 'Connect Gmail' }));
  await expect.poll(() => authorize?.host ?? null).toBe('accounts.fake.invalid');
  const state = authorize!.searchParams.get('state')!;
  const codeChallenge = authorize!.searchParams.get('code_challenge')!;
  expect(authorize!.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
  const { code } = await stack.fixture<{ code: string }>('/gmail-code', { codeChallenge, mailbox: w.mailbox });
  await page.goto(`${stack.webUrl}/api/me/mail-link/callback?${new URLSearchParams({ state, code }).toString()}`);

  await expect(page).toHaveURL(/\/settings\/mail$/);
  await expect(page.getByText('Gmail is connected. Choose which clients to sync below.')).toBeVisible();
  await expect(page.getByText(`Connected: ${w.mailbox}.`, { exact: false })).toBeVisible();
  const ask = page.getByRole('region', { name: 'Sync Gmail with these clients?' });
  await expect(ask).toBeVisible();
  for (const c of [jane, omar]) await expect(ask.getByRole('checkbox', { name: new RegExp(c.name) })).toBeChecked();
  await expect(ask.getByText(/Nothing is copied for an address you haven't confirmed/)).toBeVisible();
  await t.tap(ask.getByRole('button', { name: 'Sync these clients' }));
  await expect(page.getByText('Syncing Gmail with 2 clients.')).toBeVisible();
  const synced = page.getByRole('region', { name: 'Clients you sync' });
  await expect(synced.getByText(jane.email)).toBeVisible();
  await expect(synced.getByText(omar.email)).toBeVisible();
  expect(t.count).toBe(2);
  expect(t.count).toBeLessThanOrEqual(3);
  await noSideScroll(page);
});

test('a later client is confirmed in 1 tap; "Stop syncing this address" removes it', async ({ page }) => {
  const lee = await stack.fixture<{ id: string; name: string; email: string }>('/contact', { firstName: 'Lee', lastName: 'Park' });
  const t = tapper(page);
  await signIn(page, w.agent);
  await page.goto(`${stack.webUrl}/settings/mail`);
  const fresh = page.getByRole('region', { name: 'New clients you can sync' });
  await expect(fresh.getByText(lee.email)).toBeVisible();
  // phone layout (UX review): name blocks get the row's width and an address sits on one line, never broken mid-word
  for (const name of await page.locator('[data-point-name]').all()) {
    const box = (await name.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(isPhone(page) ? 250 : 192);
    expect(box.height).toBeLessThan(80); // two lines (name, address), no stretched block
    const address = name.locator('span').nth(1);
    const lh = await address.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 20);
    expect((await address.boundingBox())!.height).toBeLessThan(lh * 1.5);
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `client-rows-${test.info().project.name}.png`), fullPage: true });
  await t.tap(fresh.getByRole('button', { name: `Sync ${lee.email}` }));
  await expect(page.getByText('Syncing Gmail with 1 client.')).toBeVisible();
  expect(t.count).toBe(1);
  const row = page.getByRole('region', { name: 'Clients you sync' }).getByRole('listitem').filter({ hasText: lee.email });
  await expect(row).toBeVisible();
  t.reset();
  await t.tap(row.getByRole('button', { name: 'Stop syncing this address' }));
  await expect(page.getByText(`Stopped syncing ${lee.email}. Its copies left Realty OS.`)).toBeVisible();
  expect(t.count).toBe(1);
  await expect(page.getByRole('region', { name: 'Clients you sync' }).getByText(lee.email)).toHaveCount(0);
});

test("a client's email shows in the thread tagged Gmail (read-only); personal mail never does; removing the thread is 2 taps", async ({ page }) => {
  await stack.fixture('/deliver', { mailbox: w.mailbox, from: jane.email, subject: 'Offer on 12 Oak St', text: 'We would like to go in at 950.', threadId: `thr-jane-${test.info().project.name}` });
  await stack.fixture('/deliver', { mailbox: w.mailbox, from: 'dentist@personal.example', subject: 'Your cleaning', text: 'See you Tuesday.', threadId: `thr-personal-${test.info().project.name}` });
  await stack.fixture('/sync');
  const { copies } = await stack.fixture<{ copies: { thread: string; subject: string | null }[] }>('/copies', { contactId: jane.id });
  expect(copies.map((c) => c.subject)).toEqual(['Offer on 12 Oak St']);

  const t = tapper(page);
  await signIn(page, w.agent);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  const entry = convo.locator('[data-gmail-entry]').filter({ hasText: 'We would like to go in at 950.' });
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry.locator('[data-gmail-tag]')).toHaveText('Gmail (read-only)');
  await expect(entry.getByText(/From Jane Doe to Ava Chen/)).toBeVisible();
  await expect(entry.getByRole('button', { name: /reply/i })).toHaveCount(0);
  await expect(page.getByText(`Showing Gmail with ${jane.email} since`, { exact: false })).toBeVisible();
  await expect(page.getByText('See you Tuesday.')).toHaveCount(0);
  await noSideScroll(page);

  await t.tap(entry.getByRole('button', { name: 'Remove this thread from Realty OS' }));
  const sheet = page.getByRole('dialog', { name: 'Remove this thread from Realty OS?' });
  await expect(sheet.getByText("This can't be undone: its copies leave Realty OS and later messages in it are never copied.")).toBeVisible();
  await t.tap(sheet.getByRole('button', { name: 'Remove thread' }));
  await expect(convo.locator('[data-gmail-entry]')).toHaveCount(0);
  await expect(convo).toBeFocused();
  await expect(page.getByTestId('announcer')).toHaveText('Thread removed from Realty OS');
  expect(t.count).toBe(2);
});

test('the agent disconnects Gmail in 2 taps, with the exact disconnect copy', async ({ page }) => {
  const t = tapper(page);
  await signIn(page, w.agent);
  await page.goto(`${stack.webUrl}/settings/mail`);
  await t.tap(page.getByRole('button', { name: 'Disconnect', exact: true }));
  const sheet = page.getByRole('dialog', { name: 'Disconnect Gmail?' });
  await expect(sheet.getByText('Your copies disappear from Realty OS now and are deleted within a few minutes; backup copies expire on their own schedule.')).toBeVisible();
  await t.tap(sheet.getByRole('button', { name: 'Disconnect Gmail' }));
  await reauthIfAsked(page, w.agent);
  await expect(page.getByText('Gmail is disconnected. Your copies disappeared from Realty OS.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeVisible();
  expect(t.count).toBe(2);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  // Jane's only conversation was the removed Gmail thread: the conversation is empty again
  await expect(page.getByText('No messages or calls yet.')).toBeVisible();
  await expect(page.locator('[data-gmail-entry]')).toHaveCount(0);
});
