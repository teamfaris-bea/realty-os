// Warm follow-up in Today, API half (batch 19; R-TODAY-1 to R-TODAY-3), over real Postgres as app_user.
// Every follow-up card of GET /feed says why the person is due, what was last discussed and the next promise:
//   - an automated message is never the last thing discussed (it is its own line);
//   - a note or message the viewer cannot open never reaches them, by the feed or by the reader itself;
//   - a redacted message stays redacted (the stored label, and a token stored before the redaction existed);
//   - the reads are batched by the page of cards: the same number of queries for 1 person and for 30;
//   - overdue is decided in the team's time zone.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, ownedContact, sendText } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { SIGNIN_TOKEN_HIDDEN, SIGNIN_TOKEN_PLACEHOLDER } from '../portal/shared/redact.js';
import { followUpLines } from './feed.js';
import { FOLLOW_UP_CONTEXT_QUERIES, loadFollowUpContext } from './repos/followUp.js';
import { acceptedLead, call, command, contactOf, taskDueNow } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let a: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  a = w.agents[0]!;
});
afterAll(async () => {
  await h?.close();
});

interface Touch {
  kind: string;
  at: string;
  byName: string | null;
  byMe: boolean;
  direction: string | null;
  outcome: string | null;
  snippet: string | null;
  reported: boolean;
}
interface Card {
  id: string;
  itemType: string;
  contact: { id: string; name: string } | null;
  reasons: { code: string; label: string }[];
  subjectId: string;
  why?: string[] | null;
  lastTouch?: Touch | null;
  lastAutomatic?: { kind: string; at: string; bulk: boolean } | null;
  importedHistoryAt?: string | null;
  nextPromise?: { taskId: string; text: string; dueAt: string | null; dueAllDay: boolean; dueZone?: string | null; overdue: boolean } | null;
}

async function cards(c: TestClient): Promise<Card[]> {
  const r = await call<{ pinned: Card[]; scored: Card[] }>(c, 'GET', '/feed');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return [...r.body.pinned, ...r.body.scored];
}
const cardOf = async (c: TestClient, contactId: string, itemType?: string) => (await cards(c)).find((x) => x.contact?.id === contactId && (itemType === undefined || x.itemType === itemType));

async function dueTask(agent: TestClient, contactId: string, title: string, o: { kind?: string; overdueMs?: number } = {}): Promise<string> {
  const kind = o.kind ?? 'promise';
  // a promise is made by the assistant from a conversation (no route creates one by hand): the superuser sets the kind
  const t = await call<{ task: { id: string } }>(agent, 'POST', '/tasks', { title, contactId, ...(kind === 'promise' ? {} : { kind }), dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  if (kind === 'promise') await h.su.query(`UPDATE tasks SET kind = 'promise' WHERE id = $1`, [t.body.task.id]);
  await taskDueNow(h, t.body.task.id, o.overdueMs ?? 60_000);
  return t.body.task.id;
}

/** A text the system sent (a plan's step): a copy of a text the agent really sent, re-attributed by the superuser. */
async function systemText(contactId: string, from: TestClient, body: string, at: Date): Promise<string> {
  const sent = await sendText(from, contactId, 'seed for a system copy');
  expect(sent.body.result, JSON.stringify(sent.body)).toBe('sent');
  const id = sent.body.message!.id;
  await suFixture(h, [{ text: `UPDATE messages SET initiator = 'system', initiated_by_user_id = NULL, body = $2, occurred_at = $3, dispatched_at = $3 WHERE id = $1`, values: [id, body, at] }]);
  return id;
}

const actorOf = (c: TestClient): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'follow-up-test' }) as unknown as UserActor;

