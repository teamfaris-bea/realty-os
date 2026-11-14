// Module 45 sign-in (R-PORTAL-10, R-PORTAL-11, R-PORTAL-12, R-GATE-14; E680-E686). Fakes only; platform:portal is
// cleared in the per-test database inside try/finally.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_ORIGIN, createApiHarness } from '../auth/testHarness.js';
import { reconcileOutbound } from '../comms/dispatch.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { PORTAL_LINK_CAP_SENTENCE } from '../comms/telephonySafeguards.js';
import { ownedContact } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { linkChannels } from './signin/delivery.js';
import { linkExpireInTx } from './signin/links.js';
import { settlePortalSignins, signinTestHooks } from './signin/routes.js';
import { PortalClient, askLink, call, client, deal, invite, json, lastToken, portalWorld, randomEmail, setPortalCleared, signIn, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let slug: string;
let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  slug = await slugOf(h, w.tenantId);
  await setPortalCleared(h, true);
}, 240_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

/** An invited buyer on a new deal of agent 0. */
async function invited(o: { firstName?: string; email?: string } = {}) {
  const c = await client(w.agents[0]!, o);
  const dealId = await deal(w.agents[0]!, c.id);
  const inv = await invite(w.agents[0]!, dealId, c.id);
  if (inv.status !== 200) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
  return { ...c, dealId, accountId: inv.body.account.id, grantId: inv.body.grant.id };
}
const headersOf = (r: { headers: Record<string, unknown> }) => {
  const { date: _d, 'x-request-id': _r, ...rest } = r.headers;
  return rest;
};
const linkMessages = (contactId: string) =>
  h.su.query<{ id: string; status: string; body: string; channel: string; gate_decision_id: string | null }>(`SELECT id, status, body, channel, gate_decision_id FROM messages WHERE action_category = 'portal_login_link' AND contact_id = $1 ORDER BY created_at`, [contactId]).then((r) => r.rows);
const providerCalls = () => h.providers.email.sent.length + h.providers.telephony.sms.length;

