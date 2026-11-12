// Adversarial tests of the lead-email slice (module 22; ARCHITECTURE §21 "Webhooks"; R-INBOX-9, R-LEM-*, E153,
// R-TEN-3, R-TEN-11, R-PERM-11, R-AUDIT-4). Every attack goes through the real webhook route or the real database
// roles; nothing here mocks RLS.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { classifyField } from '../audit.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, leadsWorld, randomPhone } from '../leads/testing.js';
import { call } from '../admin/testing.js';
import { dkimFromAuthResults, dkimFromSendgridField } from './formats.js';
import { contactCount, contactsWith, enableInbox, labelledBody, leadAddress, messageRows, outcomeOf, postLeadEmail } from './testing.js';
import { decideTrust } from './trust.js';

let h: ApiHarness;
let a: LeadsWorld;
let b: LeadsWorld;
let addrA: string;
let addrB: string;

beforeAll(async () => {
  h = await createApiHarness({
    config: {
      emailInbound: { formats: ['postmark', 'sendgrid'], basicAuth: { username: 'inbound', password: 'p'.repeat(24) } },
      leadEmail: { inboundDomain: 'leads.realty-os.invalid', authservId: 'mx.provider.test' },
    } as never,
  });
  a = await leadsWorld(h, { agents: 1 });
  b = await leadsWorld(h, { agents: 1 });
  addrA = (await enableInbox(h, a.owner, a.sourceId)).address!;
  addrB = (await enableInbox(h, b.owner, b.sourceId)).address!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const zillow = (to: string, o: { email?: string; name?: string; phone?: string } = {}) => ({ to, from: 'Zillow <leads@zillow.com>', dkim: [{ domain: 'zillow.com', result: 'pass' }], text: labelledBody({ name: o.name ?? 'Pat Adversary', email: o.email ?? leadAddress(), ...(o.phone ? { phone: o.phone } : {}) }) });
const lastRow = async (w: LeadsWorld) => (await messageRows(h, w.tenantId)).at(-1)!;

describe('R-LEM-3 E153 trust: nothing unverified becomes a lead', () => {
  it('E153: a spoofed From (leads@zillow.com) with a valid-looking DKIM pass for another domain is held (DKIM_UNALIGNED)', async () => {
    const n = await contactCount(h, a.tenantId);
    const r = await postLeadEmail(h, { ...zillow(addrA), dkim: [{ domain: 'attacker.test', result: 'pass' }] });
    expect(outcomeOf(r)).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('DKIM_UNALIGNED');
    expect(await contactCount(h, a.tenantId)).toBe(n);
  });

  it('E153: a forged DKIM-Signature / Authentication-Results written into the message body or headers is not evidence (no provider verdict ⇒ DKIM_MISSING)', async () => {
    const forged = 'DKIM-Signature: v=1; a=rsa-sha256; d=zillow.com; s=s1; b=AAAA\nAuthentication-Results: mx.provider.test; dkim=pass header.d=zillow.com\n\n' + labelledBody({ name: 'Forged', email: leadAddress() });
    expect(outcomeOf(await postLeadEmail(h, { to: addrA, from: 'leads@zillow.com', dkim: [], text: forged }))).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('DKIM_MISSING');
    expect(outcomeOf(await postLeadEmail(h, { to: addrA, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'fail' }], text: forged }))).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('DKIM_FAILED');
  });

  it('E153: DKIM aligned to a domain that is NOT allowlisted is held (SENDER_NOT_ALLOWED); lookalike domains never count as allowlisted', async () => {
    expect(outcomeOf(await postLeadEmail(h, { to: addrA, from: 'leads@evil.test', dkim: [{ domain: 'evil.test', result: 'pass' }], text: labelledBody({ name: 'X', email: leadAddress() }) }))).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('SENDER_NOT_ALLOWED');
    for (const d of ['evilzillow.com', 'zillow.com.evil.test', 'zi11ow.com']) {
      expect(decideTrust(`leads@${d}`, [{ domain: d, result: 'pass' }], ['zillow.com'])).toMatchObject({ trusted: false, code: 'SENDER_NOT_ALLOWED' });
    }
    expect(decideTrust('leads@mail.zillow.com', [{ domain: 'zillow.com', result: 'pass' }], ['zillow.com'])).toMatchObject({ trusted: true, domain: 'zillow.com' });
    expect(decideTrust('a@zillow.com, b@zillow.com', [{ domain: 'zillow.com', result: 'pass' }], ['zillow.com'])).toMatchObject({ trusted: false, code: 'FROM_INVALID' });
  });

  it('R-LEM-3: Postmark: only the TOPMOST Authentication-Results with OUR authserv-id counts; a sender-written one below it, or another authserv-id, does not', () => {
    expect(dkimFromAuthResults(['mx.provider.test; dkim=pass header.d=zillow.com header.s=s1; spf=pass'], 'mx.provider.test')).toEqual([{ domain: 'zillow.com', result: 'pass' }]);
    // the topmost header (the receiver's own) says none: the pass below it was written by the sender
    expect(dkimFromAuthResults(['mx.provider.test; dkim=none', 'mx.provider.test; dkim=pass header.d=zillow.com'], 'mx.provider.test')).toEqual([]);
    expect(dkimFromAuthResults(['attacker.test; dkim=pass header.d=zillow.com'], 'mx.provider.test')).toEqual([]);
    expect(dkimFromAuthResults(['mx.provider.test; dkim=pass header.d=zillow.com'], null)).toEqual([]);
    expect(dkimFromSendgridField('{@zillow.com : pass, @sendgrid.net : pass}')).toEqual([{ domain: 'zillow.com', result: 'pass' }, { domain: 'sendgrid.net', result: 'pass' }]);
  });

  it('R-LEM-3: the Postmark route needs its Basic credentials, and a forged header below the provider’s is ignored end to end', async () => {
    const pm = (headers: { Name: string; Value: string }[]) => ({ MessageID: randomUUID(), From: 'leads@zillow.com', FromFull: { Email: 'leads@zillow.com' }, OriginalRecipient: addrA, Subject: 'New lead', TextBody: labelledBody({ name: 'Pm Lead', email: leadAddress() }), Headers: headers });
    const post = (body: unknown, auth = `Basic ${Buffer.from(`inbound:${'p'.repeat(24)}`).toString('base64')}`) => h.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/postmark/inbound', headers: { 'content-type': 'application/json', authorization: auth }, payload: JSON.stringify(body) });
    expect((await post(pm([]), 'Basic bm9wZTpub3Bl')).statusCode).toBe(403);
    const held = await post(pm([{ Name: 'Authentication-Results', Value: 'mx.provider.test; dkim=none' }, { Name: 'Authentication-Results', Value: 'mx.provider.test; dkim=pass header.d=zillow.com' }]));
    expect(outcomeOf(held)).toBe('needs_review');
    const ok = await post(pm([{ Name: 'Authentication-Results', Value: 'mx.provider.test; dkim=pass header.d=zillow.com' }]));
    expect(outcomeOf(ok)).toBe('lead_created');
  });
});

