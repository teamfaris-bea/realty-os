// Screenshots of every registry page against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1, light (and dark for the phone), as the Owner (who can open every
// page) plus the Agent's home. Used for the lane's before/after review.
// Run: pnpm --filter @realty/web exec tsx e2e/a11y/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type Role, SIGNED_OUT_PAGES, SWEEP_PAGES, signedOutUrl } from './pages.js';
import { type A11yStack, type World, startA11yStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/a11y';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

const slug = (path: string) => (path === '/' ? 'home' : path.slice(1).replace(/[/:]+/g, '-'));

async function signIn(page: Page, stack: A11yStack, world: World, role: Role) {
  const u = world.users[role];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (u.mfa) {
    await page.getByLabel('Code').fill(await stack.totp(u.email));
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

async function settle(page: Page) {
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

const stack = await startA11yStack();
let browser: Browser | undefined;
try {
  const world = await stack.world();
  browser = await chromium.launch();
  for (const [name, opts] of Object.entries(VIEWPORTS)) {
    for (const scheme of name === 'phone' ? (['light', 'dark'] as const) : (['light'] as const)) {
      const suffix = scheme === 'light' ? '' : '-dark';
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      for (const p of SIGNED_OUT_PAGES) {
        await page.goto(`${stack.webUrl}${signedOutUrl(p, world.ids.widgetKey)}`);
        await settle(page);
        await page.screenshot({ path: `${out}/${name}${suffix}-signed-out-${slug(p.url.replace(/\?[^#]*/, ''))}.png`, fullPage: true });
      }
      await signIn(page, stack, world, 'owner');
      for (const p of SWEEP_PAGES) {
        await page.goto(`${stack.webUrl}${p.url(world.ids)}`);
        await settle(page);
        await page.screenshot({ path: `${out}/${name}${suffix}-${slug(p.path)}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  const ctx = await browser.newContext({ ...VIEWPORTS.phone });
  const page = await ctx.newPage();
  await signIn(page, stack, world, 'agent');
  await settle(page);
  await page.screenshot({ path: `${out}/phone-agent-home.png`, fullPage: true });
  await ctx.close();
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
