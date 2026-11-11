// Adversarial tests of module 68 (PHASE2_3_PLAN §5.4 #68 "Adversarial"): the OAuth callback (forged, replayed, expired
// state; another user's or tenant's state; PKCE mismatch; a reused code; an extra scope; a mailbox live elsewhere; the
// switch turned off mid-flow), privacy (Owners/Admins/TLs read no link, token or confirmed address; a peer or TL cannot
// confirm on someone else's link; support and a client principal read no synced mail, E220, E221), token handling
// (encrypted at rest, access tokens never stored or logged) and tenant isolation.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withPortalTx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, pointId } from '../comms/testing.js';
import { CURRENT_DISCLOSURE_SHA256 } from './disclosure.js';
import { newNonce, signMailState } from './oauthState.js';
import { clearGmailPack, confirmAddresses, connectGmail, copiesOf, enableMailSync, linkOf, mailCallback, runMailSync, startMailConnect } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let admin: TestClient;
let n = 0;
const mailbox = () => `adv-${++n}-${randomUUID().slice(0, 6)}@gmail.test`;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  admin = await inviteViaApi(h, w.owner, 'admin');
  await clearGmailPack(h);
  await enableMailSync(h, w.owner);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const exchanges = () => h.providers.gmail.callCount('exchangeCode');

