// Owner decision B7 (2026-11-11, E233): Follow Up Boss tasks and appointments are not imported, and the import
// says so plainly instead of saying nothing. They are COUNTED (one-record count pages, `_metadata.total`; never a
// list, never a record) at the connection test ("Count what's there") and again at the snapshot, the Imports page
// and the final report say they won't come over, and counting never blocks the connection test, the snapshot or
// any stage. Everything runs on the deterministic FAKE Follow Up Boss connector (FakeFub); nothing real is called.
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

const TAIL = "Realty OS doesn't bring tasks or appointments over: finish or note the open ones in Follow Up Boss before you switch.";
type NotImported = { tasks: number | null; appointments: number | null; countedAt?: string | null; lines: string[] } | null;
type Batch = BatchView & { notImported: NotImported };
const tasksOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Task ${i + 1}`, dueDate: '2026-12-01', assignedUserId: 11, isCompleted: false }));
const appointmentsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Showing ${i + 1}`, start: '2026-12-02T17:00:00Z' }));
const key = (k: string) => `fub-b7-${k}-${randomUUID().slice(0, 8)}`;
/** the fake's calls for tasks and appointments since `from` (the tests of this file run one after another) */
const countOnlyCallsSince = (from: number) => ih.fub.calls.slice(from).filter((c) => c.collection === 'tasks' || c.collection === 'appointments');

async function report(batchId: string): Promise<{ notImported: NotImported }> {
  const r = await call<{ notImported: NotImported }>(w.admin, 'GET', `/imports/${batchId}/report`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('owner decision B7: FUB tasks and appointments are counted and said plainly not to come over', () => {
  it('E233 R-IMPORT-1 the connection test counts them (one-record count pages, never a list) and says plainly they do not come over', async () => {
    const k = key('ct');
    ih.fub.add(k, { ...fubFixture({ prefix: 2100 }), tasks: tasksOf(3), appointments: appointmentsOf(1) });
    const before = ih.fub.calls.length;
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: 3, appointments: 1, countedAt: 'connection_test', lines: [`Follow Up Boss has 3 tasks and 1 appointment. ${TAIL}`] });
    // counts only: the six imported collections and the two count-only ones, one one-record page each
    const made = ih.fub.calls.slice(before);
    expect(made.every((c) => c.op === 'count')).toBe(true);
    expect(made.map((c) => c.collection)).toEqual(['people', 'notes', 'textMessages', 'emails', 'calls', 'users', 'tasks', 'appointments']);
    // what is imported is unchanged: the connection test lines are the same as before B7
    expect(r.body.batch.connectionTest.join(' ')).not.toMatch(/task|appointment/i);
    expect(r.body.batch.sourceCounts).not.toHaveProperty('tasks');
  });

  it('E233 the snapshot counts them again (never reading one), the final report says it, and no stage is blocked or changed by them', async () => {
    const k = key('sn');
    ih.fub.add(k, { ...fubFixture({ prefix: 2200, phoneSeed: 2 }), tasks: tasksOf(2), appointments: appointmentsOf(5) });
    const from = ih.fub.calls.length;
    const created = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(created.body.batch.notImported?.tasks).toBe(2);
    // FUB changes between the connection test and the snapshot: the snapshot's own count is the one shown
    ih.fub.mutate(k, (d) => {
      (d.tasks as unknown[]).push(...tasksOf(1238));
      d.appointments = appointmentsOf(85);
    });
    expect((await call(w.admin, 'POST', `/imports/${created.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = (await batchOf(w.admin, created.body.batch.id)) as Batch;
    expect(b.status).toBe('dry_run');
    const sentence = `Follow Up Boss has 1,240 tasks and 85 appointments. ${TAIL}`;
    expect(b.notImported).toEqual({ tasks: 1240, appointments: 85, countedAt: 'snapshot', lines: [sentence] });
    expect(countOnlyCallsSince(from).every((c) => c.op === 'count')).toBe(true);
    expect(countOnlyCallsSince(from)).toHaveLength(4); // connection test + snapshot, a count page each
    // the stages are exactly the six imported categories, all pending: nothing about tasks blocks or adds a step
    expect(b.stages.map((s) => [s.category, s.status, s.blockers])).toEqual(['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'].map((c) => [c, 'pending', []]));
    await mapAgents(w.admin, b.id, w, [
      { sourceRef: '99', target: { kind: 'unassigned' } },
      { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } },
    ]);
    expect((await fullStage(ih, w.admin, b.id, 'contacts')).status).toBe('committed');
    expect((await report(b.id)).notImported).toEqual({ tasks: 1240, appointments: 85, lines: [sentence] });
    expect(countOnlyCallsSince(from)).toHaveLength(4); // nothing after the snapshot reads FUB, not even to count
  });

  it('E233 a count Follow Up Boss refuses (no scope, a server error) is said so, and never blocks the connection test, the snapshot or a stage', async () => {
    const k = key('nf');
    ih.fub.add(k, { ...fubFixture({ prefix: 2300, phoneSeed: 3 }), tasks: tasksOf(4), appointments: appointmentsOf(4), unavailable: ['appointments'], failing: { tasks: 403 } });
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: k });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: null, appointments: null, countedAt: 'connection_test', lines: [`We could not count tasks or appointments in Follow Up Boss. ${TAIL}`] });
    // at the snapshot FUB answers for tasks again but fails appointments with a server error: what it could count is shown
    ih.fub.mutate(k, (d) => {
      d.failing = { appointments: 503 };
      d.unavailable = [];
    });
    expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = (await batchOf(w.admin, r.body.batch.id)) as Batch & { snapshotError: string | null };
    expect([b.status, b.snapshotError]).toEqual(['dry_run', null]);
    expect(b.notImported).toEqual({ tasks: 4, appointments: null, countedAt: 'snapshot', lines: [`Follow Up Boss has 4 tasks; we could not count its appointments. ${TAIL}`] });
    const d = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/dry-run`);
    expect(d.status).toBe(202);
  });

  it('E233 a FUB export file: tasks and appointments in the file are counted; a file without them says it could not count them', async () => {
    const withTasks = { ...fubFixture({ prefix: 2400, phoneSeed: 4 }), tasks: tasksOf(7), appointments: [] };
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'fub-export.json', fileBase64: Buffer.from(JSON.stringify(withTasks)).toString('base64') });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toEqual({ tasks: 7, appointments: 0, countedAt: 'export_file', lines: [`Follow Up Boss has 7 tasks and 0 appointments. ${TAIL}`] });
    const { tasks: _t, appointments: _a, ...without } = withTasks;
    void _t;
    void _a;
    const r2 = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'fub-export.json', fileBase64: Buffer.from(JSON.stringify({ collections: without })).toString('base64') });
    expect(r2.body.batch.notImported).toEqual({ tasks: null, appointments: null, countedAt: 'export_file', lines: [`We could not count tasks or appointments in Follow Up Boss. ${TAIL}`] });
  });

  it('E233 a CSV import says nothing about tasks or appointments (a file has neither)', async () => {
    const r = await call<{ batch: Batch }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'leads.csv', fileBase64: csvBase64('First Name,Mobile Phone\nPat,(415) 555-0142\n') });
    expect(r.status).toBe(201);
    expect(r.body.batch.notImported).toBeNull();
    expect((await report(r.body.batch.id)).notImported).toBeNull();
  });
});
