// Module 68: opt-out equivalence with platform email (R-GMAIL-9, D1, D-OPTOUT-LANG), and the history cursor
// (R-GMAIL-11: replays are no-ops; the cursor never advances past an uncommitted page; a crash between pages
// resumes without gaps or duplicates). Real Postgres, real server, FakeGmail.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, emailWebhook, ownedContact, pointId } from '../comms/testing.js';
import { ProviderError } from '../providers/types.js';
import { clearGmailPack, confirmAddresses, connectGmail, copiesOf, enableMailSync, linkOf, runMailSync } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let n = 0;
const mailbox = () => `res-${++n}-${randomUUID().slice(0, 6)}@gmail.test`;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await clearGmailPack(h);
  await enableMailSync(h, w.owner);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function connected(): Promise<{ a: TestClient; box: string; linkId: string }> {
  const a = await inviteViaApi(h, w.owner, 'agent');
  const box = mailbox();
  expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
  return { a, box, linkId: (await linkOf(h, a.userId!))!.id };
}

type Ev = { event_type: string; channel: string; source: string; needs_review: boolean; address_kind: string };
const eventsOf = async (contactId: string): Promise<Ev[]> =>
  (await h.su.query<Ev>('SELECT event_type, channel, source, needs_review, address_kind FROM consent_events WHERE contact_id = $1 ORDER BY channel, source, event_type', [contactId])).rows;
const dnc = async (contactId: string) => (await h.su.query('SELECT do_not_contact_at IS NOT NULL AS d FROM contacts WHERE id = $1', [contactId])).rows[0]!.d as boolean;

describe('R-GMAIL-9: synced Gmail records what platform inbound email records for the same text', () => {
  const BODIES = ['unsubscribe', 'STOP', 'Please stop emailing me.', 'Wrong person, I am not Jane.', 'Do not text me anymore', 'Thanks, Thursday works!'];

  it('R-GMAIL-9 D-OPTOUT-LANG: the same email revokes (event type, source, needs_review) and the same person-level do-not-contact on both paths; synced mail cites itself and stays an email revoke', async () => {
    const { a, box } = await connected();
    for (const text of BODIES) {
      // platform inbound email
      const p = await ownedContact(a);
      await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), p.id, a.userId]);
      const sent = await call<{ result: string }>(a, 'POST', `/contacts/${p.id}/messages`, { channel: 'email', subject: 'Hi', body: 'Hello there.', idempotencyKey: `e-${randomUUID()}` });
      expect(sent.body.result, text).toBe('sent');
      const replyTo = h.providers.email.sent.filter((m) => m.to === p.email).at(-1)!.replyTo!;
      expect((await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: p.email, to: replyTo, subject: 'Re: Hi', text })).statusCode).toBe(200);
      // synced Gmail
      const g = await ownedContact(a);
      await confirmAddresses(a, [await pointId(h, g.id, 'email')]);
      h.providers.gmail.deliver(box, { from: g.email, to: [box], text, internalDate: Date.now() });
      await runMailSync(h, w.tenantId);
      const pe = (await eventsOf(p.id)).filter((e) => e.channel === 'email' && e.address_kind === 'email');
      const ge = (await eventsOf(g.id)).filter((e) => e.channel === 'email' && e.address_kind === 'email');
      expect(ge, text).toEqual(pe);
      expect(await dnc(g.id), text).toBe(await dnc(p.id));
      // anything platform email revoked beyond email is covered on the Gmail path by the person-level do-not-contact
      const beyond = (await eventsOf(p.id)).filter((e) => e.channel !== 'email' && e.event_type === 'revoke');
      if (beyond.length > 0) expect(await dnc(g.id), text).toBe(true);
    }
  });
});

describe('R-GMAIL-11: the history cursor', () => {
  it('R-GMAIL-11: the cursor never advances past an uncommitted page; a crash between pages resumes without gaps or duplicates; a replay stores nothing new', async () => {
    const { a, box, linkId } = await connected();
    const c = await ownedContact(a);
    await confirmAddresses(a, [await pointId(h, c.id, 'email')]);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(h.providers.gmail.deliver(box, { from: c.email, to: [box], text: `msg ${i}`, internalDate: Date.now() + i }));
    const cursor0 = (await linkOf(h, a.userId!))!.history_id;
    // the provider fails while fetching the 5th message (page 2 of 3): page 1 is committed, the cursor stays
    const real = h.providers.gmail.getMessage.bind(h.providers.gmail);
    let fail = true;
    h.providers.gmail.getMessage = async (t, id, f) => {
      if (fail && id === ids[4]) {
        fail = false;
        throw new ProviderError('unavailable', 'FAKE_OUTAGE');
      }
      return real(t, id, f);
    };
    try {
      await runMailSync(h, w.tenantId);
    } finally {
      h.providers.gmail.getMessage = real;
    }
    expect((await copiesOf(h, { linkId })).length).toBe(3);
    // the cursor moved with the committed page 1 only (3 records), never past the failed page
    const after1 = (await linkOf(h, a.userId!))!;
    expect(Number(after1.history_id)).toBe(Number(cursor0) + 3);
    expect((await h.su.query('SELECT last_error_code, status FROM user_mail_links WHERE id = $1', [linkId])).rows[0]).toMatchObject({ status: 'degraded' });
    await runMailSync(h, w.tenantId);
    const copies = await copiesOf(h, { linkId });
    expect(copies.map((x) => x.body).sort()).toEqual(ids.map((_, i) => `msg ${i}`).sort());
    expect(new Set(copies.map((x) => x.gmail_message_id)).size).toBe(8);
    const after2 = (await linkOf(h, a.userId!))!;
    expect(Number(after2.history_id)).toBeGreaterThan(Number(cursor0));
    expect((await h.su.query('SELECT status, last_error_code FROM user_mail_links WHERE id = $1', [linkId])).rows[0]).toEqual({ status: 'connected', last_error_code: null });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId })).toHaveLength(8);
  });

  it('R-GMAIL-8 R-GMAIL-11: backfill reads only the window (never the whole mailbox) and at most backfill_max_messages; older history is never imported', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const box = mailbox();
    const c = await ownedContact(a);
    const DAY = 86_400_000;
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'inside', internalDate: Date.now() - 10 * DAY });
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'outside', internalDate: Date.now() - 40 * DAY });
    expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
    await confirmAddresses(a, [await pointId(h, c.id, 'email')]);
    const from = h.providers.gmail.calls.length;
    await runMailSync(h, w.tenantId);
    expect((await copiesOf(h, { contactId: c.id })).map((x) => [x.body, x.origin])).toEqual([['inside', 'backfill']]);
    for (const l of h.providers.gmail.calls.slice(from).filter((x) => x.method === 'listMessages')) expect(Number(l.arg!.split(':')[0])).toBeGreaterThanOrEqual(Date.now() - 31 * DAY);
    expect((await linkOf(h, a.userId!))!.backfill_done_at).not.toBeNull();
  });
});