/** The reader as `c`, under their own row-level security, with every statement it sends counted. */
async function readAs(c: TestClient, contactIds: string[], at?: number) {
  let queries = 0;
  const out = await withTenantTx(
    actorOf(c),
    async (tx, now) => {
      // every method runs on the real object (kysely keeps private fields); only executeQuery is counted on the way
      const bound = (target: object, prop: string | symbol): unknown => {
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
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
      return loadFollowUpContext(counted, actorOf(c), contactIds, (at ?? now) as typeof now);
    },
    { db: h.database },
  );
  return { ...out, queries };
}

describe('R-TODAY-1: every follow-up card says why, what was last discussed and the next promise', () => {
  it('a promise due: `why` is the card’s own reason sentences, the last touch is the agent’s note, the next promise is the task as written', async () => {
    const c = await contactOf(a, { firstName: 'Dana' });
    const taskId = await dueTask(a, c.id, 'Send lender intro');
    const n = await call(a, 'POST', `/contacts/${c.id}/notes`, { body: 'Wants 3 beds near the park, pre-approval next week.' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const card = await cardOf(a, c.id, 'promise_due');
    expect(card).toBeDefined();
    expect(card!.why).toEqual(card!.reasons.map((r) => r.label));
    expect(card!.why![0]).toMatch(/^You promised this; .* overdue$/);
    expect(card!.lastTouch).toMatchObject({ kind: 'note', snippet: 'Wants 3 beds near the park, pre-approval next week.', reported: false, outcome: null, byMe: true });
    // the teammate's id itself is not sent
    expect(card!.lastTouch).not.toHaveProperty('byUserId');
    expect(card!.lastTouch!.byName).toBeTruthy();
    expect(card!.lastAutomatic).toBeNull();
    expect(card!.nextPromise).toMatchObject({ taskId, text: 'Send lender intro', overdue: true, dueAllDay: false });
  });

  it('a person with no history: no last touch, no automatic line, nothing imported (the web says "No conversation yet.")', async () => {
    const c = await contactOf(a, { firstName: 'Noor' });
    await dueTask(a, c.id, 'Introduce yourself', { kind: 'todo' });
    const card = await cardOf(a, c.id, 'task_due');
    expect(card).toMatchObject({ lastTouch: null, lastAutomatic: null, importedHistoryAt: null });
    expect(card!.nextPromise?.text).toBe('Introduce yourself');
  });

  it('a first-contact card carries the lines too; a card that is not about following up with a person carries none', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { fullName: 'Remy Castellan' });
    const ft = await cardOf(owner, contactId, 'first_touch_due');
    expect(ft).toBeDefined();
    expect(ft!.why![0]).toMatch(/^First contact /);
    expect(ft).toMatchObject({ lastTouch: null, nextPromise: null });
    // a task with no person
    const t = await call<{ task: { id: string } }>(owner, 'POST', '/tasks', { title: 'Order the yard signs', dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    await taskDueNow(h, t.body.task.id);
    const bare = (await cards(owner)).find((x) => x.subjectId === t.body.task.id)!;
    expect(bare.contact).toBeNull();
    expect(bare.lastTouch ?? null).toBeNull();
    expect(bare.why ?? null).toBeNull();
  });

  it('R-TODAY-4: a logged outside call is the last touch, marked as the agent’s own report, never as a call the system placed', async () => {
    const c = await contactOf(a, { firstName: 'Odile' });
    await dueTask(a, c.id, 'Send the comps');
    const log = await call(a, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 600_000).toISOString(), outcome: 'left_voicemail', noteId: randomUUID() });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    const card = await cardOf(a, c.id, 'promise_due');
    expect(card!.lastTouch).toMatchObject({ kind: 'call', direction: 'outbound', outcome: 'left a voicemail', reported: true, snippet: null });
    // no calls row was made: it is a note
    expect((await h.su.query('SELECT 1 FROM calls WHERE contact_id = $1', [c.id])).rowCount).toBe(0);
  });
});

describe('R-TODAY-9: a logged outside call is idempotent on its client id', () => {
  it('E851: a double tap or a retry makes one record: the same noteId again answers the first note (200, replayed) and writes nothing; the card shows one logged call', async () => {
    const c = await contactOf(a, { firstName: 'Twice' });
    await dueTask(a, c.id, 'Call about the appraisal');
    const noteId = randomUUID();
    const body = { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 120_000).toISOString(), outcome: 'no_answer', noteId };
    const [one, two] = await Promise.all([call<{ replayed: boolean; note: { id: string } }>(a, 'POST', `/contacts/${c.id}/activities`, body), call<{ replayed: boolean; note: { id: string } }>(a, 'POST', `/contacts/${c.id}/activities`, body)]);
    const three = await call<{ replayed: boolean; note: { id: string } }>(a, 'POST', `/contacts/${c.id}/activities`, { ...body, outcome: 'connected' });
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(three.status).toBe(200);
    expect(three.body).toMatchObject({ replayed: true, note: { id: noteId } });
    const rows = await h.su.query<{ id: string; activity_outcome: string; source: string }>('SELECT id, activity_outcome, source FROM notes WHERE contact_id = $1', [c.id]);
    expect(rows.rows).toEqual([{ id: noteId, activity_outcome: 'no_answer', source: 'logged_activity' }]);
    expect((await cardOf(a, c.id, 'promise_due'))!.lastTouch).toMatchObject({ kind: 'call', reported: true, outcome: 'no answer' });
  });
});

