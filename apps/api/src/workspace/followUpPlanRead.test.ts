// b19 Today fix 1 (M4, M6; R-TODAY-12, R-TODAY-13), over real Postgres as app_user.
//
// M4: the plan's candidates are paged, oldest system touch first, and each page is judged by the SAME "latest human
// contact" the plan uses, so a truly quiet person cannot hide behind people whose stale system clock fills the first
// page (they logged outside calls yesterday). The read is bounded (FOLLOW_UP_PAGE candidates a page, `depth` pages),
// says how many people it checked and whether it was complete; "nobody is due" is only true of a complete read.
// M6: a manual note is never contact for the quiet clock (a Team Lead's housekeeping note, the agent's own reminder);
// it may still be the Last line, labelled as a note. A call the agent logs from outside the app still is contact.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { FOLLOW_UP_DEPTH_DEFAULT, FOLLOW_UP_DEPTH_MAX, FOLLOW_UP_PAGE, loadFollowUpToday } from './repos/followUp.js';
import { call, contactOf } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

interface Row {
  itemType: string;
  contact: { id: string; name: string } | null;
  reasons: { code: string; label: string }[];
  lastTouch: { kind: string; reported: boolean; snippet: string | null; byMe: boolean } | null;
}
interface Plan {
  people: Row[];
  total: number;
  totalIsMinimum: boolean;
  checked: number;
  complete: boolean;
}

