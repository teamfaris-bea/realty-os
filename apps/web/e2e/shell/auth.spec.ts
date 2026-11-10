// web/shell against the REAL API (api/platform on a fresh per-test Postgres database, see stack.ts),
// on the phone (iPhone 13) and desktop (1440 px) projects: sign-up with MFA enrollment, sign-in with
// MFA, invite acceptance, error sentences, tap counts to the account, tap-target sizes, no
// horizontal scroll on a phone, and axe-core including color contrast in light and dark themes.
import { createRequire } from 'node:module';
import { type Page, expect, test } from 'playwright/test';
import { type Stack, startStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function totp(email: string, secret: string): Promise<string> {
  return (await stack.fixture<{ code: string }>('/totp', { email, secret })).code;
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, {
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Taps from the home screen to the Account page, counting each tap. */
async function tapsToAccount(page: Page): Promise<number> {
  let taps = 0;
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    taps += 1;
    await page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Account' }).tap();
    taps += 1;
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account' }).click();
    taps += 1;
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  return taps;
}

test('a new team owner signs up, sets up two-step verification, and lands in the app', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `owner-${tag}@example.test`;
  await page.goto(`${stack.webUrl}/signup`);
  await page.getByLabel('Your name').fill('Olivia Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByLabel('Team name').fill(`Harbor ${tag}`);
  await expect(page.getByLabel('Team web address')).toHaveValue(`harbor-${tag}`);
  await page.getByLabel('Brokerage legal name').fill('Harbor Realty LLC');
  await page.getByLabel('Team time zone').selectOption('America/New_York');
  await page.getByRole('button', { name: 'Create team' }).click();

  // Owners must enroll (R-PERM-14 is enforced by the server; the web routes the person there)
  await expect(page.getByRole('heading', { level: 1, name: 'Set up two-step verification' })).toBeVisible();
  const key = (await page.getByLabel('Setup key').textContent())!.replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel('Code').fill(await totp(email, key));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: 'I saved them, continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

  // sign out, sign back in: the second factor is asked again
  expect(await tapsToAccount(page)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Two-step verification' })).toBeVisible();
  await page.getByLabel('Code').fill(await totp(email, key));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(page.getByText(`Harbor ${tag}`).first()).toBeAttached();
});

test('a wrong password shows the uniform sentence, never a code', async ({ page }) => {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill('nobody@example.test');
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText("That email and password don't match.");
  await expect(page.locator('body')).not.toContainText('LOGIN_FAILED');
});

test('an invited agent joins from the email link; the token leaves the address bar', async ({ page }) => {
  const owner = await stack.fixture<{ email: string }>('/owner', {});
  const agentEmail = `agent-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { token } = await stack.fixture<{ token: string }>('/invite', { ownerEmail: owner.email, role: 'agent', email: agentEmail });
  await page.goto(`${stack.webUrl}/invite#token=${token}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Join your team' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Your name').fill('Ava Agent');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Join team' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  expect(await tapsToAccount(page)).toBeLessThanOrEqual(2);
  await expect(page.getByText('Agent', { exact: true }).last()).toBeVisible();
  // the same link cannot be used twice
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto(`${stack.webUrl}/invite#token=${token}`);
  await page.getByLabel('Your name').fill('Someone Else');
  await page.getByLabel('Password').fill('another long password here');
  await page.getByRole('button', { name: 'Join team' }).click();
  await expect(page.getByRole('alert')).toContainText('expired, was already used, or was withdrawn');
});

test('ergonomics on this viewport: one nav, tap targets ≥ 44 px, no horizontal scroll', async ({ page }) => {
  const owner = await stack.fixture<{ email: string; password: string; totpSecret: string }>('/owner', {});
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Code').fill(await totp(owner.email, owner.totpSecret));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Main tabs' });
  const sidebar = page.getByRole('navigation', { name: 'Main', exact: true });
  const shown = isPhone(page) ? tabs : sidebar;
  // exactly one navigation per breakpoint: bottom tabs on a phone, the sidebar on desktop
  await expect(shown).toBeVisible();
  await expect(isPhone(page) ? sidebar : tabs).toBeHidden();
  const vp = page.viewportSize()!;
  const box = (await shown.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  for (const link of await shown.getByRole('link').all()) {
    const b = (await link.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  for (const path of ['/', '/more', '/account']) {
    await page.goto(`${stack.webUrl}${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
    for (const b of await page.locator('main button:visible, main a:visible').all()) {
      const bb = (await b.boundingBox())!;
      expect(bb.height, `${path} ${await b.textContent()}`).toBeGreaterThanOrEqual(44);
    }
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core (incl. color contrast), ${scheme} theme: sign-in, home, account`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${stack.webUrl}/login`);
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    await page.getByLabel('Email').fill('x@example.test');
    await page.getByLabel('Password').fill('nope');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').waitFor();
    expect(await axeViolations(page)).toEqual([]);

    const owner = await stack.fixture<{ email: string; password: string; totpSecret: string }>('/owner', {});
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Code').fill(await totp(owner.email, owner.totpSecret));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await tapsToAccount(page);
    expect(await axeViolations(page)).toEqual([]);
  });
}
