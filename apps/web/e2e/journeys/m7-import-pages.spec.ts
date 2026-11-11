// M7 — every Imports page state, checked for layout, touch targets, axe and plain words, against the REAL
// API (journeys/stack.ts: a fresh Postgres database, RLS-bound app_user, fake providers, api/imports on
// the deterministic FAKE Follow Up Boss connector), on the phone (iPhone 13, 390×844) and desktop
// (1440×900) projects.
//
// The Owner walks a FUB import whose account has an agent, people assigned to that agent, notes and
// texts, through every state the Imports UI offers:
//   start page → batch page after counting → snapshot in progress → snapshot taken (agent matching,
//   stages/tags/fields) → agent matched and mapping saved → contacts dry run in progress → reconciliation
//   → each review-list tab → a review decision → approved → importing → imported, with the verification
//   (recount + side-by-side) and the report → verified → ownership, notes and texts each dry-run, approved,
//   imported and verified → the last two categories skipped → per-category undo (texts) in progress and
//   done → whole-import undo confirm, in progress, and the undone page.
// At each state:
//   - no sideways scroll (document.documentElement.scrollWidth <= innerWidth);
//   - every visible control is at least 44 × 44 CSS px. CONVENTIONS.md states no touch-target rule of its
//     own, so this follows the repo's rule exactly as tokens.css (--tap: 44px) and e2e/a11y/checks.ts
//     define it: a checkbox or radio input counts its wrapping label, and a link inside running text is
//     exempt (WCAG 2.5.8's inline exception: an inline <a> whose parent holds more text than the link);
//   - axe (@axe-core/playwright, the a11y sweep's tags) finds no serious or critical violation;
//   - the visible words (and the accessible names of visible controls) hold no raw code (STAGE_MAP_INCOMPLETE),
//     no raw enum value (dry_run_ready), and no 'undefined', 'null', 'NaN' or '[object Object]'.
// Key steps are screenshotted with helpers.shot as m7-<step>-<project>.png.
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type TestInfo, expect, test } from 'playwright/test';
import { shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

// child route: a FUB account with an agent, ownership (assignedUserId), notes and texts, under a fresh key
const ROUTES = String.raw`
  async '/fub-load-m7'(b) {
    const key = 'fub-m7-' + randomUUID().slice(0, 12);
    const ph = (n) => '(415) 57' + (n % 10) + '-' + String(1000 + n + b.seed).slice(-4);
    const p = b.prefix;
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: p + 1, created: '2023-01-01T00:00:00Z', firstName: 'Ana', lastName: b.surname, stage: 'Hot Prospect', assignedUserId: 11, tags: ['Buyer'], phones: [{ value: ph(1), type: 'mobile', status: 'Valid' }], customLeadScore: '87' },
        { id: p + 2, created: '2023-01-02T00:00:00Z', firstName: 'Ben', lastName: b.surname, stage: 'Waiting On Lender', assignedUserId: 11, phones: [{ value: b.dupPhone, type: 'mobile', status: 'Valid' }], customLeadScore: '55' },
        { id: p + 3, created: '2023-01-03T00:00:00Z', firstName: 'Cal', lastName: b.surname, stage: 'Waiting On Lender', assignedUserId: 11, tags: ['Investor'], phones: [{ value: ph(3), type: 'mobile', status: 'Valid' }] },
        { id: p + 4, created: '2023-01-04T00:00:00Z', firstName: 'Dee', lastName: b.surname, phones: [{ value: ph(4), type: 'mobile', status: 'Valid' }] },
        { firstName: 'Nobody' },
      ],
      notes: [
        { id: p * 10 + 1, personId: p + 1, subject: 'Call recap', body: 'Wants 3 beds and a yard.', created: '2026-01-15T16:00:00Z', createdById: 11 },
        { id: p * 10 + 2, personId: p + 3, body: 'Investor, cash buyer.', created: '2026-02-01T10:00:00Z', createdById: 11 },
      ],
      textMessages: [
        { id: p * 10 + 1, personId: p + 1, created: '2026-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' },
        { id: p * 10 + 2, personId: p + 1, created: '2026-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 },
      ],
      emails: [],
      calls: [],
    });
    return { key };
  },
`;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({ routes: ROUTES });
  w = await stack.world({ agents: 1 });
});
test.afterAll(async () => {
  await stack?.stop();
});

