// web/agent against the REAL API (stack.ts: api/platform's harness on a fresh per-test Postgres
// database, RLS-bound app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px)
// projects. Every FUB-benchmark job of ARCHITECTURE §1 an agent does is run with its taps counted:
//   see what's due 0 · accept an offer 1 · call 1 (+1 outcome chip) · text with the assistant's draft 2
//   · approve a draft 1 · log an appointment outcome ≤ 2 · find a contact by type-ahead.
// Then axe-core (color contrast included) in light and dark, no horizontal scroll on a phone, and
// 44 px tap targets on every agent page.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type AgentStack, startAgentStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };
let jane: { id: string; name: string };
let marco: { id: string; name: string };
let lena: { id: string; name: string };
let omar: { id: string; name: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
  jane = await stack.fixture('/contact', { firstName: 'Jane', lastName: 'Doe', inbound: 'Does Saturday work for a showing?' });
  await stack.fixture('/draft', { contactId: jane.id });
  lena = await stack.fixture('/contact', { firstName: 'Lena', lastName: 'Park', inbound: 'Can you send me the HOA docs?' });
  await stack.fixture('/draft', { contactId: lena.id });
  marco = await stack.fixture('/contact', { firstName: 'Marco', lastName: 'Silva', intent: 'seller' });
  await stack.fixture('/appointment', { contactId: marco.id });
  await stack.fixture('/deal', { contactId: jane.id });
  await stack.fixture('/listing');
  // a contact who texted STOP through the real inbound webhook: the one block nobody can override
  omar = await stack.fixture('/contact', { firstName: 'Omar', lastName: 'Reyes', inbound: 'Thanks for the info', optOut: true });
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** One counted tap (a real touch tap on the phone project, a click on desktop). */
async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

function feedCard(page: Page, name: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name }) }).first();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test('an agent’s day: every benchmark job within its tap target', async ({ page }) => {
  test.setTimeout(180_000);
  const offer = await stack.fixture<{ id: string; state: string }>('/offer', { name: 'Priya Shah' });
  expect(offer.state).toBe('offered');
  await signIn(page);

  // see what's due: 0 taps. The pinned band is first, with a live countdown.
  const due = page.getByRole('heading', { level: 2, name: 'Due now' });
  await expect(due).toBeVisible();
  const priya = feedCard(page, 'Priya Shah');
  const timer = priya.getByRole('timer');
  await expect(timer).toHaveText(/^[0-5]:\d\d left$/);
  const before = await timer.textContent();
  await expect.poll(async () => timer.textContent(), { timeout: 3000 }).not.toBe(before);

  // accept: 1 tap from the feed card
  const accept = { taps: 0 };
  await tap(page, priya.getByRole('button', { name: 'Accept' }), accept);
  await expect(page.getByText('Priya Shah is yours now.')).toBeVisible();
  expect(accept.taps).toBe(1);

  // a new portal lead can be called straight away: no consent entry, no registry scrub, no contact
  // window (owner decision: leads consent through their source; only opt-outs block). There is no
  // "call anyway" anywhere.
  const priyaNow = feedCard(page, 'Priya Shah');
  await expect(priyaNow.getByRole('button', { name: 'Call' })).toBeVisible({ timeout: 15_000 });
  await priyaNow.getByRole('button', { name: 'Call' }).click();
  const priyaCall = page.getByRole('dialog', { name: 'Call Priya Shah' });
  await expect(priyaCall.getByText("Your phone will ring first. Answer it and you're connected to Priya.")).toBeVisible({ timeout: 15_000 });
  await expect(priyaCall.getByRole('button', { name: 'Call anyway' })).toHaveCount(0);
  await priyaCall.getByRole('button', { name: 'No answer' }).click();
  await expect(page.getByText(/Call outcome saved\.|saved as a task for the new owner/)).toBeVisible();

  // text a lead: Text → the assistant's draft is prefilled → Send = 2 taps
  const text = { taps: 0 };
  const janeCard = feedCard(page, 'Jane Doe');
  await tap(page, janeCard.getByRole('button', { name: 'Text' }), text);
  const box = page.getByRole('textbox', { name: 'Text message' });
  await expect(box).not.toHaveValue('', { timeout: 15_000 });
  await expect(page.getByText('Drafted by the assistant.')).toBeVisible();
  await tap(page, page.getByRole('button', { name: 'Send' }), text);
  await expect(page.getByText(/^(Sent to Jane\.|Sending to Jane\.|Sends .+)$/)).toBeVisible({ timeout: 15_000 });
  expect(text.taps).toBe(2);

  // approve an assistant draft: 1 tap on its card (Approvals is a tab / sidebar entry away)
  if (isPhone(page)) await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'Approvals' }).tap();
  else await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
  const lenaCard = page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: 'Lena Park' }) }).first();
  await expect(lenaCard.getByText(/the text/).first()).toBeVisible(); // evidence: a quote with its source
  const approve = { taps: 0 };
  await tap(page, lenaCard.getByRole('button', { name: 'Send' }), approve);
  await expect(page.getByText(/^(Sent to Lena Park\.|Marked as reviewed\.)$|Scheduled|Not sent/)).toBeVisible({ timeout: 15_000 });
  expect(approve.taps).toBe(1);
  expect(await page.locator('body').textContent()).not.toMatch(/confiden|\d+\s?%/i);

  // log an appointment outcome: the card's Log outcome, then an outcome chip (≤ 2 taps)
  await page.goto(`${stack.webUrl}/`);
  const marcoCard = feedCard(page, 'Marco Silva');
  const appt = { taps: 0 };
  await tap(page, marcoCard.getByRole('button', { name: 'Log outcome' }), appt);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: 'Follow up' }), appt);
  await expect(page.getByText('Outcome saved.')).toBeVisible();
  expect(appt.taps).toBeLessThanOrEqual(2);

  // call: from the contact, 1 tap (dial-time gate on the server); the post-call outcome is 1 chip
  await page.goto(`${stack.webUrl}/contacts/${marco.id}`);
  const callTaps = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Call', exact: true }), callTaps);
  const sheet = page.getByRole('dialog', { name: 'Call Marco Silva' });
  await expect(sheet.getByText("Your phone will ring first. Answer it and you're connected to Marco.")).toBeVisible();
  expect(callTaps.taps).toBe(1);
  const outcome = { taps: 0 };
  await tap(page, sheet.getByRole('button', { name: 'No answer' }), outcome);
  await expect(page.getByText(/Call outcome saved\.|saved as a task for the new owner/)).toBeVisible();
  expect(outcome.taps).toBe(1);

  // an opt-out is said plainly where the buttons are, before any tap, and the action is disabled
  // (optout.spec.ts covers the exact sentences, the thread and held messages)
  await page.goto(`${stack.webUrl}/contacts/${omar.id}`);
  await expect(page.getByText(/^Texted STOP on /)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await page.goto(`${stack.webUrl}/contacts/${omar.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Still interested?');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /anyway/ })).toHaveCount(0);

  // find a contact: Search (1 tap) then type-ahead
  if (isPhone(page)) await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'Search' }).tap();
  else await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).click();
  const q = page.getByRole('searchbox');
  await q.fill('Marc');
  const t0 = Date.now();
  await expect(page.getByRole('link', { name: /Marco Silva/ })).toBeVisible();
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: 'type-ahead ms (dev server, includes 150 ms debounce)', description: String(ms) });
  expect(ms).toBeLessThan(2000);
});

const PAGES = (ids: { jane: string }) => [
  ['/', 'Home'],
  ['/approvals', 'Approvals'],
  [`/contacts/${ids.jane}`, 'Jane Doe'],
  [`/contacts/${ids.jane}/thread`, 'Jane Doe'],
  ['/tasks', 'Tasks'],
  ['/search?q=jane', 'Search'],
  ['/pond', 'Pond'],
  ['/deals', 'Deals'],
  ['/listings', 'Listings'],
] as const;

test('agent pages: axe (incl. contrast) in light and dark, no horizontal scroll on a phone, 44 px tap targets', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, h1] of PAGES({ jane: jane.id })) {
      await page.goto(`${stack.webUrl}${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page), `${scheme} ${path}`).toEqual([]);
      if (isPhone(page)) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal scroll on ${path}`).toBeLessThanOrEqual(0);
      }
      const small = await page.locator('main button:visible, main a[href]:visible').evaluateAll((els) =>
        els
          .filter((e) => !e.closest('p, li > span, [aria-label="Evidence"], blockquote'))
          .map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height }))
          .filter((x) => x.h > 0 && x.h < 44),
      );
      expect(small, `${scheme} ${path} tap targets`).toEqual([]);
    }
  }
});
