// Screenshots of the People surface and the admin parity pages against the real stack (stack.ts), phone
// 390×844 and desktop 1440×900 at deviceScaleFactor 1, light and dark.
// Run: pnpm --filter @realty/web exec tsx e2e/lists/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startListsStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/lists';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

const stack = await startListsStack();
let browser: Browser | undefined;
try {
  const w = await stack.fixture<{ agent: { email: string; password: string }; admin: { email: string; password: string }; listId: string }>('/world');
  browser = await chromium.launch();
  const signIn = async (page: Page, u: { email: string; password: string }, mfa: boolean) => {
    await page.goto(`${stack.webUrl}/login`);
    await page.getByLabel('Email').fill(u.email);
    await page.getByLabel('Password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    if (mfa) {
      await page.getByLabel('Code').fill((await stack.fixture<{ code: string }>('/totp', { email: u.email })).code);
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
  };
  // the Admin's enrollment used this 30 s TOTP step and a code is accepted once: sign in once, on the next
  // step, and reuse that session for every viewport and scheme
  await new Promise((r) => setTimeout(r, 31_000));
  const adminCtx = await browser.newContext();
  await signIn(await adminCtx.newPage(), w.admin, true);
  const adminState = await adminCtx.storageState();
  await adminCtx.close();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...vp, colorScheme: scheme });
      const page = await ctx.newPage();
      await signIn(page, w.agent, false);
      const shot = async (file: string) => {
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: `${out}/${file}-${name}-${scheme}.png`, fullPage: false });
      };
      await page.goto(`${stack.webUrl}/people`);
      await page.getByText('Showing people you can see').first().waitFor();
      await shot('people');
      await page.goto(`${stack.webUrl}/people?list=${w.listId}`);
      await page.getByRole('heading', { level: 2, name: 'Hot buyers' }).waitFor();
      await page.getByRole('checkbox', { name: /Select all/ }).check();
      await shot('people-selected');
      await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Tag', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await shot('bulk-tag-picker');
      await page.getByRole('dialog').getByRole('button', { name: 'Investor' }).click();
      await page.getByRole('dialog', { name: /^Tag \d+ of \d+\?$/ }).waitFor();
      await shot('bulk-tag-confirm');
      await page.keyboard.press('Escape');
      await page.getByRole('list', { name: 'People' }).getByRole('link').first().click();
      await page.getByText(/^1 of 30/).waitFor();
      await page.getByRole('heading', { name: /Alice Able/ }).first().waitFor();
      await shot('work-next');
      await ctx.close();
      const admin = await browser.newContext({ ...vp, colorScheme: scheme, storageState: adminState });
      const ap = await admin.newPage();
      for (const [file, path] of [['admin-tags', '/admin/tags'], ['admin-fields', '/admin/fields'], ['admin-stage-labels', '/admin/stage-labels']] as const) {
        await ap.goto(`${stack.webUrl}${path}`);
        await ap.getByRole('heading', { level: 1 }).first().waitFor();
        await ap.waitForLoadState('networkidle');
        await ap.screenshot({ path: `${out}/${file}-${name}-${scheme}.png` });
      }
      await admin.close();
    }
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