describe('R-TEN-3 R-TEN-11 R-LEM-2 the key alone resolves tenant and source', () => {
  it('R-TEN-3: a lead email to tenant B’s address lands in B only, whatever it claims; A’s inbox sees nothing', async () => {
    const email = leadAddress();
    const nA = await contactCount(h, a.tenantId);
    expect(outcomeOf(await postLeadEmail(h, { ...zillow(addrB, { email }), tenantId: a.tenantId, leadSourceId: a.sourceId } as never))).toBe('lead_created');
    expect(await contactsWith(h, b.tenantId, email)).toHaveLength(1);
    expect(await contactsWith(h, a.tenantId, email)).toHaveLength(0);
    expect(await contactCount(h, a.tenantId)).toBe(nA);
  });

  it('R-LEM-2: a guessed, malformed or other-domain address is unrouted (no tenant row); the same key at another domain does not route', async () => {
    const key = addrA.slice(6, 46);
    for (const to of [`leads+${'0'.repeat(40)}@leads.realty-os.invalid`, `leads+${key}@evil.test`, `leads+${key.slice(0, 39)}@leads.realty-os.invalid`, `r+${key}@leads.realty-os.invalid`]) {
      expect(outcomeOf(await postLeadEmail(h, zillow(to))), to).toBe('unrouted');
    }
  });

  it('R-LEM-2: after rotation the OLD address routes nothing; the new one works; audited', async () => {
    await freshReauth(h, a.owner);
    const r = await call<{ inbox: { address: string } }>(a.owner, 'POST', `/lead-sources/${a.sourceId}/lead-email/rotate`);
    expect(r.status).toBe(200);
    const fresh = r.body.inbox.address;
    expect(fresh).not.toBe(addrA);
    const n = await contactCount(h, a.tenantId);
    expect(outcomeOf(await postLeadEmail(h, zillow(addrA)))).toBe('unrouted');
    expect(await contactCount(h, a.tenantId)).toBe(n);
    expect(outcomeOf(await postLeadEmail(h, zillow(fresh)))).toBe('lead_created');
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'lead_email.key_rotated'", [a.tenantId])).rows[0].n).toBe(1);
    addrA = fresh;
  });

  it('R-TEN-11: app.resolve_lead_email_key is a reviewed definer (app_definer, pinned search_path, STABLE, not PUBLIC) and never returns a retired key or another kind', async () => {
    const r = (await h.su.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig, p.proacl::text AS acl
                                   FROM pg_proc p WHERE p.oid = 'app.resolve_lead_email_key(bytea)'::regprocedure`)).rows[0];
    expect(r).toMatchObject({ owner: 'app_definer', prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public'] });
    expect(r.acl).not.toMatch(/(^|[{,])=X/);
    const retired = (await h.su.query<{ key_hash: Buffer }>('SELECT key_hash FROM lead_email_inbox_keys WHERE tenant_id = $1 AND retired_at IS NOT NULL', [a.tenantId])).rows[0]!.key_hash;
    expect((await h.su.query('SELECT * FROM app.resolve_lead_email_key($1)', [retired])).rows).toEqual([]);
  });
});

describe('R-LEM-8 replay, size and content attacks', () => {
  it('R-LEM-8: the same message delivered twice creates one lead; a replay after webhook_events was purged is still refused by the per-tenant message key', async () => {
    const email = leadAddress();
    const msg = { ...zillow(addrA, { email }), messageId: `<replay-${randomUUID()}@zillow.test>` };
    expect(outcomeOf(await postLeadEmail(h, msg))).toBe('lead_created');
    expect(outcomeOf(await postLeadEmail(h, msg))).toBe('duplicate');
    await h.su.query("DELETE FROM webhook_events WHERE provider_event_id LIKE 'lead-email:%'");
    expect(outcomeOf(await postLeadEmail(h, msg))).toBe('duplicate');
    expect(await contactsWith(h, a.tenantId, email)).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_inquiries i JOIN contact_points p ON p.contact_id = i.contact_id WHERE p.address = $1', [email])).rows[0].n).toBe(1);
  });

  it('R-LEM-8: a sender-chosen Message-ID used against tenant A never pre-empts the same id at tenant B', async () => {
    const mid = `<shared-${randomUUID()}@x.test>`;
    expect(outcomeOf(await postLeadEmail(h, { ...zillow(addrA), messageId: mid }))).toBe('lead_created');
    expect(outcomeOf(await postLeadEmail(h, { ...zillow(addrB), messageId: mid }))).toBe('lead_created');
  });

  it('R-LEM-8: unsigned, mis-signed and stale-signature deliveries are 403 and write no tenant row', async () => {
    const n = (await messageRows(h, a.tenantId)).length;
    expect((await postLeadEmail(h, zillow(addrA), { sign: false })).statusCode).toBe(403);
    expect((await postLeadEmail(h, zillow(addrA), { secret: 'x'.repeat(32) })).statusCode).toBe(403);
    expect((await postLeadEmail(h, zillow(addrA), { at: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(403);
    expect((await messageRows(h, a.tenantId)).length).toBe(n);
  });

  it('R-LEM-8: an oversized body is refused (413) before parsing; an HTML bomb under the cap is processed in bounded time and creates nothing unsafe', async () => {
    const n = await contactCount(h, a.tenantId);
    const big = await postLeadEmail(h, { ...zillow(addrA), text: 'A'.repeat(1_100_000) });
    expect(big.statusCode).toBe(413);
    expect(await contactCount(h, a.tenantId)).toBe(n);
    const t0 = Date.now();
    const bomb = await postLeadEmail(h, { to: addrA, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], html: '<div>'.repeat(120_000) + '<script>' + 'x'.repeat(100_000) + `Name: Bomb\nEmail: ${leadAddress()}` });
    expect(bomb.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(['needs_review', 'lead_created']).toContain(outcomeOf(bomb));
  });

  it('R-LEM-8: links and remote images in HTML are never fetched (no outbound request is made while processing)', async () => {
    const orig = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetched++;
      return orig(...args);
    }) as typeof fetch;
    try {
      await postLeadEmail(h, { to: addrA, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], html: `<img src="https://tracker.test/p.gif"><a href="https://phish.test/x">Zillow lead</a><p>Name: Link Lead</p><p>Email: ${leadAddress()}</p>` });
    } finally {
      globalThis.fetch = orig;
    }
    expect(fetched).toBe(0);
  });

  it('R-LEM-8: header injection in parsed fields never reaches a contact point or a name (CR/LF, Bcc:, bidi overrides are stripped or the value refused)', async () => {
    const good = leadAddress();
    const text = `Zillow lead\nName: Eve\u202E Evil\u2028Bcc: x@evil.test\nEmail: ${good}\nEmail: bad@x.test\u2028Bcc: c@evil.test\nPhone: ${randomPhone()}\u2028To: d@evil.test`;
    expect(outcomeOf(await postLeadEmail(h, { to: addrA, from: 'leads@zillow.com', dkim: [{ domain: 'zillow.com', result: 'pass' }], text }))).toBe('lead_created');
    const [cid] = await contactsWith(h, a.tenantId, good);
    const pts = (await h.su.query<{ address: string }>('SELECT address FROM contact_points WHERE contact_id = $1', [cid])).rows.map((p) => p.address);
    for (const p of pts) expect(p).not.toMatch(/[\r\n\u2028\u2029\u202a-\u202E]|evil|bcc/i);
    expect(pts).not.toContain('bad@x.test');
    const name = (await h.su.query<{ display_name: string }>('SELECT display_name FROM contacts WHERE id = $1', [cid])).rows[0]!.display_name;
    expect(name).not.toMatch(/[\r\n\u2028\u2029\u202a-\u202E]/);
  });
});

describe('R-PERM-11 R-AUDIT-4 database: FORCE RLS, tenant policies, support read-only, system-only writes', () => {
  it('R-TEN-1: both new tables are ENABLE + FORCE RLS with the tenant_isolation and support_read_only_* policies', async () => {
    for (const t of ['lead_email_inbox_keys', 'lead_email_messages']) {
      const c = (await h.su.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass", [`public.${t}`])).rows[0];
      expect(c, t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const p = (await h.su.query<{ polname: string }>('SELECT polname FROM pg_policy WHERE polrelid = $1::regclass ORDER BY polname', [`public.${t}`])).rows.map((r) => r.polname);
      expect(p).toEqual(expect.arrayContaining(['tenant_isolation', 'support_read_only_ins', 'support_read_only_upd', 'support_read_only_del']));
    }
  });

  it('R-TEN-1 R-PERM-11: tenant B’s owner sees none of A’s rows; an agent sees no review rows; support never reads keys and never writes; a person can never insert or decide directly', async () => {
    const asUser = (w: LeadsWorld, c: { userId: string | null; role: string | null }) => ({ kind: 'user', userId: c.userId!, tenantId: w.tenantId as TenantId, role: c.role!, sessionId: 'x' }) as Actor;
    const count = (actor: Actor, t: string) => withTenantTx(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(t)}`.execute(tx)).rows[0]!.n), { db: h.database });
    expect(await count(asUser(b, b.owner), 'lead_email_messages')).toBe((await messageRows(h, b.tenantId)).length);
    expect(await count(asUser(a, a.agents[0]!), 'lead_email_messages')).toBe(0);
    expect(await count(asUser(a, a.agents[0]!), 'lead_email_inbox_keys')).toBe(0);
    const support: Actor = { kind: 'support', userId: a.owner.userId!, tenantId: a.tenantId as TenantId, grantId: randomUUID() };
    const sup = await withTenantTx(support, (tx) => sql`UPDATE lead_email_messages SET status = 'discarded' WHERE tenant_id = app.tenant_id()`.execute(tx), { db: h.database }).catch(() => ({ numAffectedRows: 0n }));
    expect(Number(sup.numAffectedRows)).toBe(0); // support is read-only: nothing changes (RLS)
    expect(await count(support, 'lead_email_inbox_keys')).toBe(0); // a key is a secret: support never reads keys
    const ownerA = asUser(a, a.owner);
    const row = (await messageRows(h, a.tenantId)).find((m) => m.status === 'needs_review')!;
    const upd = await withTenantTx(ownerA, (tx) => sql`UPDATE lead_email_messages SET status = 'discarded', decided_at = now(), decided_by_user_id = ${a.owner.userId}::uuid, content_enc = NULL, parsed_enc = NULL WHERE id = ${row.id}::uuid`.execute(tx), { db: h.database });
    expect(Number(upd.numAffectedRows)).toBe(0); // RLS: only the system writes
    await expect(
      withTenantTx(ownerA, (tx) => sql`INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at, status, parser_kind)
        SELECT app.tenant_id(), ${randomUUID()}::uuid, connection_id, lead_source_id, decode(repeat('ab', 32), 'hex'), 'generic', now(), 'lead_created', 'generic' FROM lead_email_messages LIMIT 1`.execute(tx), { db: h.database }),
    ).rejects.toBeTruthy();
  });

  it('R-LEM-5: the DB refuses re-deciding, a lead_created row with a hold code, and un-retiring a key, even for the superuser path through the guards', async () => {
    const created = (await messageRows(h, a.tenantId)).find((m) => m.status === 'lead_created')!;
    await expect(h.su.query("UPDATE lead_email_messages SET status = 'needs_review', hold_code = 'DKIM_FAILED' WHERE id = $1", [created.id])).rejects.toThrow(/LEAD_EMAIL_IMMUTABLE|LEAD_EMAIL_TRANSITION/);
    await expect(h.su.query('UPDATE lead_email_inbox_keys SET retired_at = NULL WHERE tenant_id = $1 AND retired_at IS NOT NULL', [a.tenantId])).rejects.toThrow(/LEAD_EMAIL_KEY_IMMUTABLE/);
    await expect(h.su.query('DELETE FROM lead_email_inbox_keys WHERE tenant_id = $1', [a.tenantId])).rejects.toBeTruthy();
  });

  it('R-AUDIT-4: field classification of the new columns: encrypted content and keys are secret, sender facts are PII, codes and ids are plain', () => {
    for (const c of ['content_enc', 'parsed_enc', 'key_enc']) expect([c, classifyField(c)]).toEqual([c, 'secret']);
    for (const c of ['sender_domain', 'dkim_pass_domains']) expect([c, classifyField(c)]).toEqual([c, 'pii']);
    for (const c of ['hold_code', 'parser_kind', 'message_key_sha256', 'key_hash', 'connection_id', 'decided_at', 'status']) expect([c, classifyField(c)]).toEqual([c, 'plain']);
  });
});

