// J4 — duplicate-send prevention, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound
// app_user, fake providers only), on the phone (iPhone 13) and desktop (1440 px) projects. Each way a text
// could go out twice must end in exactly ONE record in the fake telephony provider and ONE messages row:
//   1. a double tap on Send (two clicks in the same frame, before React re-renders): useCommand returns the
//      in-flight command, so one POST, one message;
//   2. a retried request: the browser's POST reaches the server but its answer is lost (a 502 from the edge);
//      the composer retries automatically with the SAME idempotencyKey, and the server answers with the
//      message it already has. Then the API itself: the same key posted again, and twice at once;
//   3. a worker restart mid-send: a scheduled text's comms.dispatch job is claimed by a worker that "dies"
//      right after the provider accepted the text (its send never returns, its lease is never renewed);
//      after the lease runs out (clock fixture) the real reaper hands the job to a NEW worker, whose TX1
//      sees `dispatching` and sends nothing; 20 minutes on (clock fixture) the real sweeper's dispatch_stale
//      branch marks it dispatch_unknown and comms.reconcile finds the provider's record by its idempotency
//      key: the message ends `sent`, never re-sent, never lost. Also the provider timing out AFTER it
//      accepted (fake `timeout_after_submit`) in an in-request send: dispatch_unknown → reconcile → sent.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'playwright/test';
import { shot, signIn, toast } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

const IMPORTS = String.raw`
import { reapJobs } from '@realty/db';
import { createSweeper } from './src/worker/sweeper.ts';
`;

// Spec routes (child JS). The superuser writes here are clock fixtures only (a lease or a dispatch instant that
// has passed; Postgres' clock cannot be faked); everything else is the real worker, reaper and sweeper.
const ROUTES = String.raw`
  /** { messageId } a scheduled text becomes due and a doomed worker claims it; the provider accepts, then the worker dies */
  async '/j4/crash-send'(b) {
    await routes._worker('e2e-before-' + randomUUID().slice(0, 8)).drain(100); // nothing else due: the doomed worker claims only this text
    const t = h.providers.telephony;
    const orig = t.sendSms.bind(t);
    let reached;
    const hit = new Promise((ok) => (reached = ok));
    t.sendSms = async (req) => {
      t.sendSms = orig;
      const out = await orig(req); // the provider accepted and recorded it ...
      reached(out);
      return new Promise(() => {}); // ... and the worker process never got the answer (it died)
    };
    await h.su.query("UPDATE messages SET scheduled_for = clock_timestamp() - interval '1 second' WHERE id = $1", [b.messageId]);
    await h.su.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'comms.dispatch' AND status = 'pending' AND payload->>'messageId' = $1", [b.messageId]);
    const doomed = routes._worker('e2e-doomed-' + randomUUID().slice(0, 8), { concurrency: 1, leaseSeconds: 3600 });
    const claimed = doomed.tick(); // never settles once the provider accepted
    const outcome = await Promise.race([hit.then(() => 'accepted'), claimed.then((n) => 'finished:' + n), new Promise((ok) => setTimeout(() => ok('timeout'), 20000))]);
    if (outcome !== 'accepted') {
      const dbg = (await h.su.query("SELECT kind, status, run_at < now() AS due, last_error FROM jobs WHERE status <> 'succeeded' OR payload->>'messageId' = $1", [b.messageId])).rows;
      const mm = (await h.su.query('SELECT status, status_reason FROM messages WHERE id = $1', [b.messageId])).rows[0];
      throw new Error('the doomed worker never reached the provider: ' + outcome + ' ' + JSON.stringify({ dbg, mm }));
    }
    const job = (await h.su.query("SELECT id::text AS id, status, locked_by, attempts FROM jobs WHERE kind = 'comms.dispatch' AND payload->>'messageId' = $1", [b.messageId])).rows[0];
    const m = (await h.su.query('SELECT status FROM messages WHERE id = $1', [b.messageId])).rows[0];
    return { job, status: m.status };
  },
  /** { jobId, messageId } the dead worker's lease ran out; a new worker and the sweeper take over */
  async '/j4/restart'(b) {
    await h.su.query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1::bigint", [b.jobId]);
    const reaped = await reapJobs({ db: h.database });
    const rerun = await routes._worker('e2e-restarted-' + randomUUID().slice(0, 8)).drain(50);
    const afterRerun = (await h.su.query('SELECT status FROM messages WHERE id = $1', [b.messageId])).rows[0].status;
    const job = (await h.su.query("SELECT status, attempts, locked_by FROM jobs WHERE id = $1::bigint", [b.jobId])).rows[0];
    await h.su.query("UPDATE messages SET dispatched_at = dispatched_at - interval '21 minutes' WHERE id = $1", [b.messageId]);
    const sweep = await createSweeper({ db: h.database, registry: routes._registry(), log: silentLogger }).sweepOnce();
    const ran = await routes._worker('e2e-after-sweep-' + randomUUID().slice(0, 8)).drain(50);
    const m = (await h.su.query('SELECT status, provider_message_ref FROM messages WHERE id = $1', [b.messageId])).rows[0];
    return { reaped, rerun, afterRerun, job, sweep: { enqueued: sweep.enqueued }, ran, status: m.status, ref: m.provider_message_ref };
  },
`;

