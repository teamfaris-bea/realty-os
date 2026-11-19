// The daily plan for warm people, API half (batch 19; R-TODAY-6), over real Postgres as app_user. GET /feed gains
// `followUpToday`: the people the agent owns who are due by a promise or task of theirs today or earlier, plus people
// in "Connected" or "Long-term follow-up" with no human contact for longer than the stage's threshold. Capped, most
// overdue first, with a reason each. Never someone who opted out of every channel, someone closed as not a lead, or
// someone who is not the agent's. A person from a source marked "No automated contact" still appears: this is the
// agent's own one-to-one follow-up. Reading the plan creates nothing.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { FOLLOW_UP_TODAY_CAP, WARM_FOLLOW_UP_DAYS } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { FOLLOW_UP_TODAY_QUERIES, loadFollowUpToday } from './repos/followUp.js';
import { acceptedLead, call, command, contactOf, freshReauth, taskDueNow } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let a: TestClient;
let b: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  [a, b] = w.agents as [TestClient, TestClient];
});
afterAll(async () => {
  await h?.close();
});

interface Row {
  id: string;
  itemType: string;
  dueAt: string | null;
  contact: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
  reasons: { code: string; label: string }[];
  primaryAction: { kind: string };
  alternatives: { kind: string }[];
  why: string[] | null;
  stage: { key: string; label: string } | null;
  lastTouch: { kind: string; reported: boolean; outcome: string | null } | null;
  nextPromise: { text: string; overdue: boolean; taskId?: string } | null;
  taskIds: string[];
  alsoDue?: { taskId: string; title: string }[];
  alsoDueMore?: number;
}
interface Feed {
  pinned: { id: string; itemType: string; subjectId: string; contact: { id: string } | null }[];
  scored: { id: string; itemType: string; subjectId: string; contact: { id: string } | null }[];
  followUpToday: { people: Row[]; total: number; totalIsMinimum: boolean };
}