async function planOf(c: TestClient, query = ''): Promise<Plan> {
  const r = await call<{ followUpToday: Plan }>(c, 'GET', `/feed${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.followUpToday;
}

async function quiet(contactId: string, stage: string, days: number): Promise<void> {
  await suFixture(h, [{ text: `UPDATE contacts SET stage = $2, owned_at = clock_timestamp() - interval '400 days', last_human_touch_at = clock_timestamp() - ($3::int * interval '1 day') - interval '1 hour' WHERE id = $1`, values: [contactId, stage, days] }]);
}

const actorOf = (c: TestClient): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'follow-up-plan-read-test' }) as unknown as UserActor;
const read = (c: TestClient, depth?: number) => withTenantTx(actorOf(c), (tx, now) => loadFollowUpToday(tx, actorOf(c), now, [], depth === undefined ? undefined : { depth }), { db: h.database });

describe('M4 (R-TODAY-13): a truly quiet person is never hidden behind people whose system clock is stale', () => {
  let w: CommsWorld;
  let agent: TestClient;
  let lonely = '';
  const BUSY = FOLLOW_UP_PAGE + 1; // the reviewer's case: 61 people fill the old window

  beforeAll(async () => {
    w = await commsWorld(h, { agents: 1 });
    agent = w.agents[0]!;
    // 61 people in "Connected" whose last touch THE SYSTEM saw is months old, each with a call the agent logged from
    // their own phone yesterday: none of them is due
    for (let i = 0; i < BUSY; i++) {
      const c = await contactOf(agent, { firstName: `Busy${i}` });
      await quiet(c.id, 'connected', 200 + i);
      const log = await call(agent, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 86_400_000).toISOString(), outcome: 'connected', noteId: randomUUID() });
      expect(log.status, JSON.stringify(log.body)).toBe(201);
    }
    // … and one person nobody has talked to for 9 days: the system's clock for them is the NEWEST of all
    const c = await contactOf(agent, { firstName: 'Lonely' });
    await quiet(c.id, 'connected', 9);
    lonely = c.id;
  }, 240_000);

  it('the bound is stated: a page is 60 candidates, a read checks 2 pages unless asked, and never more than 10', () => {
    expect([FOLLOW_UP_PAGE, FOLLOW_UP_DEPTH_DEFAULT, FOLLOW_UP_DEPTH_MAX]).toEqual([60, 2, 10]);
  });

  it('E883: GET /feed finds the quiet person behind the 61, and says the read was complete: 62 checked, 1 due', async () => {
    const p = await planOf(agent);
    expect(p.people.map((x) => x.contact?.id)).toEqual([lonely]);
    expect(p.people[0]!.reasons[0]).toEqual({ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' });
    expect(p).toMatchObject({ total: 1, totalIsMinimum: false, checked: BUSY + 1, complete: true });
  });

  it('a read that stops at its bound says so: one page finds nobody, is NOT complete, and says it checked 60; nobody is told "nobody is due"', async () => {
    const one = await read(agent, 1);
    expect(one.plan).toMatchObject({ people: [], total: 0, totalIsMinimum: true, checked: FOLLOW_UP_PAGE, complete: false });
    const viaHttp = await planOf(agent, '?followUpDepth=1');
    expect(viaHttp).toMatchObject({ people: [], total: 0, totalIsMinimum: true, checked: FOLLOW_UP_PAGE, complete: false });
    // looking further finds them
    const two = await planOf(agent, '?followUpDepth=2');
    expect(two.people.map((x) => x.contact?.id)).toEqual([lonely]);
    expect(two.complete).toBe(true);
  });

  it('the depth asked for is bounded: 0, 11 and words are refused', async () => {
    for (const bad of ['0', '11', 'all', '1.5']) expect((await call(agent, 'GET', `/feed?followUpDepth=${bad}`)).status, bad).toBe(422);
    expect((await call(agent, 'GET', `/feed?followUpDepth=${FOLLOW_UP_DEPTH_MAX}`)).status).toBe(200);
  });

  it('each further page costs the same bounded number of statements, and pages stop once the list is exhausted', async () => {
    const counted = async (depth: number) => {
      let queries = 0;
      await withTenantTx(
        actorOf(agent),
        async (tx, now) => {
          const bound = (target: object, prop: string | symbol): unknown => {
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          };
          const proxy = new Proxy(tx, {
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
          }) as typeof tx;
          return loadFollowUpToday(proxy, actorOf(agent), now, [], { depth });
        },
        { db: h.database },
      );
      return queries;
    };
    const [one, two, ten] = [await counted(1), await counted(2), await counted(10)];
    expect(two).toBeGreaterThan(one);
    // 62 candidates are two pages: asking for ten reads no more than two
    expect(ten).toBe(two);
  });
});

describe('M6 (R-TODAY-12): a manual note is never contact for the quiet clock', () => {
  let w: CommsWorld;
  let agent: TestClient;

  beforeAll(async () => {
    w = await commsWorld(h, { agents: 1, teamLead: true });
    agent = w.agents[0]!;
  });
  const rowOf = async (id: string) => (await planOf(agent)).people.find((p) => p.contact?.id === id);

  it('E884: a Team Lead’s housekeeping note leaves a quiet person in the plan, and the row may say the note as a note', async () => {
    const c = await contactOf(agent, { firstName: 'Odile' });
    await quiet(c.id, 'connected', 12);
    expect(await rowOf(c.id)).toBeDefined();
    const n = await call(w.teamLead!, 'POST', `/contacts/${c.id}/notes`, { body: 'Updated the mailing address on file.' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const row = await rowOf(c.id);
    expect(row, 'still due').toBeDefined();
    expect(row!.reasons[0]).toEqual({ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 12 days' });
    expect(row!.lastTouch).toMatchObject({ kind: 'note', reported: false, byMe: false, snippet: 'Updated the mailing address on file.' });
  });

  it('the agent’s own reminder note ("have not heard from her in two weeks") leaves her in the plan too', async () => {
    const c = await contactOf(agent, { firstName: 'Petra' });
    await quiet(c.id, 'nurture', 40);
    const n = await call(agent, 'POST', `/contacts/${c.id}/notes`, { body: 'Remember: have not heard from her in two weeks!' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    const row = await rowOf(c.id);
    expect(row, 'still due').toBeDefined();
    expect(row!.reasons[0]!.label).toBe('Long-term follow-up: no conversation for 40 days');
    expect(row!.lastTouch).toMatchObject({ kind: 'note', byMe: true });
  });

  it('a call the agent logs from their own phone still is contact (the person leaves), even with a newer note on top', async () => {
    const c = await contactOf(agent, { firstName: 'Quincy' });
    await quiet(c.id, 'connected', 12);
    const log = await call(agent, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 3_600_000).toISOString(), outcome: 'connected', noteId: randomUUID() });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    expect((await call(agent, 'POST', `/contacts/${c.id}/notes`, { body: 'Send the school report.' })).status).toBe(201);
    expect(await rowOf(c.id)).toBeUndefined();
  });

  it('a logged call from 10 days ago under a note from today: quiet for 10 days (counted from the call, not the note)', async () => {
    const c = await contactOf(agent, { firstName: 'Rhea' });
    await quiet(c.id, 'connected', 30);
    const log = await call(agent, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 10 * 86_400_000 - 3_600_000).toISOString(), outcome: 'connected', noteId: randomUUID() });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    expect((await call(agent, 'POST', `/contacts/${c.id}/notes`, { body: 'Check the listing photos.' })).status).toBe(201);
    const row = await rowOf(c.id);
    expect(row).toBeDefined();
    expect(row!.reasons[0]!.label).toBe('Connected: no conversation for 10 days');
  });
});
