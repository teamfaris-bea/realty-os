// Screenshots of the agent surfaces against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1, light and dark. The data is a seeded agent day (an offer, a
// client who texted, an assistant draft, a task, a consult awaiting its outcome, a deal, a listing).
// Run: pnpm --filter @realty/web exec tsx e2e/agent/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startAgentStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/web';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

async function signIn(page: Page, webUrl: string, email: string, password: string) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

const stack = await startAgentStack();
let browser: Browser | undefined;
try {
  const agent = await stack.fixture<{ email: string; password: string }>('/world');
  const jane = await stack.fixture<{ id: string }>('/contact', { firstName: 'Jane', lastName: 'Doe', inbound: 'Does Saturday work for a showing? We are pre-approved.' });
  const marco = await stack.fixture<{ id: string }>('/contact', { firstName: 'Marco', lastName: 'Silva', intent: 'seller' });
  await stack.fixture('/draft', { contactId: jane.id });
  await stack.fixture('/task', { title: 'Send Marco the pricing comps', contactId: marco.id, inMs: 2 * 3_600_000 });
  await stack.fixture('/appointment', { contactId: marco.id });
  await stack.fixture('/deal', { contactId: jane.id });
  await stack.fixture('/listing');
  const offer = await stack.fixture<{ id: string; state: string }>('/offer', { name: 'Priya Shah' });
  console.log(`offer state: ${offer.state}`);
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, opts] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      const suffix = scheme === 'light' ? '' : '-dark';
      await signIn(page, stack.webUrl, agent.email, agent.password);
      await page.getByRole('heading', { level: 2 }).first().waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/agent-${name}${suffix}.png` });
      for (const [slug, path, ready] of [
        ['approvals', '/approvals', 'Approvals'],
        ['contact', `/contacts/${jane.id}`, 'Jane Doe'],
        ['thread', `/contacts/${jane.id}/thread?compose=sms`, 'Jane Doe'],
        ['tasks', '/tasks', 'Tasks'],
        ['search', '/search?q=jane', 'Search'],
      ] as const) {
        await page.goto(`${stack.webUrl}${path}`);
        await page.getByRole('heading', { level: 1, name: ready }).waitFor();
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${out}/agent-${slug}-${name}${suffix}.png`, fullPage: name === 'desktop' });
      }
      await ctx.close();
    }
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
