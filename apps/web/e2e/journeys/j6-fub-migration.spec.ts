// J6 — FUB migration, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound
// app_user, fake providers, api/imports on the deterministic FAKE Follow Up Boss connector), on the phone
// (iPhone 13, 390×844) and desktop (1440×900) projects. The Owner does the whole migration in the
// Imports UI:
//   key → "Count what's there" → snapshot → map stages and custom fields → contacts dry run, whose
//   reconciliation adds up (In the source = Will import + Needs review + Rejected + Possible duplicates,
//   the same numbers the API returns) → approve exactly that dry run → import → the person's page shows the
//   mapped stage, the imported tags and the typed custom fields (in the person's Details section, PARITY_PLAN
//   §5) → Undo the whole import → the page says it was undone (and stops saying what it imported) and the
//   database holds nothing the import wrote (contacts, tags, field values), while the contact that existed
//   before the import is untouched.
// The FUB dataset has a malformed person (rejected) and a person whose phone matches a contact the team
// already has (a possible duplicate), so the reconciliation is not trivially "all imported".
import { expect, test } from 'playwright/test';
import { browserApi, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

// child route: load a FUB account into the fake connector under a fresh key
const ROUTES = String.raw`
  async '/fub-load'(b) {
    const key = 'fub-j6-' + randomUUID().slice(0, 12);
    const ph = (n) => '(415) 58' + (n % 10) + '-' + String(1000 + n + b.seed).slice(-4);
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: 9001, created: '2023-01-01T00:00:00Z', firstName: 'Ana', lastName: b.surname, stage: 'Hot Prospect', tags: ['Buyer', 'Relocating'], phones: [{ value: ph(1), type: 'mobile', status: 'Valid' }],
          customLeadScore: '87', customClosingDate: '12/15/2026', customTimeline: '0-3 months', customInterests: 'Pool, Garage' },
        { id: 9002, created: '2023-01-02T00:00:00Z', firstName: 'Ben', lastName: b.surname, stage: 'Waiting On Lender', tags: ['buyer'], phones: [{ value: b.dupPhone, type: 'mobile', status: 'Valid' }],
          customLeadScore: '55', customTimeline: '0-3 months', customInterests: 'Garage' },
        { id: 9003, created: '2023-01-03T00:00:00Z', firstName: 'Cal', lastName: b.surname, stage: 'Waiting On Lender', tags: ['Investor'], phones: [{ value: ph(3), type: 'mobile', status: 'Valid' }], customTimeline: '3-6 months', customLeadScore: '40' },
        { id: 9004, created: '2023-01-04T00:00:00Z', firstName: 'Dee', lastName: b.surname, phones: [{ value: ph(4), type: 'mobile', status: 'Valid' }], customTimeline: '3-6 months' },
        { firstName: 'Nobody' },
      ],
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

interface Counts { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number }
interface Stage { category: string; status: string; counts: Counts | null; dryRunSha256: string | null }

test('J6: a FUB import dry-runs with counts that add up, commits stages, tags and typed fields onto the person, and Undo removes exactly what it wrote', async ({ page }, info) => {
  test.setTimeout(240_000);
  const surname = info.project.name === 'phone' ? 'Phoneimport' : 'Deskimport';
  // a contact the team already has; the FUB person "Ben" carries the same mobile number
  const { phone: dupPhone } = await stack.fixture<{ phone: string }>('/phone');
  const existing = await stack.api<{ contact: { id: string } }>('a.agent0', 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Bennett', lastName: 'Existing', phones: [dupPhone] });
  expect(existing.status).toBe(201);
  const { key } = await stack.fixture<{ key: string }>('/fub-load', { surname, dupPhone, seed: info.project.name === 'phone' ? 10 : 20 });

  await signIn(page, stack, w.owner);
  // the import routes need a password confirmation within 15 min (R-PERM-13); the fixture marks every live
  // session of the Owner (this browser's included) as just confirmed, so the page asks for no password
  await stack.fixture('/reauth', { as: 'a.owner' });

  // 1. key → count
  await page.goto(`${stack.webUrl}/imports`);
  await expect(page.getByRole('heading', { name: 'Start an import' })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Follow Up Boss API key').fill(key);
  await tap(page, page.getByRole('button', { name: "Count what's there" }));
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const batchId = page.url().split('/').at(-1)!;
  await expect(page.getByText(/Nothing has been imported/)).toBeVisible({ timeout: 15_000 });

  // 2. snapshot (the worker takes it)
  await tap(page, page.getByRole('button', { name: 'Take snapshot' }));
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql('SELECT 1 FROM import_batches WHERE id = $1 AND source_snapshot_sha256 IS NOT NULL', [batchId])).length;
  }, { timeout: 30_000 }).toBe(1);
  await page.reload();
  const parity = page.getByRole('region', { name: 'Stages, tags and custom fields' });
  await expect(parity).toBeVisible({ timeout: 20_000 });

  // 3. map the stages and create typed fields
  await parity.getByLabel(/^Hot Prospect \(1 person\)/).selectOption('active');
  await parity.getByLabel(/^Waiting On Lender \(2 people\)/).selectOption('nurture');
  await parity.getByLabel(/^Lead ?score/i).selectOption('create:number');
  await parity.getByLabel(/^Closing ?date/i).selectOption('create:date');
  await parity.getByLabel(/^Timeline/i).selectOption('create:single_select');
  await parity.getByLabel(/^Interests/i).selectOption('create:multi_select');
  await shot(page, info, 'j6', '1-mapping');
  await tap(page, parity.getByRole('button', { name: 'Save stages, tags and fields' }));
  await expect(page.getByText(/^Saved\./).first()).toBeVisible({ timeout: 15_000 });

  // 4. the contacts dry run, and its reconciliation
  const contacts = page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: /\. Contacts$/ }) });
  await tap(page, contacts.getByRole('button', { name: 'Run dry run' }));
  await expect.poll(async () => {
    await stack.jobs();
    const s = await stack.api<{ batch: { stages: Stage[] } }>('a.owner', 'GET', `/imports/${batchId}`);
    return s.body.batch?.stages.find((x) => x.category === 'contacts')?.status;
  }, { timeout: 30_000 }).toBe('dry_run_ready');
  await page.reload();
  const api = (await stack.api<{ batch: { stages: Stage[]; snapshotSha256: string } }>('a.owner', 'GET', `/imports/${batchId}`)).body.batch;
  const c = api.stages.find((x) => x.category === 'contacts')!.counts!;
  expect(c.source, 'five FUB people in the snapshot').toBe(5);
  expect(c.willImport + c.needsReview + c.rejected + c.duplicate, 'the dry run accounts for every source record').toBe(c.source);
  expect(c.rejected, 'the malformed person is rejected').toBeGreaterThanOrEqual(1);
  expect(c.duplicate + c.needsReview, "Ben matches the team's existing contact").toBeGreaterThanOrEqual(1);
  // the screen shows exactly these numbers and no "don't add up" warning
  for (const [label, n] of [['In the source', c.source], ['Will import', c.willImport], ['Needs review', c.needsReview], ['Rejected', c.rejected], ['Possible duplicates', c.duplicate]] as const) {
    await expect(contacts.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(String(n));
  }
  await expect(contacts.getByText(/don't add up/)).toHaveCount(0);
  // the review list holds the would-be duplicate; it is decided "Don't import" (names are never merged on their own)
  await tap(page, contacts.getByRole('button', { name: 'Review records' }));
  const dupTab = contacts.getByRole('radio', { name: new RegExp(`^(Possible duplicates|Needs review) ${c.duplicate || c.needsReview}$`) }).first();
  if (await dupTab.count()) await tap(page, dupTab);
  const benRow = contacts.locator('li').filter({ hasText: /Ben/ }).first();
  await expect(benRow).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j6', '2-dry-run');
  await tap(page, benRow.getByRole('button', { name: "Don't import" }));
  await expect(benRow.getByText("Decided: don't import")).toBeVisible({ timeout: 15_000 });

  // 5. approve exactly that dry run, then import
  await page.reload();
  const approveBtn = contacts.getByRole('button', { name: /^Approve these \d+ records$/ });
  await expect(approveBtn).toBeEnabled({ timeout: 15_000 });
  await tap(page, approveBtn);
  await expect.poll(async () => (await stack.api<{ batch: { stages: Stage[] } }>('a.owner', 'GET', `/imports/${batchId}`)).body.batch?.stages.find((x) => x.category === 'contacts')?.status, { timeout: 15_000 }).toBe('approved');
  await expect(contacts.getByRole('button', { name: 'Import contacts' })).toBeVisible({ timeout: 15_000 });
  await tap(page, contacts.getByRole('button', { name: 'Import contacts' }));
  await expect.poll(async () => {
    await stack.jobs();
    const s = await stack.api<{ batch: { stages: Stage[] } }>('a.owner', 'GET', `/imports/${batchId}`);
    return s.body.batch?.stages.find((x) => x.category === 'contacts')?.status;
  }, { timeout: 30_000 }).toBe('committed');
  await page.reload();
  const after = (await stack.api<{ batch: { stages: Stage[] } }>('a.owner', 'GET', `/imports/${batchId}`)).body.batch.stages.find((x) => x.category === 'contacts')!.counts!;
  await expect(contacts.getByText(`${after.imported} of ${after.source} imported`)).toBeVisible();
  // the database holds exactly what the screen says was imported, all marked as this batch's
  const imported = await stack.sql<{ first_name: string; stage: string }>('SELECT first_name, stage FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL ORDER BY first_name', [batchId]);
  expect(imported.length).toBe(after.imported);
  expect(imported.map((r) => r.first_name)).toEqual(['Ana', 'Cal', 'Dee']);
  expect(imported.find((r) => r.first_name === 'Ana')!.stage).toBe('active');
  expect(imported.find((r) => r.first_name === 'Cal')!.stage).toBe('nurture');
  const values = await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM contact_field_values WHERE import_batch_id = $1 AND updated_by_kind = 'import'", [batchId]);
  expect(values[0]!.n).toBeGreaterThan(0);
  const links = await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM contact_tags WHERE import_batch_id = $1 AND added_by_kind = 'import'", [batchId]);
  expect(links[0]!.n).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Report' }).or(page.getByRole('heading', { name: 'Report' })).first()).toBeVisible();
  await shot(page, info, 'j6', '3-committed');

  // 6. the person's page: mapped stage, imported tags and the typed custom fields
  const ana = (await stack.sql<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Ana'", [batchId]))[0]!.id;
  await page.goto(`${stack.webUrl}/contacts/${ana}`);
  await expect(page.getByRole('heading', { level: 1, name: `Ana ${surname}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Stage: Active\./ })).toBeVisible();
  const tags = page.getByRole('region', { name: 'Tags' });
  for (const t of ['Buyer', 'Relocating', 'FUB stage: Hot Prospect']) await expect(tags.getByRole('button', { name: `Tag ${t}, show everyone with it` })).toBeVisible();
  // the typed custom field values, in the person's Details section (PARITY_PLAN §5), each in its field's own
  // terms; the Owner may edit the person (contact.edit), so the values are editable
  const details = page.getByRole('region', { name: 'Details' });
  const field = (label: RegExp) => details.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
  await expect(field(/^Lead score$/i)).toHaveText('87', { timeout: 15_000 });
  await expect(field(/^Closing date$/i)).toHaveText('Dec 15, 2026');
  await expect(field(/^Timeline$/i)).toHaveText('0-3 months');
  await expect(field(/^Interests$/i)).toHaveText('Pool, Garage');
  await expect(details.getByRole('button', { name: `Edit fields of Ana ${surname}` })).toBeVisible();
  await shot(page, info, 'j6', '4-person');
  // the same typed values, through the person's own read API with the Owner's browser session
  const fieldsRes = await (await browserApi(page, stack)).get(`/contacts/${ana}/fields`);
  expect(fieldsRes.status()).toBe(200);
  const vals = ((await fieldsRes.json()) as { values: { fieldId: string; number: number | null; date: string | null; optionIds: string[] | null; updatedByKind: string }[] }).values;
  const defs = await stack.sql<{ id: string; key: string }>("SELECT id, key FROM custom_field_defs WHERE tenant_id = $1", [w.tenantId]);
  const byKey = (k: string) => vals.find((v) => v.fieldId === defs.find((d) => d.key === k)?.id);
  expect(byKey('fub_lead_score')).toMatchObject({ number: 87, updatedByKind: 'import' });
  expect(byKey('fub_closing_date')?.date).toMatch(/^2026-12-15/);
  expect(byKey('fub_timeline')?.optionIds).toHaveLength(1);
  expect(byKey('fub_interests')?.optionIds).toHaveLength(2);

  // 7. Undo the whole import (2 taps) → the revert job → "This import was undone."
  await page.goto(`${stack.webUrl}/imports/${batchId}`);
  await tap(page, page.getByRole('button', { name: 'Undo this import' }));
  await tap(page, page.getByRole('button', { name: 'Undo the whole import' }));
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]))[0]!.status;
  }, { timeout: 30_000 }).toBe('reverted');
  await page.reload();
  await expect(page.getByText('This import was undone.')).toBeVisible({ timeout: 15_000 });
  // every place says what is true after the undo: the card, the report line (what it removed), the parity table
  await expect(contacts.getByText(`Undone: the ${after.imported} of ${after.source} that had been imported were removed.`)).toBeVisible();
  await expect(contacts.getByText(`${after.imported} of ${after.source} imported`, { exact: true })).toHaveCount(0);
  await expect(page.getByText(new RegExp(`The undo removed what this import added: ${after.imported} people and ${after.imported} phone numbers or emails; nothing was left for your decision\\.`))).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Imported, then undone' })).toBeVisible();
  await expect(page.getByText(/^Before the undo, the import had set \d+ stages?, added \d+ tags? and written \d+ custom values?\.$/)).toBeVisible();
  await shot(page, info, 'j6', '5-undone');
  const left = await stack.sql<{ contacts: number; tags: number; values: number }>(
    `SELECT (SELECT count(*)::int FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL) AS contacts,
            (SELECT count(*)::int FROM contact_tags WHERE import_batch_id = $1) AS tags,
            (SELECT count(*)::int FROM contact_field_values WHERE import_batch_id = $1) AS values`,
    [batchId],
  );
  expect(left[0]).toEqual({ contacts: 0, tags: 0, values: 0 });
  // the contact the team had before the import is untouched
  const kept = await stack.sql<{ deleted_at: string | null; first_name: string }>('SELECT deleted_at, first_name FROM contacts WHERE id = $1', [existing.body.contact.id]);
  expect(kept[0]).toEqual({ deleted_at: null, first_name: 'Bennett' });
  // the reverted people are soft-deleted through the ownership engine (R-OWN-26: closed/deleted, purged after
  // 30 days) and gone from People and Search
  const gone = await stack.sql<{ ownership_state: string; deleted: boolean }>('SELECT ownership_state, deleted_at IS NOT NULL AS deleted FROM contacts WHERE import_batch_id = $1', [batchId]);
  expect(gone.length).toBe(after.imported);
  expect(gone.every((r) => r.deleted && r.ownership_state === 'closed')).toBe(true);
  const search = await (await browserApi(page, stack)).get(`/search?q=${surname}`);
  expect(search.status()).toBe(200);
  expect(await search.text()).not.toContain(surname);
  await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByText('Bennett Existing').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(surname)).toHaveCount(0);
});
