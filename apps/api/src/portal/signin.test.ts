// Module 45 sign-in (R-PORTAL-10, R-PORTAL-11, R-PORTAL-12, R-GATE-14; E640-E646). Fakes only; platform:portal is
// cleared in the per-test database inside try/finally.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, TEST_ORIGIN, createApiHarness } from '../auth/testHarness.js';
import { reconcileOutbound } from '../comms/dispatch.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { systemActor } from '../worker/systemActor.js';
import { linkChannels } from './signin/delivery.js';
import { linkRedactInTx } from './signin/links.js';
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

describe('R-PORTAL-10 one answer for every address (E640)', () => {
  it('E640: a match, an unknown team or address, a disabled account, a removed point, a throttled account and an opted-out recipient get the same 202, body and headers', async () => {
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

  it('R-PORTAL-10 E640: the reply leaves before requestPortalLogin starts (a lookup held open does not hold the answer)', async () => {
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

  it('E641 R-INT-6: while platform:portal is not cleared every address gets 503 PORTAL_NOT_AVAILABLE and nothing is written or sent', async () => {
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

  it('E646 R-PORTAL-10: a channel that cannot really send answers 503 {channel} for every address of that kind (fakes refused outside tests; texts need Twilio and live texting)', async () => {
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

describe('R-PORTAL-11 the sign-in link (E642-E645)', () => {
  it('R-PORTAL-11: the link reaches the fake by email and by text, names whose portal it opens, and its stored body is redacted once final', async () => {
    const c = await invited({ firstName: 'Nia' });
    await askLink(h, slug, c.email, ip());
    const mail = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!;
    expect(mail.subject).toBe('Your sign-in link');
    expect(mail.text).toContain("sign-in link for Nia's client portal");
    expect(mail.text).toMatch(/\/portal\.html#token=[A-Za-z0-9_-]{43}/);
    const rows = await linkMessages(c.id);
    expect(rows.at(-1)!.status).toBe('sent');
    expect(rows.at(-1)!.body).toMatch(/: sign-in link for Nia's client portal \(link removed after sending; it worked once, for 15 minutes\)\.$/);
    // the search tokens follow the body (0032's trigger)
    const tok = lastToken(h, c.email)!;
    const hits = await h.su.query(`SELECT 1 FROM message_search_tokens WHERE message_id = $1 AND token ILIKE $2`, [rows.at(-1)!.id, `%${tok.slice(0, 12).toLowerCase()}%`]);
    expect(hits.rowCount).toBe(0);
    const indexed = await h.su.query(`SELECT 1 FROM message_search_tokens WHERE message_id = $1 AND token = 'removed'`, [rows.at(-1)!.id]);
    expect(indexed.rowCount).toBe(1); // the redacted line is what search now holds
  });

  it('E644: while the outcome is unknown the body is kept so the reconcile can find the text; once final it is redacted', async () => {
    const c = await invited({ firstName: 'Kit' });
    // the login point is the email; switch it to the phone so the link goes by text
    const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    expect((await call(w.agents[0]!, 'POST', `/portal-accounts/${c.accountId}/login-point`, { pointId: phonePoint })).status).toBe(200);
    h.providers.telephony.failNext('timeout_after_submit');
    await askLink(h, slug, c.phone, ip());
    const [m] = (await linkMessages(c.id)).slice(-1);
    expect(m!.status).toBe('dispatch_unknown');
    expect(m!.body).toMatch(/#token=/);
    const deps = depsFromPlatform(h.app.platform);
    const sys = systemActor(w.tenantId, 'worker');
    await withTenantTx(sys, (tx, now) => linkRedactInTx(tx, m!.id, now), { db: h.database });
    expect((await linkMessages(c.id)).at(-1)!.body).toMatch(/#token=/); // still unknown: kept
    const r = await reconcileOutbound(m!.id, deps, w.tenantId);
    expect(r).toMatchObject({ kind: 'resolved' });
    await withTenantTx(sys, (tx, now) => linkRedactInTx(tx, m!.id, now), { db: h.database });
    expect((await linkMessages(c.id)).at(-1)!.body).toMatch(/link removed after sending/);
  });

  it('E644: a link still queued after 15 minutes is canceled PORTAL_LINK_EXPIRED and redacted', async () => {
    const c = await invited({ firstName: 'Pat' });
    h.providers.email.failNext('unavailable');
    await askLink(h, slug, c.email, ip());
    const [m] = (await linkMessages(c.id)).slice(-1);
    // a retryable provider failure leaves it for the queued comms.dispatch; make it look 16 minutes old
    await h.su.query(`UPDATE messages SET status = 'queued', created_at = now() - interval '16 minutes' WHERE id = $1`, [m!.id]);
    const sys = systemActor(w.tenantId, 'worker');
    await withTenantTx(sys, (tx, now) => linkRedactInTx(tx, m!.id, now), { db: h.database });
    const after = (await linkMessages(c.id)).at(-1)!;
    expect(after.status).toBe('canceled');
    expect(after.body).toMatch(/link removed after sending/);
    expect((await h.su.query<{ status_reason: string }>('SELECT status_reason FROM messages WHERE id = $1', [m!.id])).rows[0]!.status_reason).toBe('PORTAL_LINK_EXPIRED');
  });

  it('E642: a paused conversation still gets the link; a suppression or a person-level do-not-contact blocks it with a decision and no provider call (R-GATE-14)', async () => {
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

  it('E643: spouses sharing an email each get their own link naming them, and each link opens only its own portal', async () => {
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

  it('E645: a link works once; again, after 15 minutes, after a newer link, or in two tabs at once, it is 401 PORTAL_LINK_INVALID', async () => {
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
