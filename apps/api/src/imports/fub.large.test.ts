// Journey M6 "large import": a 50,000-person Follow Up Boss account through the staged importer
// (BUILD_PLAN module 16 "Accept when: a 50k-contact FUB fixture runs dry-run → commit → verify for all
// six stages, with exact count reconciliation and a per-record review list").
//
// The fake FUB (FakeFub, never the real API) serves a deterministic export with realistic variety:
// several phones / emails / addresses per person, tags, five stage labels, three custom fields, two
// mapped FUB agents plus unassigned people, ~1% malformed people, ~1% invalid phones, in-file phone
// duplicates, opted-out phone statuses, unsubscribed emails and DNC tags; plus a few thousand notes and
// texts and a thousand calls (some with recordings) for a subset of the people.
//
// Every stage runs end to end, in the product's order: contacts → ownership → notes → messages →
// call_recordings → consent (dry run → approve → commit → verify), with the counts reconciled exactly
// and the committed rows recounted from the database.
//
// Timing: docs/PERFORMANCE.md gives the import dry run NO latency budget ("reported only, as a
// background job"). The only documented limit is the dry run's 10-minute statement timeout on its
// whole-book read (BULK_STATEMENT_TIMEOUT, imports/repos/existing.ts), so that is the only time this
// test asserts; every stage's dry-run and commit time is logged (console.info) for the report.
//
// Gated: at 50,000 people the whole journey takes far longer than the normal suite allows (the commit
// writes each contact and each assignment through the per-contact ownership engine; the 1,000-person
// all-stage run in load.test.ts already takes ~1.5 min). Run it explicitly:
//
//   cd apps/api && IMPORT_LARGE=1 pnpm exec vitest run src/imports/fub.large.test.ts
//
// IMPORT_LARGE_PEOPLE=<n> runs the same journey at another size (default 50,000; the history subsets
// scale with it). Without IMPORT_LARGE the file is skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Category } from '@realty/core/import';
import type { FubDataset } from './fub.js';
import { BULK_STATEMENT_TIMEOUT } from './repos/existing.js';
import { CHUNKS_PER_RUN } from './commit.js';
import { type ImportWorld, type ImportsHarness, type StageView, approve, batchOf, call, commitStage, dryRunStage, freshReauth, importWorld, importsHarness, mapAgents, startFub, stageOf, verify } from './testing.js';

const ENABLED = process.env.IMPORT_LARGE === '1' || process.env.IMPORT_LARGE === 'true';
const N = Number(process.env.IMPORT_LARGE_PEOPLE ?? 50_000);
const KEY = 'fub-large-key-0001';
/** the documented limit (BULK_STATEMENT_TIMEOUT = '10min'); there is no tighter dry-run budget */
const DRY_RUN_LIMIT_MS = 10 * 60 * 1000;
/** generous: the 50k journey's contacts and ownership commits each run for tens of minutes */
const STAGE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** mulberry32: a tiny deterministic PRNG (same export on every run). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ana', 'Ben', 'Chloe', 'Diego', 'Emma', 'Farah', 'Gus', 'Hana', 'Ivan', 'Jada', 'Kofi', 'Lena', 'Mateo', 'Nia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq'];
const LAST = ['Nguyen', 'Smith', 'Garcia', 'Okafor', 'Kowalski', 'Haddad', 'Patel', 'Silva', 'Brown', 'Kim', 'Rossi', 'Cohen', "O'Neil", 'Müller', 'Dubois', 'Tanaka'];
const STAGES = ['Lead', 'Nurture', 'Hot Prospect', 'Past Client', 'Sphere'];
const SOURCES = ['Zillow', 'Realtor.com', 'Open House', 'Referral', 'Website', null];
const TAGS = ['Buyer', 'Seller', 'Investor', 'Pre-approved', 'First-time buyer', 'Relocation', 'Luxury'];
const AREAS = ['415', '510', '650', '312', '512', '617', '206', '303'];
const CITIES: [string, string, string][] = [
  ['Springfield', 'IL', '62701'],
  ['Austin', 'TX', '78701'],
  ['Denver', 'CO', '80202'],
  ['Seattle', 'WA', '98101'],
  ['Boston', 'MA', '02108'],
];

