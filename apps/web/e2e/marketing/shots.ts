// Screenshots of the marketing tab and the marketing approval card against the real stack (stack.ts),
// phone 390×844 and desktop 1440×900 at deviceScaleFactor 1, light and dark: the drafts just made, the
// approvals inbox with the marketing cards, and the tab after the social post was published to the fake
// Facebook Page and the Marketplace listing was exported.
// Run: pnpm --filter @realty/web exec tsx e2e/marketing/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type MarketingSeed, startMarketingStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/marketing';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, s: MarketingSeed) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

const settle = (page: Page) => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(400));

for (const [name, opts] of Object.entries(VIEWPORTS)) {
  // a stack per viewport, so each set starts from a listing without marketing
  const stack = await startMarketingStack();
  let browser: Browser | undefined;
  try {
    const seed = await stack.fixture<MarketingSeed>('/seed');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ...opts, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await signIn(page, stack.webUrl, seed);
    const tab = `${stack.webUrl}/listings/${seed.listingId}/marketing`;
    await page.goto(`${stack.webUrl}/listings/${seed.listingId}`);
    await settle(page);
    await page.screenshot({ path: `${out}/listing-${name}.png`, fullPage: true });
    await page.goto(tab);
    await page.getByRole('button', { name: 'Make marketing' }).waitFor();
    await page.screenshot({ path: `${out}/tab-empty-${name}.png` });
    await page.getByRole('button', { name: 'Make marketing' }).click();
    await page.locator('li[data-piece-kind="social_post"]').waitFor();
    await settle(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${out}/tab-drafts-${name}-${scheme}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${stack.webUrl}/approvals`);
    await page.getByRole('region', { name: 'Marketing to approve' }).waitFor();
    await settle(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${out}/approvals-${name}-${scheme}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(tab);
    const post = page.locator('li[data-piece-kind="social_post"]');
    await post.getByRole('button', { name: 'Approve' }).click();
    await post.getByRole('button', { name: 'Publish to Harbor Page' }).click();
    await post.getByText('Posted to your Facebook Page').first().waitFor();
    const mp = page.locator('li[data-piece-kind="marketplace_export"]');
    await mp.getByRole('button', { name: 'Approve' }).click();
    await mp.getByRole('button', { name: 'Copy' }).click();
    await mp.getByTestId('status-label').filter({ hasText: 'Exported: post it yourself' }).waitFor();
    await settle(page);
    await page.screenshot({ path: `${out}/tab-published-${name}.png`, fullPage: true });
    await post.screenshot({ path: `${out}/social-card-${name}.png` });
    await ctx.close();
  } finally {
    await browser?.close();
    await stack.stop();
  }
}
console.log(`screenshots in ${out}`);
