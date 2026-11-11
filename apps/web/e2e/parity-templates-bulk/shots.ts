// Screenshots of the module 64 surfaces against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1, light and dark: the composer's template sheet, the template library,
// the bulk confirm sheet with its skip counts, a finished bulk action, and the batch-text settings page.
// Run: pnpm --filter @realty/web exec tsx e2e/parity-templates-bulk/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startBulkStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/parity-templates-bulk';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

const stack = await startBulkStack();
let browser: Browser | undefined;
try {
  const w = await stack.fixture<{ email: string; password: string; ownerEmail: string }>('/world');
  const jane = await stack.fixture<{ id: string }>('/contact', { firstName: 'Jane', lastName: 'Doe' });
  await stack.fixture('/template', { team: true, channel: 'sms', name: 'Showing follow-up', body: 'Hi {{contact.first_name}}, how was the showing today?' });
  await stack.fixture('/template', { channel: 'sms', name: 'Running late', body: 'Running 10 minutes late, sorry!' });
  await stack.fixture('/template', { team: true, channel: 'email', name: 'New listings', subject: 'New homes for {{contact.first_name}}', body: 'Hi {{contact.first_name}}, three new listings this week near you.' });
  const people = [
    await stack.fixture<{ id: string }>('/contact', { firstName: 'Ana' }),
    await stack.fixture<{ id: string }>('/contact', { firstName: 'Ben' }),
    await stack.fixture<{ id: string }>('/contact', { firstName: 'Cy', unsubscribed: true }),
    await stack.fixture<{ id: string }>('/contact', { firstName: 'Dee', noEmail: true }),
  ];
  const ids = people.map((p) => p.id).join(',');
  browser = await chromium.launch();
  const signIn = async (page: Page, email: string) => {
    await page.goto(`${stack.webUrl}/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(w.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const code = (await stack.fixture<{ code: string | null }>('/totp', { email })).code;
    if (code) {
      await page.getByLabel('Code').fill(code);
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
  };
  let finished: string | null = null;
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      const sfx = `${name}${scheme === 'light' ? '' : '-dark'}`;
      await signIn(page, w.email);
      await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread?compose=sms`);
      await page.getByRole('button', { name: 'Templates' }).click();
      await page.getByRole('dialog', { name: 'Text templates' }).getByRole('button', { name: /Showing follow-up/ }).waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/picker-${sfx}.png` });
      await page.getByRole('dialog').getByRole('button', { name: /Showing follow-up/ }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/composer-inserted-${sfx}.png` });
      await page.goto(`${stack.webUrl}/templates`);
      await page.getByRole('heading', { level: 2, name: 'Team templates' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/library-${sfx}.png`, fullPage: true });
      await page.goto(`${stack.webUrl}/bulk/new?kind=email&contacts=${ids}`);
      await page.getByRole('dialog').getByRole('button', { name: /New listings/ }).click();
      await page.getByRole('dialog', { name: 'Email 2 of 4?' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/bulk-confirm-${sfx}.png` });
      if (finished === null) {
        await page.getByRole('button', { name: 'Email 2 people' }).click();
        await page.waitForURL(/\/bulk\/[0-9a-f-]{36}$/);
        finished = new URL(page.url()).pathname.split('/').at(-1)!;
        await stack.fixture('/run', { actionId: finished });
      }
      await page.goto(`${stack.webUrl}/bulk/${finished}`);
      await page.getByRole('heading', { name: 'Emailed 2 of 4' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/bulk-done-${sfx}.png` });
      await ctx.close();
      const octx = await browser.newContext({ ...opts, colorScheme: scheme });
      const op = await octx.newPage();
      await signIn(op, w.ownerEmail);
      await op.goto(`${stack.webUrl}/settings/batch-text`);
      await op.getByRole('heading', { level: 2, name: 'Read this first' }).waitFor();
      await op.waitForTimeout(300);
      await op.screenshot({ path: `${out}/batch-text-${sfx}.png`, fullPage: true });
      await octx.close();
    }
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
