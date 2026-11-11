// Lead-email intake end to end, against the REAL API (stack.ts: api/platform's harness on a fresh per-test
// Postgres database, RLS-bound app_user, fake providers, inbound domain leads.realty-os.invalid), on the
// phone (iPhone 13) and desktop (1440 px) projects. Taps are counted the way the other specs count them
// (one real touch tap on the phone, one click on desktop; typing is not a tap):
//   (a) the Owner opens Lead routing, turns on lead email for the Portal source (re-auth prompt: password
//       + code, then Confirm) and copies the address: leads+<40 hex>@leads.realty-os.invalid;
//   (b) a VERIFIED portal email (From leads@zillow.com, DKIM pass zillow.com) is posted to that address
//       through the signed webhook; the agent accepts the offer on Home; the worker runs the first
//       response: it reached the fake provider EXACTLY ONCE, to the lead's phone, and nothing went to
//       leads@zillow.com;
//   (c) an UNVERIFIED email (DKIM pass for another domain) waits in Needs review: the Team Lead sees the
//       reason sentence, no contact exists for it yet, Accept makes the lead; another one is discarded;
//   (d) the Owner gets a new address: the old one routes nothing from then on.
// Then axe (contrast included) on both pages, no sideways scroll on a phone and 44 px targets.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type LeadEmailStack, type Outbox, type World, startLeadEmailStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const ADDRESS_RE = /^leads\+[0-9a-f]{40}@leads\.realty-os\.invalid$/;

test.describe.configure({ mode: 'serial' });

let stack: LeadEmailStack;
let w: World;
let address = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startLeadEmailStack();
  w = await stack.fixture<World>('/world');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const toast = (page: Page) => page.getByTestId('toast');

/** One counted tap (a real touch tap on the phone project, a click on desktop). */
async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page, who: 'owner' | 'teamLead' | 'agent') {
  const u = w[who];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (who === 'owner') {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email: u.email });
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

/** Home → a page through the navigation: More → page on a phone (2 taps), the sidebar on desktop (1). */
async function navTo(page: Page, label: string, counter: { taps: number }) {
  if (isPhone(page)) {
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }), counter);
    await tap(page, page.getByRole('main').getByRole('link', { name: label }), counter);
  } else await tap(page, page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: label }), counter);
  await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
}

/** The shell's password prompt: typing is not counted; Confirm is one tap. */
async function confirmReauth(page: Page, counter: { taps: number }) {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(w.owner.password);
  const { code } = await stack.fixture<{ code: string | null }>('/totp', { email: w.owner.email });
  if (code) await dialog.getByLabel('Authenticator code').fill(code);
  await tap(page, dialog.getByRole('button', { name: 'Confirm' }), counter);
  await expect(dialog).toHaveCount(0);
}

const intake = (page: Page) => page.getByRole('region', { name: 'Email intake for Portal' });
const addressField = (page: Page) => intake(page).getByRole('textbox', { name: 'Inbound address for Portal' });

function reviewCard(page: Page, subject: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: subject }) });
}

const outbox = () => stack.fixture<Outbox>('/outbox');
const contactsWith = (a: string) => stack.fixture<{ ids: string[]; states: { ownership_state: string; owner_user_id: string | null }[] }>('/contacts-with', { address: a });

test('(a) the Owner turns on lead email for a source (with re-auth) and copies the address', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.webUrl });
  await signIn(page, 'owner');
  const nav = { taps: 0 };
  await navTo(page, 'Lead routing', nav);
  expect(nav.taps).toBe(isPhone(page) ? 2 : 1);

  const box = intake(page);
  await expect(box.getByText(/Only emails DKIM-signed by an allowed domain become leads automatically; everything else waits in/)).toBeVisible();
  // the suggested portals are pre-filled, each marked "suggested" with a Remove control, and one plain sentence
  // says they are unconfirmed until a test lead arrives (the internal VERIFY marker never shows)
  await expect(box.getByText('· Zillow · suggested', { exact: false })).toBeVisible();
  await expect(box.getByText('· Realtor.com · suggested', { exact: false })).toBeVisible();
  await expect(box.getByText('Suggested domains are unconfirmed until a test lead from each portal arrives.')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Remove zillow.com' })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Remove realtor.com' })).toBeVisible();
  expect(await page.locator('body').textContent()).not.toMatch(/VERIFY/);

  // the re-auth window has passed since sign-in: the server asks, the shell prompts once, the same request goes again
  await stack.fixture('/stale-reauth', { email: w.owner.email });
  const enable = { taps: 0 };
  await tap(page, box.getByRole('button', { name: 'Turn on lead email' }), enable);
  await confirmReauth(page, enable);
  await expect(addressField(page)).toHaveValue(ADDRESS_RE, { timeout: 15_000 });
  await expect(addressField(page)).toHaveAttribute('readonly', '');
  expect(enable.taps).toBe(2);

  const copy = { taps: 0 };
  await tap(page, box.getByRole('button', { name: 'Copy the inbound address for Portal' }), copy);
  await expect(box.getByRole('status').filter({ hasText: /^Copied$/ })).toBeVisible();
  expect(copy.taps).toBe(1);
  address = await page.evaluate(() => navigator.clipboard.readText());
  expect(address).toMatch(ADDRESS_RE);
  await expect(addressField(page)).toHaveValue(address);
  test.info().annotations.push({ type: 'taps', description: `enable ${enable.taps} (incl. re-auth Confirm), copy ${copy.taps}, nav ${nav.taps}` });

  // shown again after a reload; the allowlist is what was on the chips
  await page.reload();
  await expect(addressField(page)).toHaveValue(address);
  await expect(intake(page).getByRole('button', { name: 'Remove zillow.com' })).toBeVisible();
  expect(await page.locator('body').textContent()).not.toMatch(/LEAD_EMAIL_|REAUTH_REQUIRED|VERIFY/);
});