async function feed(c: TestClient): Promise<Feed> {
  const r = await call<Feed>(c, 'GET', '/feed');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const planOf = async (c: TestClient) => (await feed(c)).followUpToday;
const rowOf = async (c: TestClient, contactId: string) => (await planOf(c)).people.find((p) => p.contact?.id === contactId);

async function task(agent: TestClient, contactId: string, title: string, o: { kind?: string; dueInMs?: number } = {}): Promise<string> {
  const kind = o.kind ?? 'follow_up';
  const t = await call<{ task: { id: string } }>(agent, 'POST', '/tasks', { title, contactId, ...(kind === 'promise' ? {} : { kind }), dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  if (kind === 'promise') await h.su.query(`UPDATE tasks SET kind = 'promise' WHERE id = $1`, [t.body.task.id]);
  if (o.dueInMs === undefined) await taskDueNow(h, t.body.task.id);
  else await h.su.query(`UPDATE tasks SET due_at = clock_timestamp() + ($2::bigint * interval '1 millisecond') WHERE id = $1`, [t.body.task.id, o.dueInMs]);
  return t.body.task.id;
}

/** Clock fixture: a person in `stage` whose last verified human touch was `days` ago (null: never), theirs for 90 days. */
async function quiet(contactId: string, stage: string, days: number | null): Promise<void> {
  await suFixture(h, [
    {
      text: `UPDATE contacts SET stage = $2, owned_at = clock_timestamp() - interval '90 days',
               last_human_touch_at = CASE WHEN $3::int IS NULL THEN NULL ELSE clock_timestamp() - ($3::int * interval '1 day') - interval '1 hour' END WHERE id = $1`,
      values: [contactId, stage, days],
    },
  ]);
}

const actorOf = (c: TestClient): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'follow-up-today-test' }) as unknown as UserActor;

describe('R-TODAY-6: who is in "Follow up today"', () => {
  it('a person with a promise of the agent’s due today is in it, with the reason, the task and the same lines as a card; one whose task is due in three days is not', async () => {
    const due = await contactOf(a, { firstName: 'Dana' });
    const later = await contactOf(a, { firstName: 'Later' });
    const taskId = await task(a, due.id, 'Send lender intro', { kind: 'promise' });
    await task(a, later.id, 'Not yet', { dueInMs: 3 * 86_400_000 });
    const f = await feed(a);
    const row = f.followUpToday.people.find((p) => p.contact?.id === due.id)!;
    expect(row).toBeDefined();
    expect(row).toMatchObject({ itemType: 'promise_due', task: { id: taskId, title: 'Send lender intro' }, taskIds: [taskId], stage: { key: 'new', label: 'New lead' }, lastTouch: null });
    expect(row.reasons[0]).toMatchObject({ code: 'PROMISE_OVERDUE' });
    expect(row.why).toEqual(row.reasons.map((r) => r.label));
    expect(row.nextPromise).toMatchObject({ text: 'Send lender intro', overdue: true });
    expect(row.primaryAction.kind).toBe('call');
    expect(row.alternatives.map((x) => x.kind)).toEqual(['text', 'email', 'complete_task', 'open_contact']);
    expect(f.followUpToday.people.some((p) => p.contact?.id === later.id)).toBe(false);
    // the same task is also a card of the feed; the row names it so a screen shows the person once
    expect(f.scored.some((c) => c.subjectId === taskId)).toBe(true);
  });

  it('warm and quiet: Connected past 7 days and Long-term follow-up past 30 are in it with the stage’s own label; inside the threshold, or in another stage, they are not', async () => {
    expect(WARM_FOLLOW_UP_DAYS).toEqual({ connected: 7, nurture: 30 });
    const mk = async (first: string, stage: string, days: number | null) => {
      const c = await contactOf(a, { firstName: first });
      await quiet(c.id, stage, days);
      return c.id;
    };
    const c9 = await mk('Nine', 'connected', 9);
    const c5 = await mk('Five', 'connected', 5);
    const n31 = await mk('Thirtyone', 'nurture', 31);
    const n20 = await mk('Twenty', 'nurture', 20);
    const act60 = await mk('Active', 'active', 60);
    const never = await mk('Never', 'connected', null);
    const p = await planOf(a);
    const ids = p.people.map((x) => x.contact!.id);
    expect(ids).toEqual(expect.arrayContaining([c9, n31, never]));
    for (const id of [c5, n20, act60]) expect(ids).not.toContain(id);
    const nine = p.people.find((x) => x.contact!.id === c9)!;
    expect(nine).toMatchObject({ itemType: 'warm_follow_up', task: null, taskIds: [], stage: { key: 'connected', label: 'Connected' } });
    expect(nine.reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }]);
    expect(p.people.find((x) => x.contact!.id === n31)!.reasons[0]!.label).toBe('Long-term follow-up: no conversation for 31 days');
    expect(p.people.find((x) => x.contact!.id === never)!.reasons[0]).toEqual({ code: 'WARM_NEVER_CONTACTED', label: 'Connected: no conversation yet' });
  });

  it('E846: a call the agent logs from outside the app is a contact for the plan: the person leaves it, and nothing was counted as a touch', async () => {
    const c = await contactOf(a, { firstName: 'Odile' });
    await quiet(c.id, 'connected', 12);
    expect(await rowOf(a, c.id)).toBeDefined();
    const before = (await h.su.query<{ t: Date | null }>('SELECT last_human_touch_at AS t FROM contacts WHERE id = $1', [c.id])).rows[0]!.t;
    const log = await call(a, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 60_000).toISOString(), outcome: 'left_voicemail', noteId: randomUUID() });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    expect(await rowOf(a, c.id)).toBeUndefined();
    // the agent's own report moved no clock the system keeps
    const after = (await h.su.query<{ t: Date | null }>('SELECT last_human_touch_at AS t FROM contacts WHERE id = $1', [c.id])).rows[0]!.t;
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('E850: a dated next step takes a quiet person out until it is due', async () => {
    const c = await contactOf(a, { firstName: 'Planned' });
    await quiet(c.id, 'connected', 20);
    expect(await rowOf(a, c.id)).toBeDefined();
    await task(a, c.id, 'Follow up with Planned', { dueInMs: 5 * 86_400_000 });
    expect(await rowOf(a, c.id)).toBeUndefined();
  });
});

