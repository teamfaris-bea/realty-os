// Screenshots of the shell against the real stack (stack.ts), phone 390×844 and desktop 1440×900
// at deviceScaleFactor 1, light and dark. Run: pnpm --filter @realty/web exec tsx e2e/shell/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/web';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, owner: { email: string; password: string }, code: () => Promise<string>) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Code').fill(await code());
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

const stack = await startStack();
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  const owner = await stack.fixture<{ email: string; password: string; totpSecret: string }>('/owner', {});
  const code = async () => (await stack.fixture<{ code: string }>('/totp', { email: owner.email, secret: owner.totpSecret })).code;
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      const suffix = scheme === 'light' ? '' : '-dark';
      await page.goto(`${stack.webUrl}/login`);
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      await page.screenshot({ path: `${out}/shell-login-${name}${suffix}.png` });
      await signIn(page, stack.webUrl, owner, code);
      await page.screenshot({ path: `${out}/shell-${name}${suffix}.png` });
      await page.goto(`${stack.webUrl}/${name === 'mobile' ? 'more' : 'account'}`);
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.screenshot({ path: `${out}/shell-${name === 'mobile' ? 'more' : 'account'}-${name}${suffix}.png` });
      await ctx.close();
    }
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