describe('R-TODAY-2: an automated message is never the last thing discussed', () => {
  it('E840: only an automatic text: no last touch, and the text is its own line; a person’s text then is the last touch; a later automatic one never replaces it', async () => {
    const c = await ownedContact(a, { firstName: 'Ilse' });
    await dueTask(a, c.id, 'Check in about the open house', { kind: 'follow_up' });
    const autoAt = new Date(Date.now() - 3 * 86_400_000);
    await systemText(c.id, a, 'Hi Ilse, new listings this week!', autoAt);
    let card = await cardOf(a, c.id);
    expect(card!.lastTouch).toBeNull();
    expect(card!.lastAutomatic).toEqual({ kind: 'text', at: autoAt.toISOString(), bulk: false });
    expect(JSON.stringify(card)).not.toContain('new listings this week');

    const human = await sendText(a, c.id, 'Ilse, it was good to talk. Sending the school report tonight.');
    expect(human.body.result).toBe('sent');
    card = await cardOf(a, c.id);
    // (the text as it was sent: the first one to a person carries the business name the sender adds)
    expect(card!.lastTouch).toMatchObject({ kind: 'text', direction: 'outbound', reported: false });
    expect(card!.lastTouch!.snippet).toMatch(/^Ilse, it was good to talk\. Sending the school report tonight\./);
    expect(card!.lastTouch!.byName).toBeTruthy();
    expect(card!.lastAutomatic).toBeNull();

    const laterAt = new Date(Date.now() + 1000);
    await systemText(c.id, a, 'Automatic: your weekly market update.', new Date(Date.now() - 1));
    card = await cardOf(a, c.id);
    expect(card!.lastTouch!.snippet).toMatch(/^Ilse, it was good to talk\. Sending the school report tonight\./);
    expect(card!.lastAutomatic).toMatchObject({ kind: 'text', bulk: false });
    expect(Date.parse(card!.lastAutomatic!.at)).toBeLessThan(laterAt.getTime());
    expect(JSON.stringify(card)).not.toContain('weekly market update');
  });
});

describe('R-TODAY-5: nothing past row-level security', () => {
  it('E842: a note the viewer cannot see never leaks: the reader as another agent returns nothing for a person they cannot open; a pond member who sees the card still reads no history', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { fullName: 'Sol Marchetti' });
    const other = w.agents.find((x) => x.userId !== owner.userId)!;
    const secret = `Private to the owner ${randomUUID()}`;
    expect((await call(owner, 'POST', `/contacts/${contactId}/notes`, { body: secret })).status).toBe(201);
    // the owner reads it
    const mine = await readAs(owner, [contactId]);
    expect(mine.byContact.get(contactId)?.lastTouch?.snippet).toBe(secret);
    // another agent cannot open the person: nothing
    const theirs = await readAs(other, [contactId]);
    expect(theirs.byContact.get(contactId)?.lastTouch ?? null).toBeNull();
    expect(JSON.stringify([...theirs.byContact.values()])).not.toContain('Private to the owner');
    // a task of theirs on that person (no application path: the superuser writes it) gives them no card and no line
    const taskId = randomUUID();
    await h.su.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'todo', 'Chase the paperwork', clock_timestamp() - interval '1 minute', 'user', $3)`, [w.tenantId, taskId, other.userId, contactId]);
    expect(JSON.stringify(await cards(other))).not.toContain('Private to the owner');
    // released to the pond: the other agent now sees a pond card for the lead, and still no history
    expect((await command(owner, contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const pond = await cards(other);
    expect(pond.some((x) => x.itemType === 'pond_new' && x.contact?.id === contactId)).toBe(true);
    expect(JSON.stringify(pond)).not.toContain('Private to the owner');
    expect((await readAs(other, [contactId])).byContact.get(contactId)?.lastTouch ?? null).toBeNull();
  });

  it('E843: a redacted message stays redacted: the stored placeholder is what the card quotes, and a token stored before the redaction existed is hidden', async () => {
    const c = await contactOf(a, { firstName: 'Tove' });
    await dueTask(a, c.id, 'Send the portal link again');
    const token = `tok_${randomUUID().replace(/-/g, '')}`;
    expect((await inboundSms(h, c.phone, w.mainNumber, `Liked “Sign in: https://app.example.test/portal.html#token=${token}”`)).statusCode).toBe(200);
    const stored = (await h.su.query<{ id: string; body: string; content_redacted: string | null }>("SELECT id, body, content_redacted FROM messages WHERE contact_id = $1 AND direction = 'inbound'", [c.id])).rows[0]!;
    expect(stored.content_redacted).toBe('portal_signin_token');
    let card = await cardOf(a, c.id, 'promise_due');
    expect(card!.lastTouch).toMatchObject({ kind: 'text', direction: 'inbound', byName: null });
    expect(card!.lastTouch!.snippet).toContain(SIGNIN_TOKEN_PLACEHOLDER);
    expect(JSON.stringify(card)).not.toContain(token);
    // a record stored before the redaction existed still holds the value: it is hidden when read
    await suFixture(h, [{ text: 'UPDATE messages SET body = $2, content_redacted = NULL WHERE id = $1', values: [stored.id, `Old: https://app.example.test/portal.html#token=${token} thanks`] }]);
    card = await cardOf(a, c.id, 'promise_due');
    expect(card!.lastTouch!.snippet).toContain(SIGNIN_TOKEN_HIDDEN);
    expect(JSON.stringify(card)).not.toContain(token);
  });
});