// b19 Today fix 4 (M7; R-TODAY-15): a due promise is never hidden behind an earlier routine task
describe('M7 (R-TODAY-15): a due promise leads the row', () => {
  it('E886: the reviewer’s case: a follow-up overdue 2 h and a promise overdue 1 h: the row is the promise (its own time), names the follow-up in "Also due", and its Next line is the promise', async () => {
    const c = await contactOf(a, { firstName: 'Dana' });
    const followUp = await task(a, c.id, 'Follow up with Dana', { dueInMs: -2 * 3_600_000 - 60_000 });
    const promise = await task(a, c.id, 'Send lender intro', { kind: 'promise', dueInMs: -3_600_000 - 60_000 });
    const f = await feed(a);
    const row = f.followUpToday.people.find((p) => p.contact?.id === c.id)!;
    expect(row).toMatchObject({ itemType: 'promise_due', task: { id: promise, title: 'Send lender intro' }, taskIds: [promise, followUp], alsoDue: [{ taskId: followUp, title: 'Follow up with Dana' }], alsoDueMore: 0 });
    expect(row.reasons).toEqual([
      { code: 'PROMISE_OVERDUE', label: 'You promised this; 1 h overdue' },
      { code: 'ALSO_DUE', label: 'Also due: Follow up with Dana' },
    ]);
    expect(row.why).toEqual(['You promised this; 1 h overdue', 'Also due: Follow up with Dana']);
    expect(row.nextPromise).toMatchObject({ taskId: promise, text: 'Send lender intro', overdue: true });
    // Done on the row is the promise's, never the follow-up's
    expect(row.alternatives.find((x) => x.kind === 'complete_task')).toMatchObject({ taskId: promise });
    // both tasks still have their own cards in the feed; the screen decides which the row stands for
    expect(f.scored.filter((x) => x.contact?.id === c.id).map((x) => x.itemType).sort()).toEqual(['promise_due', 'task_due']);
  });

  it('more due tasks than the line names: three are named and the rest counted', async () => {
    const c = await contactOf(a, { firstName: 'Many' });
    const promise = await task(a, c.id, 'Send the pre-approval letter', { kind: 'promise', dueInMs: -60_000 });
    const others: string[] = [];
    for (const [i, title] of ['Call the lender', 'Send the comps', 'Book the inspection', 'Order the survey'].entries()) others.push(await task(a, c.id, title, { kind: 'todo', dueInMs: -(5 - i) * 3_600_000 }));
    const row = (await rowOf(a, c.id))!;
    expect(row.task).toMatchObject({ id: promise });
    expect(row.alsoDue).toEqual(others.slice(0, 3).map((taskId, i) => ({ taskId, title: ['Call the lender', 'Send the comps', 'Book the inspection'][i] })));
    expect(row.alsoDueMore).toBe(1);
    expect(row.why![1]).toBe('Also due: Call the lender, Send the comps, Book the inspection and 1 more');
  });
});

describe('R-TODAY-6: who is never in it', () => {
  it('E847: someone who asked not to be contacted at all (every channel closed), a promise due included', async () => {
    const c = await contactOf(a, { firstName: 'Quiet' });
    await task(a, c.id, 'Promised a call', { kind: 'promise' });
    await quiet(c.id, 'connected', 15);
    expect(await rowOf(a, c.id)).toBeDefined();
    const dnc = await call(a, 'POST', `/contacts/${c.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(dnc.status, JSON.stringify(dnc.body)).toBe(200);
    expect(await rowOf(a, c.id)).toBeUndefined();
  });

  it('E849: someone closed as not a lead, and someone who is another agent’s (a task of mine on them does not make them mine)', async () => {
    const closed = await contactOf(a, { firstName: 'Closed' });
    await task(a, closed.id, 'Call them back', { kind: 'promise' });
    expect(await rowOf(a, closed.id)).toBeDefined();
    expect((await command(a, closed.id, 'close', { reason: 'not_a_lead' })).status).toBe(200);
    expect(await rowOf(a, closed.id)).toBeUndefined();

    const theirs = await contactOf(b, { firstName: 'Theirs' });
    await quiet(theirs.id, 'connected', 15);
    await h.su.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'todo', 'Chase the paperwork', clock_timestamp() - interval '1 minute', 'user', $3)`, [w.tenantId, randomUUID(), a.userId, theirs.id]);
    expect(await rowOf(a, theirs.id)).toBeUndefined();
    // and their owner has them
    expect(await rowOf(b, theirs.id)).toBeDefined();
  });

  it('E848: a person from a source marked "No automated contact" still appears: the restriction is on automated contact, not on the agent’s own follow-up', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { fullName: 'Remy Castellan' });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', `/lead-sources/${w.sourceId}/ai-care`, { noAiCare: true })).status).toBe(200);
    await quiet(contactId, 'connected', 10);
    const row = await rowOf(owner, contactId);
    expect(row).toBeDefined();
    expect(row!.primaryAction.kind).toBe('call');
  });
});