test('(b) a verified portal email becomes an offer; the agent accepts it; the first response goes exactly once, to the lead’s phone, never to the portal', async ({ page }) => {
  expect(address).toMatch(ADDRESS_RE);
  const before = await outbox();
  const lead = await stack.fixture<{ outcome: string; phone: string; email: string }>('/email', { to: address, name: 'Dana Field', subject: 'New Zillow lead: 12 Elm St' });
  expect(lead.outcome).toBe('lead_created');
  const [state] = (await contactsWith(lead.email)).states;
  expect(state?.ownership_state).toBe('offered');
  expect((await contactsWith('leads@zillow.com')).ids).toEqual([]);

  await signIn(page, 'agent');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: 'Dana Field' }) }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const accept = { taps: 0 };
  await tap(page, card.getByRole('button', { name: 'Accept' }), accept);
  await expect(toast(page).getByText('Dana Field is yours now.')).toBeVisible();
  expect(accept.taps).toBe(1);
  const after = (await contactsWith(lead.email)).states[0]!;
  expect(after.owner_user_id).toBe(w.agent.userId);

  await stack.fixture('/first-response');
  await stack.fixture('/first-response'); // a second worker pass sends nothing more
  const now = await outbox();
  const sms = now.sms.slice(before.sms.length);
  const emails = now.emails.slice(before.emails.length);
  const toLead = [...sms.filter((m) => m.to === lead.phone), ...emails.filter((m) => m.to.toLowerCase() === lead.email)];
  expect(toLead).toHaveLength(1);
  expect(sms.filter((m) => m.to === lead.phone)).toHaveLength(1);
  expect([...sms.map((m) => m.to), ...emails.map((m) => m.to)].filter((to) => /zillow/i.test(to))).toEqual([]);
  test.info().annotations.push({ type: 'taps', description: `accept offer ${accept.taps}` });
});