/** A unique, valid US number for slot k (two disjoint exchange ranges: primary and secondary). */
function phoneOf(k: number, secondary = false): string {
  const area = AREAS[k % AREAS.length] as string;
  const rest = Math.floor(k / AREAS.length);
  const exchange = (secondary ? 700 : 300) + Math.floor(rest / 10_000);
  return `(${area}) ${exchange}-${String(rest % 10_000).padStart(4, '0')}`;
}

/** The expected shape of the export, counted while it is generated. */
interface Expect {
  malformed: number;
  invalidPhone: number;
  inFileDuplicates: number;
  optedOutPhones: number;
  notes: number;
  notesOnRejected: number;
  texts: number;
  calls: number;
  recordings: number;
}

function largeFub(n: number): { data: FubDataset; ex: Expect } {
  const rnd = prng(0x6d6);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const ex: Expect = { malformed: 0, invalidPhone: 0, inFileDuplicates: 0, optedOutPhones: 0, notes: 0, notesOnRejected: 0, texts: 0, calls: 0, recordings: 0 };
  const people: unknown[] = [];
  const persons: { id: number; ok: boolean; dup: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const id = 200_000 + i;
    if (i % 100 === 37) {
      // ~1% malformed: the person record does not have FUB's shape (phones is not a list)
      people.push({ id, firstName: 'Broken', lastName: `Row${i}`, phones: 'n/a', emails: [{ value: `broken${i}@example.net` }] });
      ex.malformed += 1;
      persons.push({ id, ok: false, dup: false });
      continue;
    }
    const first = pick(FIRST);
    const last = pick(LAST);
    const dupOf = i % 200 === 199 ? i - 100 : null; // 0.5%: shares a phone with an earlier person
    const phones: { value: string; type: string; status: string; isPrimary: number }[] = [];
    const optedOut = i % 25 === 3;
    if (optedOut) ex.optedOutPhones += 1;
    phones.push({ value: phoneOf(dupOf ?? i), type: 'mobile', status: optedOut ? 'Opted Out' : 'Valid', isPrimary: 1 });
    if (dupOf !== null) ex.inFileDuplicates += 1;
    if (i % 3 === 0) phones.push({ value: phoneOf(i, true), type: pick(['home', 'work']), status: 'Valid', isPrimary: 0 });
    if (i % 100 === 53) {
      phones.push({ value: `555-${String(i % 10_000).padStart(4, '0')}`, type: 'home', status: 'Valid', isPrimary: 0 }); // no area code: E45
      ex.invalidPhone += 1;
    }
    const emails: { value: string; type: string; status: string; isPrimary: number }[] = [];
    if (i % 7 !== 0) emails.push({ value: `${first.toLowerCase().replace(/[^a-z]/g, '')}.${i}@${pick(['example.com', 'example.org', 'mail.example.net'])}`, type: 'home', status: i % 20 === 7 ? 'Unsubscribed' : 'Valid', isPrimary: 1 });
    if (i % 11 === 0) emails.push({ value: `work${i}@corp.example.com`, type: 'work', status: 'Valid', isPrimary: 0 });
    const tags = TAGS.filter(() => rnd() < 0.2);
    if (i % 500 === 11) tags.push('DNC');
    const [city, state, code] = pick(CITIES);
    const source = pick(SOURCES);
    const person: Record<string, unknown> = {
      id,
      created: new Date(Date.UTC(2019, 0, 1) + Math.floor(rnd() * 6 * 365) * 86_400_000).toISOString().replace('.000', ''),
      firstName: first,
      lastName: last,
      stage: STAGES[i % STAGES.length],
      ...(source ? { source } : {}),
      tags,
      phones,
      emails,
      ...(i % 2 === 0 ? { addresses: [{ type: 'home', street: `${1 + (i % 9_000)} ${pick(['Main', 'Oak', 'Elm', 'Pine'])} St`, city, state, code, country: 'US' }] } : {}),
      ...(i % 4 === 0 ? { customBirthday: `19${50 + (i % 50)}-0${1 + (i % 9)}-1${i % 10}` } : {}),
      ...(i % 5 === 0 ? { customBudget: String(200_000 + (i % 40) * 25_000) } : {}),
      ...(i % 6 === 0 ? { customPreferredArea: pick(['Downtown', 'Suburbs', 'Waterfront']) } : {}),
      smsOptIn: i % 4 === 0,
      emailOptIn: i % 3 === 0,
    };
    if (i % 50 !== 0) person.assignedUserId = i % 2 === 0 ? 11 : 12; // 2% unassigned
    people.push(person);
    persons.push({ id, ok: true, dup: dupOf !== null });
  }

  const notes: unknown[] = [];
  const textMessages: unknown[] = [];
  const calls: unknown[] = [];
  const recordings: Record<string, Uint8Array> = {};
  // History never names an in-file duplicate person: that is a known product bug (the dry run plans it,
  // the commit fails it PARENT_NOT_FOUND), reproduced on its own below ("found by M6"). At 50k the subsets
  // below never hit those people anyway (they are i % 200 === 199); the guard matters for small sizes.
  const histEvery = Math.max(1, Math.round(n / 5_000)); // ~5,000 notes and ~5,000 texts at 50k
  for (let i = 0; i < n; i += histEvery) {
    const p = persons[i] as { id: number; ok: boolean; dup: boolean };
    if (p.dup || !p.ok) continue;
    notes.push({ id: 5_000_000 + i, personId: p.id, ...(i % 3 === 0 ? { subject: 'Call recap' } : {}), body: i % 4 === 0 ? `<p>Wants <b>${2 + (i % 3)} beds</b> &amp; a yard.</p>` : `Followed up about listing ${i}.`, isHtml: i % 4 === 0, created: '2025-01-15T16:00:00Z', createdById: i % 2 === 0 ? 11 : 12 });
    textMessages.push({ id: 6_000_000 + i, personId: p.id, created: '2025-03-01T18:00:00Z', isIncoming: true, message: `Is ${i} Elm St still available?`, status: 'Received' });
    if (i % (histEvery * 2) === 0) textMessages.push({ id: 6_500_000 + i, personId: p.id, created: '2025-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 });
  }
  // a note on each of the first ten malformed people: the dry run rejects it (its person was rejected)
  for (const p of persons.filter((x) => !x.ok).slice(0, 10)) {
    notes.push({ id: 5_900_000 + p.id, personId: p.id, body: 'Note on a malformed person', created: '2025-01-16T16:00:00Z' });
    ex.notesOnRejected += 1;
  }
  const callEvery = Math.max(1, Math.round(n / 1_000)); // ~1,000 calls at 50k
  for (let i = 0; i < n; i += callEvery) {
    const p = persons[i] as { id: number; ok: boolean; dup: boolean };
    if (p.dup || !p.ok) continue;
    const withRec = calls.length < 20;
    const url = `https://fub.example/rec/large-${i}?token=secret`;
    calls.push({ id: 7_000_000 + i, personId: p.id, created: '2025-04-04T15:00:00Z', isIncoming: i % 2 === 0, duration: i % 5 === 0 ? 0 : 30 + (i % 600), outcome: i % 5 === 0 ? 'No Answer' : 'Interested', ...(i % 3 === 0 ? { note: 'Talked about schools' } : {}), userId: 11, ...(withRec ? { recordingUrl: url } : {}) });
    if (withRec) recordings[url] = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, i % 256]);
  }
  ex.notes = notes.length;
  ex.texts = textMessages.length;
  ex.calls = calls.length;
  ex.recordings = Object.keys(recordings).length;
  return {
    data: {
      users: [
        { id: 11, name: 'Alex Agent' },
        { id: 12, name: 'Bea Agent' },
      ],
      people,
      notes,
      textMessages,
      emails: [],
      calls,
      recordings,
    },
    ex,
  };
}