describe('R-TODAY-5: bounded reads', () => {
  it(`the lines of a page of cards cost ${FOLLOW_UP_CONTEXT_QUERIES} queries, for 1 person and for 30 alike (no per-card query)`, async () => {
    const people: string[] = [];
    for (let i = 0; i < 30; i++) people.push((await contactOf(a, { firstName: `Batch${i}` })).id);
    for (const id of people.slice(0, 5)) expect((await call(a, 'POST', `/contacts/${id}/notes`, { body: `Note for ${id}` })).status).toBe(201);
    await dueTask(a, people[0]!, 'First of thirty');
    const one = await readAs(a, [people[0]!]);
    const many = await readAs(a, people);
    expect(one.queries).toBe(FOLLOW_UP_CONTEXT_QUERIES);
    expect(many.queries).toBe(FOLLOW_UP_CONTEXT_QUERIES);
    expect(FOLLOW_UP_CONTEXT_QUERIES).toBe(3);
    expect(many.byContact.size).toBe(30);
    expect(many.byContact.get(people[0]!)?.nextPromise?.text).toBe('First of thirty');
    expect(many.byContact.get(people[3]!)?.lastTouch?.snippet).toBe(`Note for ${people[3]!}`);
    expect(many.byContact.get(people[20]!)).toMatchObject({ lastTouch: null, nextPromise: null });
    // nothing to read: nothing asked
    expect((await readAs(a, [])).queries).toBe(0);
  });
});

describe('R-TODAY-3: overdue is decided in the team’s time zone', () => {
  it('E844: an all-day task is overdue only once its day has ended in the team’s zone, whatever the UTC date says', async () => {
    const w2 = await commsWorld(h, { agents: 1, timezone: 'America/New_York' });
    const agent = w2.agents[0]!;
    const c = await contactOf(agent, { firstName: 'Zone' });
    const t = await call<{ task: { id: string } }>(agent, 'POST', '/tasks', { title: 'All-day promise', contactId: c.id, dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    // due all day Thursday Jan 14 2027 in New York (EST, UTC-5), stored with no zone of its own
    await h.su.query('UPDATE tasks SET due_at = $2, due_all_day = true, due_tz = NULL WHERE id = $1', [t.body.task.id, '2027-01-14T05:00:00Z']);
    // Thursday 11:30 PM in New York: the UTC date is already Friday, and the task is still on time
    const lateThursday = await readAs(agent, [c.id], Date.parse('2027-01-15T04:30:00Z'));
    expect(lateThursday.zone).toBe('America/New_York');
    expect(lateThursday.byContact.get(c.id)?.nextPromise).toMatchObject({ text: 'All-day promise', dueAllDay: true, overdue: false });
    // Friday 12:30 AM in New York: overdue
    const earlyFriday = await readAs(agent, [c.id], Date.parse('2027-01-15T05:30:00Z'));
    expect(earlyFriday.byContact.get(c.id)?.nextPromise).toMatchObject({ overdue: true });
    // b19 Today fix 6 (M10, R-TODAY-19): the answer names the zone the day is in (the team's here), and GET /feed sends
    // it with the date, so a viewer in any zone words the same day
    expect(lateThursday.byContact.get(c.id)?.nextPromise).toMatchObject({ dueZone: 'America/New_York' });
    expect(followUpLines(lateThursday.byContact.get(c.id), agent.userId!).nextPromise).toMatchObject({ dueAllDay: true, dueZone: 'America/New_York', dueAt: '2027-01-14T05:00:00.000Z' });
    // a task with a zone of its own keeps it
    await h.su.query(`UPDATE tasks SET due_tz = 'Pacific/Auckland' WHERE id = $1`, [t.body.task.id]);
    expect((await readAs(agent, [c.id])).byContact.get(c.id)?.nextPromise).toMatchObject({ dueZone: 'Pacific/Auckland' });
  });
});
