// Parity module 64 against the REAL API (stack.ts), on the phone (iPhone 13) and desktop (1440 px)
// projects. Jobs with their taps counted (PARITY_PLAN §5):
//   template text: Text → Templates → template → Send = 4 from the person's page (3 from the composer)
//   bulk email: the sheet adds template → Confirm = 2 to the People page's 4 (People → list → Select all →
//     Email), with the people left out counted by reason before Confirm
//   template library: create a template; the batch-text page: counsel text, Owner + re-auth
// Then axe-core (contrast included) in light and dark, no horizontal scroll on a phone, 44 px targets.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type BulkStack, startBulkStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: BulkStack;
let world: { email: string; password: string; ownerEmail: string };
let jane: { id: string; name: string };
const bulkPeople: { id: string }[] = [];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startBulkStack();
  world = await stack.fixture('/world');
  jane = await stack.fixture('/contact', { firstName: 'Jane', lastName: 'Doe' });
  await stack.fixture('/template', { team: true, channel: 'sms', name: 'Showing follow-up', body: 'Hi {{contact.first_name}}, how was the showing today?' });
  await stack.fixture('/template', { channel: 'sms', name: 'Running late', body: 'Running 10 minutes late, sorry!' });
  await stack.fixture('/template', { team: true, channel: 'email', name: 'New listings', subject: 'New homes for {{contact.first_name}}', body: 'Hi {{contact.first_name}}, three new listings this week.' });
  bulkPeople.push(await stack.fixture('/contact', { firstName: 'Ana' }), await stack.fixture('/contact', { firstName: 'Ben' }), await stack.fixture('/contact', { firstName: 'Cy', unsubscribed: true }), await stack.fixture('/contact', { firstName: 'Dee', noEmail: true }));
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

async function signIn(page: Page, email = world.email) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email })).code;
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function smallTargets(page: Page, scope: string): Promise<{ t: string; h: number }[]> {
  return page.locator(`${scope} button:visible, ${scope} a[href]:visible, ${scope} input:visible, ${scope} textarea:visible`).evaluateAll((els) =>
    els
      .filter((e) => !e.closest('p, li > span, summary'))
      .map((e) => ({ t: ((e as HTMLElement).innerText || (e as HTMLInputElement).name || e.getAttribute('aria-label') || '').trim().slice(0, 30), h: e.getBoundingClientRect().height }))
      .filter((x) => x.h > 0 && x.h < 44),
  );
}

test('a template text from the person\'s page in 4 taps (3 from the composer); the text has their name and only Send sends it', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Jane Doe' })).toBeVisible();
  const c = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Text' }).first(), c);
  await expect(page.getByRole('textbox', { name: 'Text message' })).toBeVisible();
  const fromComposer = c.taps;
  await tap(page, page.getByRole('button', { name: 'Templates' }), c);
  const sheet = page.getByRole('dialog', { name: 'Text templates' });
  await expect(sheet.getByRole('region', { name: 'Team templates' })).toBeVisible();
  await tap(page, sheet.getByRole('button', { name: /Showing follow-up/ }), c);
  await expect(page.getByRole('textbox', { name: 'Text message' })).toHaveValue('Hi Jane, how was the showing today?');
  const before = (await stack.fixture<{ sms: { to: string; body: string }[] }>('/sent')).sms.length;
  await tap(page, page.getByRole('button', { name: 'Send', exact: true }), c);
  await expect(page.getByTestId('toast')).toContainText('Jane');
  const sent = (await stack.fixture<{ sms: { to: string; body: string }[] }>('/sent')).sms;
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)!.body).toContain('Hi Jane, how was the showing today?');
  expect(c.taps).toBe(4);
  expect(c.taps - fromComposer).toBe(3);
});