describe.skipIf(!ENABLED)(`journey M6: a ${N.toLocaleString('en-US')}-person FUB import`, () => {
  let ih: ImportsHarness;
  let w: ImportWorld;
  let batchId: string;
  let ex: Expect;
  const times: Record<string, Record<string, number>> = {};
  const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];
  const n1 = async (text: string, args: unknown[]) => Number(((await q<{ n: string }>(text, args))[0] as { n: string }).n);

  beforeAll(async () => {
    ih = await importsHarness();
    w = await importWorld(ih);
    const g = largeFub(N);
    ex = g.ex;
    ih.fub.add(KEY, g.data);
  }, STAGE_TIMEOUT_MS);
  afterAll(async () => {
    console.info(`imports M6 large (${N} people) ms`, JSON.stringify(times));
    await ih?.close();
  });

  const reconciles = (c: NonNullable<StageView['counts']>) => c.source === c.willImport + c.needsReview + c.rejected + c.duplicate;
  /** records the commit rejected (COMMIT_FAILED), with the error code each one hit */
  const commitFailed = (stageId: string) =>
    q<{ source_ref: string; detail: string }>(
      `SELECT r.source_ref, i->>'detail' AS detail FROM import_records r, jsonb_array_elements(r.issues) i WHERE r.stage_id = $1 AND i->>'code' = 'COMMIT_FAILED' ORDER BY r.source_ref`,
      [stageId],
    );

  /** The Admin's step-up window (15 minutes) lapses during the long commits: they re-authenticate before each step. */
  const reauth = () => freshReauth(ih.h, w.admin);

  /**
   * POST …/commit, then drain until the stage leaves `committing`. The commit job yields after
   * CHUNKS_PER_RUN chunks (10,000 records) and app.reschedule_job puts it back at least 1 s in the future,
   * so the harness's one-shot drain() (testing.ts commitStage) returns after the first 10,000 records with
   * the stage still committing; the real worker loop just polls again, which is what this does.
   */
  async function commitAll(cat: Category): Promise<StageView> {
    await reauth();
    const r = await call(w.admin, 'POST', `/imports/${batchId}/stages/${cat}/commit`);
    expect(r.status).toBe(202);
    const maxRuns = Math.ceil(N / (1000 * CHUNKS_PER_RUN)) * 4 + 10;
    for (let run = 0; run < maxRuns; run++) {
      await ih.drain();
      await reauth();
      const s = stageOf(await batchOf(w.admin, batchId), cat);
      if (s.status !== 'committing') return s;
      await new Promise((res) => setTimeout(res, 1_100));
    }
    throw new Error(`commit ${cat} still committing after ${maxRuns} worker drains`);
  }

  /** dry run (timed, ≤ the 10-minute statement timeout) → approve → commit (timed) → verify. */
  async function runStage(cat: Category, expectSource: number): Promise<{ dry: StageView; done: StageView }> {
    await reauth();
    const t = performance.now();
    const dry = await dryRunStage(ih, w.admin, batchId, cat);
    const dryMs = Math.round(performance.now() - t);
    console.info(`imports M6 ${cat} dry run: ${dryMs} ms`, JSON.stringify(dry.counts));
    expect(dry.status).toBe('dry_run_ready');
    expect(dry.blockers).toEqual([]);
    expect(dry.counts!.source).toBe(expectSource);
    expect(reconciles(dry.counts!)).toBe(true);
    // the only documented limit (BULK_STATEMENT_TIMEOUT); PERFORMANCE.md sets no dry-run budget
    expect(BULK_STATEMENT_TIMEOUT).toBe('10min');
    expect(dryMs).toBeLessThan(DRY_RUN_LIMIT_MS);

    await reauth();
    const a = await approve(w.admin, batchId, cat, dry.dryRunSha256 as string);
    expect(a.status).toBe(200);
    expect(a.body.expected).toEqual({ source: expectSource, imported: dry.counts!.willImport, needs_review: dry.counts!.needsReview, rejected: dry.counts!.rejected, duplicate: dry.counts!.duplicate });

    const tc = performance.now();
    const done = await commitAll(cat);
    const commitMs = Math.round(performance.now() - tc);
    console.info(`imports M6 ${cat} commit: ${commitMs} ms`, JSON.stringify(done.counts));
    expect(done.status).toBe('committed');
    expect(await commitFailed(done.id)).toEqual([]);
    const c = done.counts!;
    expect(c.source).toBe(expectSource);
    expect(c.source).toBe((c.imported ?? 0) + c.needsReview + c.rejected + c.duplicate);

    await reauth();
    const tv = performance.now();
    const v = await verify(w.admin, batchId, cat);
    const verifyMs = Math.round(performance.now() - tv);
    expect(v.view.diffs).toEqual([]);
    expect(v.view.matches).toBe(true);
    expect(v.view.sample.length).toBeGreaterThan(0);
    expect(v.view.sample.filter((s) => !s.same)).toEqual([]);
    expect(v.res.status).toBe(200);
    expect(stageOf(await batchOf(w.admin, batchId), cat).status).toBe('verified');
    times[cat] = { dryRun: dryMs, commit: commitMs, verify: verifyMs };
    return { dry, done };
  }

  it(
    'snapshot: every collection is read once and counted',
    async () => {
      await reauth();
      const t = performance.now();
      const b = await startFub(ih, w.admin, KEY);
      times.snapshot = { total: Math.round(performance.now() - t) };
      batchId = b.id;
      expect(b.status).toBe('dry_run');
      expect(b.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.sourceCounts).toMatchObject({ contacts: N, ownership: N, notes: ex.notes, messages: ex.texts, call_recordings: ex.calls, consent: N });
      expect(ih.fub.calls.filter((c) => c.op === 'recording')).toHaveLength(ex.recordings);
      await mapAgents(w.admin, batchId, w);
    },
    STAGE_TIMEOUT_MS,
  );

  it(
    'contacts: counts reconcile exactly; the commit writes exactly the imported count; verify passes',
    async () => {
      const { dry, done } = await runStage('contacts', N);
      const d = dry.counts!;
      // every malformed person is rejected; every in-file phone duplicate is a duplicate; every person with
      // an invalid phone (and nothing else wrong) waits for review instead of importing silently
      expect(d.rejected).toBe(ex.malformed);
      expect(d.duplicate).toBe(ex.inFileDuplicates);
      expect(d.needsReview).toBeGreaterThanOrEqual(ex.invalidPhone - Math.ceil(ex.invalidPhone / 100));
      expect(d.willImport).toBeGreaterThan(N * 0.9);
      expect(done.counts!.imported).toBe(d.willImport);
      expect(await n1('SELECT count(*) AS n FROM contacts WHERE tenant_id = $1 AND import_batch_id = $2', [w.tenantId, batchId])).toBe(done.counts!.imported);
      // R-IMPORT-8 / E40: created unassigned through the ownership engine; opted-out phones are revoked at once
      expect(await n1("SELECT count(*) AS n FROM contacts WHERE tenant_id = $1 AND import_batch_id = $2 AND ownership_state <> 'unassigned'", [w.tenantId, batchId])).toBe(0);
      expect(await n1("SELECT count(*) AS n FROM consent_events WHERE tenant_id = $1 AND source = 'import_fub' AND event_type = 'revoke' AND channel = 'sms'", [w.tenantId])).toBeGreaterThan(0);
    },
    STAGE_TIMEOUT_MS,
  );

  it(
    'ownership: imported assignments to the two mapped agents; counts reconcile; verify passes',
    async () => {
      const { done } = await runStage('ownership', N);
      const owned = await q<{ owner_user_id: string; n: string }>(
        "SELECT owner_user_id, count(*) AS n FROM contacts WHERE tenant_id = $1 AND import_batch_id = $2 AND ownership_state = 'owned' GROUP BY owner_user_id",
        [w.tenantId, batchId],
      );
      expect(new Set(owned.map((o) => o.owner_user_id))).toEqual(new Set([w.agents[0]!.userId, w.agents[1]!.userId]));
      const assigned = owned.reduce((s, o) => s + Number(o.n), 0);
      expect(assigned).toBe(await n1("SELECT count(*) AS n FROM lead_ownership_events WHERE tenant_id = $1 AND type = 'imported' AND to_state = 'owned'", [w.tenantId]));
      expect(assigned).toBeLessThanOrEqual(done.counts!.imported ?? 0);
      // R-IMPORT-8: no offer, no SLA timers
      expect(await n1("SELECT count(*) AS n FROM jobs WHERE tenant_id = $1 AND kind IN ('ownership.first_touch_breach','ownership.auto_release','ownership.offer_expiry')", [w.tenantId])).toBe(0);
    },
    STAGE_TIMEOUT_MS,
  );

  it(
    'notes, messages and call recordings: imported history reconciles and verifies',
    async () => {
      const notes = await runStage('notes', ex.notes);
      expect(notes.dry.counts!.rejected).toBe(ex.notesOnRejected);
      expect(await n1('SELECT count(*) AS n FROM notes WHERE tenant_id = $1 AND imported AND import_record_id IN (SELECT id FROM import_records WHERE stage_id = $2)', [w.tenantId, notes.done.id])).toBe(notes.done.counts!.imported);
      const msgs = await runStage('messages', ex.texts);
      expect(await n1('SELECT count(*) AS n FROM messages WHERE tenant_id = $1 AND imported', [w.tenantId])).toBe(msgs.done.counts!.imported);
      const calls = await runStage('call_recordings', ex.calls);
      expect(await n1('SELECT count(*) AS n FROM calls WHERE tenant_id = $1', [w.tenantId])).toBe(calls.done.counts!.imported);
      expect(await n1('SELECT count(*) AS n FROM recordings WHERE tenant_id = $1', [w.tenantId])).toBeGreaterThan(0);
    },
    STAGE_TIMEOUT_MS,
  );

  it(
    'consent: grants, revocations and DNC reconcile and verify; the batch is committed',
    async () => {
      await runStage('consent', N);
      await reauth();
      const b = await batchOf(w.admin, batchId);
      expect(b.status).toBe('committed');
      expect(b.stages.map((s) => s.status)).toEqual(['verified', 'verified', 'verified', 'verified', 'verified', 'verified']);
      const rep = await call<{ categories: { category: string; source: number; reconciles: boolean }[] }>(w.admin, 'GET', `/imports/${batchId}/report`);
      expect(rep.status).toBe(200);
      expect(rep.body.categories.every((c) => c.reconciles)).toBe(true);
    },
    STAGE_TIMEOUT_MS,
  );
});

