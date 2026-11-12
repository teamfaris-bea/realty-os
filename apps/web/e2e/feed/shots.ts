// Screenshots of the Phase 2/3 feed cards against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1, light and dark: the feed with one card of each type, the weekly plan
// opened in place, and the page the seller-update card opens.
// Run: pnpm --filter @realty/web exec tsx e2e/feed/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type FeedSeed, startFeedStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/feed';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, s: FeedSeed) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

const stack = await startFeedStack();
let browser: Browser | undefined;
try {
  const seed = await stack.fixture<FeedSeed>('/seed');
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      await signIn(page, stack.webUrl, seed);
      await page.getByText('Your plan this week', { exact: true }).waitFor();
      await page.screenshot({ path: `${out}/feed-${name}-${scheme}.png`, fullPage: true });
      const plan = page.locator('article').filter({ has: page.getByText('Your plan this week', { exact: true }) }).first();
      await plan.screenshot({ path: `${out}/plan-card-${name}-${scheme}.png` });
      if (scheme === 'light') {
        const seller = page.locator('article').filter({ has: page.getByText('Seller update to review', { exact: true }) }).first();
        await seller.getByRole('button', { name: 'Open listing' }).click();
        await page.waitForURL(`**/listings/${seed.listingId}`);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${out}/listing-from-card-${name}.png` });
      }
      await ctx.close();
    }
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