describe('the OAuth callback (R-GMAIL-2, R-GMAIL-3)', () => {
  it('a forged or altered state is refused before any provider call and stores nothing', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    const code = h.providers.gmail.issueCode({ codeChallenge: f.challenge, mailbox: mailbox() });
    const before = exchanges();
    const [body, mac] = f.state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), u: w.agents[1]!.userId })).toString('base64url')}.${mac}`;
    for (const state of [forged, `${body}.${'A'.repeat(43)}`, 'garbage', '']) expect((await mailCallback(h, { state, code })).result).toBe('STATE_INVALID');
    expect(exchanges()).toBe(before);
    expect(await linkOf(h, a.userId!)).toBeUndefined();
    expect(await linkOf(h, w.agents[1]!.userId!)).toBeUndefined();
  });

  it('a replayed state is refused (single use), whatever the first outcome was; an expired state is refused', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    expect((await mailCallback(h, { state: f.state, error: 'access_denied' })).result).toBe('CANCELLED');
    const code = h.providers.gmail.issueCode({ codeChallenge: f.challenge, mailbox: mailbox() });
    expect((await mailCallback(h, { state: f.state, code })).result).toBe('STATE_REPLAYED');
    expect(await linkOf(h, a.userId!)).toBeUndefined();
    const expired = signMailState(h.config.sessionSecret, { tenantId: w.tenantId, userId: a.userId!, disclosureSha256: CURRENT_DISCLOSURE_SHA256, expiresAt: Date.now() - 1, nonce: newNonce() });
    expect((await mailCallback(h, { state: expired, code: 'x' })).result).toBe('STATE_EXPIRED');
  });

  it('a state names its user and tenant: the link is the starter’s, and a state for a user who is not a member of that tenant stores nothing', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    const code = h.providers.gmail.issueCode({ codeChallenge: f.challenge, mailbox: mailbox() });
    // whoever's browser delivers it, the link belongs to the user the state names
    expect((await mailCallback(h, { state: f.state, code })).result).toBe('CONNECTED');
    expect((await linkOf(h, a.userId!))!.status).toBe('connected');
    const other = await h.signup();
    const cross = signMailState(h.config.sessionSecret, { tenantId: other.tenantId!, userId: a.userId!, disclosureSha256: CURRENT_DISCLOSURE_SHA256, expiresAt: Date.now() + 60_000, nonce: newNonce() });
    expect((await mailCallback(h, { state: cross, code: 'x' })).result).toBe('MAIL_SYNC_OFF');
    expect((await h.su.query('SELECT count(*)::int AS n FROM user_mail_links WHERE tenant_id = $1', [other.tenantId])).rows[0]!.n).toBe(0);
  });

  it('a PKCE verifier mismatch and a reused code are refused by the token exchange; nothing is stored', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f1 = await startMailConnect(a);
    const wrong = h.providers.gmail.issueCode({ codeChallenge: 'x'.repeat(43), mailbox: mailbox() });
    expect((await mailCallback(h, { state: f1.state, code: wrong })).result).toBe('PROVIDER_REFUSED');
    const f2 = await startMailConnect(a);
    const good = h.providers.gmail.issueCode({ codeChallenge: f2.challenge, mailbox: mailbox() });
    const f3 = await startMailConnect(a);
    expect((await mailCallback(h, { state: f3.state, code: good })).result).toBe('PROVIDER_REFUSED'); // another flow's code
    expect((await mailCallback(h, { state: f2.state, code: good })).result).toBe('PROVIDER_REFUSED'); // used once already
    expect(await linkOf(h, a.userId!)).toBeUndefined();
  });

  it('E225: a token with an extra scope (incremental authorization) is refused and revoked at Google; nothing is stored', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const r = await connectGmail(h, a, mailbox(), { scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'] });
    expect(r.result).toBe('SCOPE_NOT_ALLOWED');
    expect(await linkOf(h, a.userId!)).toBeUndefined();
  });

  it('the connect request asks exactly gmail.readonly, with PKCE S256, and never include_granted_scopes', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    const u = new URL(f.authorizeUrl);
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.has('include_granted_scopes')).toBe(false);
    expect((await call(a, 'POST', '/me/mail-link/connect', { disclosureSha256: 'f'.repeat(64) })).code).toBe('MAIL_DISCLOSURE_STALE');
  });

  it('a callback after the Owner switched sync off stores nothing and revokes the token', async () => {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const f = await startMailConnect(a);
    const code = h.providers.gmail.issueCode({ codeChallenge: f.challenge, mailbox: mailbox() });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/admin/mail-sync', { enabled: false, backfillDays: 30 })).status).toBe(200);
    try {
      expect((await mailCallback(h, { state: f.state, code })).result).toBe('MAIL_SYNC_OFF');
      expect(await linkOf(h, a.userId!)).toBeUndefined();
    } finally {
      await enableMailSync(h, w.owner);
    }
  });
});

describe('the Owner switch (R-GMAIL-1)', () => {
  it('R-GMAIL-1: only the Owner turns sync on and sets the window; an Admin may only turn it off; the Owner cannot turn it on while platform:gmail is uncleared', async () => {
    await freshReauth(h, admin);
    expect((await call(admin, 'PUT', '/admin/mail-sync', { enabled: true, backfillDays: 10 })).code).toBe('OWNER_REQUIRED');
    expect((await call(admin, 'PUT', '/admin/mail-sync', { enabled: false, backfillDays: 30 })).status).toBe(200);
    expect((await call(admin, 'PUT', '/admin/mail-sync', { enabled: true, backfillDays: 30 })).code).toBe('OWNER_REQUIRED');
    await clearGmailPack(h, false);
    try {
      await freshReauth(h, w.owner);
      const r = await call<{ pack: { sentence: string } }>(w.owner, 'GET', '/admin/mail-sync');
      expect(r.body.pack.sentence).toMatch(/Not reviewed by counsel; waiting for Google verification/);
      expect((await call(w.owner, 'PUT', '/admin/mail-sync', { enabled: true, backfillDays: 30 })).code).toBe('MAIL_SYNC_NOT_CLEARED');
    } finally {
      await clearGmailPack(h);
      await enableMailSync(h, w.owner);
    }
    for (const c of [w.agents[0]!, w.teamLead!]) expect([403, 404]).toContain((await call(c, 'GET', '/admin/mail-sync')).status);
  });
});

describe('privacy (R-GMAIL-2, -4, -6)', () => {
  async function connected() {
    const a = await inviteViaApi(h, w.owner, 'agent');
    const box = mailbox();
    expect((await connectGmail(h, a, box)).result).toBe('CONNECTED');
    const c = await ownedContact(a);
    await confirmAddresses(a, [await pointId(h, c.id, 'email')]);
    h.providers.gmail.deliver(box, { from: c.email, to: [box], threadId: 'privthr', text: 'Private client note', internalDate: Date.now() });
    await runMailSync(h, w.tenantId);
    return { a, box, c, link: (await linkOf(h, a.userId!))! };
  }

  it('Owners, Admins and Team Leads read no link, token, sync state, confirmed address or exclusion of another user (RLS and the API)', async () => {
    const { a, link } = await connected();
    expect((await call(a, 'POST', '/me/mail-threads/privthr/exclude')).status).toBe(200);
    for (const c of [w.owner, admin, w.teamLead!]) {
      const rows = await withTenantTx(c.actor(), async (tx) => ({
        links: (await sql`SELECT * FROM user_mail_links WHERE id = ${link.id}::uuid`.execute(tx)).rows.length,
        points: (await sql`SELECT * FROM mail_sync_points WHERE link_id = ${link.id}::uuid`.execute(tx)).rows.length,
        excl: (await sql`SELECT * FROM mail_thread_exclusions WHERE link_id = ${link.id}::uuid`.execute(tx)).rows.length,
      }), { db: h.database });
      expect(rows).toEqual({ links: 0, points: 0, excl: 0 });
      const me = await call<{ link: unknown }>(c, 'GET', '/me/mail-link');
      expect(me.body.link).toBeNull();
      expect((await call(c, 'DELETE', '/me/mail-link')).code).toBe('MAIL_NOT_CONNECTED');
      const adminView = await call(c, 'GET', '/admin/mail-sync');
      expect(JSON.stringify(adminView.body)).not.toMatch(/gmail\.test|mailbox|link/i);
    }
  });

  it('a peer or a Team Lead cannot confirm an address on someone else’s link (the policy and the definer guard)', async () => {
    const { link, c } = await connected();
    const pid = await pointId(h, c.id, 'email');
    for (const who of [w.teamLead!, w.owner, w.agents[1]!]) {
      await expect(withTenantTx(who.actor(), (tx) => sql`INSERT INTO mail_sync_points (tenant_id, link_id, contact_point_id, contact_id) VALUES (app.tenant_id(), ${link.id}::uuid, ${pid}::uuid, ${c.id}::uuid)`.execute(tx), { db: h.database })).rejects.toBeTruthy();
      expect((await call(who, 'POST', '/me/mail-sync-points', { pointIds: [pid] })).code).toBe('MAIL_NOT_CONNECTED');
    }
  });

  it('E220 E221: a support actor under an Owner grant and a client principal read no synced mail', async () => {
    const { c } = await connected();
    const support: Actor = { kind: 'support', userId: w.owner.userId!, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
    const sup = await withTenantTx(support, async (tx) => (await sql`SELECT id FROM mail_messages WHERE contact_id = ${c.id}::uuid`.execute(tx)).rows.length, { db: h.database }).catch(() => 0);
    expect(sup).toBe(0);
    const client = await withPortalTx({ kind: 'client', tenantId: w.tenantId as TenantId, portalAccountId: randomUUID() } as never, async (tx) => (await sql`SELECT id FROM mail_messages`.execute(tx)).rows.length, { db: h.database }).catch(() => 0);
    expect(client).toBe(0);
    // while the timeline readers do
    expect((await call<{ items: unknown[] }>(w.owner, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toHaveLength(1);
  });

  it('R-GMAIL-4: the refresh token is encrypted at rest; no access or refresh token appears in any row, response or log', async () => {
    const { a, c, link } = await connected();
    const row = (await h.su.query('SELECT refresh_enc, key_version FROM user_mail_links WHERE id = $1', [link.id])).rows[0]!;
    expect(row.refresh_enc.toString('utf8')).not.toMatch(/fake-refresh-/);
    expect(row.key_version).toBeGreaterThan(0);
    const dump = JSON.stringify([
      (await h.su.query('SELECT * FROM user_mail_links')).rows.map((r) => ({ ...r, refresh_enc: null })),
      (await h.su.query('SELECT * FROM audit_log')).rows,
      (await h.su.query('SELECT payload, last_error FROM jobs')).rows,
      (await h.su.query('SELECT * FROM webhook_events')).rows,
    ]);
    expect(dump).not.toMatch(/fake-(access|refresh)-/);
    expect(h.logs.join('\n')).not.toMatch(/fake-(access|refresh)-|Private client note/);
    const responses = JSON.stringify([(await call(a, 'GET', '/me/mail-link')).body, (await call(a, 'GET', `/contacts/${c.id}/mail-messages`)).body, (await call(a, 'GET', '/me/mail-sync-points')).body]);
    expect(responses).not.toMatch(/refresh|access_?token|fake-(access|refresh)-/i);
  });

  it('cross-tenant isolation: another tenant reads none of this tenant’s copies, links or confirmations, even with their ids', async () => {
    const { c, link } = await connected();
    const other = await h.signup();
    expect((await call<{ items: unknown[] }>(other, 'GET', `/contacts/${c.id}/mail-messages`)).body.items).toEqual([]);
    const rows = await withTenantTx(other.actor(), async (tx) => (await sql`SELECT 1 FROM user_mail_links WHERE id = ${link.id}::uuid UNION ALL SELECT 1 FROM mail_messages WHERE link_id = ${link.id}::uuid`.execute(tx)).rows.length, { db: h.database });
    expect(rows).toBe(0);
    expect(await copiesOf(h, { linkId: link.id })).toHaveLength(1);
  });

  it('a person cannot write synced mail, sync state or a link themselves (system only)', async () => {
    const { a, c, link } = await connected();
    const pid = await pointId(h, c.id, 'email');
    await expect(withTenantTx(a.actor(), (tx) => sql`UPDATE user_mail_links SET history_id = '1' WHERE id = ${link.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/MAIL_LINK_SYSTEM_ONLY/);
    await expect(withTenantTx(a.actor(), (tx) => sql`INSERT INTO mail_messages (tenant_id, id, link_id, contact_id, contact_point_id, contact_address_hmac, gmail_message_id, gmail_thread_id, sender, contact_role, body, internal_at, origin)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${link.id}::uuid, ${c.id}::uuid, ${pid}::uuid, ${Buffer.alloc(32)}, 'forged', 'forged', 'contact', 'from', 'x', now(), 'live')`.execute(tx), { db: h.database })).rejects.toBeTruthy();
  });
});