// ---- R-LEM-12 E329: auto-forwarded mail, our address only in the provider's envelope (SYNTHETIC) -----------------

describe('R-LEM-12 E329 auto-forwarded portal mail through the vendor formats', () => {
  const auth = `Basic ${Buffer.from(`inbound:${'p'.repeat(24)}`).toString('base64')}`;
  const AGENT = 'agent.sample@example.test';

  it('R-LEM-12 E329: Postmark: To is the agent and our address is only the OriginalRecipient ⇒ routed; signature intact ⇒ lead; broken ⇒ DKIM_FAILED', async () => {
    const pm = (email: string, dkim: string) => ({
      MessageID: randomUUID(),
      From: 'leads@zillow.com',
      FromFull: { Email: 'leads@zillow.com' },
      To: AGENT,
      ToFull: [{ Email: AGENT }],
      OriginalRecipient: addrA,
      Subject: 'New lead',
      TextBody: labelledBody({ name: 'Pia Postmark', email }),
      Headers: [{ Name: 'Authentication-Results', Value: `mx.provider.test; dkim=${dkim} header.d=zillow.com` }],
    });
    const post = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/postmark/inbound', headers: { 'content-type': 'application/json', authorization: auth }, payload: JSON.stringify(body) });
    const email = leadAddress();
    expect(outcomeOf(await post(pm(email, 'pass')))).toBe('lead_created');
    expect(await contactsWith(h, a.tenantId, email)).toHaveLength(1);
    expect(outcomeOf(await post(pm(leadAddress(), 'fail')))).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('DKIM_FAILED');
  });

  it('R-LEM-12 E329: SendGrid: To is the agent and our address is only in the SMTP envelope ⇒ routed; signature intact ⇒ lead; broken ⇒ DKIM_FAILED', async () => {
    const sg = async (email: string, dkim: string) => {
      const fd = new FormData();
      fd.set('headers', `Message-ID: <${randomUUID()}@mail.zillow.test>\r\nFrom: Zillow <leads@zillow.com>\r\nTo: ${AGENT}\r\nSubject: New lead`);
      fd.set('from', 'Zillow <leads@zillow.com>');
      fd.set('to', AGENT);
      fd.set('subject', 'New lead');
      fd.set('text', labelledBody({ name: 'Sid Sendgrid', email }));
      fd.set('envelope', JSON.stringify({ to: [addrA], from: 'bounce@zillow.com' }));
      fd.set('dkim', `{@zillow.com : ${dkim}}`);
      const req = new Request('http://x.invalid', { method: 'POST', body: fd });
      const payload = Buffer.from(await req.arrayBuffer());
      return h.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/sendgrid/inbound', headers: { 'content-type': req.headers.get('content-type')!, authorization: auth }, payload });
    };
    const email = leadAddress();
    expect(outcomeOf(await sg(email, 'pass'))).toBe('lead_created');
    expect(await contactsWith(h, a.tenantId, email)).toHaveLength(1);
    expect(outcomeOf(await sg(leadAddress(), 'fail'))).toBe('needs_review');
    expect((await lastRow(a)).hold_code).toBe('DKIM_FAILED');
  });
});