describe('R-TODAY-6: reading the plan creates nothing', () => {
  // (b19 Today fix 7, L13: this test passed only after the tests above had made somebody due, and did not count
  // notifications, deliveries or jobs. It now makes its own world, and counts every table a read could reach.)
  it('no message, draft, task, enrolment, note, call, notification, delivery, job, stage event or audit row is written by GET /feed, however many people are due and however far it looks', async () => {
    const w3 = await commsWorld(h, { agents: 1 });
    const agent = w3.agents[0]!;
    const warm = await contactOf(agent, { firstName: 'Quiet' });
    await quiet(warm.id, 'connected', 12);
    const promised = await contactOf(agent, { firstName: 'Promised' });
    await task(agent, promised.id, 'Send lender intro', { kind: 'promise' });
    // the feed is materialized by its first read (cards for the due task): that write is the feed's own, made before the counts
    expect((await planOf(agent)).people.map((p) => p.contact!.id).sort()).toEqual([warm.id, promised.id].sort());
    const counts = async () =>
      (
        await h.su.query<Record<string, string>>(
          `SELECT (SELECT count(*) FROM messages WHERE tenant_id = $1) AS messages, (SELECT count(*) FROM assistant_actions WHERE tenant_id = $1) AS assistant_actions,
                  (SELECT count(*) FROM tasks WHERE tenant_id = $1) AS tasks, (SELECT count(*) FROM playbook_enrollments WHERE tenant_id = $1) AS playbook_enrollments,
                  (SELECT count(*) FROM notes WHERE tenant_id = $1) AS notes, (SELECT count(*) FROM calls WHERE tenant_id = $1) AS calls,
                  (SELECT count(*) FROM notifications WHERE tenant_id = $1) AS notifications, (SELECT count(*) FROM notification_deliveries WHERE tenant_id = $1) AS notification_deliveries,
                  (SELECT count(*) FROM jobs WHERE tenant_id = $1) AS jobs, (SELECT count(*) FROM contact_stage_events WHERE tenant_id = $1) AS contact_stage_events,
                  (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS audit_log,
                  (SELECT max(last_human_touch_at)::text FROM contacts WHERE tenant_id = $1) AS last_touch`,
          [w3.tenantId],
        )
      ).rows[0];
    const before = await counts();
    expect(Object.keys(before!)).toHaveLength(12);
    expect((await planOf(agent)).people).toHaveLength(2);
    expect((await call(agent, 'GET', '/feed?followUpDepth=10')).status).toBe(200);
    expect((await call(agent, 'GET', '/activities/recent-people')).status).toBe(200);
    expect(await counts()).toEqual(before);
  });
});

describe('R-TODAY-6: capped, ordered, bounded', () => {
  it(`E859: at most ${FOLLOW_UP_TODAY_CAP} people, most overdue first, with the total; and the same number of statements for 2 people and for 25`, async () => {
    const w2 = await commsWorld(h, { agents: 1 });
    const agent = w2.agents[0]!;
    const read = async () => {
      let queries = 0;
      const out = await withTenantTx(
        actorOf(agent),
        async (tx, now) => {
          const bound = (target: object, prop: string | symbol): unknown => {
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          };
          const counted = new Proxy(tx, {
            get(target, prop) {
              if (prop !== 'getExecutor') return bound(target, prop);
              return () => {
                const ex = target.getExecutor();
                return new Proxy(ex, {
                  get(t2, p2) {
                    if (p2 !== 'executeQuery') return bound(t2, p2);
                    return (...args: Parameters<typeof ex.executeQuery>) => {
                      queries += 1;
                      return ex.executeQuery(...args);
                    };
                  },
                });
              };
            },
          }) as Tx;
          return loadFollowUpToday(counted, actorOf(agent), now, []);
        },
        { db: h.database },
      );
      return { ...out, queries };
    };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await contactOf(agent, { firstName: `Warm${i}` });
      await quiet(c.id, 'connected', 10 + i);
      ids.push(c.id);
    }
    const two = await read();
    expect(two.plan.people.map((p) => p.contactId)).toEqual([ids[1], ids[0]]);
    for (let i = 2; i < 25; i++) {
      const c = await contactOf(agent, { firstName: `Warm${i}` });
      await quiet(c.id, 'connected', 10 + i);
      ids.push(c.id);
    }
    const many = await read();
    expect(two.queries).toBe(FOLLOW_UP_TODAY_QUERIES);
    expect(many.queries).toBe(FOLLOW_UP_TODAY_QUERIES);
    const p = await planOf(agent);
    expect(p.people).toHaveLength(FOLLOW_UP_TODAY_CAP);
    expect(p.total).toBe(25);
    expect(p.totalIsMinimum).toBe(false);
    // most overdue first: the one quiet longest leads
    expect(p.people.map((x) => x.contact!.id)).toEqual([...ids].reverse().slice(0, FOLLOW_UP_TODAY_CAP));
  });
});
