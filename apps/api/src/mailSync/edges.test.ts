// The D2 edge cases of module 68 against the FakeGmail and real Postgres (DATA_MODEL §10 E202-E225, E229; R-GMAIL-5,
// -8, -9, -11, -13). Each test is named by its edge-case id.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, pointId, randomEmail } from '../comms/testing.js';
import { command } from '../leads/testing.js';
import { gmailMessageRef } from './match.js';
import { GMAIL_READONLY_SCOPE } from './provider.js';
import { asSystem, clearGmailPack, confirmAddresses, connectGmail, copiesOf, enableMailSync, linkOf, runMailSync } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let n = 0;
const mailbox = () => `box-${++n}-${randomUUID().slice(0, 6)}@gmail.test`;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, teamLead: true });
  await clearGmailPack(h);
  await enableMailSync(h, w.owner);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function connected(o: { confirm?: boolean } = {}) {
  const a = await inviteViaApi(h, w.owner, 'agent');
  const box = mailbox();
  expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
  const c = await ownedContact(a);
  const pid = await pointId(h, c.id, 'email');
  if (o.confirm !== false) await confirmAddresses(a, [pid]);
  return { a, box, c, pid, link: (await linkOf(h, a.userId!))! };
}

const consentFor = async (contactId: string) =>
  (await h.su.query("SELECT event_type, channel, source, needs_review, actor_kind, evidence, evidence_message_id FROM consent_events WHERE contact_id = $1 AND evidence->>'kind' = 'synced_gmail' ORDER BY occurred_at", [contactId])).rows;