// ---- the per-state checks ------------------------------------------------------------------------

const MIN_TAP = 44;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=link]';

/** Sideways scroll and touch targets (the rule of tokens.css / e2e/a11y/checks.ts, see the header). */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ CONTROLS, MIN_TAP }) => {
      const out: string[] = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > window.innerWidth) out.push(`scrolls sideways: content is ${doc.scrollWidth}px wide in a ${window.innerWidth}px window`);
      const label = (e: Element) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText ?? e.getAttribute('name') ?? e.tagName).trim().replace(/\s+/g, ' ').slice(0, 50) || e.tagName.toLowerCase();
      const visible = (e: Element) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      for (const e of [...document.querySelectorAll<HTMLElement>(CONTROLS)].filter(visible)) {
        if (e.closest('[aria-hidden="true"], .sr-only')) continue;
        const own = (e.textContent ?? '').trim().length;
        const around = (e.parentElement?.textContent ?? '').trim().length;
        if (e.tagName === 'A' && getComputedStyle(e).display === 'inline' && around > own + 2) continue;
        const target = e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio') ? (e.closest('label') ?? e) : e;
        const r = target.getBoundingClientRect();
        if (Math.round(r.width) < MIN_TAP || Math.round(r.height) < MIN_TAP) out.push(`small tap target "${label(e)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      return [...new Set(out)];
    },
    { CONTROLS, MIN_TAP },
  );
}

/** Raw codes, raw enum values and leaked JS values in what a person sees or hears. */
async function wordProblems(page: Page): Promise<string[]> {
  const texts = await page.evaluate((CONTROLS) => {
    const names = [...document.querySelectorAll<HTMLElement>(CONTROLS)]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => e.getAttribute('aria-label') ?? '')
      .filter(Boolean);
    return [document.body.innerText, ...names];
  }, CONTROLS);
  const out: string[] = [];
  const bad: [RegExp, string][] = [
    [/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, 'raw code'],
    [/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, 'raw enum value'],
    [/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/g, 'leaked value'],
  ];
  for (const t of texts) for (const [re, what] of bad) for (const m of t.matchAll(re)) out.push(`${what} "${m[0]}" in "${t.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40).replace(/\s+/g, ' ')}"`);
  return [...new Set(out)];
}

async function axeProblems(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 120)}`).join(', ')}`);
}

const covered: string[] = [];

/** All four checks at one state; every finding is listed (soft), the test fails at the end if any. */
async function checkState(page: Page, state: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // let lazy sections (parity, report, verification, review list) finish rendering
  await expect(page.getByText(/^(Loading|Recounting)$/)).toHaveCount(0, { timeout: 15_000 });
  const found = { layout: await layoutProblems(page), words: await wordProblems(page), axe: await axeProblems(page) };
  covered.push(state);
  expect.soft(found, `state "${state}"`).toEqual({ layout: [], words: [], axe: [] });
}

// ---- driving the import ---------------------------------------------------------------------------

interface Counts { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number }
interface Stage { category: string; status: string; counts: Counts | null; dryRunSha256: string | null }

const card = (page: Page, label: string): Locator => page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^\\d+\\. ${label}$`) }) });

async function stageOf(batchId: string, category: string): Promise<Stage> {
  const s = await stack.api<{ batch: { stages: Stage[] } }>('a.owner', 'GET', `/imports/${batchId}`);
  return s.body.batch.stages.find((x) => x.category === category)!;
}

async function drainTo(batchId: string, category: string, status: string) {
  await expect.poll(async () => {
    await stack.jobs();
    return (await stageOf(batchId, category)).status;
  }, { timeout: 30_000 }).toBe(status);
}

