// POST /tasks with a client-generated id (R-STG-6, E770): the "next follow-up" a phone saves once, however many times
// the request arrives. The noteId replay pattern of people/notes.ts: the same id by the same person answers the task
// that id already made; the same id from another person or another team can neither read nor overwrite it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, contactOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let a: TestClient;
let b: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true });
  [a, b] = w.agents as [TestClient, TestClient];
}, 240_000);
afterAll(async () => {
  await h?.close();
});

type TaskRes = { task: { id: string; title: string; contact: { id: string } | null }; replayed: boolean };
const create = (by: TestClient, body: Record<string, unknown>) => call<TaskRes>(by, 'POST', '/tasks', body);
const rowsOf = async (id: string) => (await h.su.query<{ tenant_id: string; title: string; created_by_user_id: string | null; notes: string | null }>('SELECT tenant_id, title, created_by_user_id, notes FROM tasks WHERE id = $1', [id])).rows;

describe('POST /tasks with a client id (R-STG-6)', () => {
  it('R-STG-6 without an id nothing changes: the server makes the id and every post is a new task', async () => {
    const c = await contactOf(a);
    const one = await create(a, { title: 'Call back', contactId: c.id });
    const two = await create(a, { title: 'Call back', contactId: c.id });
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(one.body.replayed).toBe(false);
    expect(one.body.task.id).not.toBe(two.body.task.id);
  });

  it('R-STG-6 E770 the same id by the same person answers the same task: one row, the first one\'s content, 200 and replayed', async () => {
    const c = await contactOf(a);
    const id = randomUUID();
    const first = await create(a, { id, title: 'Send the comps', contactId: c.id, kind: 'follow_up' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ task: { id, title: 'Send the comps', contact: { id: c.id } }, replayed: false });
    const again = await create(a, { id, title: 'Send the comps', contactId: c.id, kind: 'follow_up' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ task: first.body.task, replayed: true });
    // a replay never rewrites the task, even when the retried body differs (the stored task is the answer)
    const edited = await create(a, { id, title: 'Something else', contactId: c.id, notes: 'changed my mind' });
    expect(edited.status).toBe(200);
    expect(edited.body).toEqual({ task: first.body.task, replayed: true });
    expect(await rowsOf(id)).toEqual([{ tenant_id: w.tenantId, title: 'Send the comps', created_by_user_id: a.userId, notes: null }]);
    // two at the same moment: one creates, neither fails, one row
    const id2 = randomUUID();
    const both = await Promise.all([create(a, { id: id2, title: 'Twice', contactId: c.id }), create(a, { id: id2, title: 'Twice', contactId: c.id })]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 201]);
    expect(both[0]!.body.task.id).toBe(id2);
    expect(await rowsOf(id2)).toHaveLength(1);
  });

  it('R-STG-6 E770 the same id for another person of the same caller is not a replay: refused, and the first task is untouched', async () => {
    const c1 = await contactOf(a);
    const c2 = await contactOf(a);
    const id = randomUUID();
    expect((await create(a, { id, title: 'For the first', contactId: c1.id })).status).toBe(201);
    const other = await create(a, { id, title: 'For the second', contactId: c2.id });
    expect(other.status).toBe(422);
    expect(other.code).toBe('COMMAND_ID_REUSED');
    expect((await rowsOf(id)).map((r) => r.title)).toEqual(['For the first']);
  });

  it('R-STG-6 E770 R-PERM-5 the same id from another member cannot read or overwrite the task, whether or not they can see it', async () => {
    const c = await contactOf(a);
    const id = randomUUID();
    const mine = await create(a, { id, title: 'Private follow-up', contactId: c.id, notes: 'their budget is tight' });
    expect(mine.status).toBe(201);
    // another agent, who cannot see this person or the task
    const stranger = await create(b, { id, title: 'Mine now' });
    expect(stranger.status).toBe(422);
    expect(stranger.code).toBe('COMMAND_ID_REUSED');
    expect(JSON.stringify(stranger.body)).not.toMatch(/Private follow-up|budget/);
    // the Team Lead and the Owner can see the task (RLS), but it is not theirs to replay or replace
    for (const who of [w.teamLead!, w.owner]) {
      const r = await create(who, { id, title: 'Mine now', contactId: c.id });
      expect(r.status).toBe(422);
      expect(r.code).toBe('COMMAND_ID_REUSED');
      expect(JSON.stringify(r.body)).not.toMatch(/Private follow-up|budget/);
    }
    expect(await rowsOf(id)).toEqual([{ tenant_id: w.tenantId, title: 'Private follow-up', created_by_user_id: a.userId, notes: 'their budget is tight' }]);
  });

  it('R-STG-6 E770 R-TEN-3 the same id in another team is that team\'s own task: neither sees or changes the other\'s', async () => {
    const c = await contactOf(a);
    const id = randomUUID();
    expect((await create(a, { id, title: 'Ours', contactId: c.id })).status).toBe(201);
    const elsewhere = await workspaceWorld(h, { agents: 1 });
    const theirs = await create(elsewhere.agents[0]!, { id, title: 'Theirs' });
    expect(theirs.status).toBe(201);
    expect(theirs.body).toMatchObject({ task: { id, title: 'Theirs', contact: null }, replayed: false });
    const rows = await rowsOf(id);
    expect(rows.map((r) => [r.tenant_id, r.title]).sort()).toEqual([[w.tenantId, 'Ours'], [elsewhere.tenantId, 'Theirs']].sort());
    expect((await call<TaskRes>(a, 'GET', `/tasks/${id}`)).body.task.title).toBe('Ours');
    expect((await call<TaskRes>(elsewhere.agents[0]!, 'GET', `/tasks/${id}`)).body.task.title).toBe('Theirs');
  });

  it('R-STG-6 an id that is not a uuid is refused; an id naming a task the system made is never replayed as the caller\'s', async () => {
    expect((await create(a, { id: 'next-follow-up', title: 'x' })).status).toBe(422);
    const c = await contactOf(a);
    const sysTask = randomUUID();
    await h.su.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, created_by_kind) VALUES ($1, $2, $3, $4, 'follow_up', 'From the system', 'system')`, [w.tenantId, sysTask, a.userId, c.id]);
    const r = await create(a, { id: sysTask, title: 'x', contactId: c.id });
    expect(r.status).toBe(422);
    expect(r.code).toBe('COMMAND_ID_REUSED');
    expect((await rowsOf(sysTask)).map((x) => x.title)).toEqual(['From the system']);
  });
});
