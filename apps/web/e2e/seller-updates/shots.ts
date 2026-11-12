// Screenshots of the seller-update card against the real stack (stack.ts), phone 390×844 and desktop 1440×900
// at deviceScaleFactor 1, light and dark: the card as the feed opens it (recipients, sections, sources), the
// sources opened, and the stale state. Run: pnpm --filter @realty/web exec tsx e2e/seller-updates/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type SellerSeed, startSellerStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/seller-updates';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, s: SellerSeed) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

const stack = await startSellerStack();
let browser: Browser | undefined;
try {
  const seed = await stack.fixture<SellerSeed>('/seed');
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      await signIn(page, stack.webUrl, seed);
      await page.goto(`${stack.webUrl}/listings/${seed.listingId}`);
      await page.getByRole('heading', { name: 'Seller update this week' }).waitFor();
      await page.screenshot({ path: `${out}/card-${name}-${scheme}.png`, fullPage: true });
      await page.getByText(/^Sources · as of /).first().click();
      await page.getByLabel('Your recommendation (required)').fill('Hold the price two more weeks; the kitchen feedback is strong.');
      await page.screenshot({ path: `${out}/card-open-${name}-${scheme}.png`, fullPage: true });
      await ctx.close();
    }
  }
  await stack.fixture('/showing');
  const ctx = await browser.newContext({ ...VIEWPORTS.phone, colorScheme: 'light' });
  const page = await ctx.newPage();
  await signIn(page, stack.webUrl, seed);
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}`);
  await page.getByText('New data since this was put together').waitFor();
  await page.screenshot({ path: `${out}/stale-phone-light.png`, fullPage: false });
  await ctx.close();
} finally {
  await browser?.close();
  await stack.stop();
}
