// Test helpers for the api/imports integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server (or the module's public functions) as
// app_user; jobs run through the real worker loop on the `bulk` queue. The superuser pool only reads
// state back and, where a test needs a clock, moves stored instants.
import { randomUUID } from 'node:crypto';
import type { Category } from '@realty/core/import';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, freshReauth } from '../admin/testing.js';
import { type LeadsWorld, leadsWorld } from '../leads/testing.js';
import { routeModules } from '../routes.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { FakeFub, type FubDataset } from './fub.js';
import { makeImportHandlers } from './handlers.js';
import { makeImportsRoutes } from './routes.js';
import type { ImportDeps } from './types.js';

export { call, freshReauth };

export interface ImportsHarness {
  h: ApiHarness;
  fub: FakeFub;
  deps: ImportDeps;
  /** overrides applied to the deps the worker uses (crash seam, chunk size) */
  workerDeps: Partial<ImportDeps>;
  drain(): Promise<number>;
  close(): Promise<void>;
}

export async function importsHarness(): Promise<ImportsHarness> {
  const fub = new FakeFub();
  const holder: { deps: ImportDeps | null } = { deps: null };
  const routes = [...routeModules.filter((m) => m.name !== 'imports'), makeImportsRoutes(() => holder.deps as ImportDeps)];
  const h = await createApiHarness({ routeModules: routes });
  const p = h.app.platform;
  const deps: ImportDeps = { db: p.db, envelope: p.envelope, ids: p.ids, storage: p.providers.storage, fub: fub.connector };
  holder.deps = deps;
  const workerDeps: Partial<ImportDeps> = {};
  const ih: ImportsHarness = {
    h,
    fub,
    deps,
    workerDeps,
    async drain() {
      const registry = new HandlerRegistry().registerAll(makeImportHandlers(() => ({ ...deps, ...workerDeps })));
      const worker = createWorker({ db: h.database, registry, providers: h.providers, queues: ['bulk'], concurrency: 1, worker: `imports-test-${randomUUID().slice(0, 8)}`, idleMs: 5, log: silentLogger });
      return worker.drain(400);
    },
    close: () => h.close(),
  };
  return ih;
}

export interface ImportWorld extends LeadsWorld {
  admin: TestClient;
}

export async function importWorld(ih: ImportsHarness): Promise<ImportWorld> {
  const w = await leadsWorld(ih.h, { agents: 2, others: ['admin'] });
  const admin = w.others[0] as TestClient;
  await freshReauth(ih.h, admin);
  await freshReauth(ih.h, w.owner);
  return { ...w, admin };
}

export const FUB_KEY = 'fub-test-key-0001';

/**
 * The golden Follow Up Boss fixture: every category and the consent edge cases (E39–E44) — an
 * unsubscribed person, a DNC tag, an opted-out phone, custom fields, an invalid phone, an unmapped
 * agent, a malformed person, an orphan note, HTML, emails, a call with a recording.
 * FUB users 11 and 12 are the two test agents (mapped by the tests).
 */
