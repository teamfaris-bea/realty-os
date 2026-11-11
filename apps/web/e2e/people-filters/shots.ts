// Screenshots of the People filter builder against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1, light and dark. Run: pnpm --filter @realty/web exec tsx e2e/people-filters/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { startFiltersStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/people-filters';
mkdirSync(out, { recursive: true });
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

const stack = await startFiltersStack();
const browser = await chromium.launch();
try {
  const w = await stack.fixture<{ agent: { email: string; password: string } }>('/world');
  const login = await browser.newContext();
  const lp = await login.newPage();
  await lp.goto(`${stack.webUrl}/login`);
  await lp.getByLabel('Email').fill(w.agent.email);
  await lp.getByLabel('Password').fill(w.agent.password);
  await lp.getByRole('button', { name: 'Sign in' }).click();
  await lp.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
  const state = await login.storageState();
  await login.close();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...vp, colorScheme: scheme, storageState: state });
      const page: Page = await ctx.newPage();
      const shot = async (file: string) => {
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: `${out}/${file}-${name}-${scheme}.png` });
      };
      await page.goto(`${stack.webUrl}/people`);
      await page.getByText('Showing people you can see').first().waitFor();
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stage', exact: true }).waitFor();
      await shot('1-fields');
      await page.getByRole('dialog').getByRole('button', { name: 'Source', exact: true }).click();
      await page.getByRole('dialog').getByText('is not', { exact: true }).click();
      await page.getByRole('dialog').getByRole('checkbox', { name: 'Zillow' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Show \d+ people$/ }).waitFor();
      await shot('2-values');
      await page.getByRole('dialog').getByRole('button', { name: 'Add another' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Tags', exact: true }).click();
      await page.getByRole('dialog').getByText('has none of', { exact: true }).click();
      await page.getByRole('dialog').getByRole('checkbox', { name: 'DNC' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Show \d+ people$/ }).click();
      await page.getByRole('list', { name: 'Active filters' }).waitFor();
      await shot('3-results');
      await page.getByRole('button', { name: /^Filter, \d+ active$/ }).click();
      await page.getByRole('dialog').getByRole('list', { name: 'Filters' }).waitFor();
      await shot('4-filter-list');
      await page.keyboard.press('Escape');
      await page.goto(`${page.url()}&q=zzz`);
      await page.getByText(/^0 people/).waitFor().catch(async (e) => {
        await page.screenshot({ path: `${out}/debug-${name}-${scheme}.png` });
        throw e;
      });
      await shot('5-empty');
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await stack.stop();
}
