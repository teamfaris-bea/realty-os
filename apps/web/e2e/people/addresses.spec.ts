// Delete an address from the person's Details section (PARITY_PLAN module 57/58; FUB lets an agent delete a
// person's address) against the REAL API (e2e/agent/stack.ts: api/platform's harness on a fresh per-test
// Postgres database, RLS-bound app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px)
// projects. PARITY_PLAN §5: a reversible one-person edit gets an Undo toast, never a confirm modal:
//   Remove = 1 tap (no dialog), the toast says so with Undo; Undo puts the address back.
// Then axe-core (light and dark) and 44 px targets on the person's page with its address and Remove control.
import { createRequire } from 'node:module';
import { type BrowserContext, type Locator, type Page, expect, test } from 'playwright/test';
import { phoneProblems } from '../a11y/checks.js';
import { type AgentStack, startAgentStack } from '../agent/stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
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

let session: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

/** Signs in once per run (the login endpoint is rate limited) and reuses the session cookies after. */
async function signIn(page: Page) {
  if (session) {
    await page.context().addCookies(session.cookies);
    await page.goto(`${stack.webUrl}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    return;
  }
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  session = await page.context().storageState();
}

async function openContact(page: Page, id: string, name: string) {
  await page.goto(`${stack.webUrl}/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Stage: / })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const peopleToast = (page: Page) => page.getByTestId('people-toast');

test('delete an address: Remove = 1 tap, no confirm modal, an Undo toast; Undo puts it back', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const p = await stack.fixture<{ id: string; name: string }>('/contact', { firstName: 'Ada', lastName: isPhone(page) ? 'Phone' : 'Desk' });
  const street = isPhone(page) ? '12 Oak St' : '40 Elm Ave';
  await stack.fixture('/address', { contactId: p.id, line1: street, city: 'Oakland', region: 'CA', postalCode: '94610' });
  await openContact(page, p.id, p.name);
  const text = `${street}, Oakland, CA, 94610`;
  const addresses = page.getByRole('list', { name: 'Addresses' });
  await expect(addresses.getByText(text)).toBeVisible();

  const remove = { taps: 0 };
  await tap(page, addresses.getByRole('button', { name: `Remove address ${text}` }), remove);
  await expect(peopleToast(page).getByText('Address removed')).toBeVisible();
  expect(remove.taps).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(text)).toHaveCount(0, { timeout: 15_000 });

  await peopleToast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('list', { name: 'Addresses' }).getByText(text)).toBeVisible({ timeout: 15_000 });
});

test('Undo puts back an address longer than the add form allows (as an import stores it): the server restores the deleted row, nothing is re-added through the add form', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const p = await stack.fixture<{ id: string; name: string }>('/contact', { firstName: 'Ima', lastName: isPhone(page) ? 'Phone' : 'Desk' });
  // 300 characters: over the add form's 200, inside an import's 500
  const street = `${'1200 Old Mill Pond Road Building Seven '.repeat(8).slice(0, 292)}Suite 4B`;
  expect(street).toHaveLength(300);
  await stack.fixture('/long-address', { contactId: p.id, line1: street });
  await openContact(page, p.id, p.name);
  const text = `${street}, Oakland, CA, 94610`;
  const addresses = page.getByRole('list', { name: 'Addresses' });
  await expect(addresses.getByText(text)).toBeVisible();
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/contacts\/[^/]+\/addresses/.test(r.url())) sent.push(new URL(r.url()).pathname);
  });

  await tap(page, addresses.getByRole('button', { name: `Remove address ${text}` }), { taps: 0 });
  await expect(peopleToast(page).getByText('Address removed')).toBeVisible();
  await expect(page.getByText(text)).toHaveCount(0, { timeout: 15_000 });
  await peopleToast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('list', { name: 'Addresses' }).getByText(text)).toBeVisible({ timeout: 15_000 });
  expect(sent).toEqual([expect.stringMatching(/\/addresses\/[0-9a-f-]{36}\/restore$/)]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the person’s page with an address: axe (incl. contrast) in light and dark, 44 px tap targets, no sideways scroll', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const p = await stack.fixture<{ id: string; name: string }>('/contact', { firstName: 'Axe', lastName: isPhone(page) ? 'Phone' : 'Desk' });
  await stack.fixture('/address', { contactId: p.id });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openContact(page, p.id, p.name);
    await expect(page.getByRole('button', { name: /^Remove address / })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await axeViolations(page), `${scheme} contact`).toEqual([]);
    if (isPhone(page)) expect(await phoneProblems(page), `${scheme} contact`).toEqual([]);
  }
});