// ---- found by M6 (runs in the normal suite: a handful of records) ------------------------------------------
//
// PRODUCT BUG (not fixed here; see the report): history (notes / texts / emails / calls) of a person whose
// contacts record ended `duplicate` with a `skip` plan — an in-file duplicate (IN_FILE_DUPLICATE: same id,
// phone or email as an earlier row) or an exact match to an existing contact with nothing new to fill — is
// planned `will_import` by the history dry run (core resolveParent sees the person as a pending 'attach':
// api contactsStageMap / core contactsStagePlan map every non-create, non-rejected record to 'attach'),
// but the contacts commit wrote no external_ref for that person (a skip writes nothing), so the history
// commit cannot resolve the parent and rejects the record COMMIT_FAILED / PARENT_NOT_FOUND. The dry run the
// Admin approved did not predict the commit (R-IMPORT-4). Whether such history should attach to the
// surviving contact (the record's skip.existingId) or be rejected at the dry run is a product decision, so
// the invariant below only requires that the commit does what the reviewed dry run said. `it.fails`: these
// pass while the bug is present and start failing (to be flipped to `it`) once it is fixed.
describe('found by M6: history of a person whose contacts record was a skipped duplicate', () => {
  let ih: ImportsHarness;
  let w: ImportWorld;
  const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];
  beforeAll(async () => {
    ih = await importsHarness();
    w = await importWorld(ih);
  });
  afterAll(async () => {
    await ih?.close();
  });

  const PHONE = '(415) 820-0001';
  /** contacts (dry run → approve → commit → verify), ownership skipped, then the notes dry run → approve → commit */
  async function importWithNote(key: string, people: unknown[], notePersonId: number): Promise<{ contacts: StageView; planned: StageView; committed: StageView; failed: { source_ref: string; detail: string }[] }> {
    ih.fub.add(key, { users: [], people, notes: [{ id: 9_000 + notePersonId, personId: notePersonId, body: 'Note on the duplicate row', created: '2025-01-15T16:00:00Z' }] });
    const b = await startFub(ih, w.admin, key);
    const c = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', c.dryRunSha256 as string)).status).toBe(200);
    expect((await commitStage(ih, w.admin, b.id, 'contacts')).status).toBe('committed');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/skip`)).status).toBe(200);
    const planned = await dryRunStage(ih, w.admin, b.id, 'notes');
    expect((await approve(w.admin, b.id, 'notes', planned.dryRunSha256 as string)).status).toBe(200);
    const committed = await commitStage(ih, w.admin, b.id, 'notes');
    const failed = await q<{ source_ref: string; detail: string }>(
      `SELECT r.source_ref, i->>'detail' AS detail FROM import_records r, jsonb_array_elements(r.issues) i WHERE r.stage_id = $1 AND i->>'code' = 'COMMIT_FAILED'`,
      [committed.id],
    );
    return { contacts: c, planned, committed, failed };
  }

  type Run = Awaited<ReturnType<typeof importWithNote>>;
  const runs: { inFile?: Run; existing?: Run } = {};

  it('setup: an in-file duplicate person (302 shares 301\'s phone) with a note; contacts committed, the note planned', async () => {
    runs.inFile = await importWithNote(
      'fub-m6-dup-key-01',
      [
        { id: 301, firstName: 'Ann', lastName: 'One', phones: [{ value: PHONE, type: 'mobile', status: 'Valid' }] },
        { id: 302, firstName: 'Ann', lastName: 'Again', phones: [{ value: PHONE, type: 'mobile', status: 'Valid' }] }, // IN_FILE_DUPLICATE of 301
      ],
      302,
    );
    expect(runs.inFile.contacts.counts).toMatchObject({ source: 2, willImport: 1, duplicate: 1 });
    expect(runs.inFile.planned.counts).toMatchObject({ source: 1, willImport: 1 });
  });

  it.fails('an in-file duplicate person: the note the dry run planned to import does not fail at commit (R-IMPORT-4)', () => {
    const r = runs.inFile as Run;
    // today: committed { imported: 0, rejected: 1 } with [{ source_ref: 'fub:notes/9302', detail: 'PARENT_NOT_FOUND' }]
    expect(r.failed).toEqual([]);
    expect(r.committed.counts).toMatchObject({ imported: r.planned.counts!.willImport, rejected: r.planned.counts!.rejected });
  });

  it('setup: a second account has Ann One (301) again under id 401, nothing new to fill, with a note', async () => {
    runs.existing = await importWithNote('fub-m6-dup-key-02', [{ id: 401, firstName: 'Ann', lastName: 'One', phones: [{ value: PHONE, type: 'mobile', status: 'Valid' }] }], 401);
    expect(runs.existing.contacts.counts).toMatchObject({ source: 1, willImport: 0, duplicate: 1 });
    expect(runs.existing.planned.counts).toMatchObject({ source: 1, willImport: 1 });
  });

  it.fails('an exact match to an existing contact with nothing new: the planned note does not fail at commit (R-IMPORT-4)', () => {
    const r = runs.existing as Run;
    // today: committed { imported: 0, rejected: 1 } with [{ source_ref: 'fub:notes/9401', detail: 'PARENT_NOT_FOUND' }]
    expect(r.failed).toEqual([]);
    expect(r.committed.counts).toMatchObject({ imported: r.planned.counts!.willImport, rejected: r.planned.counts!.rejected });
  });
});