describe('R-LEM-11 R-LEM-12 R-LEM-10 database: hold codes and parser kinds', () => {
  it('R-LEM-11 R-LEM-12: the DB refuses an unknown hold_code or parser_kind, even for the superuser', async () => {
    const insert = (holdCode: string, parserKind: string | null) =>
      h.su.query(
        `INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at, status, hold_code, parser_kind)
         SELECT tenant_id, $2::uuid, connection_id, lead_source_id, decode(md5($2::text) || md5($2::text || 'x'), 'hex'), 'generic', now(), 'needs_review', $3, $4
           FROM lead_email_messages WHERE tenant_id = $1 LIMIT 1`,
        [a.tenantId, randomUUID(), holdCode, parserKind],
      );
    await expect(insert('PERSONAL_MAILBOX_X', null)).rejects.toThrow(/hold_code_check/);
    await expect(insert('FORWARDING_CONFIRMATION', 'leadmetadata_v2')).rejects.toThrow(/parser_kind_check/);
    const held = (await messageRows(h, a.tenantId)).find((m) => m.status === 'needs_review')!;
    await expect(h.su.query("UPDATE lead_email_messages SET hold_code = 'NOT_A_CODE' WHERE id = $1", [held.id])).rejects.toBeTruthy();
    expect((await h.su.query('SELECT hold_code FROM lead_email_messages WHERE id = $1', [held.id])).rows[0].hold_code).toBe(held.hold_code);
  });
});
