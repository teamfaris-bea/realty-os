// The Phase 3 staff screens against the REAL API (stack.ts), on the phone (iPhone 13) and desktop (1440×900) projects
// (module 55; R-STAFF-1..10). Every pack starts dark and `/reset` withdraws every platform pack after each test, so
// each test clears only what its job needs. The tap table (BRIEF "Tap budget"): reach the job's screen within 2 taps
// from the home tabs (phone: More → the page; desktop: the sidebar, 1 click) and do the job within 2 taps there.
// Typing, the re-auth password and the file picker are not taps.
//   - AI call answering: dark state in words, no Turn on; the test call says no call was placed; with the voice pack
//     cleared the Owner turns it on (Turn on → I confirm, re-auth through the shell) and off (Turn off → Turn off);
//     an Admin cannot widen timing (E660, E661); a TC opening it by URL gets "Not available" and no /voice request (E671).
//   - Voice handback: a real AI-answered booking call's card on the agent's Approvals, "The assistant answered a call"
//     and "From the call record", never a raw value, one-tap Send of the confirmation draft (R-STAFF-9, E662, E664).
//   - Google Ads: dark page says the server's sentence with no Approve or Resume (E667); the Admin has the card; the
//     Owner approves in Approvals → Approve and reads the outcome in words, every total against its ceiling; an agent
//     has no card and the browser never requests /ads (R-STAFF-6, E671).
//   - Documents: the TC uploads a contract (1 tap + the picker) through the Vite /api proxy with x-csrf-token, the
//     worker scans and reads it, Review dates → Confirm on one claim; a photo says "Enter the dates by hand"; a
//     10,000,001-byte PDF is refused in words before any request (E672) and one just under 10 MB goes through; the
//     deal's agent marks the contract for the client portal (document → Mark), the API's sentence shown (R-STAFF-10).
//   - Google Business Profile: dark, the status sentence without the pack key and no review request (E678); cleared,
//     the Owner drafts with the assistant on /gbp and posts it from Approvals → Post reply.
//   - Likely to move: More → Likely to move as the agent; the back-test sentence and the contact; after the model is
//     withdrawn, the no_model sentence (E677).
//   - Coaching trends: More → Coaching trends; scoring off says the state sentence (E679).
// Every page visited: axe finds nothing; on phone no sideways scroll (and the phone checks of the a11y sweep); no "%"
// on Likely or Trends; no raw code anywhere.
import { createRequire } from 'node:module';
import { type Locator, type Page, type Request, expect, test } from 'playwright/test';
import { phoneProblems } from '../a11y/checks.js';
import { type People, type StaffStack, startStaffStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

/** BRIEF: no rendered text may match a raw code, pack key, edge id or ISO time. */
const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;

test.describe.configure({ mode: 'serial' });

let stack: StaffStack;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startStaffStack();
});
test.afterAll(async () => {
  await stack?.stop();
});
test.afterEach(async () => {
  await stack.fixture('/reset');
});

/** The page's own content: not the announcer, which repeats a sentence for screen readers. */
const main = (page: Page) => page.locator('main');
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email })).code;
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 20_000 });
}

/** A More page from Home: phone More → the entry (2 taps), desktop the sidebar (1 click). */
async function openFromHome(page: Page, label: string, title: string): Promise<number> {
  const n = { taps: 0 };
  if (isPhone(page)) {
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }), n);
    await tap(page, page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: label, exact: true }), n);
    expect(n.taps).toBe(2);
  } else {
    await tap(page, page.getByRole('navigation').getByRole('link', { name: label, exact: true }), n);
    expect(n.taps).toBe(1);
  }
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });
  return n.taps;
}

/** Approvals is a home tab on the phone and a sidebar entry on desktop: 1 tap either way. */
async function openApprovals(page: Page, n: { taps: number }) {
  const nav = isPhone(page) ? page.getByRole('navigation', { name: 'Main tabs' }) : page.getByRole('navigation');
  await tap(page, nav.getByRole('link', { name: /^Approvals/ }).first(), n);
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Every page visited: no raw code in the text, axe clean, and on the phone no sideways scroll (plus the sweep's checks). */
async function pageChecks(page: Page, o: { noPercent?: boolean } = {}) {
  await page.waitForLoadState('networkidle');
  const text = (await page.locator('main').innerText()) ?? '';
  expect(text).not.toMatch(RAW);
  if (o.noPercent) expect(text).not.toMatch(/%|percent/i);
  if (isPhone(page)) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await phoneProblems(page)).toEqual([]);
  }
  expect(await axeViolations(page)).toEqual([]);
}