let stack: JourneyStack;
let w: WorldInfo;
let agent: WorldInfo['agents'][number];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({ imports: IMPORTS, routes: ROUTES });
  w = await stack.world({ agents: 1 });
  agent = w.agents[0]!;
});
test.afterAll(async () => {
  await stack?.stop();
});

async function person(first: string): Promise<{ id: string; phone: string }> {
  const { phone, email } = await stack.fixture<{ phone: string; email: string }>('/phone');
  const r = await stack.api<{ contact: { id: string } }>('a.agent0', 'POST', '/contacts', { commandId: randomUUID(), firstName: first, lastName: 'Dup', phones: [phone], emails: [email] });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return { id: r.body.contact.id, phone };
}

const smsTo = async (phone: string) => (await stack.sends()).sms.filter((m) => m.to === phone);
const messagesOf = (contactId: string) => stack.sql<{ id: string; status: string; idempotency_key: string }>("SELECT id, status, idempotency_key FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at", [contactId]);

test('J4: a double tap on Send sends one text (one POST, one message, one provider record)', async ({ page }, info) => {
  const p = await person('Dana');
  await signIn(page, stack, agent);
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/contacts/${p.id}/messages`)) posts.push(r.postData() ?? '');
  });
  await page.goto(`${stack.webUrl}/contacts/${p.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Your showing is confirmed for 11.');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  // two taps in the same frame: the second lands before React can disable the button
  await send.evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(toast(page).getByText(/^(Sent to Dana\.|Sending to Dana\.)$/)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await smsTo(p.phone)).length, { timeout: 15_000 }).toBe(1);
  await shot(page, info, 'j4', '1-double-tap');
  expect(posts).toHaveLength(1);
  const rows = await messagesOf(p.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('sent');
  // nothing else arrives later (the worker has nothing to send for her)
  await stack.fixture('/pjobs');
  expect(await smsTo(p.phone)).toHaveLength(1);
});

test('J4: a retried request (answer lost, the composer retries with the same key) sends one text', async ({ page }, info) => {
  const p = await person('Eli');
  await signIn(page, stack, agent);
  const keys: string[] = [];
  let lost = false;
  await page.route(`**/api/contacts/${p.id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push((JSON.parse(route.request().postData() ?? '{}') as { idempotencyKey: string }).idempotencyKey);
    if (!lost) {
      lost = true;
      await route.fetch(); // the server got it and sent the text ...
      return route.fulfill({ status: 502, body: 'Bad Gateway' }); // ... but the answer never reached the phone
    }
    return route.continue();
  });
  await page.goto(`${stack.webUrl}/contacts/${p.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Sending the HOA docs now.');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  await expect(toast(page).getByText(/^(Sent to Eli\.|Sending to Eli\.)$/)).toBeVisible({ timeout: 15_000 });
  expect(keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await shot(page, info, 'j4', '2-retried');
  expect(await smsTo(p.phone)).toHaveLength(1);
  expect(await messagesOf(p.id)).toHaveLength(1);

  // the API on its own: the same key again later, and twice at once, still one text
  const key = `k-${randomUUID()}`;
  const body = { channel: 'sms', body: 'Quick reminder about Saturday.', idempotencyKey: key };
  const first = await stack.api<{ message: { id: string } }>('a.agent0', 'POST', `/contacts/${p.id}/messages`, body);
  const again = await stack.api<{ message: { id: string } }>('a.agent0', 'POST', `/contacts/${p.id}/messages`, body);
  expect(first.status).toBeLessThan(300);
  expect(again.status).toBeLessThan(300);
  expect(again.body.message.id).toBe(first.body.message.id);
  const key2 = `k-${randomUUID()}`;
  const both = await Promise.all([0, 1].map(() => stack.api<{ message: { id: string } }>('a.agent0', 'POST', `/contacts/${p.id}/messages`, { ...body, body: 'And bring your ID.', idempotencyKey: key2 })));
  expect(both.map((r) => r.status).every((s) => s < 300), JSON.stringify(both)).toBe(true);
  expect(both[1]!.body.message.id).toBe(both[0]!.body.message.id);
  await stack.fixture('/pjobs');
  const sms = await smsTo(p.phone);
  expect(sms.map((m) => m.body)).toEqual([expect.stringContaining('HOA docs'), expect.stringContaining('Quick reminder'), expect.stringContaining('bring your ID')]);
  expect(await messagesOf(p.id)).toHaveLength(3);
});

test('J4: a worker that dies after the provider accepted a scheduled text: the restarted worker and the sweeper never re-send it, and it ends sent', async ({ page }, info) => {
  test.setTimeout(120_000);
  const p = await person('Fay');
  const s = await stack.api<{ message: { id: string; status: string } }>('a.agent0', 'POST', `/contacts/${p.id}/messages`, { channel: 'sms', body: 'See you at the open house.', idempotencyKey: `k-${randomUUID()}`, scheduleAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(s.status, JSON.stringify(s.body)).toBeLessThan(300);
  const id = s.body.message.id;
  expect(s.body.message.status).toBe('scheduled');

  const crash = await stack.fixture<{ job: { id: string; status: string; locked_by: string }; status: string }>('/j4/crash-send', { messageId: id });
  expect(crash.job.status).toBe('running');
  expect(crash.job.locked_by).toMatch(/^e2e-doomed-/);
  expect(crash.status).toBe('dispatching');
  expect(await smsTo(p.phone)).toHaveLength(1);

  const r = await stack.fixture<{ reaped: number; rerun: number; afterRerun: string; job: { status: string; attempts: number }; sweep: { enqueued: number }; ran: number; status: string; ref: string | null }>('/j4/restart', { jobId: crash.job.id, messageId: id });
  expect(r.reaped).toBeGreaterThanOrEqual(1);
  expect(r.rerun).toBeGreaterThanOrEqual(1); // the new worker ran the reaped job ...
  expect(r.afterRerun).toBe('dispatching'); // ... and its TX1 sent nothing (not scheduled/queued any more)
  expect(r.job.status).toBe('succeeded');
  expect(r.job.attempts).toBe(2);
  expect(r.sweep.enqueued).toBeGreaterThanOrEqual(1); // dispatch_stale
  expect(r.status).toBe('sent'); // dispatch_unknown → comms.reconcile found the provider's record
  const sms = await smsTo(p.phone);
  expect(sms).toHaveLength(1);
  expect(r.ref).toBe(sms[0]!.ref);
  expect(sms[0]!.key).toBe(id); // the provider idempotency key is the message id

  // the provider timed out AFTER accepting an in-request send: dispatch_unknown, reconciled to sent, one record
  const q = await person('Gus');
  await stack.fixture('/fail-next', { channel: 'sms', kind: 'timeout_after_submit' });
  const t = await stack.api<{ message: { id: string; status: string } }>('a.agent0', 'POST', `/contacts/${q.id}/messages`, { channel: 'sms', body: 'Offer docs are in your inbox.', idempotencyKey: `k-${randomUUID()}` });
  expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
  expect(t.body.message.status).toBe('dispatch_unknown');
  await expect
    .poll(async () => {
      await stack.fixture('/pjobs', { kinds: ['comms.reconcile'] });
      return (await stack.sql<{ status: string }>('SELECT status FROM messages WHERE id = $1', [t.body.message.id]))[0]?.status;
    }, { timeout: 20_000 })
    .toBe('sent');
  expect(await smsTo(q.phone)).toHaveLength(1);

  // the thread shows one sent text, not two
  await signIn(page, stack, agent);
  await page.goto(`${stack.webUrl}/contacts/${p.id}/thread`);
  await expect(page.getByRole('list', { name: 'Conversation' }).getByText(/See you at the open house/)).toHaveCount(1, { timeout: 15_000 });
  await shot(page, info, 'j4', '3-after-restart');
});