/** One category, all the way: dry run → approve → import → verify, checking each state. */
async function walkStage(page: Page, info: TestInfo, batchId: string, category: string, label: string, step: string) {
  const c = card(page, label);
  await tap(page, c.getByRole('button', { name: 'Run dry run' }));
  await expect(c.getByText(/Dry run in progress/).first()).toBeVisible({ timeout: 15_000 });
  await drainTo(batchId, category, 'dry_run_ready');
  await page.reload();
  await expect(c.getByRole('button', { name: /^Approve these \d+ records$/ })).toBeEnabled({ timeout: 15_000 });
  await checkState(page, `${label}: dry run ready`);
  await tap(page, c.getByRole('button', { name: /^Approve these \d+ records$/ }));
  await expect(c.getByRole('button', { name: `Import ${label.toLowerCase()}` })).toBeVisible({ timeout: 15_000 });
  await tap(page, c.getByRole('button', { name: `Import ${label.toLowerCase()}` }));
  await expect(c.getByText(/Importing… this page updates on its own/)).toBeVisible({ timeout: 15_000 });
  await drainTo(batchId, category, 'committed');
  await page.reload();
  await verifyStage(page, info, batchId, category, label, step);
}

/** The verification panel: recount, side by side, Same on each, Mark verified. */
async function verifyStage(page: Page, info: TestInfo, batchId: string, category: string, label: string, step: string) {
  const c = card(page, label);
  const panel = c.getByRole('heading', { level: 4, name: `Verify ${label.toLowerCase()}` });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(c.getByText('The recount matches.')).toBeVisible({ timeout: 15_000 });
  await checkState(page, `${label}: imported, verification`);
  await shot(page, info, 'm7', `${step}-verify`);
  const v = await stack.api<{ sample: { sourceRef: string; same: boolean }[] }>('a.owner', 'GET', `/imports/${batchId}/stages/${category}/verification`);
  expect(v.body.sample.every((s) => s.same), 'every sampled record imported as it was').toBe(true);
  for (const s of v.body.sample) await tap(page, c.getByRole('group', { name: `Check ${s.sourceRef}` }).getByRole('button', { name: 'Same' }));
  await tap(page, c.getByRole('button', { name: 'Mark verified' }));
  await expect.poll(async () => (await stageOf(batchId, category)).status, { timeout: 15_000 }).toBe('verified');
  await expect(c.getByText('Verified', { exact: true })).toBeVisible({ timeout: 15_000 });
  await checkState(page, `${label}: verified`);
}