/** Every API request whose path matches `re` from now on (only writes with `writes`), as "METHOD /path". */
function watch(page: Page, re: RegExp, o: { writes?: boolean } = {}): string[] {
  const seen: string[] = [];
  page.on('request', (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (o.writes && r.method() === 'GET') return;
    if (re.test(path)) seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

/** When the shell asks to confirm it's you: the password (and the authenticator code), typed; not a tap. */
async function reauthIfAsked(page: Page, email: string, password: string): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  const asked = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (!asked) return false;
  await dialog.getByLabel('Password').fill(password);
  const code = dialog.getByLabel('Authenticator code');
  if (await code.count()) await code.fill((await stack.fixture<{ code: string | null }>('/totp', { email })).code ?? '');
  await dialog.getByLabel('Password').press('Enter');
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  return true;
}

// ---- AI call answering --------------------------------------------------------------------------------------------

test.describe('AI call answering', () => {
  let v: People & { admin: string; tc: string };
  test.beforeAll(async () => {
    v = await stack.fixture('/voice');
  });

  test('R-STAFF-1 E660: dark, the state and reasons are in words, no Turn on; the test call says no call was placed', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, v.owner, v.password);
    await openFromHome(page, 'AI call answering', 'AI call answering');
    await expect(main(page).getByText('AI answering is not available on this deployment yet.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'What keeps it off' })).toBeVisible();
    const shown = (await page.locator('main').innerText()) ?? '';
    expect(shown).not.toContain('platform:');
    expect(shown).not.toContain('(N12)');
    await expect(page.getByRole('button', { name: 'Turn on AI answering' })).toHaveCount(0);
    await pageChecks(page);
    const n = { taps: 0 };
    await tap(page, page.getByRole('button', { name: 'Run' }), n);
    const result = page.getByTestId('test-call-result');
    await expect(result.getByText('Simulation with a scripted caller. No call was placed and nothing was saved.')).toBeVisible({ timeout: 15_000 });
    // E664: the booking simulation notes that a real call's confirmation is a draft
    await expect(result.getByText('In a real call the confirmation is a draft your agent sends with one tap.')).toBeVisible();
    expect(n.taps).toBe(1);
    await pageChecks(page);
  });

  test('R-STAFF-4: cleared, the Owner turns AI answering on (Turn on → I confirm, re-auth by the shell) and off (2 taps each)', async ({ page }) => {
    test.setTimeout(180_000);
    await stack.fixture('/packs', { voice: true });
    await signIn(page, v.owner, v.password);
    await openFromHome(page, 'AI call answering', 'AI call answering');
    await expect(main(page).getByText('AI answering is off.', { exact: true })).toBeVisible();
    await expect(main(page).getByText('The Owner has not turned AI answering on.')).toBeVisible();
    await pageChecks(page);
    // as 15 minutes after sign-in: turning it on is a loosening change, so the shell asks for the password
    await stack.fixture('/reauth/expire', { email: v.owner });
    const on = { taps: 0 };
    await tap(page, page.getByRole('button', { name: 'Turn on AI answering' }), on);
    const dialog = page.getByRole('dialog', { name: 'Turn on AI answering' });
    await expect(dialog.locator('blockquote')).not.toBeEmpty();
    expect(await axeViolations(page)).toEqual([]);
    await tap(page, dialog.getByRole('button', { name: 'I confirm and turn on' }), on);
    expect(await reauthIfAsked(page, v.owner, v.password)).toBe(true);
    await expect(main(page).getByText('AI answering is on.', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(on.taps).toBe(2);
    await pageChecks(page);
    const off = { taps: 0 };
    await tap(page, page.getByRole('button', { name: 'Turn off AI answering' }), off);
    await tap(page, page.getByRole('dialog', { name: 'Turn off AI answering?' }).getByRole('button', { name: 'Turn off', exact: true }), off);
    await reauthIfAsked(page, v.owner, v.password);
    await expect(main(page).getByText('AI answering is off.', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(off.taps).toBe(2);
  });

  test('R-STAFF-4 E661: an Admin cannot make it answer sooner: Save stays off with the Owner-only reason', async ({ page }) => {
    test.setTimeout(120_000);
    await stack.fixture('/packs', { voice: true });
    await signIn(page, v.admin, v.password);
    await openFromHome(page, 'AI call answering', 'AI call answering');
    await expect(main(page).getByText('Only the Owner can turn AI answering on.')).toBeVisible();
    const after = page.getByLabel('Answer a missed call');
    const values = await after.locator('option').evaluateAll((os) => os.map((o) => Number((o as HTMLOptionElement).value)));
    const current = Number(await after.inputValue());
    const sooner = Math.min(...values);
    expect(sooner).toBeLessThan(current);
    await after.selectOption(String(sooner));
    await expect(main(page).getByText('Only the Owner can make AI answer sooner or in more hours.')).toBeVisible();
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await expect(save).toHaveAccessibleDescription('Only the Owner can make AI answer sooner or in more hours.');
    await pageChecks(page);
  });

  test('R-STAFF-6 E671: a TC who types the address gets "Not available" and no /voice request', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, v.tc, v.password);
    const seen = watch(page, /^\/api\/voice\b/);
    await page.goto(`${stack.webUrl}/admin/ai-answering`);
    await expect(page.getByRole('heading', { level: 1, name: 'Not available' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual([]);
  });

  test('R-STAFF-9 E662 E664: the booking call’s handback card on the agent’s Approvals, worded, Send in one tap', async ({ page }) => {
    test.setTimeout(180_000);
    const call = await stack.fixture<{ callId: string; contactId: string }>('/voice/call', { script: 'booking' });
    await signIn(page, v.agent, v.password);
    const n = { taps: 0 };
    await openApprovals(page, n);
    const card = page.getByRole('article').filter({ has: page.getByText('The assistant answered a call', { exact: true }) });
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.getByText('From the call record').first()).toBeVisible();
    const words = (await card.innerText()) ?? '';
    expect(words).not.toMatch(RAW);
    expect(words).not.toContain(call.callId);
    // what the assistant did, from the call's own read: in words, nothing the caller said
    await card.getByRole('button', { name: 'What the assistant did' }).click();
    await expect(card.getByText("Nothing the caller said is shown here; their words are kept only in the call's encrypted transcript.")).toBeVisible({ timeout: 15_000 });
    expect((await card.innerText()) ?? '').not.toMatch(RAW);
    await pageChecks(page);
    // the confirmation draft keeps its one-tap Send (the existing approve); without a draft, Mark handled
    const send = card.getByRole('button', { name: 'Send', exact: true });
    if (await send.count()) {
      console.log(`[${test.info().project.name}] handback: the booking left a confirmation draft: Send`);
      const approved = page.waitForResponse((r) => /^\/api\/assistant\/actions\/[^/]+\/approve$/.test(new URL(r.url()).pathname));
      await tap(page, send, n);
      expect((await approved).status()).toBe(200);
      await expect(page.getByTestId('announcer')).toHaveText(/^Sent to .+\.$/);
      await expect(card).toHaveCount(0, { timeout: 15_000 });
    } else {
      console.log(`[${test.info().project.name}] handback: no confirmation draft: Mark handled`);
      await tap(page, card.getByRole('button', { name: 'Mark handled' }), n);
      await expect(card).toHaveCount(0, { timeout: 15_000 });
    }
    expect(n.taps).toBe(2);
  });
});

// ---- Google Ads ---------------------------------------------------------------------------------------------------

test.describe('Google Ads', () => {
  let a: People & { admin: string; teamLead: string; actionId: string };
  test.beforeAll(async () => {
    a = await stack.fixture('/ads');
  });
  const adsRead = /^\/api\/ads(\/|$)/;

  test('R-STAFF-1 E667: dark, /ads shows the server’s sentence; stored campaigns read-only; no Approve, no Resume', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, a.owner, a.password);
    const overview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ads' && r.request().method() === 'GET');
    await openFromHome(page, 'Google Ads', 'Google Ads');
    const o = (await (await overview).json()) as { cleared: boolean; stateSentence: string; packSentence: string };
    expect(o.cleared).toBe(false);
    await expect(main(page).getByText(o.stateSentence, { exact: true })).toBeVisible();
    await expect(main(page).getByText(o.packSentence, { exact: true })).toBeVisible();
    await expect(main(page).getByText('Shown as last read. Nothing here can be changed until budget changes are turned on.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await pageChecks(page);
  });

  test('R-STAFF-6: the Admin has this week’s proposal in Approvals with Approve (before the Owner decides it)', async ({ page }) => {
    test.setTimeout(120_000);
    await stack.fixture('/packs', { ads: true });
    await signIn(page, a.admin, a.password);
    await openApprovals(page, { taps: 0 });
    const region = page.getByRole('region', { name: 'Google Ads budget to approve' });
    await expect(region.getByRole('heading', { name: 'Budget proposal' })).toBeVisible({ timeout: 15_000 });
    await expect(region.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await pageChecks(page);
  });

  test('R-STAFF-2 R-STAFF-3 R-STAFF-4: the Owner approves in Approvals → Approve (2) and reads the outcome in words, totals against the ceiling', async ({ page }) => {
    test.setTimeout(180_000);
    await stack.fixture('/packs', { ads: true });
    await signIn(page, a.owner, a.password);
    const decisions = watch(page, /^\/api\/(ads\/proposals|assistant)\//, { writes: true });
    const n = { taps: 0 };
    await openApprovals(page, n);
    const region = page.getByRole('region', { name: 'Google Ads budget to approve' });
    const card = region.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Budget proposal' }) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('proposal-total')).toHaveText(/^Daily budgets total \$[\d,]+\.\d\d \(now \$[\d,]+\.\d\d\) against your \$[\d,]+\.\d\d daily ceiling\.$/);
    await pageChecks(page);
    await tap(page, card.getByRole('button', { name: 'Approve' }), n);
    await reauthIfAsked(page, a.owner, a.password);
    await expect(card.getByText(/^Approved\./).first()).toBeVisible({ timeout: 15_000 });
    const did = card.getByRole('list', { name: 'What Google Ads did' }).getByRole('listitem');
    expect(await did.count()).toBeGreaterThan(0);
    for (const t of await did.allInnerTexts()) expect(t).toMatch(/: \$[\d,]+\.\d\d → \$[\d,]+\.\d\d a day\. (Changed on Google Ads|Waiting for Google Ads to confirm; checked hourly|Not changed: .+)\.$/);
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    expect(n.taps).toBe(2);
    expect(decisions).toEqual([`POST /api/ads/proposals/${a.actionId}/approve`]);
    // the page: month-to-date against the cap, the daily total against the ceiling, and the ledger, in words
    await page.goto(`${stack.webUrl}/ads`);
    await expect(page.getByTestId('month-to-date')).toHaveText(/\$[\d,]+\.\d\d.*\$[\d,]+\.\d\d/);
    await expect(page.getByTestId('daily-total')).toHaveText(/\$[\d,]+\.\d\d.*\$[\d,]+\.\d\d/);
    // Resume is one tap only while cleared and only for a paused campaign; this world's two campaigns are active
    // (nothing pauses them: the cap is far above the spend), so there is no Resume to tap and none is offered.
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await pageChecks(page);
  });

  test('R-STAFF-6 E671: an agent has no ad card, never requests /ads, and gets "Not available" by address', async ({ page }) => {
    test.setTimeout(120_000);
    await stack.fixture('/packs', { ads: true });
    await signIn(page, a.agent, a.password);
    const seen = watch(page, adsRead);
    await openApprovals(page, { taps: 0 });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('region', { name: 'Google Ads budget to approve' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Budget proposal' })).toHaveCount(0);
    await pageChecks(page);
    await page.goto(`${stack.webUrl}/ads`);
    await expect(page.getByRole('heading', { level: 1, name: 'Not available' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual([]);
  });
});

// ---- Documents ----------------------------------------------------------------------------------------------------

const CONTRACT_PAGES = [
  { page: 1, text: 'RESIDENTIAL PURCHASE AGREEMENT (synthetic test form)\nEffective Date: 01/05/2027\nThe Buyer and the Seller agree as follows.' },
  { page: 2, text: 'Appraisal deadline: January 20, 2027' },
  { page: 3, text: 'Closing Date: 2/12/27 or sooner by agreement.\nPossession: at closing.' },
];

let fileSeq = 0;
function pdf(padTo = 0): Buffer {
  const head = `%PDF-1.4\n% synthetic e2e test file ${Date.now()}-${++fileSeq}-${Math.random().toString(36).slice(2)}\n`;
  const tail = '\n%%EOF\n';
  const pad = Math.max(0, padTo - head.length - tail.length);
  return Buffer.concat([Buffer.from(head), Buffer.alloc(pad, 0x20), Buffer.from(tail)]);
}
function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from(`JFIF synthetic ${Date.now()}-${++fileSeq}`), 0xff, 0xd9]);
}

/** "Upload a contract" (1 tap) and the picker (not a tap). */
async function pickContract(page: Page, n: { taps: number }, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await tap(page, page.getByRole('button', { name: 'Upload a contract' }), n);
  await (await chooser).setFiles(file);
}

const isUpload = (dealId: string) => (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/deals/${dealId}/documents`;

test.describe('Documents', () => {
  let d: People & { tc: string; isa: string; dealId: string };
  let contractId = '';
  test.beforeAll(async () => {
    d = await stack.fixture('/docs');
  });

  test('R-STAFF-8 R-STAFF-2 R-STAFF-6: the TC uploads a contract (1 tap + picker) through the /api proxy with x-csrf-token; Review dates → Confirm (2)', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, d.tc, d.password);
    await page.goto(`${stack.webUrl}/deals/${d.dealId}`);
    await expect(page.getByRole('button', { name: 'Upload a contract' })).toBeVisible({ timeout: 15_000 });
    await pageChecks(page);
    const bytes = pdf();
    await stack.fixture('/docs/pages', { base64: bytes.toString('base64'), pages: CONTRACT_PAGES });
    const up = { taps: 0 };
    const req = page.waitForRequest(isUpload(d.dealId));
    const res = page.waitForResponse((r) => isUpload(d.dealId)(r.request()));
    await pickContract(page, up, { name: 'Purchase contract (synthetic).pdf', mimeType: 'application/pdf', buffer: bytes });
    // verify 4: same origin, through Vite's /api proxy, with the CSRF header; multipart with the browser's boundary
    const sent = await req;
    expect(sent.url().startsWith(`${stack.webUrl}/api/`)).toBe(true);
    const headers = await sent.allHeaders();
    expect(headers['x-csrf-token']).toMatch(/\S{16,}/);
    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const r = await res;
    expect(r.status()).toBe(201);
    contractId = ((await r.json()) as { document: { id: string } }).document.id;
    await expect(main(page).getByText('Added Purchase contract (synthetic), version 1.').or(main(page).getByText(/^Added Purchase contract \(synthetic\)(\.pdf)?, version 1\.$/))).toBeVisible();
    expect(up.taps).toBe(1);
    // the worker: the virus check, then the date reading
    const scan = await stack.fixture<{ extract: { result?: string; error?: string } }>('/docs/scan', { documentId: contractId });
    expect(scan.extract.error ?? null).toBeNull();
    await page.reload();
    const n = { taps: 0 };
    await tap(page, page.getByRole('link', { name: /^Review \d+ dates?$/ }).first(), n);
    await expect(page).toHaveURL(new RegExp(`/documents/${contractId}/dates$`));
    const claims = page.getByRole('region', { name: 'Dates found' }).getByRole('article');
    await expect(claims.first()).toBeVisible({ timeout: 15_000 });
    await pageChecks(page);
    const closing = claims.filter({ hasText: 'Closing Date' }).first();
    const one = (await closing.count()) ? closing : claims.filter({ has: page.getByRole('button', { name: 'Confirm' }) }).first();
    const confirms = watch(page, /\/(confirm|reject)$|^\/api\/assistant\//, { writes: true });
    await tap(page, one.getByRole('button', { name: 'Confirm' }), n);
    await expect(one.getByText('Confirmed: on the deal timeline.')).toBeVisible({ timeout: 15_000 });
    expect(n.taps).toBe(2);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatch(new RegExp(`^POST /api/documents/${contractId}/extraction/claims/[^/]+/confirm$`));
    await pageChecks(page);
  });

  test('R-STAFF-1: a photo of a contract says "Enter the dates by hand"', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, d.tc, d.password);
    await page.goto(`${stack.webUrl}/deals/${d.dealId}`);
    const res = page.waitForResponse((r) => isUpload(d.dealId)(r.request()));
    await pickContract(page, { taps: 0 }, { name: 'Contract photo (synthetic).jpg', mimeType: 'image/jpeg', buffer: jpeg() });
    const r = await res;
    expect(r.status()).toBe(201);
    const photoId = ((await r.json()) as { document: { id: string } }).document.id;
    await stack.fixture('/docs/scan', { documentId: photoId });
    await page.goto(`${stack.webUrl}/documents/${photoId}/dates`);
    await expect(main(page).getByText(/Enter the dates by hand/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await pageChecks(page);
  });

  test('R-STAFF-8 E672: a 10,000,001-byte PDF is refused in words before any request; one just under 10 MB goes through the proxy', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, d.tc, d.password);
    await page.goto(`${stack.webUrl}/deals/${d.dealId}`);
    await expect(page.getByRole('button', { name: 'Upload a contract' })).toBeVisible({ timeout: 15_000 });
    const seen = watch(page, /\/documents$/);
    await pickContract(page, { taps: 0 }, { name: 'Too big (synthetic).pdf', mimeType: 'application/pdf', buffer: pdf(10_000_001) });
    await expect(main(page).getByText('This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(seen.filter((s) => s.startsWith('POST'))).toEqual([]);
    const big = pdf(9_999_000);
    expect(big.length).toBe(9_999_000);
    const req = page.waitForRequest(isUpload(d.dealId));
    const res = page.waitForResponse((r) => isUpload(d.dealId)(r.request()), { timeout: 120_000 });
    await pickContract(page, { taps: 0 }, { name: 'Large contract (synthetic).pdf', mimeType: 'application/pdf', buffer: big });
    const sent = await req;
    expect(sent.url().startsWith(`${stack.webUrl}/api/`)).toBe(true);
    expect((await sent.allHeaders())['x-csrf-token']).toMatch(/\S{16,}/);
    expect((await res).status()).toBe(201);
    await expect(main(page).getByText(/^Added Large contract \(synthetic\)(\.pdf)?, version 1\.$/)).toBeVisible();
  });

  test('R-STAFF-10: the deal’s agent marks the contract for the client portal (document → Mark, 2 taps); the API’s sentence says clients see nothing yet', async ({ page }) => {
    test.setTimeout(120_000);
    expect(contractId).not.toBe('');
    await signIn(page, d.agent, d.password);
    await page.goto(`${stack.webUrl}/deals/${d.dealId}`);
    const n = { taps: 0 };
    await tap(page, page.getByRole('list', { name: 'Documents' }).getByRole('link', { name: /^Purchase contract \(synthetic\)/ }), n);
    await expect(page).toHaveURL(new RegExp(`/documents/${contractId}$`));
    await expect(main(page).getByText('Not marked for the client portal.')).toBeVisible({ timeout: 15_000 });
    await pageChecks(page);
    const shares = watch(page, /\/share$|^\/api\/portal|^\/p\//);
    // platform:portal is not cleared: marking is still allowed and the API says plainly that clients see nothing
    await tap(page, page.getByRole('button', { name: 'Mark for the client portal' }), n);
    await expect(main(page).getByText('Marked for the client portal. Clients see nothing until the portal is turned on.').first()).toBeVisible({ timeout: 15_000 });
    expect(n.taps).toBe(2);
    expect(shares).toEqual([`POST /api/documents/${contractId}/share`]);
    await pageChecks(page);
  });
});

// ---- Google Business Profile --------------------------------------------------------------------------------------

test.describe('Google Business Profile', () => {
  let g: People & { admin: string };
  test.beforeAll(async () => {
    g = await stack.fixture('/gbp');
  });

  test('R-STAFF-1 E678: dark, /gbp says the status sentence without the pack key and requests no reviews', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, g.owner, g.password);
    const seen = watch(page, /^\/api\/gbp\/reviews/);
    await openFromHome(page, 'Google reviews', 'Google Business Profile');
    await expect(main(page).getByText('Google Business Profile is off')).toBeVisible({ timeout: 15_000 });
    expect((await page.locator('main').innerText()) ?? '').not.toContain('platform:');
    await expect(page.getByRole('button', { name: /Draft|Post reply/ })).toHaveCount(0);
    await pageChecks(page);
    await openApprovals(page, { taps: 0 });
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual([]);
  });

  test('R-STAFF-2: cleared, the Owner drafts with the assistant on /gbp, then Approvals → Post reply (2)', async ({ page }) => {
    test.setTimeout(180_000);
    // posting a reply also checks the fair-housing pack (PLATFORM_NOT_CLEARED otherwise): both cleared for this job
    await stack.fixture('/packs', { keys: ['platform:gbp', 'platform:fair_housing'], reviewed: true });
    await signIn(page, g.owner, g.password);
    await openFromHome(page, 'Google reviews', 'Google Business Profile');
    const review = page.getByRole('article').filter({ hasText: 'Helpful and patient with every question.' });
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(review.getByText('5 of 5 stars')).toBeVisible();
    await pageChecks(page);
    await review.getByRole('button', { name: 'Draft with the assistant' }).click();
    await expect(review.getByLabel(/Reply drafted by the assistant/)).not.toHaveValue('', { timeout: 30_000 });
    await pageChecks(page);
    const posts = watch(page, /^\/api\/(gbp\/reviews\/[^/]+\/(reply|discard)|assistant\/)/, { writes: true });
    const n = { taps: 0 };
    await openApprovals(page, n);
    const card = page.getByRole('region', { name: 'Review replies to approve' }).getByRole('article');
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.getByText('Reply the assistant drafted')).toBeVisible();
    await pageChecks(page);
    const replied = page.waitForResponse((r) => /^\/api\/gbp\/reviews\/[^/]+\/reply$/.test(new URL(r.url()).pathname));
    await tap(page, card.getByRole('button', { name: 'Post reply' }), n);
    const r = await replied;
    expect(r.status()).toBe(200);
    const out = (await r.json()) as { outcome: string; sentence: string };
    expect(out.outcome).toBe('replied');
    await expect(card.getByText(out.sentence, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Post reply' })).toHaveCount(0, { timeout: 15_000 });
    const said = (await card.innerText()) ?? '';
    expect(said).not.toMatch(RAW);
    expect(n.taps).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^POST \/api\/gbp\/reviews\/[^/]+\/reply$/);
  });
});

// ---- Likely to move and Coaching trends ---------------------------------------------------------------------------

test.describe('Likely to move and Coaching trends', () => {
  test('R-STAFF-7 R-STAFF-3 E677: the agent opens Likely to move (More → 2); the back-test sentence and the contact; withdrawn, the no_model sentence', async ({ page }) => {
    test.setTimeout(180_000);
    const l = await stack.fixture<People & { contactId: string }>('/likely');
    await signIn(page, l.agent, l.password);
    await openFromHome(page, 'Likely to move', 'Likely to move');
    await expect(main(page).getByText(/^Of \d+ .*back-test.*\d+ .*within \d+ days\.$/).first()).toBeVisible({ timeout: 15_000 });
    const contact = page.getByRole('link', { name: /^Pat\b/ });
    await expect(contact).toBeVisible();
    expect(await contact.getAttribute('href')).toBe(`/contacts/${l.contactId}`);
    // the only action is opening the contact
    await expect(page.locator('main').getByRole('button')).toHaveCount(0);
    await pageChecks(page, { noPercent: true });
    await stack.fixture('/reset');
    await page.reload();
    await expect(main(page).getByText('No model is in use')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /^Pat\b/ })).toHaveCount(0);
    expect((await page.locator('main').innerText()) ?? '').not.toMatch(/nobody is likely to move/i);
    await pageChecks(page, { noPercent: true });
  });

  test('R-STAFF-3 E679: Coaching trends (More → 2) with scoring off says the state sentence; no percentage', async ({ page }) => {
    test.setTimeout(120_000);
    const l = await stack.fixture<People>('/likely');
    await signIn(page, l.agent, l.password);
    const trends = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/coaching/trends' && r.request().method() === 'GET');
    await openFromHome(page, 'Coaching trends', 'Coaching trends');
    const body = ((await (await trends).json()) as { trends: { state: string; sentence: string } }).trends;
    expect(body.state).not.toBe('ready');
    await expect(main(page).getByText(body.sentence, { exact: true })).toBeVisible();
    await pageChecks(page, { noPercent: true });
  });
});