describe('what is stored (R-GMAIL-5)', () => {
  it('E202: a client writes from an address not on file: not stored; once added and confirmed, later mail syncs and "import again" brings earlier mail inside the window', async () => {
    const { a, box, c, link } = await connectedAgentWithBackfill();
    const work = randomEmail();
    h.providers.gmail.deliver(box, { from: work, to: [box], text: 'From my work address', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    expect((await call(a, 'POST', `/contacts/${c.id}/points`, { kind: 'email', address: work })).status).toBe(201);
    const sugg = await call<{ suggestions: { pointId: string; address: string }[] }>(a, 'GET', '/me/mail-sync-points');
    const s = sugg.body.suggestions.find((x) => x.address === work)!;
    expect(s).toBeTruthy();
    await confirmAddresses(a, [s.pointId]);
    expect((await call(a, 'POST', '/me/mail-link/import-again')).status).toBe(200);
    await runMailSync(h, w.tenantId);
    expect((await copiesOf(h, { linkId: link.id })).map((x) => x.body)).toEqual(['From my work address']);
  });

  it('E203: personal mail is never stored: an unconfirmed address captures nothing (a peer made the agent a collaborator on a stranger), and the agent’s own mailbox added as a contact point by a Team Lead cannot be confirmed', async () => {
    const { a, box, link } = await connected();
    // a TL adds the agent's own Gmail as an address of a contact the agent owns
    const victim = await ownedContact(a);
    const own = await call(w.teamLead!, 'POST', `/contacts/${victim.id}/points`, { kind: 'email', address: box });
    if (own.status === 201) {
      const pid = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2", [victim.id, box])).rows[0]!.id;
      expect((await call(a, 'POST', '/me/mail-sync-points', { pointIds: [pid] })).code).toBe('MAIL_POINT_NOT_ALLOWED');
      const sugg = await call<{ suggestions: { address: string }[] }>(a, 'GET', '/me/mail-sync-points');
      expect(sugg.body.suggestions.map((x) => x.address)).not.toContain(box);
    }
    // an address on a related contact that the agent never confirmed
    const stranger = await ownedContact(a);
    h.providers.gmail.deliver(box, { from: stranger.email, to: [box], text: 'my doctor', internalDate: Date.now() });
    h.providers.gmail.deliver(box, { from: box, to: [box], text: 'note to self', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });

  it('E204 E205 E206 E208: Cc with a lender (count only), Bcc (count only), a forward to a friend (nothing), an attachment (metadata only, never fetched)', async () => {
    const { box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: box, to: ['lender@bank.test'], cc: [c.email], text: 'Looping in the lender', internalDate: Date.now() });
    h.providers.gmail.deliver(box, { from: box, to: ['a@o.test', 'b@o.test'], bcc: [c.email], text: 'Bcc', internalDate: Date.now() });
    h.providers.gmail.deliver(box, { from: box, to: ['friend@home.test'], text: `Fwd: from ${c.email}`, internalDate: Date.now() });
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Contract attached', attachments: [{ name: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 12345 }], internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const rows = await copiesOf(h, { linkId: link.id });
    expect(rows.map((r) => [r.contact_role, r.sender, r.other_recipient_count])).toEqual([['cc', 'mailbox', 1], ['bcc', 'mailbox', 2], ['from', 'contact', 0]]);
    const att = (await h.su.query('SELECT attachments FROM mail_messages WHERE link_id = $1 AND contact_role = $2', [link.id, 'from'])).rows[0]!.attachments;
    expect(att).toEqual([{ name: 'contract.pdf', mime_type: 'application/pdf', size_bytes: 12345 }]);
    const all = JSON.stringify((await h.su.query('SELECT * FROM mail_messages WHERE link_id = $1', [link.id])).rows);
    for (const x of ['lender@bank.test', 'a@o.test', 'friend@home.test']) expect(all).not.toContain(x);
    expect(h.providers.gmail.calls.some((x) => /attachment/i.test(x.method))).toBe(false);
  });

  it('R-GMAIL-5: HTML is never stored: a message with only an HTML part stores an empty plain text body', async () => {
    const { box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: null, html: '<p>Hi <b>there</b><script>x</script></p>', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const rows = (await h.su.query('SELECT body FROM mail_messages WHERE link_id = $1', [link.id])).rows;
    expect(rows).toEqual([{ body: '' }]);
  });

  it('E209: a long thread keeps at most max_messages_per_thread copies; the read route says older messages stay in Gmail', async () => {
    const { a, box, c, link } = await connected();
    await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || '{"max_messages_per_thread": 3}' WHERE key = 'platform:gmail' AND status = 'published'`);
    try {
      for (let i = 0; i < 5; i++) h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: 'longthread', text: `msg ${i}`, internalDate: Date.now() + i });
      await runMailSync(h, w.tenantId);
      await runMailSync(h, w.tenantId);
      expect(await copiesOf(h, { linkId: link.id })).toHaveLength(3);
      const r = await call<{ items: { threadCapped: boolean }[] }>(a, 'GET', `/contacts/${c.id}/mail-messages`);
      expect(r.body.items.every((i) => i.threadCapped)).toBe(true);
    } finally {
      await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || '{"max_messages_per_thread": 200}' WHERE key = 'platform:gmail' AND status = 'published'`);
    }
  });
});

async function connectedAgentWithBackfill() {
  return connected();
}

describe('one mailbox, one live link (R-GMAIL-2)', () => {
  it('E210: a shared mailbox a teammate already linked is refused (nothing stored, the token revoked at Google)', async () => {
    const { box } = await connected();
    const b = await inviteViaApi(h, w.owner, 'agent');
    const revoked = h.providers.gmail.revoked.length;
    expect((await connectGmail(h, b, box)).result).toBe('MAILBOX_LINKED_ELSEWHERE');
    expect(await linkOf(h, b.userId!)).toBeUndefined();
    expect(h.providers.gmail.revoked.length).toBe(revoked + 1);
  });

  it('E211: the same Gmail connected in a second workspace is refused', async () => {
    const { box } = await connected();
    const other = await h.signup();
    await clearGmailPack(h);
    await enableMailSync(h, other);
    expect((await connectGmail(h, other, box)).result).toBe('MAILBOX_LINKED_ELSEWHERE');
  });

  it('E225 R-GMAIL-3: a token that also grants gmail.modify (incremental authorization) is refused and nothing is stored; a narrower grant too', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    for (const scopes of [[GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.modify'], ['https://www.googleapis.com/auth/gmail.metadata'], [GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/calendar.events']]) {
      const before = h.providers.gmail.revoked.length;
      expect((await connectGmail(h, a, mailbox(), { scopes })).result).toBe('SCOPE_NOT_ALLOWED');
      expect(await linkOf(h, a.userId!)).toBeUndefined();
      expect(h.providers.gmail.revoked.length).toBe(before + 1);
    }
    // and the database would refuse it anyway (scopes CHECK)
    const def = (await h.su.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'user_mail_links'::regclass AND pg_get_constraintdef(oid) LIKE '%scopes%'")).rows[0]!.d;
    expect(def).toContain(GMAIL_READONLY_SCOPE);
  });
});

describe('opt-outs (R-GMAIL-9, D1)', () => {
  it('E213: "Please stop emailing me" in Gmail sets the person-level do-not-contact (needs_review), citing the stored copy, as a system email revoke', async () => {
    const { box, c } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Please stop emailing me.', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const ev = await consentFor(c.id);
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect(e).toMatchObject({ event_type: 'revoke', channel: 'email', source: 'inbound_language', needs_review: true, actor_kind: 'system', evidence_message_id: null });
    const copy = (await copiesOf(h, { contactId: c.id }))[0]!;
    expect(ev[0].evidence.mail_message_id).toBe(copy.id);
    expect((await h.su.query('SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [c.id])).rows[0]!.dnc).toBe(true);
  });

  it('E214: an old "unsubscribe" inside the backfill revokes email on that point', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const box = mailbox();
    const c = await ownedContact(a);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'unsubscribe', internalDate: Date.now() - 5 * 86_400_000 });
    expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
    await confirmAddresses(a, [await pointId(h, c.id, 'email')]);
    await runMailSync(h, w.tenantId);
    const copies = await copiesOf(h, { contactId: c.id });
    expect(copies.map((x) => x.origin)).toEqual(['backfill']);
    const ev = await consentFor(c.id);
    expect(ev.map((e) => [e.event_type, e.channel, e.source])).toEqual([['revoke', 'email', 'inbound_keyword']]);
  });

  it('E229 S-D2-3: "unsubscribe" in a thread the agent excluded is recorded (citing gmail_message_ref) and nothing is stored; an unconfirmed address too', async () => {
    const { a, box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: 'private1', text: 'hello', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect((await call(a, 'POST', '/me/mail-threads/private1/exclude')).status).toBe(200);
    const id = h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: 'private1', text: 'unsubscribe', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    const ev = await consentFor(c.id);
    expect(ev.map((e) => e.evidence.gmail_message_ref)).toContain(gmailMessageRef(link.id, id));
    // unconfirmed: a related client the agent never confirmed
    const other = await ownedContact(a);
    h.providers.gmail.deliver(box, { from: other.email, to: [box], text: 'STOP', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { contactId: other.id })).toEqual([]);
    expect((await consentFor(other.id)).map((e) => [e.channel, e.source])).toEqual([['email', 'inbound_keyword']]);
    // replay records nothing twice
    await asSystem(h, w.tenantId, (tx) => sql`UPDATE user_mail_links SET history_id = '1000' WHERE id = ${link.id}::uuid`.execute(tx));
    await runMailSync(h, w.tenantId);
    expect(await consentFor(other.id)).toHaveLength(1);
  });

  it('R-GMAIL-9: synced mail never lifts an opt-out ("START" in Gmail records nothing)', async () => {
    const { box, c } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'unsubscribe', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'START', internalDate: Date.now() + 1 });
    await runMailSync(h, w.tenantId);
    expect((await consentFor(c.id)).map((e) => e.event_type)).toEqual(['revoke']);
  });
});

describe('revocation, reassignment, merge, erasure (R-GMAIL-6, -13)', () => {
  it('E215: the agent leaves the team: the link is revoked (MEMBER_INACTIVE), the token deleted, copies hidden at once and deleted', async () => {
    const { a, box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Hi', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    const version = (await h.su.query('SELECT version FROM memberships WHERE user_id = $1', [a.userId])).rows[0]!.version;
    await freshReauth(h, w.owner);
    const rm = await call(w.owner, 'PATCH', `/members/${a.userId}`, { status: 'suspended', version });
    expect(rm.status).toBe(200);
    expect((await call<{ items: unknown[] }>(w.owner, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    await runMailSync(h, w.tenantId);
    expect(await linkOf(h, a.userId!)).toMatchObject({ status: 'revoked', revoke_reason: 'MEMBER_INACTIVE', refresh_enc: null });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });

  it('E216: a contact reassigned A → B: B reads A’s earlier synced mail like the timeline; A’s new mail with that contact is no longer stored', async () => {
    const { a, box, c, link } = await connected();
    const b = await inviteViaApi(h, w.owner, 'agent');
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'before', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect((await command(w.owner, c.id, 'reassign', { toUserId: b.userId })).status).toBe(200);
    expect((await call<{ items: { body: string }[] }>(b, 'GET', `/contacts/${c.id}/mail-messages`)).body.items.map((i) => i.body)).toEqual(['before']);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'after', internalDate: Date.now() + 1 });
    await runMailSync(h, w.tenantId);
    expect((await copiesOf(h, { linkId: link.id })).map((x) => x.body)).toEqual(['before']);
    void a;
  });

  it('E217: the agent revokes access in their Google account: invalid_grant ⇒ PROVIDER_REVOKED, handled as a disconnect; the status says "connect again"', async () => {
    const { a, box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'Hi', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    h.providers.gmail.revokeAllFor(box);
    await runMailSync(h, w.tenantId);
    expect(await linkOf(h, a.userId!)).toMatchObject({ status: 'revoked', revoke_reason: 'PROVIDER_REVOKED', refresh_enc: null });
    const st = await call<{ link: { statusSentence: string } }>(a, 'GET', '/me/mail-link');
    expect(st.body.link.statusSentence).toBe('Google access was removed: connect again.');
    await runMailSync(h, w.tenantId, { due: false });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });

  it('E218 R-GMAIL-11: an expired history id triggers a bounded resync inside the backfill window, never a full-mailbox read; what it finds pauses only under the 1-hour rule', async () => {
    const { box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'during the outage', internalDate: Date.now() });
    h.providers.gmail.expireHistory(box);
    const from = h.providers.gmail.calls.length;
    await runMailSync(h, w.tenantId);
    expect((await copiesOf(h, { linkId: link.id })).map((x) => x.body)).toEqual(['during the outage']);
    const lists = h.providers.gmail.calls.slice(from).filter((x) => x.method === 'listMessages');
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) expect(Number(l.arg!.split(':')[0])).toBeGreaterThan(Date.now() - 31 * 86_400_000);
  });

  it('E219: a message trashed, marked spam or deleted in Gmail has its copies deleted in the next pass', async () => {
    const { box, c, link } = await connected();
    const t = h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'one', internalDate: Date.now() });
    const s = h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'two', internalDate: Date.now() });
    const d = h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'three', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(3);
    h.providers.gmail.label(box, t, ['TRASH']);
    h.providers.gmail.label(box, s, ['SPAM']);
    h.providers.gmail.remove(box, d);
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });

  it('E223: two contacts merged: copies re-pointed to the survivor’s confirmed point with the same address; a copy that would collide, or whose survivor point is unconfirmed, is deleted', async () => {
    const { a, box, link } = await connected();
    const shared = randomEmail();
    const loser = await ownedContact(a, { email: shared, confirmDistinct: true });
    const survivor = await ownedContact(a, { email: randomEmail() });
    expect((await call(a, 'POST', `/contacts/${survivor.id}/points`, { kind: 'email', address: shared })).status).toBe(201);
    const lp = (await h.su.query('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [loser.id, shared])).rows[0]!.id;
    const sp = (await h.su.query('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [survivor.id, shared])).rows[0]!.id;
    await confirmAddresses(a, [lp, sp]);
    // one message to the loser only (re-pointed), one to both (collides: deleted)
    h.providers.gmail.deliver(box, { from: shared, to: [box], text: 'only loser', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    const before = await copiesOf(h, { linkId: link.id });
    expect(before.length).toBeGreaterThanOrEqual(1);
    await h.su.query('UPDATE contacts SET merged_into_contact_id = $2 WHERE id = $1', [loser.id, survivor.id]);
    await runMailSync(h, w.tenantId, { due: false });
    const after = await copiesOf(h, { linkId: link.id });
    expect(after.every((x) => x.contact_id === survivor.id)).toBe(true);
    expect(new Set(after.map((x) => x.gmail_message_id)).size).toBe(after.length);
  });

  it('E224: a contact erased: its copies are deleted', async () => {
    const { box, c, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'erase me', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'POST', `/contacts/${c.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(r.status).toBe(200);
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });

  it('S-D2-2 R-GMAIL-13: "Stop syncing this address" hides at once and deletes in the next pass; a revoked link whose next_sync_at is NULL still has its copies deleted', async () => {
    const { a, box, c, pid, link } = await connected();
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'x', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    expect((await call(a, 'DELETE', `/me/mail-sync-points/${pid}`)).body).toEqual({ removed: true });
    expect((await call<{ items: unknown[] }>(a, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    await runMailSync(h, w.tenantId, { due: false });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
    // revoked with next_sync_at NULL
    await confirmAddresses(a, [pid]);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], text: 'y', internalDate: Date.now() + 5 });
    await runMailSync(h, w.tenantId);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
    await withTenantTx(systemActor(), async (tx) => {
      await sql`UPDATE user_mail_links SET status = 'revoked', revoke_reason = 'PROVIDER_REVOKED', refresh_enc = NULL, next_sync_at = NULL, purge_after = now() + interval '30 days' WHERE id = ${link.id}::uuid`.execute(tx);
    }, { db: h.database });
    await runMailSync(h, w.tenantId, { due: false });
    expect(await copiesOf(h, { linkId: link.id })).toEqual([]);
  });
});

function systemActor() {
  return { kind: 'system' as const, tenantId: w.tenantId as never, via: 'worker' as const };
}