describe('R-PORTAL-10 one answer for every address (E680)', () => {
  it('E680: a match, an unknown team or address, a disabled account, a removed point, a throttled account and an opted-out recipient get the same 202, body and headers', async () => {
    const match = await invited({ firstName: 'Mia' });
    const disabled = await invited({ firstName: 'Dee' });
    await call(w.agents[0]!, 'POST', `/portal-accounts/${disabled.accountId}/disable`, { reason: 'CLIENT_ASKED' });
    const removed = await invited({ firstName: 'Rae' });
    await h.su.query(`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE contact_id = $1 AND kind = 'email'`, [removed.id]);
    const throttled = await invited({ firstName: 'Tom' });
    for (let i = 0; i < 5; i++) await h.su.query(`INSERT INTO portal_login_tokens (tenant_id, id, token_hash, portal_account_id, login_point_id, created_at, expires_at)
      SELECT a.tenant_id, gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), a.id, a.login_point_id, now(), now() + interval '15 minutes' FROM portal_accounts a WHERE a.id = $1`, [throttled.accountId]);
    const opted = await invited({ firstName: 'Oli' });
    const point = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'`, [opted.id])).rows[0]!.id;
    const rv = await call(w.agents[0]!, 'POST', `/contacts/${opted.id}/consent`, { kind: 'revoke', pointId: point, channel: 'email', purpose: 'all', evidence: { note: 'asked by email' } });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);

    const answers = [];
    for (const [team, address] of [[slug, match.email], ['no-such-team', match.email], [slug, randomEmail()], [slug, disabled.email], [slug, removed.email], [slug, throttled.email], [slug, opted.email], [slug.toUpperCase(), match.email]] as const) {
      answers.push(await askLink(h, team, address, ip()));
    }
    for (const a of answers) {
      expect(a.statusCode).toBe(202);
      expect(a.body).toBe(answers[0]!.body);
      expect(headersOf(a)).toEqual(headersOf(answers[0]!));
    }
    expect(json<{ message: string }>(answers[0]!).message).toMatch(/^If that email or phone number is the one your agent set up/);
    expect(lastToken(h, match.email)).not.toBeNull();
    expect(lastToken(h, disabled.email)).toBeNull();
    expect(lastToken(h, throttled.email)).toBeNull();
    // the opted-out recipient (R-GATE-14): a stored deny decision with the portal category, no provider call
    expect(lastToken(h, opted.email)).toBeNull();
    const m = await linkMessages(opted.id);
    expect(m.map((x) => x.status)).toEqual(['blocked']);
    const d = await h.su.query<{ action_category: string; outcome: string; reason_codes: string[]; core_rules_version: string }>('SELECT action_category, outcome, reason_codes, core_rules_version FROM gate_decisions WHERE id = $1', [m[0]!.gate_decision_id]);
    expect(d.rows[0]).toMatchObject({ action_category: 'portal_login_link', outcome: 'deny', core_rules_version: 'core-compliance/3.2.0' });
    expect(d.rows[0]!.reason_codes).toContain('CONSENT_REVOKED');
  });

  it('R-PORTAL-10 E680: the reply leaves before requestPortalLogin starts (a lookup held open does not hold the answer)', async () => {
    const match = await invited({ firstName: 'Ari' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: boolean[] = [];
    const { requestPortalLogin } = await import('@realty/db');
    signinTestHooks.onLookup = (o) => seen.push(o.replySent);
    signinTestHooks.lookup = async (...a) => {
      await gate;
      return requestPortalLogin(...a);
    };
    try {
      const r = await h.app.inject({ method: 'POST', url: '/api/portal/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, remoteAddress: ip(), payload: JSON.stringify({ team: slug, address: match.email }) });
      expect(r.statusCode).toBe(202);
      expect(lastToken(h, match.email)).toBeNull(); // nothing looked up yet: the answer did not wait
      release();
      await settlePortalSignins();
      expect(seen).toEqual([true]);
      expect(lastToken(h, match.email)).not.toBeNull();
    } finally {
      signinTestHooks.onLookup = undefined;
      signinTestHooks.lookup = undefined;
    }
  });

  it('E681 R-INT-6: while platform:portal is not cleared every address gets 503 PORTAL_NOT_AVAILABLE and nothing is written or sent', async () => {
    const match = await invited({ firstName: 'Bo' });
    await setPortalCleared(h, false);
    try {
      const before = providerCalls();
      for (const address of [match.email, match.phone, randomEmail(), '+14155550199']) {
        const r = await askLink(h, slug, address, ip());
        expect(r.statusCode, address).toBe(503);
        expect(json<{ error: { code: string } }>(r).error.code).toBe('PORTAL_NOT_AVAILABLE');
      }
      expect(providerCalls()).toBe(before);
      expect((await h.su.query('SELECT 1 FROM portal_login_tokens WHERE portal_account_id = $1', [match.accountId])).rowCount).toBe(0);
    } finally {
      await setPortalCleared(h, true);
    }
  });

  it('E686 R-PORTAL-10: a channel that cannot really send answers 503 {channel} for every address of that kind (fakes refused outside tests; texts need Twilio and live texting)', async () => {
    expect(linkChannels({ env: 'production', telephonyLiveRequests: false, providers: { email: 'smtp', telephony: 'twilio' } })).toEqual({ email: 'real', sms: 'off' });
    expect(linkChannels({ env: 'production', telephonyLiveRequests: true, providers: { email: 'fake', telephony: 'twilio' } })).toEqual({ email: 'off', sms: 'real' });
    expect(linkChannels({ env: 'development', telephonyLiveRequests: true, providers: { email: 'fake', telephony: 'fake' } })).toEqual({ email: 'off', sms: 'off' });
    expect(linkChannels({ env: 'test', telephonyLiveRequests: false, providers: { email: 'fake', telephony: 'twilio' } })).toEqual({ email: 'test', sms: 'off' });
    const match = await invited({ firstName: 'Cy' });
    const cfg = h.app.platform.config as { env: string };
    const saved = cfg.env;
    cfg.env = 'development'; // fakes outside tests: both channels off
    try {
      const before = providerCalls();
      for (const [address, channel] of [[match.email, 'email'], [randomEmail(), 'email'], [match.phone, 'sms'], ['+14155550142', 'sms']] as const) {
        const r = await askLink(h, slug, address, ip());
        expect(r.statusCode).toBe(503);
        expect(json<{ error: { code: string; details: { channel: string } } }>(r).error).toMatchObject({ code: 'PORTAL_NOT_AVAILABLE', details: { channel } });
      }
      expect(providerCalls()).toBe(before);
    } finally {
      cfg.env = saved;
    }
  });

  it('R-PORTAL-12: limits that apply whatever the address: the sixth try from one IP for one address in 15 minutes is 429, known or unknown', async () => {
    const match = await invited({ firstName: 'Lu' });
    for (const address of [match.email, randomEmail()]) {
      const from = ip();
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await askLink(h, slug, address, from)).statusCode);
      expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
    }
  });

  it('R-PORTAL-12: a malformed address is 422 before any lookup; a 5 KB body is 413', async () => {
    expect((await askLink(h, slug, 'not-an-address', ip())).statusCode).toBe(422);
    const big = await h.app.inject({ method: 'POST', url: '/api/portal/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, remoteAddress: ip(), payload: JSON.stringify({ team: slug, address: 'x'.repeat(5000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe('R-PORTAL-11 the sign-in link (E682-E685)', () => {
  it('R-PORTAL-11: the link reaches the fake by email, names whose portal it opens, and the stored body is the fixed line with no link (b14 F2; seal.test.ts covers every status)', async () => {
    const c = await invited({ firstName: 'Nia' });
    await askLink(h, slug, c.email, ip());
    const mail = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!;
    expect(mail.subject).toBe('Your sign-in link');
    expect(mail.text).toContain("sign-in link for Nia's client portal");
    expect(mail.text).toMatch(/\/portal\.html#token=[A-Za-z0-9_-]{43}$/);
    const rows = await linkMessages(c.id);
    expect(rows.at(-1)!.status).toBe('sent');
    expect(rows.at(-1)!.body).toBe("Harbor Realty LLC: sign-in link for Nia's client portal. It works once, for 15 minutes; if you did not ask for it, ignore this message. Sign in here (the link itself is not kept in the message history):");
    // the search tokens follow the body (0032's trigger): the line is indexed, the token never was
    const tok = lastToken(h, c.email)!;
    const hits = await h.su.query(`SELECT 1 FROM message_search_tokens WHERE message_id = $1 AND token ILIKE $2`, [rows.at(-1)!.id, `%${tok.slice(0, 12).toLowerCase()}%`]);
    expect(hits.rowCount).toBe(0);
    const indexed = await h.su.query(`SELECT 1 FROM message_search_tokens WHERE message_id = $1 AND token = 'history'`, [rows.at(-1)!.id]);
    expect(indexed.rowCount).toBe(1);
  });

  it('E684: while the outcome is unknown the body still holds no link (the reconcile renders it from its seal, seal.test.ts); once final it is unchanged, and the staff thread shows the line, never the link', async () => {
    const c = await invited({ firstName: 'Kit' });
    // the login point is the email; switch it to the phone so the link goes by text
    const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    expect((await call(w.agents[0]!, 'POST', `/portal-accounts/${c.accountId}/login-point`, { pointId: phonePoint })).status).toBe(200);
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, c.phone, ip());
    const [m] = (await linkMessages(c.id)).slice(-1);
    expect(m!.status).toBe('dispatch_unknown');
    expect(m!.body).not.toMatch(/#token=/);
    const deps = depsFromPlatform(h.app.platform);
    const sys = systemActor(w.tenantId, 'worker');
    await withTenantTx(sys, (tx, now) => linkExpireInTx(tx, m!.id, now), { db: h.database });
    expect((await linkMessages(c.id)).at(-1)!.status).toBe('dispatch_unknown'); // under 15 minutes: left to the reconcile
    const r = await reconcileOutbound(m!.id, deps, w.tenantId);
    expect(r).toMatchObject({ kind: 'resolved' });
    const after = (await linkMessages(c.id)).at(-1)!;
    expect(after.status).toBe('sent');
    expect(after.body).toBe(m!.body);
    // b14 F10: what staff see when they open the contact's thread (the timeline route), not just the row
    const thread = await call(w.agents[0]!, 'GET', `/contacts/${c.id}/timeline`);
    expect(thread.status).toBe(200);
    expect(JSON.stringify(thread.body)).toContain("sign-in link for Kit's client portal");
    expect(JSON.stringify(thread.body)).not.toContain('#token='); // the invite notice's ?team= page link is no token
  });

  it('E684: a link still queued after 15 minutes is canceled PORTAL_LINK_EXPIRED; its body never held the link', async () => {
    const c = await invited({ firstName: 'Pat' });
    h.providers.email.failNext('unavailable');
    await askLink(h, slug, c.email, ip());
    const [m] = (await linkMessages(c.id)).slice(-1);
    // a retryable provider failure leaves it for the queued comms.dispatch; make it look 16 minutes old
    await h.su.query(`UPDATE messages SET status = 'queued', created_at = now() - interval '16 minutes' WHERE id = $1`, [m!.id]);
    const sys = systemActor(w.tenantId, 'worker');
    await withTenantTx(sys, (tx, now) => linkExpireInTx(tx, m!.id, now), { db: h.database });
    const after = (await linkMessages(c.id)).at(-1)!;
    expect(after.status).toBe('canceled');
    expect(after.body).not.toMatch(/#token=/);
    expect((await h.su.query<{ status_reason: string }>('SELECT status_reason FROM messages WHERE id = $1', [m!.id])).rows[0]!.status_reason).toBe('PORTAL_LINK_EXPIRED');
  });

  it('E682: a paused conversation still gets the link; a suppression or a person-level do-not-contact blocks it with a decision and no provider call (R-GATE-14)', async () => {
    const paused = await invited({ firstName: 'Ivy' });
    const pausedRows = await h.su.query(`UPDATE conversations SET automation_paused_at = now(), automation_pause_reason = 'client_reply' WHERE contact_id = $1`, [paused.id]);
    expect(pausedRows.rowCount).toBe(1);
    const before = lastToken(h, paused.email);
    await askLink(h, slug, paused.email, ip());
    expect(lastToken(h, paused.email)).not.toBe(before);
    expect((await linkMessages(paused.id)).at(-1)!.status).toBe('sent');

    const supp = await invited({ firstName: 'Sol' });
    const hm = (await h.su.query<{ address_hmac: Buffer }>(`SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'email'`, [supp.id])).rows[0]!.address_hmac;
    await h.su.query("INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref) VALUES ($1, $2, 'email', $3, 'x', 'all', 'internal_dnc', '{}'::jsonb)", [w.tenantId, randomUUID(), hm]);
    const dnc = await invited({ firstName: 'Dan' });
    const d = await call(w.agents[0]!, 'POST', `/contacts/${dnc.id}/do-not-contact`, { reason: 'asked_in_writing' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const before2 = providerCalls();
    for (const [c, code] of [[supp, 'SUPPRESSED'], [dnc, 'PERSON_DO_NOT_CONTACT']] as const) {
      const r = await askLink(h, slug, c.email, ip());
      expect(r.statusCode).toBe(202);
      const m = (await linkMessages(c.id)).at(-1)!;
      expect(m.status).toBe('blocked');
      const dec = await h.su.query<{ reason_codes: string[]; action_category: string }>('SELECT reason_codes, action_category FROM gate_decisions WHERE id = $1', [m.gate_decision_id]);
      expect(dec.rows[0]!.action_category).toBe('portal_login_link');
      expect(dec.rows[0]!.reason_codes).toContain(code);
    }
    expect(providerCalls()).toBe(before2);
  });

  it('E683: spouses sharing an email each get their own link naming them, and each link opens only its own portal', async () => {
    const shared = randomEmail();
    const a = await invited({ firstName: 'Alex', email: shared });
    const b = await invited({ firstName: 'Blair', email: shared });
    const before = h.providers.email.sent.length;
    await askLink(h, slug, shared, ip());
    const mails = h.providers.email.sent.slice(before).filter((m) => m.to === shared);
    expect(mails).toHaveLength(2);
    expect(mails.map((m) => /for (\w+)'s client portal/.exec(m.text)![1]).sort()).toEqual(['Alex', 'Blair']);
    for (const m of mails) {
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
      const pc = new PortalClient(h, ip());
      expect((await pc.post('/api/portal/session', { token })).statusCode).toBe(200);
      const me = json<{ grants: { id: string }[] }>(await pc.get('/api/portal/me'));
      const mine = m.text.includes('Alex') ? a.grantId : b.grantId;
      expect(me.grants.map((g) => g.id)).toEqual([mine]);
    }
  });

  it('E685: a link works once; again, after 15 minutes, after a newer link, or in two tabs at once, it is 401 PORTAL_LINK_INVALID', async () => {
    const c = await invited({ firstName: 'Eve' });
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE portal_account_id = $1`, [c.accountId]);
    await askLink(h, slug, c.email, ip());
    const first = lastToken(h, c.email)!;
    const pc = new PortalClient(h, ip());
    expect((await pc.post('/api/portal/session', { token: first })).statusCode).toBe(200);
    const again = await new PortalClient(h, ip()).post('/api/portal/session', { token: first });
    expect(again.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(again).error.code).toBe('PORTAL_LINK_INVALID');
    // superseded by a newer link
    await askLink(h, slug, c.email, ip());
    const older = lastToken(h, c.email)!;
    await askLink(h, slug, c.email, ip());
    const newer = lastToken(h, c.email)!;
    expect((await new PortalClient(h, ip()).post('/api/portal/session', { token: older })).statusCode).toBe(401);
    // two tabs at once: exactly one wins
    const both = await Promise.all([new PortalClient(h, ip()).post('/api/portal/session', { token: newer }), new PortalClient(h, ip()).post('/api/portal/session', { token: newer })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    // expired
    await askLink(h, slug, c.email, ip());
    const late = lastToken(h, c.email)!;
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '16 minutes', expires_at = expires_at - interval '16 minutes' WHERE portal_account_id = $1 AND used_at IS NULL AND superseded_at IS NULL`, [c.accountId]);
    expect((await new PortalClient(h, ip()).post('/api/portal/session', { token: late })).statusCode).toBe(401);
  });

  it('R-PORTAL-12: opening sessions is limited per IP (the 21st try in 15 minutes is 429)', async () => {
    const from = ip();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await new PortalClient(h, from).post('/api/portal/session', { token: 'A'.repeat(43) })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('R-PORTAL-11: signIn helper works end to end (sanity)', async () => {
    const c = await invited({ firstName: 'Zed' });
    const pc = await signIn(h, slug, c.email, new PortalClient(h, ip()));
    expect((await pc.get('/api/portal/me')).statusCode).toBe(200);
  });
});

describe('R-PORTAL-12, R-TWL-2: sign-in texts spend only a bounded share of the team\'s daily text cap (b14 review R1)', () => {
  it('b14 review R1: anonymous link requests for a phone client spend at most a tenth of the cap; past that a link is blocked PORTAL_LINK_DAILY_CAP_REACHED, claims nothing, and a person\'s next text still goes', async () => {
    const agent = w.agents[0]!;
    const c = await client(agent, { firstName: 'Pat' });
    const d = await deal(agent, c.id);
    const phone = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    const inv = await invite(agent, d, c.id, { loginPointId: phone });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 20 WHERE tenant_id = $1', [w.tenantId]);
    await h.su.query('DELETE FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId]);
    // a real text channel (Twilio with live requests): the cap is on (depsFromPlatform), and text links are 'real'
    const cfg = h.app.platform.config as unknown as { providers: { telephony: string }; telephonyLiveRequests: boolean };
    const saved = { t: cfg.providers.telephony, live: cfg.telephonyLiveRequests };
    cfg.providers.telephony = 'twilio';
    cfg.telephonyLiveRequests = true;
    try {
      const before = h.providers.telephony.sms.length;
      for (let i = 0; i < 4; i++) expect((await askLink(h, slug, c.phone, ip())).statusCode).toBe(202);
      const links = await h.su.query<{ status: string; status_reason: string | null; gate_decision_id: string | null }>(
        `SELECT status, status_reason, gate_decision_id FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link' ORDER BY created_at`,
        [c.id],
      );
      // a cap of 20 lets sign-in texts use 2 units a day; the third and fourth are refused with their own reason
      expect(links.rows.map((m) => [m.status, m.status_reason])).toEqual([
        ['sent', null],
        ['sent', null],
        ['blocked', 'PORTAL_LINK_DAILY_CAP_REACHED'],
        ['blocked', 'PORTAL_LINK_DAILY_CAP_REACHED'],
      ]);
      const dec = await h.su.query<{ reason_codes: string[]; explanation: string }>('SELECT reason_codes, explanation FROM gate_decisions WHERE id = $1', [links.rows[3]!.gate_decision_id]);
      expect(dec.rows[0]!.reason_codes).toContain('PORTAL_LINK_DAILY_CAP_REACHED');
      expect(dec.rows[0]!.explanation).toContain(PORTAL_LINK_CAP_SENTENCE);
      expect(h.providers.telephony.sms.length - before).toBe(2);
      const usage = await h.su.query<{ sends: number; portal_link_sends: number }>('SELECT sends, portal_link_sends FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId]);
      expect(usage.rows).toEqual([{ sends: 2, portal_link_sends: 2 }]);
      // the agent's own text still goes, and claims the team's budget as usual
      const other = await ownedContact(agent, { consent: false });
      const sent = await call<{ message: { id: string } | null }>(agent, 'POST', `/contacts/${other.id}/messages`, { channel: 'sms', body: 'Are you free to see the house at 4?', idempotencyKey: randomUUID().replace(/-/g, '') });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const m = await h.su.query<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM messages WHERE id = $1', [sent.body.message?.id]);
      expect(m.rows[0]).toEqual({ status: 'sent', status_reason: null });
      expect((await h.su.query<{ sends: number }>('SELECT sends FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId])).rows[0]!.sends).toBe(3);
      // a cap under 10 leaves sign-in texts no share at all: the link is refused and the team's budget untouched
      await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 9 WHERE tenant_id = $1', [w.tenantId]);
      await h.su.query('DELETE FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId]);
      await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE portal_account_id = $1`, [inv.body.account.id]);
      expect((await askLink(h, slug, c.phone, ip())).statusCode).toBe(202);
      const last = await h.su.query<{ status: string; status_reason: string | null }>(`SELECT status, status_reason FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link' ORDER BY created_at DESC LIMIT 1`, [c.id]);
      expect(last.rows[0]).toEqual({ status: 'blocked', status_reason: 'PORTAL_LINK_DAILY_CAP_REACHED' });
      expect((await h.su.query('SELECT sends FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId])).rows).toEqual([]);
      // the team's own cap reached by people's texts: a link is refused with the team's reason, as before
      await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 20 WHERE tenant_id = $1', [w.tenantId]);
      await h.su.query(`INSERT INTO telephony_daily_usage (tenant_id, day, sends) SELECT tenant_id, (now() AT TIME ZONE default_timezone)::date, 20 FROM tenant_settings WHERE tenant_id = $1`, [w.tenantId]);
      await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE portal_account_id = $1`, [inv.body.account.id]);
      expect((await askLink(h, slug, c.phone, ip())).statusCode).toBe(202);
      const full = await h.su.query<{ status: string; status_reason: string | null }>(`SELECT status, status_reason FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link' ORDER BY created_at DESC LIMIT 1`, [c.id]);
      expect(full.rows[0]).toEqual({ status: 'blocked', status_reason: 'DAILY_SEND_CAP_REACHED' });
      expect((await h.su.query('SELECT sends, portal_link_sends FROM telephony_daily_usage WHERE tenant_id = $1', [w.tenantId])).rows).toEqual([{ sends: 20, portal_link_sends: 0 }]);
    } finally {
      cfg.providers.telephony = saved.t;
      cfg.telephonyLiveRequests = saved.live;
      await h.su.query('UPDATE tenant_settings SET telephony_daily_cap = 200 WHERE tenant_id = $1', [w.tenantId]);
    }
  });

  it('b15 (b14 low b): a client whose sign-in point is a phone gets no link by email (portal.request_login matches only that point), so past the share, or under a cap of 10, they cannot sign in by text that day; the docs say so', async () => {
    const agent = w.agents[0]!;
    const c = await client(agent, { firstName: 'Lee' });
    const d = await deal(agent, c.id);
    const phone = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    expect((await invite(agent, d, c.id, { loginPointId: phone })).status).toBe(200);
    const emailsBefore = h.providers.email.sent.filter((m) => m.to.toLowerCase() === c.email.toLowerCase()).length;
    expect((await askLink(h, slug, c.email, ip())).statusCode).toBe(202);
    expect(h.providers.email.sent.filter((m) => m.to.toLowerCase() === c.email.toLowerCase())).toHaveLength(emailsBefore);
    expect((await h.su.query(`SELECT 1 FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link'`, [c.id])).rows).toEqual([]);
    // the three places that described the share say the real trade-off, never that the client can ask by email
    const { readFileSync } = await import('node:fs');
    const repo = new URL('../../../../', import.meta.url);
    const texts = {
      constant: /\/\*\*[^/]*\*\/\s*export const PORTAL_LINK_CAP_PERCENT/.exec(readFileSync(new URL('apps/api/src/comms/telephonySafeguards.ts', repo), 'utf8'))![0].replace(/\n\s*\*\s?/g, ' '),
      deploy: readFileSync(new URL('docs/DEPLOY.md', repo), 'utf8').split('\n').find((l) => l.startsWith('**Daily cap.**'))!,
      plan: readFileSync(new URL('docs/PHASE2_3_PLAN.md', repo), 'utf8').split('\n').find((l) => l.startsWith('| Q-PORTAL-17 '))!,
    };
    for (const [where, t] of Object.entries(texts)) {
      expect(t, where).not.toMatch(/can (still )?(ask|request)[^.]*by email|email links are not limited/i);
      expect(t, where).toMatch(/sign-in point is a phone/);
      expect(t, where).toMatch(/under a cap of 10/);
    }
  });
});
