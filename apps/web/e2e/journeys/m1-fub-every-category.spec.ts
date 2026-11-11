// M1 + M5 (browser half) — a staged FUB migration of every category the importer reads, against the REAL
// API (journeys/stack.ts: fresh Postgres, RLS-bound app_user, fake providers, the deterministic FAKE Follow Up
// Boss connector), on the phone (390×844) and desktop (1440×900) projects.
//   1. The migration runs through the real import routes (the click path for one stage is J6's; here every
//      stage is run by the child's /m1-migrate route as the Owner, with the per-stage dry run asserted to add
//      up: imported + needs review + rejected + already here = source).
//   2. The person's page shows what came over: stage, tags, phones, emails, addresses, notes (incl. a call
//      note), texts, emails and calls (imported, with the recording label), and an imported opt-out's reason.
//   3. M5 in the UI: "Undo this category" newest first (consent → calls → messages → notes → ownership →
//      contacts) on the batch page; after each, the database holds nothing that stage wrote, and the person's
//      page follows; the undo is audited as the Owner.
// The API/DB half of M1, M2, M4 and M5 (incl. reconciling back to the pre-import counts) is
// apps/api/src/imports/migration.journeys.test.ts.
import { expect, test } from 'playwright/test';
import { drainUntil, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

const ORDER = ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'];

const ROUTES = String.raw`
  /** loads a FUB account into the fake and runs every stage as the Owner: dry run (+ counts), approve, commit, verify */
  async '/m1-migrate'(b) {
    const key = 'fub-m1-' + randomUUID().slice(0, 12);
    const p = b.prefix;
    const ph = (n) => '(415) 7' + (b.seed % 10) + (n % 10) + '-' + String(1000 + b.seed * 10 + n).slice(-4);
    const recUrl = 'https://fub.example/rec/' + p + '?token=secret';
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: p + 1, created: '2023-03-01T14:00:00Z', firstName: 'Jane', lastName: b.surname, stage: 'Hot Prospect', assignedUserId: 11, tags: ['Buyer', 'Pre-approved'],
          emails: [{ value: 'jane.' + p + '@example.com', type: 'home', status: 'Valid', isPrimary: 1 }],
          phones: [{ value: ph(1), type: 'mobile', status: 'Valid', isPrimary: 1 }, { value: ph(2), type: 'work', status: 'Valid' }],
          addresses: [{ type: 'home', street: '1 Main St', city: 'Springfield', state: 'IL', code: '62701', country: 'US' }] },
        { id: p + 2, created: '2022-01-05T10:00:00Z', firstName: 'Omar', lastName: b.surname, stage: 'Nurture', assignedUserId: 11,
          phones: [{ value: ph(3), type: 'mobile', status: 'Opted Out', isPrimary: 1 }] },
        { firstName: 'Nobody' },
      ],
      notes: [
        { id: p * 10 + 1, personId: p + 1, subject: 'Recap', body: '<p>Wants <b>3 beds</b> &amp; a yard.</p>', isHtml: true, created: '2026-01-15T16:00:00Z', createdById: 11 },
        // VERIFY: a FUB call note (the importer reads subject/body; the type key passes through)
        { id: p * 10 + 2, personId: p + 1, type: 'Call', subject: 'Call note', body: 'Spoke 10 min, wants a showing Saturday.', created: '2026-01-16T16:00:00Z', createdById: 11 },
      ],
      textMessages: [
        { id: p * 10 + 1, personId: p + 1, created: '2026-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' },
        { id: p * 10 + 2, personId: p + 1, created: '2026-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 },
      ],
      emails: [{ id: p * 10 + 1, personId: p + 1, created: '2026-03-03T12:00:00Z', isIncoming: false, subject: 'Listings for you', body: 'Here are three homes.', status: 'Sent', userId: 11 }],
      calls: [{ id: p * 10 + 1, personId: p + 1, created: '2026-03-04T15:00:00Z', isIncoming: false, duration: 312, outcome: 'Interested', note: 'Talked about schools', userId: 11, recordingUrl: recUrl }],
      recordings: { [recUrl]: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]) },
    });
    const owner = client('a.owner');
    await freshReauth(h, owner);
    const c = must(await call(owner, 'POST', '/imports', { source: 'fub_api', apiKey: key }), 'create').batch;
    must(await call(owner, 'POST', '/imports/' + c.id + '/snapshot'), 'snapshot');
    await routes['/jobs']({});
    must(await call(owner, 'PUT', '/imports/' + c.id + '/user-mappings', { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: world('a').agents[0].userId } }] }), 'mapping');
    const par = must(await call(owner, 'GET', '/imports/' + c.id + '/parity'), 'parity');
    const stageMap = { ...par.options.stageMap, 'Hot Prospect': 'active', Nurture: 'nurture' };
    must(await call(owner, 'PUT', '/imports/' + c.id + '/parity', { ...par.options, stageMap }), 'parity put');
    const counts = {};
    for (const cat of ${JSON.stringify(['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'])}) {
      must(await call(owner, 'POST', '/imports/' + c.id + '/stages/' + cat + '/dry-run'), 'dry ' + cat);
      await routes['/jobs']({});
      let st = must(await call(owner, 'GET', '/imports/' + c.id), 'get').batch.stages.find((s) => s.category === cat);
      if (st.status !== 'dry_run_ready') throw new Error('dry run ' + cat + ' ' + st.status);
      counts[cat] = { dryRun: st.counts };
      const recs = must(await call(owner, 'GET', '/imports/' + c.id + '/stages/' + cat + '/records?limit=200&outcome=needs_review'), 'records').records;
      for (const r of recs) must(await call(owner, 'POST', '/imports/' + c.id + '/records/' + r.id + '/review', { decision: 'import' }), 'review');
      must(await call(owner, 'POST', '/imports/' + c.id + '/stages/' + cat + '/approve', { snapshotSha256: st.dryRunSha256 }), 'approve ' + cat);
      must(await call(owner, 'POST', '/imports/' + c.id + '/stages/' + cat + '/commit'), 'commit ' + cat);
      await routes['/jobs']({});
      st = must(await call(owner, 'GET', '/imports/' + c.id), 'get').batch.stages.find((s) => s.category === cat);
      counts[cat].committed = st.counts;
      const v = must(await call(owner, 'GET', '/imports/' + c.id + '/stages/' + cat + '/verification'), 'verification ' + cat);
      must(await call(owner, 'POST', '/imports/' + c.id + '/stages/' + cat + '/verify', { spotChecks: v.sample.map((s) => ({ sourceRef: s.sourceRef, matches: s.same })) }), 'verify ' + cat);
    }
    return { batchId: c.id, counts };
  },
`;

interface Counts { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number }

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({ routes: ROUTES });
  w = await stack.world({ agents: 1 });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('M1 + M5: every FUB category lands on the person and each category undoes on its own, newest first', async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = info.project.name === 'phone';
  const surname = phone ? 'Phonemig' : 'Deskmig';
  const { batchId, counts } = await stack.fixture<{ batchId: string; counts: Record<string, { dryRun: Counts; committed: Counts }> }>('/m1-migrate', { prefix: phone ? 81000 : 82000, seed: phone ? 1 : 2, surname });

  // every stage's dry run and commit add up
  for (const cat of ORDER) {
    const d = counts[cat]!.dryRun;
    const c = counts[cat]!.committed;
    expect([cat, d.willImport + d.needsReview + d.rejected + d.duplicate]).toEqual([cat, d.source]);
    expect([cat, (c.imported ?? 0) + c.needsReview + c.rejected + c.duplicate]).toEqual([cat, c.source]);
  }
  expect([counts.contacts!.committed.source, counts.contacts!.committed.imported, counts.contacts!.committed.rejected]).toEqual([3, 2, 1]);
  expect([counts.notes!.committed.imported, counts.messages!.committed.imported, counts.call_recordings!.committed.imported]).toEqual([2, 3, 1]);

  const [jane] = await stack.sql<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Jane'", [batchId]);
  const [omar] = await stack.sql<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Omar'", [batchId]);

  // 2. the person's page, as the agent who owns them now
  await signIn(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/contacts/${jane!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Jane ${surname}` })).toBeVisible({ timeout: 15_000 });
  const main = page.locator('main');
  for (const t of ['active · Yours', '· mobile', '· work', `jane.${phone ? 81000 : 82000}@example.com · home`, '1 Main St, Springfield, IL, 62701 · home']) await expect(main.getByText(t, { exact: false }).first()).toBeVisible();
  const tags = page.getByRole('region', { name: 'Tags' });
  for (const t of ['Buyer', 'Pre-approved', 'FUB stage: Hot Prospect']) await expect(tags.getByRole('button', { name: `Tag ${t}, show everyone with it` })).toBeVisible();
  const conv = main.locator('section').filter({ has: page.getByRole('heading', { name: /^Conversation$/i }) });
  for (const t of ['Is the Elm St house still available?', 'Yes! Want to see it Saturday?', 'Here are three homes.', 'Note: Recap Wants 3 beds & a yard.', 'Note: Call note Spoke 10 min, wants a showing Saturday.', 'Note: Talked about schools', 'Call by Member agent · Talked']) {
    await expect(conv.getByText(t, { exact: false }).first()).toBeVisible();
  }
  // every history row on the page is marked imported, with its original FUB time
  await expect(conv.getByText(/Thu, Jan 15, 4:00 PM · Imported/)).toBeVisible();
  await expect(conv.getByText(/Wed, Mar 4, 3:00 PM · Imported/).first()).toBeVisible();
  await shot(page, info, 'm1', '1-person');

  // the imported opt-out: Omar's phone was "Opted Out" in FUB; his page says texting is off and why
  await page.goto(`${stack.webUrl}/contacts/${omar!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Omar ${surname}` })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText(/opted out/i).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'm1', '2-optout');

  // 3. M5 in the UI: undo each category, newest first, as the Owner
  await page.context().clearCookies();
  await signIn(page, stack, w.owner);
  await stack.fixture('/reauth', { as: 'a.owner' });
  const left = async () =>
    (await stack.sql<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL) AS contacts,
              (SELECT count(*)::int FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL AND ownership_state = 'owned') AS owned,
              (SELECT count(*)::int FROM notes n JOIN import_records r ON r.id = n.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1) AS notes,
              (SELECT count(*)::int FROM messages m JOIN import_records r ON r.id = m.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1) AS messages,
              (SELECT count(*)::int FROM calls m JOIN import_records r ON r.id = m.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1) AS calls,
              (SELECT count(*)::int FROM consent_events e JOIN import_records r ON r.id = e.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'consent' AND e.event_type = 'grant'
                 AND NOT EXISTS (SELECT 1 FROM consent_events v WHERE v.tenant_id = e.tenant_id AND v.reverts_event_id = e.id)) AS grants`,
      [batchId],
    ))[0]!;
  const start = await left();
  expect(start).toMatchObject({ contacts: 2, owned: 2, notes: 3, messages: 3, calls: 1 });
  const TITLES: Record<string, RegExp> = { consent: /Opt-outs/, call_recordings: /Calls and recordings/, messages: /Texts and emails/, notes: /Notes/, ownership: /Who owns each contact/, contacts: /Contacts$/ };
  const expectAfter: Record<string, Partial<Record<string, number>>> = {
    consent: { grants: 0 },
    call_recordings: { calls: 0, notes: 2 }, // the call and its note go together
    messages: { messages: 0 },
    notes: { notes: 0 },
    ownership: { owned: 0 },
    contacts: { contacts: 0 },
  };
  let expected = { ...start };
  for (const cat of [...ORDER].reverse()) {
    await page.goto(`${stack.webUrl}/imports/${batchId}`);
    const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: TITLES[cat]! }) });
    // only the newest imported category offers its own undo
    await expect(page.getByRole('button', { name: 'Undo this category' })).toHaveCount(1, { timeout: 15_000 });
    await tap(page, card.getByRole('button', { name: 'Undo this category' }));
    await drainUntil(stack, async () => (await stack.sql<{ status: string }>('SELECT status FROM import_stages WHERE batch_id = $1 AND category = $2', [batchId, cat]))[0]!.status === 'reverted', { timeout: 30_000 });
    expected = { ...expected, ...expectAfter[cat] } as typeof start;
    expect([cat, await left()]).toEqual([cat, expected]);
    const audit = await stack.sql<{ actor_user_id: string }>("SELECT a.actor_user_id FROM audit_log a JOIN import_stages s ON s.id = a.entity_id WHERE a.action = 'import.reverted' AND s.batch_id = $1 AND s.category = $2", [batchId, cat]);
    expect([cat, audit.map((x) => x.actor_user_id)]).toEqual([cat, [w.owner.userId]]);
  }
  await page.reload();
  await expect(page.getByText('This import was undone.')).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'm1', '3-undone');
  // the imported opt-out stays after the undo (R-CONSENT-3)
  const revoked = await stack.sql<{ n: number }>(
    // (keyed by the address, not the contact: the undo removed Omar and his points, the opt-out stays on the number)
    "SELECT count(*)::int AS n FROM consent_state cs WHERE cs.channel = 'sms' AND cs.status = 'revoked' AND cs.address_hmac IN (SELECT e.address_hmac FROM consent_events e WHERE e.contact_id = $1 AND e.imported AND e.event_type = 'revoke')",
    [omar!.id],
  );
  expect(revoked[0]!.n).toBeGreaterThan(0);
  // the people are gone from People
  await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByRole('heading', { level: 1, name: /People/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(surname)).toHaveCount(0);
});

// GAP (low-medium, R-IMPORT-12): an imported call recording is stored (recordings.consent_basis
// 'unknown_imported') and the import report says 'recording notice unknown', but no person-facing surface shows
// it: GET /contacts/:id/timeline carries no recording for a call (leads/timeline.ts), and the person page's call row
// reads "Call by Member agent · Talked · Wed, Mar 4, 3:00 PM · Imported" with no recording and no label.
// Repro: run the test above to step 2 and look at Jane's Conversation section.
test.fixme("M1: the person's imported call shows its recording labelled 'recording notice unknown'", async ({ page }) => {
  await signIn(page, stack, w.agents[0]!);
  const [jane] = await stack.sql<{ id: string }>("SELECT id FROM contacts WHERE first_name = 'Jane' AND import_batch_id IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  await page.goto(`${stack.webUrl}/contacts/${jane!.id}`);
  await expect(page.getByText(/recording notice unknown/i)).toBeVisible();
});
