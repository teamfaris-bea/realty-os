// A merge moves the loser's tasks and appointments (migration *_backlog_merge_work; R-OWN-24, E549): the calendar side.
// The agent's appointments are synced to the deterministic fake Google calendar; the merge (POST /leads/:S/merge, the
// ownership engine) moves them to the survivor and bumps their sync_version once; the hourly calendar.reconcile then
// re-pushes the FUTURE one only (a past appointment is never pushed again). The database side, the backfill and the
// guard are packages/db/test/backlog_merge_work.test.ts. Real server as app_user; the superuser only reads back.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { contactOf } from '../workspace/testing.js';
import { reconcileLinks } from './push.js';
import { apptSync, connectCalendar, inHours, newAppointment, runCalendarJobs } from './testing.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;

const google = () => h.providers.integrations.calendar.google;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  agent = await inviteViaApi(h, owner, 'agent');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-OWN-24 a merge moves the loser\'s appointments; the calendar follows once', () => {
  it('R-OWN-24 E549: an engine merge moves the loser\'s open task, a future and a past appointment to the survivor, assignee unchanged, sync_version +1; the calendar fake receives one push, for the future one', async () => {
    await connectCalendar(h, agent, 'google_calendar');
    const s = await contactOf(agent, { firstName: 'Mia' });
    const l = await contactOf(agent, { firstName: 'Mia' });
    const future = await newAppointment(agent, { contactId: l.id, startsAt: inHours(72) });
    const past = randomUUID();
    await h.su.query(
      `INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1, $2, $3, $4, $4, 'consult', $5, $6, 'user')`,
      [agent.tenantId, past, l.id, agent.userId, inHours(-50), inHours(-49)],
    );
    const task = randomUUID();
    await h.su.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'promise', 'Send the comps', $5, 'user', $3)`,
      [agent.tenantId, task, agent.userId, l.id, inHours(24)],
    );
    await runCalendarJobs(h, agent.tenantId!);
    // the future one is in the calendar at its current version
    const synced = await apptSync(h, future);
    expect(synced.external_pushed_version).toBe(synced.sync_version);
    const pastBefore = await apptSync(h, past);

    const m = await command(agent, s.id, 'merge', { loserId: l.id });
    expect(m.status, JSON.stringify(m.body)).toBe(200);

    const rows = async () => (await h.su.query<{ id: string; contact_id: string; who: string; status: string }>(`
      SELECT id, contact_id, assignee_user_id AS who, status FROM tasks WHERE id = $1
      UNION ALL SELECT id, contact_id, user_id AS who, status FROM appointments WHERE id = ANY ($2::uuid[]) ORDER BY id`, [task, [future, past]])).rows;
    expect(await rows()).toEqual([
      { id: task, contact_id: s.id, who: agent.userId, status: 'open' },
      { id: future, contact_id: s.id, who: agent.userId, status: 'scheduled' },
      { id: past, contact_id: s.id, who: agent.userId, status: 'scheduled' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await apptSync(h, future)).sync_version).toBe(synced.sync_version + 1);
    expect((await apptSync(h, past)).sync_version).toBe(pastBefore.sync_version + 1);

    // the hourly reconcile and the worker: exactly one push, of the future appointment, at its new version
    const callsBefore = google().calls.length;
    const actor = systemActor(agent.tenantId!, 'provider');
    const reconcile = () => withTenantTx(actor, (tx) => reconcileLinks({ envelope: h.app.platform.envelope, adapters: h.providers.integrations, now: () => Date.now() }, tx, actor), { db: h.database });
    await reconcile();
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().calls.slice(callsBefore)).toEqual([future]);
    const after = await apptSync(h, future);
    expect(after.external_pushed_version).toBe(after.sync_version);
    // nothing more on the next pass
    await reconcile();
    await runCalendarJobs(h, agent.tenantId!);
    expect(google().calls.slice(callsBefore)).toEqual([future]);
  });
});