test('M7: every Imports page state of a FUB migration holds up on the screen: no sideways scroll, 44 px targets, axe, plain words', async ({ page }, info) => {
  test.setTimeout(600_000);
  const phone = info.project.name === 'phone';
  const surname = phone ? 'Phonemseven' : 'Deskmseven';
  const { phone: dupPhone } = await stack.fixture<{ phone: string }>('/phone');
  const existing = await stack.api('a.agent0', 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Bianca', lastName: 'Existing', phones: [dupPhone] });
  expect(existing.status).toBe(201);
  const { key } = await stack.fixture<{ key: string }>('/fub-load-m7', { surname, dupPhone, seed: phone ? 30 : 40, prefix: phone ? 7000 : 8000 });

  await signIn(page, stack, w.owner);
  await stack.fixture('/reauth', { as: 'a.owner' });

  // 1. the start page
  await page.goto(`${stack.webUrl}/imports`);
  await expect(page.getByRole('heading', { name: 'Start an import' })).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'start page');
  await shot(page, info, 'm7', '01-start');
  for (const src of ['FUB export file', 'CSV file']) {
    await tap(page, page.getByRole('radio', { name: src }));
    await checkState(page, `start page: ${src}`);
  }
  await tap(page, page.getByRole('radio', { name: 'Follow Up Boss' }));

  // 2. key → count → the batch page
  await page.getByLabel('Follow Up Boss API key').fill(key);
  await tap(page, page.getByRole('button', { name: "Count what's there" }));
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const batchId = page.url().split('/').at(-1)!;
  await expect(page.getByText(/Nothing has been imported/)).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'batch page after counting');
  await shot(page, info, 'm7', '02-counted');

  // 3. the snapshot: in progress, then taken
  await tap(page, page.getByRole('button', { name: 'Take snapshot' }));
  await expect(page.getByText('Taking the snapshot…')).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'snapshot in progress');
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql('SELECT 1 FROM import_batches WHERE id = $1 AND source_snapshot_sha256 IS NOT NULL', [batchId])).length;
  }, { timeout: 30_000 }).toBe(1);
  await page.reload();
  const matching = page.getByRole('region', { name: 'Match Follow Up Boss people' });
  const parity = page.getByRole('region', { name: 'Stages, tags and custom fields' });
  await expect(matching).toBeVisible({ timeout: 20_000 });
  await expect(parity).toBeVisible({ timeout: 20_000 });
  await expect(matching.getByText('1 person still to match.')).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'snapshot taken: agent matching and stage mapping');
  await shot(page, info, 'm7', '03-snapshot');

  // 4. match the FUB agent to the team's agent, in the UI
  const agent = w.agents[0]!;
  await matching.getByLabel(/^Alex Agent \(3 contacts\)/).selectOption(`user:${agent.userId}`);
  await tap(page, matching.getByRole('button', { name: 'Save matches' }));
  await expect(matching.getByText('Everyone is matched.')).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'agent matched');

  // 5. stages, tags and fields
  await parity.getByLabel(/^Hot Prospect \(1 person\)/).selectOption('active');
  await parity.getByLabel(/^Waiting On Lender \(2 people\)/).selectOption('nurture');
  await parity.getByLabel(/^Lead ?score/i).selectOption('create:number');
  await tap(page, parity.getByRole('button', { name: 'Save stages, tags and fields' }));
  await expect(page.getByText(/^Saved\./).first()).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'stages, tags and fields saved');
  await shot(page, info, 'm7', '04-mapping');

  // 6. the contacts dry run: in progress, then the reconciliation
  const contacts = card(page, 'Contacts');
  await tap(page, contacts.getByRole('button', { name: 'Run dry run' }));
  await expect(contacts.getByText(/Dry run in progress… this page updates on its own/)).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'contacts dry run in progress');
  await drainTo(batchId, 'contacts', 'dry_run_ready');
  await page.reload();
  const c = (await stageOf(batchId, 'contacts')).counts!;
  expect(c.source).toBe(5);
  expect(c.willImport + c.needsReview + c.rejected + c.duplicate).toBe(c.source);
  for (const [l, n] of [['In the source', c.source], ['Will import', c.willImport], ['Needs review', c.needsReview], ['Rejected', c.rejected], ['Possible duplicates', c.duplicate]] as const) {
    await expect(contacts.locator('dl > div').filter({ has: page.getByText(l, { exact: true }) }).locator('dd')).toHaveText(String(n));
  }
  await checkState(page, 'contacts dry run: reconciliation');
  await shot(page, info, 'm7', '05-dry-run');

  // 7. every review-list tab
  await tap(page, contacts.getByRole('button', { name: 'Review records' }));
  const tabs: [string, number][] = [['Needs review', c.needsReview], ['Possible duplicate', c.duplicate], ['Rejected', c.rejected], ['Will import', c.willImport]];
  for (const [l, n] of tabs) {
    const tab = contacts.getByRole('radio', { name: `${l} ${n}` });
    await tap(page, tab);
    await expect(tab).toHaveAttribute('aria-checked', 'true');
    if (n === 0) await expect(contacts.getByText('No records here.')).toBeVisible({ timeout: 15_000 });
    else await expect(contacts.locator('ul li').filter({ hasText: surname }).or(contacts.locator('ul li').filter({ hasText: /Nobody|No details|Person/ })).first()).toBeVisible({ timeout: 15_000 });
    await checkState(page, `review list: ${l}`);
    await shot(page, info, 'm7', `06-review-${l.toLowerCase().replace(/ /g, '-')}`);
  }
  // the would-be duplicate: "Don't import"
  await tap(page, contacts.getByRole('radio', { name: new RegExp(`^${c.duplicate > 0 ? 'Possible duplicate' : 'Needs review'} \\d+$`) }));
  const benRow = contacts.locator('li').filter({ hasText: /Ben/ }).first();
  await expect(benRow).toBeVisible({ timeout: 15_000 });
  await tap(page, benRow.getByRole('button', { name: "Don't import" }));
  await expect(benRow.getByText("Decided: don't import")).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'review decision made');

  // 8. approve → importing → imported + verification + report → verified
  await page.reload();
  const approve = contacts.getByRole('button', { name: /^Approve these \d+ records$/ });
  await expect(approve).toBeEnabled({ timeout: 15_000 });
  await tap(page, approve);
  await expect(contacts.getByRole('button', { name: 'Import contacts' })).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'contacts approved');
  await shot(page, info, 'm7', '07-approved');
  await tap(page, contacts.getByRole('button', { name: 'Import contacts' }));
  await expect(contacts.getByText(/Importing… this page updates on its own/)).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'contacts importing');
  await drainTo(batchId, 'contacts', 'committed');
  await page.reload();
  const after = (await stageOf(batchId, 'contacts')).counts!;
  await expect(contacts.getByText(`${after.imported} of ${after.source} imported`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Report' })).toBeVisible({ timeout: 15_000 });
  await verifyStage(page, info, batchId, 'contacts', 'Contacts', '08-contacts');
  await shot(page, info, 'm7', '09-report');

  // 9. ownership, notes and texts: each dry run, approve, import, verify
  await walkStage(page, info, batchId, 'ownership', 'Who owns each contact', '10-ownership');
  await walkStage(page, info, batchId, 'notes', 'Notes', '11-notes');
  await walkStage(page, info, batchId, 'messages', 'Texts and emails', '12-messages');
  const owned = await stack.sql<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE import_batch_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL', [batchId, agent.userId]);
  expect(owned[0]!.n, 'the imported people assigned to Alex Agent belong to the matched agent').toBe(2);

  // 10. the two remaining categories are skipped: calls (none in the source) at once; consent only after its
  // dry run has shown which opt-outs would not carry over (the server refuses an earlier skip, and the page
  // no longer offers one)
  const calls = card(page, 'Calls and recordings');
  await tap(page, calls.getByRole('button', { name: 'Skip this category' }));
  await expect(calls.getByText('Skipped', { exact: true })).toBeVisible({ timeout: 15_000 });
  const consent = card(page, 'Opt-outs and consent history');
  await expect(consent.getByRole('button', { name: 'Skip this category' })).toHaveCount(0);
  await expect(consent.getByText(/To skip it, run its dry run first/)).toBeVisible();
  await checkState(page, 'consent: skip needs its dry run');
  await tap(page, consent.getByRole('button', { name: 'Run dry run' }));
  await drainTo(batchId, 'consent', 'dry_run_ready');
  await page.reload();
  await checkState(page, 'consent: dry run ready');
  await tap(page, consent.getByRole('button', { name: 'Skip this category' }));
  await expect(consent.getByText('Skipped', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await checkState(page, 'all categories verified or skipped');
  await shot(page, info, 'm7', '13-all-done');

  // 11. per-category undo, offered on the last imported category only (undo runs latest first)
  const texts = card(page, 'Texts and emails');
  await expect(page.getByRole('button', { name: 'Undo this category' })).toHaveCount(1);
  await expect(texts.getByRole('button', { name: 'Undo this category' })).toBeVisible();
  await tap(page, texts.getByRole('button', { name: 'Undo this category' }));
  await expect(texts.getByText(/Undoing… this page updates on its own/)).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'texts: undo in progress');
  await drainTo(batchId, 'messages', 'reverted');
  await page.reload();
  await expect(texts.getByText('Undone', { exact: true })).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'texts undone, the rest still imported');
  await shot(page, info, 'm7', '14-category-undone');

  // 12. the whole import: confirm, in progress, undone
  await tap(page, page.getByRole('button', { name: 'Undo this import' }));
  await expect(page.getByRole('button', { name: 'Undo the whole import' })).toBeVisible();
  await checkState(page, 'whole undo: confirm');
  await tap(page, page.getByRole('button', { name: 'Undo the whole import' }));
  await expect(page.getByText(/Undoing… this page updates on its own/).first()).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'whole undo in progress');
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]))[0]!.status;
  }, { timeout: 30_000 }).toBe('reverted');
  await page.reload();
  await expect(page.getByText('This import was undone.')).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'undone');
  await shot(page, info, 'm7', '15-undone');
  const left = await stack.sql<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL', [batchId]);
  expect(left[0]!.n).toBe(0);

  // 13. the list of imports, with this one undone
  await page.goto(`${stack.webUrl}/imports`);
  await expect(page.getByText(/· undone/).first()).toBeVisible({ timeout: 15_000 });
  await checkState(page, 'imports list with the undone import');
  info.annotations.push({ type: 'states', description: covered.join(' | ') });
});
