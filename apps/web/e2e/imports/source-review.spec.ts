// "Review sources" as a step of every import (owner decision 2026-11-14; R-LSRC-9, R-LSRC-10; E728 to E747), against the
// REAL API (journeys/stack.ts: a fresh Postgres database, the RLS-bound app_user, fake providers, api/imports on the
// deterministic FAKE Follow Up Boss connector), on the phone (iPhone 13, 390x844) and desktop (1440x900) projects.
//
// One journey per import flow. In each, the Owner opens the import after its snapshot and sees "Review sources" before
// anything is imported: every label exactly as imported with its people and state. One label reads the same as the
// lead source "Open houses" apart from capitals, so it is SUGGESTED, never applied: the Owner confirms it with its
// button. One label ("Sunday flyer") is left in review, and the import runs anyway. Afterwards:
//   - the import's summary repeats the review with the people it brought in;
//   - for a person from the in-review label, the agent's stage change to Active does NOT start the agent's plan, and
//     the toast says why in the in-review words (never that a setting is on, never a code); the database holds the
//     skipped decision and no enrollment, and nothing automatic reaches the fake provider;
//   - the agent's own one-to-one text to that same person goes out, once.
// Follow Up Boss: the import is created through the API (the Imports UI path is M7's and J6's); the review and the
// contacts category (dry run, approve, import) are the browser's. A person from the confirmed label then does get the
// plan, so the confirmation is what opened automation for them.
// CSV: the Owner uploads the file in the browser; the file also has a person with no source, who is their own row.
// The labels and the lead source are made up; phone numbers are the fixtures' fictional ones.
import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from 'playwright/test';
import { isPhone, shot, signIn, tap } from '../journeys/helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from '../journeys/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
let planId: string;
let openHouses: string;
const OWNER = 'a.owner';
const AGENT = 'a.agent0';

const IN_REVIEW_TOAST = "Stage: Active. Buyer plan didn't start: they came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources)";
const STEP = { stepKey: 'check_in', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, checking in on your home search.', personalization: 'none', slots: ['first_name'], maxLength: 640, stopIf: [] };

// child route: a Follow Up Boss account whose three people carry a source label each (one of them none)
const ROUTES = String.raw`
  async '/fub-load-sr'(b) {
    const key = 'fub-sr-' + randomUUID().slice(0, 12);
    const phones = [randomPhone(), randomPhone()];
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: b.prefix + 1, created: '2024-03-01T10:00:00Z', firstName: 'Flora', lastName: b.surname, assignedUserId: 11, source: 'Sunday flyer', phones: [{ value: phones[0], type: 'mobile', status: 'Valid', isPrimary: 1 }] },
        { id: b.prefix + 2, created: '2024-03-02T10:00:00Z', firstName: 'Otis', lastName: b.surname, assignedUserId: 11, source: 'open houses', phones: [{ value: phones[1], type: 'mobile', status: 'Valid', isPrimary: 1 }] },
      ],
      notes: [], textMessages: [], emails: [], calls: [],
    });
    return { key, phones };
  },
`;

interface StageView { category: string; status: string; dryRunSha256: string | null }

async function must<T>(p: Promise<{ status: number; body: T }>, ok: number[] = [200, 201, 202]): Promise<T> {
  const r = await p;
  expect(ok, JSON.stringify(r.body)).toContain(r.status);
  return r.body;
}
const stageOf = async (batchId: string, cat: string) => (await stack.api<{ batch: { stages: StageView[] } }>(OWNER, 'GET', `/imports/${batchId}`)).body.batch.stages.find((s) => s.category === cat)!;
async function untilStage(batchId: string, cat: string, status: string) {
  await expect.poll(async () => {
    await stack.jobs();
    return (await stageOf(batchId, cat)).status;
  }, { timeout: 60_000 }).toBe(status);
}
async function verifyStage(batchId: string, cat: string) {
  const v = await stack.api<{ sample: { sourceRef: string; same: boolean }[] }>(OWNER, 'GET', `/imports/${batchId}/stages/${cat}/verification`);
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/verify`, { spotChecks: v.body.sample.map((s) => ({ sourceRef: s.sourceRef, matches: s.same })) }));
}
/** One category through the API: dry run, approve exactly that dry run, import, verify. */
async function fullStage(batchId: string, cat: string) {
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/dry-run`));
  await untilStage(batchId, cat, 'dry_run_ready');
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/approve`, { snapshotSha256: (await stageOf(batchId, cat)).dryRunSha256 }));
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/commit`));
  await untilStage(batchId, cat, 'committed');
  await verifyStage(batchId, cat);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({ routes: ROUTES });
  w = await stack.world({ agents: 1 });
  // the agent's own plan, started when a person's stage becomes Active (as J8)
  const c = await must(stack.api<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(AGENT, 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', name: 'Buyer plan', steps: [STEP] }));
  planId = c.playbook.id;
  const v = c.playbook.versions[0]!;
  await must(stack.api(AGENT, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 }));
  await must(stack.api(AGENT, 'PUT', `/playbooks/${planId}/auto-enroll-stage`, { stage: 'active' }));
  // the lead source one imported label reads the same as
  openHouses = (await must(stack.api<{ source: { id: string } }>(OWNER, 'POST', '/lead-sources', { name: 'Open houses', kind: 'open_house' }))).source.id;
});
test.afterAll(async () => {
  await stack?.stop();
});

