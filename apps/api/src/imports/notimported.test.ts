// Owner decision B7 (2026-11-11, E233), amended 2026-11-21: Follow Up Boss tasks are not imported, and the
// import says so plainly. Appointments and deals are imported. Tasks are COUNTED (one-record count pages,
// `_metadata.total`; never a list, never a record) at the connection test and again at the snapshot. Counting
// never blocks the connection test, the snapshot or any stage. Everything runs on FakeFub.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  batchOf,
  call,
  csvBase64,
  fubFixture,
  fullStage,
  importWorld,
  importsHarness,
  mapAgents,
} from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
});
afterAll(async () => {
  await ih?.close();
});

const TAIL = "Realty OS doesn't bring tasks over: finish or note the open ones in Follow Up Boss before you switch.";
type NotImported = { tasks: number | null; countedAt?: string | null; keptFrom?: { tasks?: string }; lines: string[] } | null;
type Batch = BatchView & { notImported: NotImported };
const tasksOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Task ${i + 1}`, dueDate: '2026-12-01', assignedUserId: 11, isCompleted: false }));
const key = (k: string) => `fub-b7-${k}-${randomUUID().slice(0, 8)}`;
const taskCountsSince = (from: number) => ih.fub.calls.slice(from).filter((c) => c.collection === 'tasks');

async function report(batchId: string): Promise<{ notImported: NotImported }> {
  const r = await call<{ notImported: NotImported }>(w.admin, 'GET', `/imports/${batchId}/report`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('owner decision B7: FUB tasks are counted and said plainly not to come over', () => {
  it('E233 R-IMPORT-1 the connection test counts tasks (one-record count pages, never a list) and says they do not come over', async () => {
    const k = key('ct');
    ih.fub.add(k, { ...fubFixture({ prefix: 2100 }), tasks: tasksOf(3) });
    const before = ih.fub.calls.length;
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: 3, countedAt: 'connection_test', lines: [`Follow Up Boss has 3 tasks. ${TAIL}`] });
    const made = ih.fub.calls.slice(before);
    expect(made.every((c) => c.op === 'count')).toBe(true);
    expect(made.map((c) => c.collection)).toEqual(['people', 'notes', 'textMessages', 'emails', 'calls', 'users', 'appointments', 'deals', 'tasks']);
    expect(made.filter((c) => c.collection === 'tasks')).toHaveLength(1);
    expect(r.body.batch.connectionTest.join(' ')).not.toMatch(/\btasks?\b/i);
    expect(r.body.batch.sourceCounts).not.toHaveProperty('tasks');
    expect(r.body.batch.connectionTest.join(' ')).toMatch(/appointments found in Follow Up Boss/);
  });

  it('E233 the snapshot counts tasks again (never reading one), the final report says it, and tasks add no stage', async () => {
    const k = key('sn');
    ih.fub.add(k, { ...fubFixture({ prefix: 2200, phoneSeed: 2 }), tasks: tasksOf(2) });
    const from = ih.fub.calls.length;
    const created = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(created.body.batch.notImported?.tasks).toBe(2);
    ih.fub.mutate(k, (d) => {
      (d.tasks as unknown[]).push(...tasksOf(1238));
    });
    expect((await call(w.admin, 'POST', `/imports/${created.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = (await batchOf(w.admin, created.body.batch.id)) as Batch;
    expect(b.status).toBe('dry_run');
    const sentence = `Follow Up Boss has 1,240 tasks. ${TAIL}`;
    expect(b.notImported).toEqual({ tasks: 1240, countedAt: 'snapshot', lines: [sentence] });
    expect(taskCountsSince(from).every((c) => c.op === 'count')).toBe(true);
    expect(taskCountsSince(from)).toHaveLength(2);
    const pending = ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'];
    expect(b.stages.filter((s) => pending.includes(s.category)).map((s) => [s.category, s.status, s.blockers])).toEqual(pending.map((c) => [c, 'pending', []]));
    expect(b.stages.filter((s) => s.category === 'deals' || s.category === 'appointments').map((s) => s.status)).toEqual(['skipped', 'skipped']);
    await mapAgents(w.admin, b.id, w, [
      { sourceRef: '99', target: { kind: 'unassigned' } },
      { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } },
    ]);
    expect((await fullStage(ih, w.admin, b.id, 'contacts')).status).toBe('committed');
    expect((await report(b.id)).notImported).toEqual({ tasks: 1240, lines: [sentence] });
    expect(taskCountsSince(from)).toHaveLength(2);
  });

  it('E233 a task count Follow Up Boss refuses is said so, and never blocks the connection test, the snapshot or a stage', async () => {
    const k = key('nf');
    ih.fub.add(k, { ...fubFixture({ prefix: 2300, phoneSeed: 3 }), tasks: tasksOf(4), failing: { tasks: 403 } });
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: null, countedAt: 'connection_test', lines: [`We could not count tasks in Follow Up Boss. ${TAIL}`] });
    ih.fub.mutate(k, (d) => {
      d.failing = {};
    });
    expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = (await batchOf(w.admin, r.body.batch.id)) as Batch & { snapshotError: string | null };
    expect([b.status, b.snapshotError]).toEqual(['dry_run', null]);
    expect(b.notImported).toEqual({ tasks: 4, countedAt: 'snapshot', lines: [`Follow Up Boss has 4 tasks. ${TAIL}`] });
    const d = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/dry-run`);
    expect(d.status).toBe(202);
  });

  it("E233 a task count that fails at the snapshot keeps the earlier one with when it was taken (review F4)", async () => {
    const k = key('mx');
    ih.fub.add(k, { ...fubFixture({ prefix: 2500, phoneSeed: 5 }), tasks: tasksOf(3) });
    const created = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(created.body.batch.notImported).toEqual({ tasks: 3, countedAt: 'connection_test', lines: [`Follow Up Boss has 3 tasks. ${TAIL}`] });
    const id = created.body.batch.id;
    const snapshot = async (): Promise<Batch & { snapshotError: string | null }> => {
      expect((await call(w.admin, 'POST', `/imports/${id}/snapshot`)).status).toBe(202);
      await ih.drain();
      return (await batchOf(w.admin, id)) as Batch & { snapshotError: string | null };
    };
    ih.fub.mutate(k, (d) => {
      (d.tasks as unknown[]).push(...tasksOf(1237));
      d.failing = { tasks: 503 };
    });
    let b = await snapshot();
    expect([b.status, b.snapshotError]).toEqual(['dry_run', null]);
    const mixed = `We could not count tasks in Follow Up Boss again (it had 3 tasks at the connection test). ${TAIL}`;
    expect(b.notImported).toEqual({ tasks: 3, countedAt: 'snapshot', keptFrom: { tasks: 'connection_test' }, lines: [mixed] });
    expect((await report(id)).notImported).toEqual({ tasks: 3, lines: [mixed] });
    ih.fub.mutate(k, (d) => {
      d.failing = {};
    });
    b = await snapshot();
    expect(b.notImported).toEqual({ tasks: 1240, countedAt: 'snapshot', lines: [`Follow Up Boss has 1,240 tasks. ${TAIL}`] });
  });

  it('E233 a FUB export file: tasks in the file are counted; a file without them says it could not count them', async () => {
    const withTasks = { ...fubFixture({ prefix: 2400, phoneSeed: 4 }), tasks: tasksOf(7) };
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'fub-export.json', fileBase64: Buffer.from(JSON.stringify(withTasks)).toString('base64') });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: 7, countedAt: 'export_file', lines: [`Follow Up Boss has 7 tasks. ${TAIL}`] });
    const { tasks: _t, ...without } = withTasks;
    void _t;
    const r2 = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'fub-export.json', fileBase64: Buffer.from(JSON.stringify({ collections: without })).toString('base64') });
    expect(r2.body.batch.notImported).toEqual({ tasks: null, countedAt: 'export_file', lines: [`We could not count tasks in Follow Up Boss. ${TAIL}`] });
  });

  it('E233 a CSV import says nothing about tasks', async () => {
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'leads.csv', fileBase64: csvBase64('First Name,Mobile Phone\nPat,(415) 555-0142\n') });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toBeNull();
    expect((await report(r.body.batch.id)).notImported).toBeNull();
  });
});