export function fubFixture(o: { prefix?: number; phoneSeed?: number } = {}): FubDataset {
  const p = o.prefix ?? 1000;
  const s = String((o.phoneSeed ?? 1) % 9).padStart(1, '0');
  const ph = (n: number) => `(415) 55${s}-${String(1000 + n).slice(-4)}`;
  return {
    users: [
      { id: 11, name: 'Alex Agent' },
      { id: 12, name: 'Bea Agent' },
      { id: 99, name: 'Gone Agent' },
    ],
    people: [
      {
        id: p + 1,
        created: '2023-03-01T14:00:00Z',
        firstName: 'Jane',
        lastName: 'Doe',
        stage: 'Hot Prospect',
        source: 'Zillow',
        assignedUserId: 11,
        tags: ['Buyer', 'Pre-approved'],
        emails: [{ value: `jane.${p}@example.com`, type: 'home', status: 'Valid', isPrimary: 1 }],
        phones: [
          { value: ph(1), type: 'mobile', status: 'Valid', isPrimary: 1 },
          { value: '555-0100', type: 'home', status: 'Valid', isPrimary: 0 },
        ],
        addresses: [{ type: 'home', street: '1 Main St', city: 'Springfield', state: 'IL', code: '62701', country: 'US' }],
        customBirthday: '1980-05-01',
        smsOptIn: true,
        emailOptIn: true,
      },
      {
        id: p + 2,
        created: '2022-01-05T10:00:00Z',
        name: 'Bob Unsub',
        stage: 'Nurture',
        assignedUserId: 12,
        emails: [{ value: `bob.${p}@example.org`, type: 'work', status: 'Unsubscribed', isPrimary: 1 }],
        phones: [{ value: ph(2), type: 'cell', status: 'Opted Out', isPrimary: 1 }],
        smsOptIn: true,
        emailOptIn: true,
      },
      {
        id: p + 3,
        created: '2021-07-07T07:07:07Z',
        firstName: 'Carla',
        lastName: 'Dnc',
        stage: 'Sphere',
        assignedPondId: 3,
        tags: ['DNC'],
        phones: [{ value: ph(3), type: 'mobile', status: 'Valid' }],
      },
      { id: p + 4, created: '2024-02-02T02:02:02Z', firstName: 'Dan', lastName: 'Nostage', stage: 'Waiting On Lender', emails: [{ value: `dan.${p}@example.com`, type: 'home', status: 'Valid' }] },
      { id: p + 5, created: '2024-03-03T03:03:03Z', firstName: 'Erin', lastName: 'Unmapped', stage: 'Lead', assignedUserId: 99, phones: [{ value: ph(5), type: 'mobile', status: 'Valid' }] },
      { id: p + 6, created: '2024-04-04T04:04:04Z', phones: [{ value: '555-0100', type: 'mobile', status: 'Valid' }] },
      { firstName: 'Nobody' },
    ],
    notes: [
      { id: p * 10 + 1, personId: p + 1, subject: 'Call recap', body: '<p>Wants <b>3 beds</b> &amp; a yard.</p>', isHtml: true, created: '2026-01-15T16:00:00Z', createdById: 11 },
      { id: p * 10 + 2, personId: p + 2, body: 'Asked to stop texting.', created: '2026-02-01T10:00:00Z', createdById: 12 },
      { id: p * 10 + 3, personId: 424242, body: 'Orphan note', created: '2026-02-01T10:00:00Z' },
    ],
    textMessages: [
      { id: p * 10 + 1, personId: p + 1, created: '2026-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' },
      { id: p * 10 + 2, personId: p + 1, created: '2026-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 },
    ],
    emails: [{ id: p * 10 + 1, personId: p + 1, created: '2026-03-03T12:00:00Z', isIncoming: false, subject: 'Listings for you', body: 'Here are three homes.', status: 'Sent', userId: 11 }],
    calls: [
      { id: p * 10 + 1, personId: p + 1, created: '2026-03-04T15:00:00Z', isIncoming: false, duration: 312, outcome: 'Interested', note: 'Talked about schools', userId: 11, recordingUrl: `https://fub.example/rec/${p}1?token=secret` },
      { id: p * 10 + 2, personId: p + 2, created: '2026-03-05T15:00:00Z', isIncoming: false, duration: 0, outcome: 'No Answer', userId: 12 },
    ],
    recordings: { [`https://fub.example/rec/${p}1?token=secret`]: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]) },
  };
}

export type Res<T = Record<string, unknown>> = Awaited<ReturnType<typeof call<T>>>;

export interface StageView {
  id: string;
  category: Category;
  status: string;
  counts: { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number } | null;
  dryRunSha256: string | null;
  blockers: { code: string }[];
  revert: Record<string, unknown> | null;
}
export interface BatchView {
  id: string;
  status: string;
  stages: StageView[];
  sourceCounts: Record<string, number | null>;
  connectionTest: string[];
  snapshotSha256: string | null;
}