const review = (page: Page) => page.getByRole('region', { name: 'Review sources' });
const labelRow = (page: Page, label: string) => review(page).getByRole('group', { name: `Source label "${label}"` });
const mappedTo = async (label: string) => (await stack.sql<{ id: string }>('SELECT id FROM lead_sources WHERE tenant_id = $1 AND $2 = ANY (import_labels)', [w.tenantId, label])).map((r) => r.id);
/** What the server answers when the agent tries to start the plan for their own lead by hand: the refusal's code, or null when it started. */
async function handEnrol(contactId: string): Promise<string | null> {
  const r = await stack.api<{ error?: { code: string } }>(AGENT, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: planId });
  if (r.status === 201) return null;
  expect(r.status, JSON.stringify(r.body)).toBe(409);
  return r.body.error?.code ?? 'unknown';
}
const contactOf = async (batchId: string, first: string) => (await stack.sql<{ id: string; display_name: string }>('SELECT id, display_name FROM contacts WHERE import_batch_id = $1 AND first_name = $2 AND deleted_at IS NULL', [batchId, first]))[0]!;
const smsTo = async (phone: string) => (await stack.sends()).sms.filter((m) => m.to === phone);

async function openImport(page: Page, batchId: string) {
  await page.goto(`${stack.webUrl}/imports/${batchId}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Categories' })).toBeVisible({ timeout: 20_000 });
}

/** The Owner confirms the exact-match suggestion with its button; until then nothing is mapped. */
async function confirmSuggestion(page: Page, label: string, info: Parameters<typeof shot>[1], journey: string) {
  const row = labelRow(page, label);
  await expect(row.getByText('In review · a match is suggested')).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('so Open houses is suggested. Nothing is mapped until the Owner confirms it');
  expect(await mappedTo(label), 'a suggestion maps nothing').toEqual([]);
  // the dropdown is a choice only: changing it sends nothing
  await row.getByLabel(`Lead source for "${label}"`).selectOption({ label: 'Open houses' });
  await expect(row.getByRole('button', { name: 'Map to Open houses' })).toBeVisible();
  expect(await mappedTo(label), 'changing the dropdown maps nothing').toEqual([]);
  await tap(page, row.getByRole('button', { name: 'Cancel' }));
  await shot(page, info, journey, '1-review-before');
  await tap(page, row.getByRole('button', { name: 'Confirm Open houses' }));
  await expect(labelRow(page, label).getByText('Mapped', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(labelRow(page, label)).toContainText(`"${label}"`);
  await expect(labelRow(page, label)).toContainText('mapped to Open houses.');
  expect(await mappedTo(label)).toEqual([openHouses]);
  // who mapped it, and that it was a confirmed suggestion, is on record
  const audit = await stack.sql<{ reason: string }>("SELECT reason FROM audit_log WHERE tenant_id = $1 AND action = 'routing.changed' AND reason LIKE 'LEAD_SOURCE_IMPORT_LABEL%' ORDER BY occurred_at DESC LIMIT 1", [w.tenantId]);
  expect(audit[0]?.reason).toBe('LEAD_SOURCE_IMPORT_LABEL_SUGGESTION_CONFIRMED');
}

async function toActive(page: Page, p: { id: string; display_name: string }) {
  await page.goto(`${stack.webUrl}/contacts/${p.id}`);
  await expect(page.getByRole('heading', { level: 1, name: p.display_name })).toBeVisible({ timeout: 20_000 });
  await tap(page, page.getByRole('button', { name: /^Stage: .*\. Change stage$/ }));
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /^Active/ }));
}

/** A person from the in-review label: the plan is refused in the in-review words, and the agent's own text still goes. */
async function refusedThenTexted(page: Page, p: { id: string; display_name: string }, phone: string, info: Parameters<typeof shot>[1], journey: string) {
  expect(await handEnrol(p.id), 'a plan by hand is refused for the in-review reason').toBe('SOURCE_UNCLASSIFIED');
  const before = (await smsTo(phone)).length;
  await toActive(page, p);
  const toast = page.getByTestId('people-toast');
  await expect(toast.getByText(IN_REVIEW_TOAST)).toBeVisible({ timeout: 20_000 });
  await expect(toast).not.toContainText(/No automated contact for leads from this source|SOURCE_UNCLASSIFIED|source_unclassified/);
  await shot(page, info, journey, '3-plan-refused-in-review');
  expect(await stack.sql('SELECT outcome, reason, enrollment_id FROM stage_automation_decisions WHERE contact_id = $1', [p.id])).toEqual([{ outcome: 'skipped', reason: 'source_unclassified', enrollment_id: null }]);
  expect(await stack.sql('SELECT 1 FROM playbook_enrollments WHERE contact_id = $1', [p.id])).toEqual([]);
  await stack.jobs({ tenantId: w.tenantId });
  expect((await smsTo(phone)).length, 'nothing automatic reached them').toBe(before);

  // the agent's own one-to-one text to the same person goes out, once
  await page.goto(`${stack.webUrl}/contacts/${p.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Hi, this is Alex from the team. Is now a good time to talk?');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled({ timeout: 20_000 });
  await tap(page, send);
  await expect.poll(async () => (await smsTo(phone)).length, { timeout: 30_000 }).toBe(before + 1);
  await expect(page.getByText('Hi, this is Alex from the team. Is now a good time to talk?').first()).toBeVisible({ timeout: 20_000 });
  const sent = await stack.sql<{ status: string; initiator: string; playbook_step_run_id: string | null }>("SELECT status, initiator, playbook_step_run_id FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [p.id]);
  expect(sent).toEqual([{ status: 'sent', initiator: 'human', playbook_step_run_id: null }]);
  await shot(page, info, journey, '4-one-to-one-sent');
  // still in review: the text changed nothing about that
  expect(await handEnrol(p.id)).toBe('SOURCE_UNCLASSIFIED');
}

async function asAgent(page: Page) {
  await page.context().clearCookies();
  await signIn(page, stack, w.agents[0]!);
}

test('Follow Up Boss: the Owner confirms one exact match in Review sources and leaves one label in review; the import runs; the in-review person gets no plan, says why, and still gets a one-to-one text', async ({ page }, info) => {
  test.setTimeout(420_000);
  const phone = isPhone(page);
  const surname = phone ? 'Phonesrc' : 'Desksrc';
  const { key, phones } = await stack.fixture<{ key: string; phones: string[] }>('/fub-load-sr', { surname, prefix: phone ? 5100 : 5200 });
  await stack.fixture('/reauth', { as: OWNER });
  const batchId = (await must(stack.api<{ batch: { id: string } }>(OWNER, 'POST', '/imports', { source: 'fub_api', apiKey: key }))).batch.id;
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/snapshot`));
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql('SELECT 1 FROM import_batches WHERE id = $1 AND source_snapshot_sha256 IS NOT NULL', [batchId])).length;
  }, { timeout: 60_000 }).toBe(1);
  await must(stack.api(OWNER, 'PUT', `/imports/${batchId}/user-mappings`, { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } }] }));

  await signIn(page, stack, w.owner);
  await stack.fixture('/reauth', { as: OWNER });
  await openImport(page, batchId);

  // the step, before anything is imported: both labels, their people and states, and what "in review" means
  await expect(review(page).getByRole('heading', { level: 2, name: 'Review sources' })).toBeVisible();
  await expect(labelRow(page, 'Sunday flyer').getByText('In review', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(labelRow(page, 'Sunday flyer')).toContainText('"Sunday flyer" (1 person): not reviewed yet.');
  await expect(review(page).getByText('Still in review: 2 labels (2 people). You can run the import with these left in review.')).toBeVisible();
  await expect(review(page).getByText(/get no automated contact .* until an Owner chooses a lead source\. Anyone on the team can still call, text or email them one to one\./)).toBeVisible();
  await confirmSuggestion(page, 'open houses', info, 'source-review-fub');
  await expect(review(page).getByText('Still in review: 1 label (1 person). You can run the import with these left in review.')).toBeVisible({ timeout: 20_000 });
  // the preview had no side effect: no review record exists before anything is imported
  expect(await stack.sql("SELECT 1 FROM import_source_labels WHERE tenant_id = $1 AND import_label = 'Sunday flyer'", [w.tenantId])).toEqual([]);

  // the contacts category, in the browser, with "Sunday flyer" left in review: the page says so next to Approve
  const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: '1. Contacts' }) });
  await tap(page, card.getByRole('button', { name: 'Run dry run' }));
  await untilStage(batchId, 'contacts', 'dry_run_ready');
  await page.reload();
  const approve = card.getByRole('button', { name: /^Approve these \d+ records$/ });
  await expect(approve).toBeEnabled({ timeout: 20_000 });
  await expect(card.getByText('Still in review: 1 label (1 person). You can run the import with these left in review.')).toBeVisible({ timeout: 20_000 });
  await shot(page, info, 'source-review-fub', '2-approve-with-one-in-review');
  await tap(page, approve);
  await tap(page, card.getByRole('button', { name: 'Import contacts' }));
  await untilStage(batchId, 'contacts', 'committed');
  await verifyStage(batchId, 'contacts');
  await fullStage(batchId, 'ownership');

  // the summary repeats the review with the people the import brought in
  await openImport(page, batchId);
  await expect(review(page).getByRole('heading', { level: 3, name: 'Review sources' })).toBeVisible({ timeout: 20_000 });
  await expect(review(page).getByText('Still in review after this import: 1 label (1 person imported).')).toBeVisible();
  await expect(labelRow(page, 'open houses').getByText('Mapped', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Review sources' })).toHaveCount(1);
  await shot(page, info, 'source-review-fub', '2b-summary');

  const flora = await contactOf(batchId, 'Flora');
  const otis = await contactOf(batchId, 'Otis');
  await asAgent(page);
  await refusedThenTexted(page, flora, phones[0]!, info, 'source-review-fub');

  // the person from the label the Owner confirmed is not in review, and the plan starts for them
  await toActive(page, otis);
  await expect(page.getByTestId('people-toast').getByText('Stage: Active. Started Buyer plan')).toBeVisible({ timeout: 20_000 });
  expect(await stack.sql("SELECT state, enrolled_by FROM playbook_enrollments WHERE contact_id = $1 AND playbook_id = $2", [otis.id, planId])).toEqual([{ state: 'active', enrolled_by: 'stage_change' }]);
});

test('CSV: the Owner uploads a file, confirms one exact match in Review sources and leaves a label and the no-label people in review; the in-review person gets no plan, says why, and still gets a one-to-one text', async ({ page }, info) => {
  test.setTimeout(420_000);
  const surname = isPhone(page) ? 'Phonefile' : 'Deskfile';
  const ph = async () => (await stack.fixture<{ phone: string }>('/phone')).phone;
  const [p1, p2, p3] = [await ph(), await ph(), await ph()];
  const csv = `First Name,Last Name,Mobile Phone,Source\nCai,${surname},${p1},Sunday flyer\nDee,${surname},${p2},OPEN HOUSES\nEli,${surname},${p3},\n`;

  await signIn(page, stack, w.owner);
  await stack.fixture('/reauth', { as: OWNER });
  await page.goto(`${stack.webUrl}/imports`);
  await tap(page, page.getByRole('radio', { name: 'CSV file' }));
  await page.locator('#import-file').setInputFiles({ name: `old-crm-${randomUUID().slice(0, 6)}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await tap(page, page.getByRole('button', { name: "Count what's there" }));
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const batchId = page.url().split('/').at(-1)!;
  await tap(page, page.getByRole('button', { name: 'Take snapshot' }));
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql('SELECT 1 FROM import_batches WHERE id = $1 AND source_snapshot_sha256 IS NOT NULL', [batchId])).length;
  }, { timeout: 60_000 }).toBe(1);
  await openImport(page, batchId);

  // the same step for a file: after its columns, before its categories; the no-label person is their own row
  await expect(review(page).getByText(/^Your file gives each person's source as a label, shown here exactly as it was imported\./)).toBeVisible({ timeout: 20_000 });
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings.indexOf('Columns')).toBeLessThan(headings.indexOf('Review sources'));
  expect(headings.indexOf('Review sources')).toBeLessThan(headings.indexOf('Categories'));
  const blank = review(page).getByRole('group', { name: 'People imported with no source label' });
  await expect(blank).toContainText('No source label in this import (1 person): not reviewed yet.');
  await expect(blank.getByText('In review', { exact: true })).toBeVisible();
  await expect(labelRow(page, 'Sunday flyer').getByText('In review', { exact: true })).toBeVisible();
  await expect(review(page).getByText('Still in review: 2 labels and the people with no source label (3 people). You can run the import with these left in review.')).toBeVisible();
  await confirmSuggestion(page, 'OPEN HOUSES', info, 'source-review-csv');
  await expect(review(page).getByText('Still in review: 1 label and the people with no source label (2 people). You can run the import with these left in review.')).toBeVisible({ timeout: 20_000 });

  // the import runs with the rest left in review
  await fullStage(batchId, 'contacts');
  await openImport(page, batchId);
  await expect(review(page).getByText('Still in review after this import: 1 label and the people with no source label (2 people imported).')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Review sources' })).toHaveCount(1);
  await shot(page, info, 'source-review-csv', '2-summary');
  // the same review is on the Lead sources page
  await tap(page, review(page).getByRole('link', { name: 'Lead sources' }));
  await expect(page).toHaveURL(/\/admin\/lead-sources#review-sources$/, { timeout: 20_000 });
  await expect(labelRow(page, 'Sunday flyer').getByText('In review', { exact: true })).toBeVisible({ timeout: 20_000 });
  // a label is the team's, not one import's: the Follow Up Boss journey above brought one person with "Sunday flyer" first
  // and this file another; this file's no-label person is the file's own row
  await expect(labelRow(page, 'Sunday flyer')).toContainText('"Sunday flyer" (2 people): not reviewed yet.');
  await expect(labelRow(page, 'Sunday flyer')).toContainText('from Follow Up Boss.');
  await expect(review(page).getByRole('group', { name: 'People imported with no source label' })).toContainText('No source label in one file import (1 person): not reviewed yet.');
  await expect(review(page).getByRole('group', { name: 'People imported with no source label' })).toContainText('from a CSV file.');

  // a file's people come in unassigned: the Owner gives them to the agent
  const [cai, dee, eli] = [await contactOf(batchId, 'Cai'), await contactOf(batchId, 'Dee'), await contactOf(batchId, 'Eli')];
  for (const p of [cai, dee, eli]) await must(stack.api(OWNER, 'POST', `/leads/${p.id}/reassign`, { commandId: randomUUID(), toUserId: w.agents[0]!.userId }));
  expect(await handEnrol(eli.id), 'a person with no source label is in review too').toBe('SOURCE_UNCLASSIFIED');
  expect(await handEnrol(dee.id), 'the confirmed label is reviewed: the plan starts').toBeNull();
  await asAgent(page);
  await refusedThenTexted(page, cai, p1!, info, 'source-review-csv');
});