test('(c) an unverified email waits in Needs review with its reason; no contact exists until the Team Lead taps Accept; Discard asks first', async ({ page }) => {
  expect(address).toMatch(ADDRESS_RE);
  const subject = 'New Zillow lead: 40 Oak Ave';
  const held = await stack.fixture<{ outcome: string; phone: string; email: string }>('/email', { to: address, name: 'Rae Moss', subject, dkim: [{ domain: 'mailer.example.test', result: 'pass' }] });
  expect(held.outcome).toBe('needs_review');
  const junkSubject = 'Claim your prize';
  const junk = await stack.fixture<{ outcome: string }>('/email', { to: address, name: 'Prize Desk', subject: junkSubject, from: 'Prizes <win@prizes.example.test>', dkim: [{ domain: 'prizes.example.test', result: 'pass' }] });
  expect(junk.outcome).toBe('needs_review');

  await signIn(page, 'teamLead');
  const nav = { taps: 0 };
  await navTo(page, 'Needs review', nav);
  expect(nav.taps).toBe(isPhone(page) ? 2 : 1);
  await expect(page.getByText('2 emails waiting for review')).toBeVisible();
  const card = reviewCard(page, subject);
  await expect(card.getByText(w.holdSentences.DKIM_UNALIGNED!)).toBeVisible();
  await expect(card.getByText(/· Portal · from zillow\.com/)).toBeVisible();
  await expect(card.getByText('Rae Moss', { exact: true })).toBeVisible();
  await expect(card.getByText(held.email, { exact: true })).toBeVisible();
  await expect(reviewCard(page, junkSubject).getByText(w.holdSentences.SENDER_NOT_ALLOWED!)).toBeVisible();
  expect(await page.locator('body').textContent()).not.toMatch(/DKIM_UNALIGNED|SENDER_NOT_ALLOWED|LEAD_EMAIL_|VERIFY/);
  // the email text is there on request
  await card.getByText('Show the email').click();
  await expect(card.getByText(/Message: Can I tour Saturday\?/)).toBeVisible();

  expect((await contactsWith(held.email)).ids).toEqual([]);
  const accept = { taps: 0 };
  await tap(page, card.getByRole('button', { name: `Accept: ${subject}` }), accept);
  const created = page.getByRole('status').filter({ hasText: 'Lead created' }).filter({ has: page.getByRole('link') });
  await expect(created).toBeVisible({ timeout: 15_000 });
  expect(accept.taps).toBe(1);
  const ids = (await contactsWith(held.email)).ids;
  expect(ids).toHaveLength(1);
  await expect(created.getByRole('link', { name: 'Open Rae Moss' })).toHaveAttribute('href', `/contacts/${ids[0]}`);
  await expect(page.getByText('1 email waiting for review')).toBeVisible();

  const discard = { taps: 0 };
  await tap(page, reviewCard(page, junkSubject).getByRole('button', { name: `Discard: ${junkSubject}` }), discard);
  const dialog = page.getByRole('dialog', { name: 'Discard this email?' });
  await tap(page, dialog.getByRole('button', { name: 'Discard email' }), discard);
  await expect(page.getByText('Email discarded. No lead was made.')).toBeVisible();
  expect(discard.taps).toBe(2);
  // nothing left: the empty state says so once (the header line does not repeat it)
  await expect(page.getByText('Nothing needs review')).toBeVisible();
  await expect(page.getByText('No emails are waiting for review.')).toHaveCount(0);

  // Decided lists both
  await page.getByRole('radio', { name: 'Decided' }).click();
  // (the server deletes a decided email's content, so the cards are named by their sender)
  const accepted = reviewCard(page, 'Email from zillow.com');
  await expect(accepted.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(reviewCard(page, 'Email from prizes.example.test').getByText('Discarded', { exact: true })).toBeVisible();
  await expect(page.getByText('The email itself was deleted once it was decided.')).toHaveCount(2);

  // the link opens the new lead
  await accepted.getByRole('link', { name: 'Open the lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Rae Moss' })).toBeVisible({ timeout: 15_000 });
  test.info().annotations.push({ type: 'taps', description: `nav ${nav.taps}, accept held ${accept.taps}, discard ${discard.taps}` });
});

test('(d) the Owner gets a new address after a confirm; the old address routes nothing from then on', async ({ page }) => {
  expect(address).toMatch(ADDRESS_RE);
  await signIn(page, 'owner');
  await page.goto(`${stack.webUrl}/admin/routing`);
  await expect(addressField(page)).toHaveValue(address, { timeout: 15_000 });
  const rotate = { taps: 0 };
  await tap(page, intake(page).getByRole('button', { name: 'Get a new address' }), rotate);
  const dialog = page.getByRole('dialog', { name: 'Get a new address?' });
  await expect(dialog.getByText(/The old address stops working at once/)).toBeVisible();
  await tap(page, dialog.getByRole('button', { name: 'Get a new address now' }), rotate);
  // the session was confirmed at sign-in (within 15 minutes), so no password prompt here
  await expect(intake(page).getByText('New address made. The old one no longer works.')).toBeVisible({ timeout: 15_000 });
  expect(rotate.taps).toBe(2);
  const next = await addressField(page).inputValue();
  expect(next).toMatch(ADDRESS_RE);
  expect(next).not.toBe(address);
  expect((await stack.fixture<{ outcome: string }>('/email', { to: address, name: 'Old Address' })).outcome).toBe('unrouted');
  expect((await stack.fixture<{ outcome: string }>('/email', { to: next, name: 'New Address' })).outcome).toBe('lead_created');
  address = next;
  test.info().annotations.push({ type: 'taps', description: `rotate ${rotate.taps}` });
});

test('Lead routing and Needs review: axe (incl. contrast) in light and dark, no horizontal scroll on a phone, 44 px tap targets', async ({ page }) => {
  test.setTimeout(120_000);
  await stack.fixture('/email', { to: address, name: 'Lee Held', subject: 'Held for the sweep', dkim: [] });
  await signIn(page, 'owner');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, h1] of [
      ['/admin/routing', 'Lead routing'],
      ['/team/lead-email', 'Needs review'],
    ] as const) {
      await page.goto(`${stack.webUrl}${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        const r = await (window as unknown as { axe: { run(n: Node, o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document.body, { resultTypes: ['violations'] });
        return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      });
      expect(violations, `${scheme} ${path}`).toEqual([]);
      if (isPhone(page)) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal scroll on ${path}`).toBeLessThanOrEqual(0);
      }
      const small = await page.locator('main button:visible, main summary:visible, main [role="radio"]:visible').evaluateAll((els) =>
        els.map((e) => ({ t: (e.textContent ?? e.getAttribute('aria-label') ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })).filter((x) => x.h < 44 || x.w < 44),
      );
      expect(small, `${scheme} ${path} tap targets`).toEqual([]);
    }
  }
});
