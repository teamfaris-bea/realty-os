// Screenshots of the CMA screen against the real stack (stack.ts), phone 390×844 and desktop 1440×900 at
// deviceScaleFactor 1, light and dark: the contact page's "Home value (CMA)" section, the CMA as shipped (platform:cma
// not reviewed: Email off, the reason in words), a comp opened to its adjustments, and, with platform:cma reviewed in
// this test database only (restored in a finally), the share ready and then sent.
// Run: pnpm --filter @realty/web exec tsx e2e/cma/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type CmaSeed, startCmaStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/cma';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, s: CmaSeed) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

async function openCma(page: Page, webUrl: string, s: CmaSeed) {
  await page.goto(`${webUrl}/contacts/${s.contactId}`);
  await page.getByRole('heading', { name: 'Home value (CMA)' }).waitFor();
  await page.getByRole('button', { name: 'Prepare CMA' }).click();
  await page.getByRole('heading', { name: 'Estimated range' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^Email/ }).waitFor();
  await page.waitForLoadState('networkidle');
}

const stack = await startCmaStack();
let browser: Browser | undefined;
try {
  const seed = await stack.fixture<CmaSeed>('/seed');
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      await signIn(page, stack.webUrl, seed);
      await openCma(page, stack.webUrl, seed);
      await page.screenshot({ path: `${out}/cma-${name}-${scheme}.png`, fullPage: false });
      await page.screenshot({ path: `${out}/cma-full-${name}-${scheme}.png`, fullPage: true });
      const first = page.getByRole('article').first();
      await first.getByRole('button', { name: 'Show adjustments' }).click();
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/cma-comp-open-${name}-${scheme}.png`, fullPage: false });
      await page.goto(`${stack.webUrl}/contacts/${seed.contactId}`);
      await page.getByRole('link', { name: /^Open the CMA of / }).first().waitFor();
      await page.getByRole('heading', { name: 'Home value (CMA)' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/contact-section-${name}-${scheme}.png`, fullPage: false });
      await ctx.close();
    }
  }
  await stack.fixture('/clear-platform');
  try {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const s = await stack.fixture<CmaSeed>('/seed', { name: 'Sam Seller' });
      const ctx = await browser.newContext({ ...opts, colorScheme: 'light' });
      const page = await ctx.newPage();
      await signIn(page, stack.webUrl, s);
      await openCma(page, stack.webUrl, s);
      await page.getByRole('button', { name: 'Email to Sam' }).waitFor();
      await page.getByRole('heading', { name: 'Share with the client' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/share-ready-${name}.png`, fullPage: false });
      await page.getByRole('button', { name: 'Email to Sam' }).click();
      await page.getByText('Sent', { exact: true }).waitFor({ timeout: 20_000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${out}/shared-${name}.png`, fullPage: false });
      await ctx.close();
    }
  } finally {
    await stack.fixture('/restore-platform');
  }
} finally {
  await browser?.close();
  await stack.stop();
}
