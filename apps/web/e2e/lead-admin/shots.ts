// Screenshots of the lead-admin surfaces against the real stack (stack.ts), phone 390×844 and desktop
// 1440×900 at deviceScaleFactor 1. The data is a seeded team: a Team Lead leading two agents, two
// leads whose first-touch deadline passed, an overdue promise and a consult with no outcome.
//   lead-admin-{desktop,mobile}.png          the Team Lead's exception queue
//   lead-admin-<page>-{desktop,mobile}.png   the Owner's admin pages
// Run: pnpm --filter @realty/web exec tsx e2e/lead-admin/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type World, startLeadAdminStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/web';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const;

const stack = await startLeadAdminStack();

async function signIn(page: Page, email: string, password: string, totpSecret?: string) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (totpSecret) {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email, secret: totpSecret });
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
}

let browser: Browser | undefined;
try {
  const w = await stack.fixture<World>('/world');
  await stack.fixture('/exceptions', { names: ['Priya Shah', 'Marcus Lee'] });
  await stack.fixture('/admin');
  browser = await chromium.launch();
  for (const [name, opts] of Object.entries(VIEWPORTS)) {
    // the Team Lead's queue
    const tl = await browser.newContext(opts);
    const page = await tl.newPage();
    await signIn(page, w.teamLead.email, w.teamLead.password);
    await page.goto(`${stack.webUrl}/team`);
    await page.getByRole('heading', { level: 1, name: 'Needs attention' }).waitFor();
    await page.getByRole('heading', { level: 2, name: /Untouched lead/ }).first().waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/lead-admin-${name}.png`, fullPage: name === 'desktop' });
    await page.goto(`${stack.webUrl}/team/scoreboard`);
    await page.getByRole('heading', { level: 2, name: 'Scoreboard' }).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/lead-admin-scoreboard-${name}.png`, fullPage: name === 'desktop' });
    await tl.close();

    // the Owner's admin pages
    const ow = await browser.newContext(opts);
    const op = await ow.newPage();
    await signIn(op, w.owner.email, w.owner.password, w.owner.totpSecret);
    for (const [slug, path, ready] of [
      ['members', '/admin/members', 'Members'],
      ['routing', '/admin/routing', 'Lead routing'],
      ['numbers', '/admin/numbers', 'Phone and email'],
      ['compliance', '/settings/compliance', 'Compliance'],
      ['brokerage', '/settings/team', 'Brokerage and team'],
      ['playbooks', '/settings/playbooks', 'Playbooks'],
    ] as const) {
      await op.goto(`${stack.webUrl}${path}`);
      await op.getByRole('heading', { level: 1, name: ready }).waitFor();
      await op.waitForTimeout(700);
      await op.screenshot({ path: `${out}/lead-admin-${slug}-${name}.png`, fullPage: name === 'desktop' });
    }
    await ow.close();
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
