// Regression tests for the confirmed findings of module 68's independent review (each fails without its fix).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, playbookFixture, pointId, randomEmail } from '../comms/testing.js';
import { parseAddressList } from './match.js';
import { MAX_HISTORY_PAGES } from './sync.js';
import { asSystem, clearGmailPack, confirmAddresses, connectGmail, copiesOf, enableMailSync, linkOf, mailCallback, runMailSync, startMailConnect } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let n = 0;
const mailbox = () => `fix-${++n}-${randomUUID().slice(0, 6)}@gmail.test`;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await clearGmailPack(h);
  await enableMailSync(h, w.owner);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function connected() {
  const a = await inviteViaApi(h, w.owner, 'agent');
  const box = mailbox();
  expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
  const c = await ownedContact(a);
  const pid = await pointId(h, c.id, 'email');
  await confirmAddresses(a, [pid]);
  return { a, box, c, pid, link: (await linkOf(h, a.userId!))! };
}

describe('review fixes (module 68)', () => {
  it('R-GMAIL-2 E211: a refused connect never revokes at Google (a revoke ends the whole grant), so the live link of the same mailbox in another workspace keeps syncing', async () => {
    const { box, c, link } = await connected();
    const other = await h.signup();
    await enableMailSync(h, other);
    expect((await connectGmail(h, other, box)).result).toBe('MAILBOX_LINKED_ELSEWHERE');
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'still here', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect((await h.su.query('SELECT status FROM user_mail_links WHERE id = $1', [link.id])).rows[0]!.status).toBe('connected');
    expect((await copiesOf(h, { linkId: link.id })).map((x) => x.body)).toEqual(['still here']);
  });

  it('an unexpected database error in the callback redirects (PROVIDER_REFUSED) instead of a 500, and stores nothing', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    const code = h.providers.gmail.issueCode({ codeChallenge: f.challenge, mailbox: mailbox() });
    const env = h.app.platform.envelope;
    const real = env.inTx.bind(env);
    env.inTx = ((tx: never, t: never) => ({ ...real(tx, t), hmacAddress: async () => Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' })) })) as typeof env.inTx;
    try {
      const r = await mailCallback(h, { state: f.state, code }, f.binder);
      expect([r.status, r.result]).toEqual([303, 'PROVIDER_REFUSED']);
    } finally {
      env.inTx = real;
    }
    expect(await linkOf(h, a.userId!)).toBeUndefined();
  });

  it('a link revoked while a page was being fetched: nothing from that page is processed (no copy, no opt-out, no notification)', async () => {
    const { a, box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'unsubscribe', internalDate: Date.now() });
    const real = h.providers.gmail.getMessage.bind(h.providers.gmail);
    h.providers.gmail.getMessage = async (t, id, f) => {
      const m = await real(t, id, f);
      expect((await call(a, 'DELETE', '/me/mail-link')).status).toBe(200);
      return m;
    };
    try {
      await runMailSync(h, w.tenantId);
    } finally {
      h.providers.gmail.getMessage = real;
    }
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND evidence->>'kind' = 'synced_gmail'", [c.id])).rows[0]!.n).toBe(0);
  });

  it('R-GMAIL-11: a backlog longer than MAX_HISTORY_PAGES makes progress every pass (the cursor moves with each page) and drains completely', async () => {
    const { box, c, link } = await connected();
    // the connect-time backfill is done (an empty mailbox), so only history can bring these messages in
    await runMailSync(h, w.tenantId);
    const total = MAX_HISTORY_PAGES * 3 + 7; // the fake pages history by 3
    for (let i = 0; i < total; i++) h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: `bk${i}`, text: `b${i}`, internalDate: Date.now() + i });
    await runMailSync(h, w.tenantId);
    const after1 = (await copiesOf(h, { linkId: link.id })).length;
    expect(after1).toBe(MAX_HISTORY_PAGES * 3);
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(total);
  });

  it('E223: two merged duplicates that both hold a copy of the same Gmail message: one copy moves to the survivor, the other is deleted; the pass does not fail', async () => {
    const { a, box, link } = await connected();
    const shared = randomEmail();
    const l1 = await ownedContact(a, { email: shared, confirmDistinct: true });
    const l2 = await ownedContact(a, { email: randomEmail() });
    const sv = await ownedContact(a, { email: randomEmail() });
    for (const c of [l2, sv]) expect((await call(a, 'POST', `/contacts/${c.id}/points`, { kind: 'email', address: shared })).status).toBe(201);
    const pts = (await h.su.query('SELECT id FROM contact_points WHERE address = $1 AND contact_id = ANY ($2::uuid[])', [shared, [l1.id, l2.id, sv.id]])).rows.map((x) => x.id);
    await confirmAddresses(a, pts);
    h.providers.gmail.deliver(box, { from: shared, to: [box], text: 'to all of us', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const before = await copiesOf(h, { linkId: link.id });
    expect(new Set(before.map((x) => x.contact_id)).size).toBeGreaterThanOrEqual(2);
    // delete the survivor's own copy so both losers' copies are re-point candidates for the same (message, survivor)
    await asSystem(h, w.tenantId, (tx) => sql`DELETE FROM mail_messages WHERE contact_id = ${sv.id}::uuid`.execute(tx));
    await h.su.query('UPDATE contacts SET merged_into_contact_id = $2 WHERE id = ANY ($1::uuid[])', [[l1.id, l2.id], sv.id]);
    await runMailSync(h, w.tenantId, { due: false });
    const after = await copiesOf(h, { linkId: link.id });
    expect(after.map((x) => x.contact_id)).toEqual([sv.id]);
    const jobs = (await h.su.query("SELECT status FROM jobs WHERE kind = 'mail.sync' AND tenant_id = $1 ORDER BY id DESC LIMIT 1", [w.tenantId])).rows[0]!;
    expect(jobs.status).toBe('succeeded');
  });

  it('R-GMAIL-8: "import again" during an unfinished backfill re-runs the window from its start, not from the old page token', async () => {
    const { a, link } = await connected();
    await asSystem(h, w.tenantId, (tx) => sql`UPDATE user_mail_links SET backfill_page_token = '8', backfill_done_at = NULL, last_synced_at = now() - interval '1 minute' WHERE id = ${link.id}::uuid`.execute(tx));
    expect((await call(a, 'POST', '/me/mail-link/import-again')).status).toBe(200);
    const from = h.providers.gmail.calls.length;
    await runMailSync(h, w.tenantId);
    const lists = h.providers.gmail.calls.slice(from).filter((x) => x.method === 'listMessages');
    expect(lists[0]!.arg!.split(':')[1]).toBe('');
  });

  it('R-GMAIL-10: a fresh live client reply seen only by a backfill page still pauses (decided by the copy’s origin and age, not the mode)', async () => {
    const { box, c } = await connected();
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step: { stepKey: 's', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] }, body: 'Reminder.', category: 'reminder', purpose: 'informational' });
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'call me', internalDate: Date.now() });
    const real = h.providers.gmail.listHistory.bind(h.providers.gmail);
    h.providers.gmail.listHistory = async (t, s) => ({ added: [], removed: [], labelChanges: [], historyId: s, pageHistoryId: null });
    try {
      await runMailSync(h, w.tenantId);
    } finally {
      h.providers.gmail.listHistory = real;
    }
    expect((await copiesOf(h, { contactId: c.id })).map((x) => x.origin)).toEqual(['live']);
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [pb.enrollmentId])).rows[0]!.state).toBe('paused');
  });

  it('R-GMAIL-9: an opt-out is recorded once per Gmail message, even after its cited copy was deleted and the message re-imported', async () => {
    const { a, box, c, pid } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'unsubscribe', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const count = async () => (await h.su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND evidence->>'kind' = 'synced_gmail'", [c.id])).rows[0]!.n;
    expect(await count()).toBe(1);
    await call(a, 'DELETE', `/me/mail-sync-points/${pid}`);
    await runMailSync(h, w.tenantId, { due: false });
    expect(await copiesOf(h, { contactId: c.id })).toEqual([]);
    await confirmAddresses(a, [pid]);
    await call(a, 'POST', '/me/mail-link/import-again');
    await asSystem(h, w.tenantId, (tx) => sql`UPDATE user_mail_links SET history_id = '1000' WHERE user_id = ${a.userId}::uuid AND status <> 'revoked'`.execute(tx));
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: c.id })).toHaveLength(1);
    expect(await count()).toBe(1);
  });

  it('R-GMAIL-8: confirming a client after the connect-time backfill ran imports that client’s earlier mail inside the window (the page’s "was imported" stays true)', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const box = mailbox();
    const c = await ownedContact(a);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'from last week', internalDate: Date.now() - 7 * 86_400_000 });
    expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
    await runMailSync(h, w.tenantId); // the backfill runs before anything is confirmed
    expect((await linkOf(h, a.userId!))!.backfill_done_at).not.toBeNull();
    await confirmAddresses(a, [await pointId(h, c.id, 'email')]);
    await runMailSync(h, w.tenantId);
    expect((await copiesOf(h, { contactId: c.id })).map((x) => [x.body, x.origin])).toEqual([['from last week', 'backfill']]);
  });

  it('R-GMAIL-5: a colon inside a comment is not a group separator', () => {
    expect(parseAddressList('jane@x.com (Jane: Sales), bob@y.test')).toEqual(['jane@x.com', 'bob@y.test']);
  });
});
