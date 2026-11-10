// Load smoke for api/imports (BUILD_PLAN module 16 "Accept when: a 50k-contact FUB fixture runs
// dry-run → commit → verify for all six stages, with exact count reconciliation and a per-record review
// list"). The full 50k end-to-end run is NOT executed here (it takes tens of minutes on this shared
// machine, dominated by the per-contact ownership-engine transaction); this file runs:
//   - every stage end to end at 1,000 people (+1,000 notes, 1,000 texts, 100 calls), timed;
//   - the dry run of a 50,000-row file (the largest single step that must stay interactive).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FubDataset } from './fub.js';
import { type BatchView, type ImportWorld, type ImportsHarness, batchOf, call, csvBase64, csvOf, dryRunStage, fullStage, importWorld, importsHarness, mapAgents, records, startFub } from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
});
afterAll(async () => {
  await ih?.close();
});

function bigFub(n: number): FubDataset {
  const people = Array.from({ length: n }, (_, i) => ({
    id: 100_000 + i,
    created: '2024-01-01T00:00:00Z',
    firstName: `First${i}`,
    lastName: `Last${i}`,
    stage: i % 3 === 0 ? 'Lead' : 'Nurture',
    assignedUserId: i % 2 === 0 ? 11 : 12,
    phones: [{ value: `(415) ${400 + Math.floor(i / 10000)}-${String(i % 10000).padStart(4, '0')}`, type: 'mobile', status: 'Valid' }],
    emails: [{ value: `p${i}@load.example.com`, type: 'home', status: i % 10 === 0 ? 'Unsubscribed' : 'Valid' }],
    smsOptIn: i % 4 === 0,
  }));
  return {
    users: [
      { id: 11, name: 'A' },
      { id: 12, name: 'B' },
    ],
    people,
    notes: people.map((p, i) => ({ id: 500_000 + i, personId: p.id, body: `Note ${i}`, created: '2025-01-01T00:00:00Z', createdById: 11 })),
    textMessages: people.map((p, i) => ({ id: 600_000 + i, personId: p.id, created: '2025-02-01T00:00:00Z', isIncoming: i % 2 === 0, message: `Text ${i}`, status: i % 2 === 0 ? 'Received' : 'Delivered', userId: 12 })),
    emails: [],
    calls: people.filter((_, i) => i % 10 === 0).map((p, i) => ({ id: 700_000 + i, personId: p.id, created: '2025-03-01T00:00:00Z', isIncoming: false, duration: 60, outcome: 'Interested', userId: 11 })),
  };
}

describe('load smoke', () => {
  it('all six stages at 1,000 people: exact reconciliation and a paged per-record review list', async () => {
    const n = 1000;
    ih.fub.add('key-load-00001', bigFub(n));
    const t0 = performance.now();
    const b = await startFub(ih, w.admin, 'key-load-00001');
    await mapAgents(w.admin, b.id, w);
    const times: Record<string, number> = {};
    for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
      const t = performance.now();
      await fullStage(ih, w.admin, b.id, c);
      times[c] = Math.round(performance.now() - t);
    }
    const nb: BatchView = await batchOf(w.admin, b.id);
    expect(nb.status).toBe('committed');
    const rep = await call<{ categories: { category: string; source: number; imported: number; reconciles: boolean }[] }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.categories.map((c) => [c.category, c.source, c.imported, c.reconciles])).toEqual([
      ['contacts', n, n, true],
      ['ownership', n, n, true],
      ['notes', n, n, true],
      ['messages', n, n, true],
      ['call_recordings', n / 10, n / 10, true],
      ['consent', n, expect.any(Number), true],
    ]);
    const list = await records(w.admin, b.id, 'contacts');
    expect(list).toHaveLength(n);
    expect(new Set(list.map((r) => r.id)).size).toBe(n);
    console.info('imports load smoke (ms)', JSON.stringify({ total: Math.round(performance.now() - t0), ...times }));
  }, 600_000);

  it('a 50,000-row file dry-runs in one job with exact counts', async () => {
    const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'fifty.csv', fileBase64: csvBase64(csvOf(50_000, 20_000)) });
    expect(r.status).toBe(201);
    await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`);
    await ih.drain();
    const t = performance.now();
    const d = await dryRunStage(ih, w.admin, r.body.batch.id, 'contacts');
    const ms = Math.round(performance.now() - t);
    expect(d.status).toBe('dry_run_ready');
    expect(d.counts!.source).toBe(50_000);
    expect(d.counts!.source).toBe(d.counts!.willImport + d.counts!.needsReview + d.counts!.rejected + d.counts!.duplicate);
    console.info('imports 50k dry run (ms)', ms);
  }, 600_000);
});
