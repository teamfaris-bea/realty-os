// Annual-date reminder tasks (parity module 67; R-PAR-20, E176): core nextAnnualOccurrence in the tenant's
// timezone, one task per person, field and occurrence (dedupe key, rerun-safe), assigned to the owner,
// never a send.
import { randomUUID } from 'node:crypto';
import { type Instant, localDateOf, zone } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, leadsWorld } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { ANNUAL_REMINDER_LEAD_DAYS, createAnnualRemindersInTx, monthDaysInWindow, planAnnualReminder } from './annual.js';
import { annualTaskId } from './ids.js';
import { newContact } from './testing.js';

const at = (iso: string) => Date.parse(iso) as Instant;

describe('R-PAR-20 E176 the next occurrence and the reminder plan (pure)', () => {
  it('E176 a 29 February birthday falls on 28 February in a non-leap year, and on 29 February in a leap year', () => {
    const v = { contactId: '00000000-0000-4000-8000-000000000001', fieldId: '00000000-0000-4000-8000-000000000002', label: 'Birthday', date: '1992-02-29' };
    const p = planAnnualReminder(v, 'America/New_York', at('2027-02-25T15:00:00Z'));
    expect(p?.occurrence).toBe('2027-02-28');
    expect(p?.title).toBe('Birthday coming up');
    expect(p?.taskId).toBe(annualTaskId(v.contactId, v.fieldId, '2027-02-28'));
    expect(planAnnualReminder(v, 'America/New_York', at('2028-02-25T15:00:00Z'))?.occurrence).toBe('2028-02-29');
    // the stored 29 Feb is found by the window of a non-leap year that holds 28 Feb
    expect(monthDaysInWindow(at('2027-02-25T15:00:00Z'), 'America/New_York', 7)).toContain('02-29');
    expect(monthDaysInWindow(at('2028-02-20T15:00:00Z'), 'America/New_York', 7)).toEqual(['02-20', '02-21', '02-22', '02-23', '02-24', '02-25', '02-26', '02-27']);
  });

  it('R-PAR-20 the window is the tenant\'s local days (not UTC), and nothing beyond the lead time is planned', () => {
    // 23:30 on 31 December in Los Angeles is already 1 January in UTC
    const now = at('2027-01-01T07:30:00Z');
    expect(localDateOf(now, zone('America/Los_Angeles'))).toBe('2026-12-31');
    const v = { contactId: '00000000-0000-4000-8000-000000000003', fieldId: '00000000-0000-4000-8000-000000000004', label: 'Home anniversary', date: '2015-12-31' };
    expect(planAnnualReminder(v, 'America/Los_Angeles', now)?.occurrence).toBe('2026-12-31'); // today, local
    expect(planAnnualReminder(v, 'UTC', now)?.occurrence).toBeUndefined(); // next is 2027-12-31 in UTC: beyond the lead
    expect(planAnnualReminder({ ...v, date: '2000-01-07' }, 'America/Los_Angeles', now)?.occurrence).toBe('2027-01-07');
    expect(planAnnualReminder({ ...v, date: '2000-01-08' }, 'America/Los_Angeles', now)).toBeNull(); // 8 days out
    expect(monthDaysInWindow(now, 'America/Los_Angeles', 1)).toEqual(['01-01', '12-31']);
  });

  it('R-PAR-20 the due time is 09:00 on the occurrence day in the tenant zone', () => {
    const p = planAnnualReminder({ contactId: '00000000-0000-4000-8000-000000000005', fieldId: '00000000-0000-4000-8000-000000000006', label: 'Birthday', date: '1980-07-04' }, 'America/Chicago', at('2027-07-01T12:00:00Z'));
    expect(new Date(p!.dueAt).toISOString()).toBe('2027-07-04T14:00:00.000Z');
  });
});

describe('R-PAR-20 reminder tasks in the database', () => {
  let h: ApiHarness;
  let w: Awaited<ReturnType<typeof leadsWorld>>;
  let agent: TestClient;
  let fieldId: string;
  const tz = 'America/Denver';

  beforeAll(async () => {
    h = await createApiHarness();
    w = await leadsWorld(h, { agents: 1, rule: false, timezone: tz });
    agent = w.agents[0]!;
    const f = await call<{ field: { id: string } }>(w.owner, 'POST', '/custom-fields', { label: 'Birthday', fieldType: 'date', annual: true });
    if (f.status !== 201) throw new Error(`field: ${f.status} ${JSON.stringify(f.body)}`);
    fieldId = f.body.field.id;
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  });

  /** A YYYY-MM-DD birth date whose month/day is `days` local days from today (in an old year). */
  function dateInDays(days: number): string {
    const d = localDateOf((Date.now() + days * 86_400_000) as Instant, zone(tz));
    const md = d.slice(5) === '02-29' ? '02-28' : d.slice(5);
    return `1988-${md}`;
  }

  async function run(): Promise<number> {
    return withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => createAnnualRemindersInTx(tx, now), { db: h.database });
  }

  it('R-PAR-20 one task per person, field and occurrence: assigned to the owner, due that day, created by the system; a rerun adds none', async () => {
    const soon = await newContact(agent, { firstName: 'Bea' });
    const later = await newContact(agent, { firstName: 'Cal' });
    expect((await call(agent, 'PUT', `/contacts/${soon}/fields/${fieldId}`, { value: dateInDays(3) })).status).toBe(200);
    expect((await call(agent, 'PUT', `/contacts/${later}/fields/${fieldId}`, { value: dateInDays(ANNUAL_REMINDER_LEAD_DAYS + 20) })).status).toBe(200);
    const first = await run();
    expect(first).toBeGreaterThanOrEqual(1);
    const tasks = (await h.su.query('SELECT id, assignee_user_id, contact_id, kind, title, due_all_day, due_tz, status, created_by_kind FROM tasks WHERE contact_id = ANY ($1)', [[soon, later]])).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignee_user_id: agent.userId, contact_id: soon, kind: 'todo', title: 'Birthday coming up', due_all_day: true, due_tz: tz, status: 'open', created_by_kind: 'system' });
    // rerun-safe: the derived id is the dedupe key
    expect(await run()).toBe(0);
    await Promise.all([run(), run()]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [soon])).rows[0].n).toBe(1);
    // a completed reminder is never re-created for the same occurrence
    await h.su.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE contact_id = $1", [soon]);
    expect(await run()).toBe(0);
    // never a send (R-PAR-20)
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = ANY ($1)', [[soon, later]])).rows[0].n).toBe(0);
  });

  it('R-PAR-20 a field that is not annual and a deleted person get no reminder', async () => {
    const plain = await call<{ field: { id: string } }>(w.owner, 'POST', '/custom-fields', { label: 'Closing date', fieldType: 'date' });
    const c = await newContact(agent, { firstName: 'Dee' });
    expect((await call(agent, 'PUT', `/contacts/${c}/fields/${plain.body.field.id}`, { value: dateInDays(2) })).status).toBe(200);
    await run();
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [c])).rows[0].n).toBe(0);
    const gone = await newContact(agent, { firstName: 'Eve' });
    expect((await call(agent, 'PUT', `/contacts/${gone}/fields/${fieldId}`, { value: dateInDays(1) })).status).toBe(200);
    const del = await call(w.owner, 'POST', `/leads/${gone}/delete`, { commandId: randomUUID() });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    await run();
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [gone])).rows[0].n).toBe(0);
  });
});