export async function batchOf(c: TestClient, id: string): Promise<BatchView> {
  const r = await call<{ batch: BatchView }>(c, 'GET', `/imports/${id}`);
  if (r.status !== 200) throw new Error(`batch: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.batch;
}

export function stageOf(b: BatchView, c: Category): StageView {
  const s = b.stages.find((x) => x.category === c);
  if (!s) throw new Error(`no stage ${c}`);
  return s;
}

export async function startFub(ih: ImportsHarness, c: TestClient, key = FUB_KEY): Promise<BatchView> {
  const r = await call<{ batch: BatchView }>(c, 'POST', '/imports', { source: 'fub_api', apiKey: key });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  const s = await call(c, 'POST', `/imports/${r.body.batch.id}/snapshot`);
  if (s.status !== 202) throw new Error(`snapshot: ${s.status} ${JSON.stringify(s.body)}`);
  await ih.drain();
  return batchOf(c, r.body.batch.id);
}

export async function mapAgents(c: TestClient, batchId: string, w: ImportWorld, extra: { sourceRef: string; kind?: 'user' | 'pond'; target: unknown }[] = []): Promise<void> {
  const r = await call(c, 'PUT', `/imports/${batchId}/user-mappings`, {
    mappings: [
      { sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } },
      { sourceRef: '12', target: { kind: 'user', userId: w.agents[1]!.userId } },
      ...extra,
    ],
  });
  if (r.status !== 200) throw new Error(`mapping: ${r.status} ${JSON.stringify(r.body)}`);
}

/**
 * PARITY 65 (R-PAR-46): the Admin maps every source stage label the plain vocabulary cannot place. Tests that
 * are not about stages map them to `new` explicitly (the behaviour before the stage map); a stage label is
 * never silently `new` any more, so the contacts approval is blocked until this is done.
 */
export async function mapUnmappedStages(c: TestClient, batchId: string, to = 'new', extra: Record<string, unknown> = {}): Promise<void> {
  const g = await call<{ options: { stageMap: Record<string, string>; keepStageAsTag: boolean; fields: Record<string, unknown> }; stages: { label: string; mapped: string | null }[] }>(c, 'GET', `/imports/${batchId}/parity`);
  if (g.status !== 200) throw new Error(`parity: ${g.status} ${JSON.stringify(g.body)}`);
  const missing = g.body.stages.filter((s) => s.mapped === null);
  if (missing.length === 0 && Object.keys(extra).length === 0) return;
  const stageMap = { ...g.body.options.stageMap, ...Object.fromEntries(missing.map((s) => [s.label, to])) };
  const r = await call(c, 'PUT', `/imports/${batchId}/parity`, { ...g.body.options, stageMap, ...extra });
  if (r.status !== 200) throw new Error(`parity: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function dryRunStage(ih: ImportsHarness, c: TestClient, batchId: string, cat: Category): Promise<StageView> {
  if (cat === 'contacts') await mapUnmappedStages(c, batchId);
  const r = await call(c, 'POST', `/imports/${batchId}/stages/${cat}/dry-run`);
  if (r.status !== 202) throw new Error(`dry-run ${cat}: ${r.status} ${JSON.stringify(r.body)}`);
  await ih.drain();
  return stageOf(await batchOf(c, batchId), cat);
}

export async function approve(c: TestClient, batchId: string, cat: Category, sha: string): Promise<Res> {
  return call(c, 'POST', `/imports/${batchId}/stages/${cat}/approve`, { snapshotSha256: sha });
}

export async function commitStage(ih: ImportsHarness, c: TestClient, batchId: string, cat: Category): Promise<StageView> {
  const r = await call(c, 'POST', `/imports/${batchId}/stages/${cat}/commit`);
  if (r.status !== 202) throw new Error(`commit ${cat}: ${r.status} ${JSON.stringify(r.body)}`);
  await ih.drain();
  return stageOf(await batchOf(c, batchId), cat);
}

export interface Verification {
  expected: Record<string, number>;
  db: Record<string, number>;
  matches: boolean;
  diffs: unknown[];
  sample: { sourceRef: string; recordId: string; same: boolean; source: Record<string, unknown>; imported: Record<string, unknown> | null }[];
}

/** Opens the verification, confirms every sampled record as the verifier saw it, and verifies. */
export async function verify(c: TestClient, batchId: string, cat: Category): Promise<{ view: Verification; res: Res }> {
  const v = await call<Verification>(c, 'GET', `/imports/${batchId}/stages/${cat}/verification`);
  if (v.status !== 200) throw new Error(`verification ${cat}: ${v.status} ${JSON.stringify(v.body)}`);
  const res = await call(c, 'POST', `/imports/${batchId}/stages/${cat}/verify`, { spotChecks: v.body.sample.map((s) => ({ sourceRef: s.sourceRef, matches: s.same })) });
  return { view: v.body, res };
}

/** dry run → approve → commit → verify for one stage; returns the committed stage. */
export async function fullStage(ih: ImportsHarness, c: TestClient, batchId: string, cat: Category): Promise<StageView> {
  const d = await dryRunStage(ih, c, batchId, cat);
  if (d.status !== 'dry_run_ready') throw new Error(`dry run ${cat} ended ${d.status}`);
  const a = await approve(c, batchId, cat, d.dryRunSha256 as string);
  if (a.status !== 200) throw new Error(`approve ${cat}: ${a.status} ${JSON.stringify(a.body)}`);
  const s = await commitStage(ih, c, batchId, cat);
  if (s.status !== 'committed') throw new Error(`commit ${cat} ended ${s.status}`);
  const v = await verify(c, batchId, cat);
  if (v.res.status !== 200) throw new Error(`verify ${cat}: ${v.res.status} ${JSON.stringify(v.res.body)}`);
  return s;
}

export interface RecordView {
  id: string;
  sourceRef: string;
  outcome: string;
  dryRunOutcome: string | null;
  issues: { code: string; sentence: string }[];
  record: Record<string, unknown> | null;
  matchContactId: string | null;
  duplicateCandidates: { contactId: string }[];
  optOutNote: string | null;
  planned: string | null;
  targetId: string | null;
}

export async function records(c: TestClient, batchId: string, cat: Category, outcome?: string): Promise<RecordView[]> {
  const out: RecordView[] = [];
  let after: string | null = null;
  for (;;) {
    const q: URLSearchParams = new URLSearchParams({ limit: '200', ...(outcome ? { outcome } : {}), ...(after ? { after } : {}) });
    const r: Res<{ records: never[]; next: string | null }> = await call<{ records: never[]; next: string | null }>(c, 'GET', `/imports/${batchId}/stages/${cat}/records?${q.toString()}`);
    if (r.status !== 200) throw new Error(`records: ${r.status} ${JSON.stringify(r.body)}`);
    out.push(...r.body.records);
    if (!r.body.next) return out;
    after = r.body.next;
  }
}

export function csvBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** n distinct, valid US mobile numbers and emails. */
export function csvOf(n: number, offset = 0): string {
  const rows = ['First Name,Last Name,Mobile Phone,Email,Tags'];
  for (let i = offset; i < offset + n; i++) {
    rows.push(`Pat${i},Lead${i},(415) ${300 + Math.floor(i / 10000)}-${String(i % 10000).padStart(4, '0')},pat${i}@example.com,imported`);
  }
  return `${rows.join('\n')}\n`;
}