test('bulk email: template → Confirm (2 taps in the sheet), with everyone left out counted by reason before Confirm', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/bulk/new?kind=email&contacts=${bulkPeople.map((p) => p.id).join(',')}`);
  const c = { taps: 0 };
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /New listings/ }), c);
  const sheet = page.getByRole('dialog', { name: 'Email 2 of 4?' });
  await expect(sheet).toBeVisible();
  const left = sheet.getByRole('region', { name: 'Left out (2)' });
  await expect(left.locator('[data-reason="RECIPIENT_OPTED_OUT"]')).toHaveText('1 opted out');
  await expect(left.locator('[data-reason="NO_ADDRESS"]')).toHaveText('1 have no address for this');
  await expect(sheet.getByText(/an unsubscribe link are added/)).toBeVisible();
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await tap(page, sheet.getByRole('button', { name: 'Email 2 people' }), c);
  await expect(page).toHaveURL(/\/bulk\/[0-9a-f-]{36}$/);
  expect(c.taps).toBe(2);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const r = await stack.fixture<{ result: { kind: string; status?: string } }>('/run', { actionId: id });
  expect(r.result).toEqual({ kind: 'finished', status: 'completed' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Emailed 2 of 4' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Why people were left out' }).locator('[data-reason="RECIPIENT_OPTED_OUT"]')).toHaveText('1 opted out');
  const sent = (await stack.fixture<{ emails: { to: string; subject: string }[] }>('/sent')).emails.map((e) => e.subject);
  expect(sent).toEqual(expect.arrayContaining(['New homes for Ana', 'New homes for Ben']));
});

test('the template library: create your own text template with a merge field, and it is offered in the composer', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/templates`);
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  await page.getByRole('button', { name: 'New template' }).click();
  const d = page.getByRole('dialog', { name: 'New template' });
  const name = `Check-in ${isPhone(page) ? 'phone' : 'desk'}`;
  await d.getByLabel('Name').fill(name);
  await d.getByLabel('Message').fill('Checking in, ');
  await d.getByRole('button', { name: 'Their first name' }).click();
  await expect(d.getByLabel('Message')).toHaveValue('Checking in, {{contact.first_name}}');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Saved “${name}”.`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your templates' }).getByRole('heading', { name })).toBeVisible();
});

test('the batch-text page states the counsel text; only the Owner turns it on, after re-authenticating', async ({ page }) => {
  await signIn(page, world.ownerEmail);
  await page.goto(`${stack.webUrl}/settings/batch-text`);
  await expect(page.getByRole('heading', { level: 2, name: 'Batch text is off' })).toBeVisible();
  await expect(page.getByText(/Florida's Telephone Solicitation Act \(FTSA\) and Oklahoma's telephone solicitation act/)).toBeVisible();
  await expect(page.getByText(/Realty OS does not check consent before a text/)).toBeVisible();
  const on = page.getByRole('button', { name: 'Turn batch text on' });
  await expect(on).toBeDisabled();
  await page.getByLabel(/To turn it on, type/).fill('I have reviewed batch texting with counsel and accept responsibility');
  await stack.fixture('/stale-reauth', { email: world.ownerEmail });
  await on.click();
  const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(reauth).toBeVisible();
  await reauth.getByLabel('Password').fill(world.password);
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email: world.ownerEmail })).code;
  if (code) await reauth.getByLabel(/code/i).fill(code);
  await reauth.getByRole('button', { name: /Confirm|Continue/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Batch text is on' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Turn batch text off' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Batch text is off' })).toBeVisible();
});

test('module 64 pages: axe (incl. contrast) in light and dark, no horizontal scroll on a phone, 44 px tap targets', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, world.ownerEmail);
  const pages: [string, string, (() => Promise<void>)?][] = [
    ['/templates', 'Templates'],
    ['/bulk', 'Bulk actions'],
    ['/settings/batch-text', 'Batch text'],
    [`/bulk/new?kind=email&contacts=${bulkPeople.map((p) => p.id).join(',')}`, 'Bulk action'],
  ];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, h1] of pages) {
      await page.goto(`${stack.webUrl}${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page), `${scheme} ${path}`).toEqual([]);
      if (isPhone(page)) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal scroll on ${path}`).toBeLessThanOrEqual(0);
      }
      expect(await smallTargets(page, 'main'), `${scheme} ${path} tap targets`).toEqual([]);
      if (await page.getByRole('dialog').count()) expect(await smallTargets(page, '[role="dialog"]'), `${scheme} ${path} sheet targets`).toEqual([]);
    }
    // the picker sheet in the composer
    await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread?compose=sms`);
    await page.getByRole('button', { name: 'Templates' }).click();
    await expect(page.getByRole('dialog', { name: 'Text templates' }).getByRole('button', { name: /Showing follow-up/ })).toBeVisible();
    expect(await axeViolations(page), `${scheme} picker`).toEqual([]);
    expect(await smallTargets(page, '[role="dialog"]'), `${scheme} picker targets`).toEqual([]);
  }
});
