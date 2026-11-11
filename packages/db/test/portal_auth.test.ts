// db/p3-portal-auth (PHASE2_3_PLAN module 43): portal sessions, magic-link tokens, the pre-tenant portal.*
// definers and the client transaction helper. R-TEN-14, R-PORTAL-4 (DB half), R-PORTAL-5, R-PORTAL-6, R-PORTAL-7,
// E125, E126, E127, E129, E148 (DB half), E149.
//
// Every client step runs through the real path: requestPortalLogin -> consumePortalLogin -> resolvePortalSession
// -> withPortalTx, as app_user under RLS. The superuser only flips the platform:portal clearance, ages rows past
// their expiry and reads state back.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ClientActor,
  PortalNotClearedError,
  consumePortalLogin,
  endPortalSession,
  issuePortalDocumentStream,
  recordPortalAudit,
  redeemPortalDocumentStream,
  requestPortalLogin,
  resolvePortalSession,
  withPortalTx,
} from '../src/portalTx.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { addEmailPoint, createParty, type Party, publishDocument, setPortalCleared, signIn } from './portalFixture.js';
import { createHarness, createWorld, type Harness, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World; // tenant A
let wb: World; // tenant B
let jane: Party; // agent 0's buyer
let omar: Party; // agent 1's buyer, another deal of the same tenant
let bea: Party; // tenant B's buyer

const sha = (s: string) => createHash('sha256').update(s).digest();
const tokenCount = async (accountId: string) =>
  Number((await suRows<{ n: string }>(h.su, 'SELECT count(*) AS n FROM portal_login_tokens WHERE portal_account_id = $1', [accountId]))[0]!.n);
const asClient = <T>(c: ClientActor, fn: Parameters<typeof withPortalTx<T>>[1]) => withPortalTx(c, fn, { db: h.app });

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
  wb = await createWorld(h.app, { agents: 1 });
  jane = await createParty(h, w, w.agents[0]!, 'Jane Buyer');
  omar = await createParty(h, w, w.agents[1]!, 'Omar Buyer');
  bea = await createParty(h, wb, wb.agents[0]!, 'Bea Buyer');
});
afterAll(async () => {
  await h?.close();
});

describe('R-PORTAL-5 sign-in waits for platform:portal', () => {
  it('R-PORTAL-5: the magic-link request and the sign-in refuse while platform:portal is not counsel-cleared', async () => {
    await setPortalCleared(h, false);
    await expect(requestPortalLogin(w.slug, jane.email, { db: h.app })).rejects.toBeInstanceOf(PortalNotClearedError);
    await expect(consumePortalLogin('x'.repeat(43), {}, { db: h.app })).rejects.toBeInstanceOf(PortalNotClearedError);
    expect(await tokenCount(jane.accountId)).toBe(0);
  });

  it('R-PORTAL-5: a live session stops resolving at once when the clearance is withdrawn (fail closed)', async () => {
    await setPortalCleared(h, true);
    const s = await signIn(h, w, jane);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).not.toBeNull();
    await setPortalCleared(h, false);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).toBeNull();
    await setPortalCleared(h, true);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).not.toBeNull();
  });
});

describe('R-PORTAL-5 magic links', () => {
  beforeAll(() => setPortalCleared(h, true));

  it('R-PORTAL-5: the login request is indistinguishable for unknown addresses (same empty answer, nothing written)', async () => {
    const before = Number((await suRows<{ n: string }>(h.su, 'SELECT count(*) AS n FROM portal_login_tokens'))[0]!.n);
    const auditBefore = Number((await suRows<{ n: string }>(h.su, "SELECT count(*) AS n FROM audit_log WHERE action LIKE 'portal.%'"))[0]!.n);
    const answers = await Promise.all([
      requestPortalLogin(w.slug, 'nobody@example.test', { db: h.app }), // unknown address
      requestPortalLogin('no-such-team', jane.email, { db: h.app }), // unknown tenant
      requestPortalLogin(wb.slug, jane.email, { db: h.app }), // known address, other tenant
      requestPortalLogin(w.slug, '%', { db: h.app }), // a pattern is not a wildcard
      requestPortalLogin(w.slug, jane.email.toUpperCase(), { db: h.app }), // not normalized: no match, no hint
    ]);
    for (const a of answers) expect(a).toEqual([]);
    expect(Number((await suRows<{ n: string }>(h.su, 'SELECT count(*) AS n FROM portal_login_tokens'))[0]!.n)).toBe(before);
    expect(Number((await suRows<{ n: string }>(h.su, "SELECT count(*) AS n FROM audit_log WHERE action LIKE 'portal.%'"))[0]!.n)).toBe(auditBefore);
  });

  it('R-PORTAL-5: a known address gets one 15-minute link to the account\'s own login point; only its hash is stored', async () => {
    const [link, ...rest] = await requestPortalLogin(w.slug, jane.email, { db: h.app });
    expect(rest).toEqual([]);
    expect(link).toMatchObject({ tenantId: w.tenantId, portalAccountId: jane.accountId, contactId: jane.contactId, loginPointId: jane.pointId, loginKind: 'email' });
    expect(link!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await suRows<{ token_hash: Buffer; minutes: number; login_point_id: string }>(h.su,
      `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes, login_point_id
         FROM portal_login_tokens WHERE portal_account_id = $1 ORDER BY created_at DESC LIMIT 1`, [jane.accountId]);
    expect(row!.token_hash.equals(sha(link!.token))).toBe(true);
    expect(row!.minutes).toBe(15);
    expect(row!.login_point_id).toBe(jane.pointId);
  });

  it('R-PORTAL-5: a link works once; a second use, an older superseded link and an expired link do not', async () => {
    const [first] = await requestPortalLogin(w.slug, jane.email, { db: h.app });
    const [second] = await requestPortalLogin(w.slug, jane.email, { db: h.app });
    expect(await consumePortalLogin(first!.token, {}, { db: h.app })).toBeNull(); // superseded by the newer link
    const s = await consumePortalLogin(second!.token, {}, { db: h.app });
    expect(s?.client.portalAccountId).toBe(jane.accountId);
    expect(await consumePortalLogin(second!.token, {}, { db: h.app })).toBeNull(); // single use
    const [third] = await requestPortalLogin(w.slug, jane.email, { db: h.app });
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '16 minutes', expires_at = expires_at - interval '16 minutes'
                       WHERE token_hash = $1`, [sha(third!.token)]);
    expect(await consumePortalLogin(third!.token, {}, { db: h.app })).toBeNull(); // expired by the database clock
  });

  it('R-PORTAL-5: two concurrent sign-ins with the same link: exactly one wins', async () => {
    const [link] = await requestPortalLogin(w.slug, omar.email, { db: h.app });
    const results = await Promise.all(Array.from({ length: 4 }, () => consumePortalLogin(link!.token, {}, { db: h.app })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(Number((await suRows<{ n: string }>(h.su, 'SELECT count(*) AS n FROM portal_sessions WHERE portal_account_id = $1', [omar.accountId]))[0]!.n)).toBe(1);
  });

  it('R-PORTAL-5: the first sign-in activates an invited account and is audited as the client', async () => {
    const [acc] = await suRows<{ status: string; activated: boolean }>(h.su, 'SELECT status, activated_at IS NOT NULL AS activated FROM portal_accounts WHERE id = $1', [omar.accountId]);
    expect(acc).toEqual({ status: 'active', activated: true });
    const audit = await suRows<{ action: string; actor_kind: string; principal: string; account: string }>(h.su,
      `SELECT action, actor_kind, changes->>'principal' AS principal, changes->>'portal_account_id' AS account
         FROM audit_log WHERE entity_id = $1 AND action LIKE 'portal.%' ORDER BY seq`, [omar.accountId]);
    expect(audit.map((a) => a.action)).toEqual(['portal.login_link_issued', 'portal.signed_in']);
    for (const a of audit) expect(a).toMatchObject({ actor_kind: 'system', principal: 'client', account: omar.accountId });
  });

  it('R-PORTAL-5: a link sent to a point that is no longer the login point does not sign in', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Rita Repoint');
    const [link] = await requestPortalLogin(w.slug, p.email, { db: h.app });
    const other = await addEmailPoint(h, p.agent, p.contactId, `rita-new-${uuid().slice(0, 6)}@example.test`);
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE portal_accounts SET login_point_id = ${other} WHERE id = ${p.accountId}`.execute(tx), { db: h.app });
    expect(await consumePortalLogin(link!.token, {}, { db: h.app })).toBeNull();
  });

  it('R-PORTAL-5: a removed login point and a disabled account get no link', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Remy Removed');
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE contact_points SET status = 'removed', removed_at = now() WHERE id = ${p.pointId}`.execute(tx), { db: h.app });
    expect(await requestPortalLogin(w.slug, p.email, { db: h.app })).toEqual([]);
    const q = await createParty(h, w, w.agents[0]!, 'Dina Disabled');
    await withTenantTx(q.agent.actor, (tx) => sql`UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = 'CLIENT_ASKED' WHERE id = ${q.accountId}`.execute(tx), { db: h.app });
    expect(await requestPortalLogin(w.slug, q.email, { db: h.app })).toEqual([]);
  });

  it('R-PORTAL-5: at most 5 links per account per hour (no mail-bombing a client through the portal)', async () => {
    const p = await createParty(h, w, w.agents[1]!, 'Tess Throttle');
    for (let i = 0; i < 5; i++) expect(await requestPortalLogin(w.slug, p.email, { db: h.app })).toHaveLength(1);
    expect(await requestPortalLogin(w.slug, p.email, { db: h.app })).toEqual([]);
  });

  it('E127: spouses sharing one email get one link each, each for their own account and its own login point', async () => {
    const shared = `the-smiths-${uuid().slice(0, 6)}@example.test`;
    const a = await createParty(h, w, w.agents[0]!, 'Ann Smith', shared);
    const b = await createParty(h, w, w.agents[0]!, 'Ben Smith', shared);
    const links = await requestPortalLogin(w.slug, shared, { db: h.app });
    expect(links.map((l) => [l.portalAccountId, l.loginPointId]).sort()).toEqual([[a.accountId, a.pointId], [b.accountId, b.pointId]].sort());
    expect(new Set(links.map((l) => l.token)).size).toBe(2);
    const signedIn = await Promise.all(links.map((l) => consumePortalLogin(l.token, {}, { db: h.app })));
    expect(signedIn.map((s) => s!.client.portalAccountId).sort()).toEqual([a.accountId, b.accountId].sort());
    // each sees only their own account
    for (const s of signedIn) {
      const rows = await asClient(s!.client, (tx) => sql<{ id: string }>`SELECT id FROM portal_accounts`.execute(tx));
      expect(rows.rows.map((r) => r.id)).toEqual([s!.client.portalAccountId]);
    }
  });
});

describe('sessions', () => {
  beforeAll(() => setPortalCleared(h, true));

  it('R-PORTAL-4: sign-out ends the session; idle and absolute expiry are enforced by the database clock', async () => {
    const s = await signIn(h, w, jane);
    expect(await endPortalSession(s.sessionToken, 'logout', { db: h.app })).toBe(true);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).toBeNull();
    expect(await endPortalSession(s.sessionToken, 'logout', { db: h.app })).toBe(false);
    const idle = await signIn(h, w, jane);
    await h.su.query(`UPDATE portal_sessions SET last_seen_at = last_seen_at - interval '2 days', idle_expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha(idle.sessionToken)]);
    expect(await resolvePortalSession(idle.sessionToken, { db: h.app })).toBeNull();
    const abs = await signIn(h, w, jane);
    await h.su.query(`UPDATE portal_sessions SET created_at = created_at - interval '15 days', last_seen_at = now(), idle_expires_at = now() - interval '1 second',
                        absolute_expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha(abs.sessionToken)]);
    expect(await resolvePortalSession(abs.sessionToken, { db: h.app })).toBeNull();
  });

  it('R-PORTAL-4: the idle expiry slides on use but never past the absolute expiry', async () => {
    const s = await signIn(h, w, jane);
    await h.su.query(`UPDATE portal_sessions SET last_seen_at = now() - interval '2 hours', idle_expires_at = now() + interval '1 hour',
                        absolute_expires_at = now() + interval '3 hours' WHERE token_hash = $1`, [sha(s.sessionToken)]);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).not.toBeNull();
    const [r] = await suRows<{ eq: boolean }>(h.su, 'SELECT idle_expires_at = absolute_expires_at AS eq FROM portal_sessions WHERE token_hash = $1', [sha(s.sessionToken)]);
    expect(r!.eq).toBe(true);
  });

  it('R-PORTAL-6: disabling the account ends every session at the next request (final: invite again)', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Kai Disable');
    const s = await signIn(h, w, p);
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).not.toBeNull();
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = 'AGENT_REVOKED' WHERE id = ${p.accountId}`.execute(tx), { db: h.app });
    expect(await resolvePortalSession(s.sessionToken, { db: h.app })).toBeNull();
  });

  it('E148 (DB half): staff and client sessions are disjoint: neither resolver accepts the other\'s token', async () => {
    const s = await signIn(h, w, jane);
    const staffToken = `staff-${uuid()}`;
    await h.su.query(`INSERT INTO sessions (id, token_hash, user_id, active_tenant_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
                      VALUES ($1, $2, $3, $4, now(), now(), now() + interval '1 hour', now() + interval '1 day')`, [uuid(), sha(staffToken), w.agents[0]!.id, w.tenantId]);
    const staffResolves = await withPreTenant((tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM auth.resolve_session(${sha(staffToken)}, now())`.execute(tx), { db: h.app });
    expect(staffResolves.rows[0]!.n).toBe(1); // the staff token is live for the staff resolver
    expect(await resolvePortalSession(staffToken, { db: h.app })).toBeNull();
    const portalAsStaff = await withPreTenant((tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM auth.resolve_session(${sha(s.sessionToken)}, now())`.execute(tx), { db: h.app });
    expect(portalAsStaff.rows[0]!.n).toBe(0);
  });
});

describe('R-TEN-14 the client transaction helper', () => {
  let client: ClientActor;
  beforeAll(async () => {
    await setPortalCleared(h, true);
    client = (await signIn(h, w, jane)).client;
  });

  it('R-TEN-14: withPortalTx sets only tenant, principal and portal account; the session never yields a staff GUC', async () => {
    const r = await asClient(client, (tx) => sql<Record<string, string | boolean | null>>`
      SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.principal_type', true) AS principal,
             current_setting('app.portal_account_id', true) AS account, current_setting('app.user_id', true) AS user_id,
             current_setting('app.actor_kind', true) AS actor_kind, current_setting('app.ownership_command', true) AS cmd,
             app.portal_account_id()::text AS fn_account, app.user_id()::text AS fn_user, app.actor_kind() AS fn_kind,
             app.my_role() AS role, app.is_member() AS member, app.is_tenant_wide() AS wide`.execute(tx));
    expect(r.rows[0]).toEqual({
      tenant: w.tenantId, principal: 'client', account: jane.accountId, user_id: '', actor_kind: '', cmd: '',
      fn_account: jane.accountId, fn_user: null, fn_kind: 'none', role: null, member: false, wide: false,
    });
  });

  it('R-TEN-14: the client context dies with the transaction (a pooled connection reads nothing afterwards)', async () => {
    await asClient(client, (tx) => sql`SELECT 1`.execute(tx));
    for (let i = 0; i < 8; i++) {
      const r = await withPreTenant((tx) => sql<{ p: string; a: string; t: string }>`
        SELECT current_setting('app.principal_type', true) AS p, current_setting('app.portal_account_id', true) AS a,
               current_setting('app.tenant_id', true) AS t`.execute(tx), { db: h.app });
      expect(r.rows[0]).toEqual({ p: 'staff', a: '', t: '' });
    }
  });

  it('R-TEN-14: withPortalTx refuses anything that is not a client actor', async () => {
    await expect(withPortalTx(w.agents[0]!.actor as unknown as ClientActor, async () => 1, { db: h.app })).rejects.toThrow(/ClientActor/);
    await expect(withPortalTx({ ...client, portalAccountId: 'not-a-uuid' } as ClientActor, async () => 1, { db: h.app })).rejects.toThrow(/uuid/);
  });

  it('E149: a staff session that sets the portal account GUC gains nothing (portal_account_id() is NULL for staff)', async () => {
    const r = await withTenantTx(w.agents[1]!.actor, async (tx) => {
      await sql`SELECT set_config('app.portal_account_id', ${jane.accountId}, true)`.execute(tx);
      const fn = await sql<{ a: string | null }>`SELECT app.portal_account_id()::text AS a`.execute(tx);
      // agent 1 is not on Jane's deal: staff RLS still hides Jane's grant and items
      const g = await sql<{ n: number }>`SELECT (SELECT count(*) FROM portal_grants WHERE id = ${jane.grantId})::int AS n`.execute(tx);
      const doc = await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal.document_object(${sha('anything')})`.execute(tx);
      return { fn: fn.rows[0]!.a, grants: g.rows[0]!.n, doc: doc.rows[0]!.n };
    }, { db: h.app });
    const audit = await withTenantTx(w.agents[0]!.actor, async (tx) => {
      await sql`SELECT set_config('app.portal_account_id', ${jane.accountId}, true)`.execute(tx);
      await sql`SELECT portal.record_audit('portal.viewed', 'portal_item', ${jane.itemId}::uuid)`.execute(tx);
    }, { db: h.app }).then(() => 'ok', (e: Error) => e.message);
    expect(r.fn).toBeNull();
    expect(r.grants).toBe(0);
    expect(r.doc).toBe(0);
    expect(audit).toMatch(/PORTAL_NOT_CLIENT/);
    const stream = await withTenantTx(w.agents[0]!.actor, async (tx) => {
      await sql`SELECT set_config('app.portal_account_id', ${jane.accountId}, true)`.execute(tx);
      return sql<{ n: number }>`SELECT count(*)::int AS n FROM portal.issue_document_stream(${jane.itemId}::uuid, ${sha('t')})`.execute(tx);
    }, { db: h.app });
    expect(stream.rows[0]!.n).toBe(0); // even the deal's own agent cannot mint a client download token
  });
});

describe('R-PORTAL-1 / R-PORTAL-2 what a client principal reaches', () => {
  let client: ClientActor;
  beforeAll(async () => {
    await setPortalCleared(h, true);
    client = (await signIn(h, w, jane)).client;
  });

  it('R-PORTAL-2: a client sees its own account, grant and items only (cross-deal denial within the tenant)', async () => {
    const r = await asClient(client, async (tx) => ({
      accounts: (await sql<{ id: string }>`SELECT id FROM portal_accounts`.execute(tx)).rows.map((x) => x.id),
      grants: (await sql<{ id: string }>`SELECT id FROM portal_grants`.execute(tx)).rows.map((x) => x.id),
      items: (await sql<{ id: string }>`SELECT id FROM portal_items`.execute(tx)).rows.map((x) => x.id),
      omar: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_items WHERE id = ${omar.itemId}`.execute(tx)).rows[0]!.n,
    }));
    expect(r).toEqual({ accounts: [jane.accountId], grants: [jane.grantId], items: [jane.itemId], omar: 0 });
  });

  it('E126: a client editing the URL to another deal\'s document item gets nothing (no stream token)', async () => {
    const r = await asClient(client, async (tx) => ({ other: await issuePortalDocumentStream(tx, omar.itemId), tenantB: await issuePortalDocumentStream(tx, bea.itemId), own: await issuePortalDocumentStream(tx, jane.itemId) }));
    expect(r.other).toBeNull();
    expect(r.tenantB).toBeNull();
    expect(r.own).toMatchObject({ documentId: jane.documentId, contentType: 'application/pdf', byteSize: 1234 });
  });

  it('cross-tenant denial: a tenant-B client sees none of tenant A\'s rows and cannot reach its documents', async () => {
    const b = (await signIn(h, wb, bea)).client;
    const r = await asClient(b, async (tx) => ({
      grants: (await sql<{ id: string }>`SELECT id FROM portal_grants`.execute(tx)).rows.map((x) => x.id),
      aItems: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_items WHERE tenant_id = ${w.tenantId}`.execute(tx)).rows[0]!.n,
      stream: await issuePortalDocumentStream(tx, jane.itemId),
    }));
    expect(r).toEqual({ grants: [bea.grantId], aItems: 0, stream: null });
  });

  it('E129: a client context reads 0 rows from every staff table and view, including the new definer-only tables', async () => {
    const tables = await suRows<{ relname: string }>(h.su, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname NOT IN ('portal_accounts','portal_grants','portal_items','jurisdiction_packs','prediction_models')
      ORDER BY 1`);
    expect(tables.map((t) => t.relname)).toEqual(expect.arrayContaining(['portal_sessions', 'portal_login_tokens', 'portal_stream_tokens', 'contacts', 'deals', 'documents', 'audit_log']));
    const leaks: string[] = [];
    let refused = 0;
    for (const { relname } of tables) {
      const res = await asClient(client, (tx) => sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(relname)}`.execute(tx)).then(
        (r) => Number(r.rows[0]!.n),
        (e: { code?: string }) => (e.code === '42501' ? -1 : Promise.reject(e)),
      );
      if (res === -1) refused++;
      else if (res !== 0) leaks.push(`${relname}=${res}`);
    }
    expect(leaks).toEqual([]);
    expect(refused).toBeGreaterThanOrEqual(3); // at least the three definer-only portal tables refuse outright
  });

  it('R-PORTAL-1: a client never writes, not even to its own portal rows or the definer-only tables', async () => {
    const attempts = [
      sql`UPDATE portal_items SET retracted_at = now() WHERE id = ${jane.itemId}`,
      sql`UPDATE portal_grants SET expires_at = now() + interval '1 year' WHERE id = ${jane.grantId}`,
      sql`INSERT INTO portal_sessions (tenant_id, id, token_hash, portal_account_id, last_seen_at, idle_expires_at, absolute_expires_at)
          VALUES (${w.tenantId}, ${uuid()}, ${sha('x')}, ${jane.accountId}, now(), now(), now())`,
      sql`UPDATE portal_accounts SET status = 'active' WHERE id = ${omar.accountId}`,
      sql`SELECT portal.audit_internal(${w.tenantId}::uuid, ${jane.accountId}::uuid, 'portal.forged', 'document', NULL, '{}'::jsonb, NULL, NULL)`,
      sql`SELECT * FROM portal.document_chain_internal(${jane.itemId}::uuid)`,
    ];
    for (const q of attempts) {
      const out = await asClient(client, (tx) => q.execute(tx)).then((r) => ('numAffectedRows' in r ? Number(r.numAffectedRows) : 'ran'), (e: Error) => e.message);
      expect(out === 0 || /CLIENT_READ_ONLY|permission denied|row-level security/.test(String(out)), String(out)).toBe(true);
    }
  });
});

describe('R-PORTAL-7 document downloads', () => {
  let client: ClientActor;
  beforeAll(async () => {
    await setPortalCleared(h, true);
    client = (await signIn(h, w, jane)).client;
  });

  it('R-PORTAL-7: a 60 s single-use stream token; the download re-checks and is audited', async () => {
    const t = await asClient(client, (tx) => issuePortalDocumentStream(tx, jane.itemId));
    expect(t).not.toBeNull();
    const [tok] = await suRows<{ secs: number }>(h.su, 'SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM portal_stream_tokens WHERE token_hash = $1', [sha(t!.token)]);
    expect(tok!.secs).toBe(60);
    const obj = await asClient(client, (tx) => redeemPortalDocumentStream(tx, t!.token, { ip: '203.0.113.7', userAgent: 'vitest' }));
    expect(obj).toMatchObject({ documentId: jane.documentId, objectId: jane.objectId, storageKey: `tenants/${w.tenantId}/doc/${jane.objectId}`, keyVersion: 1 });
    expect(await asClient(client, (tx) => redeemPortalDocumentStream(tx, t!.token))).toBeNull(); // single use
    const audit = await suRows<{ principal: string; item: string; ip: string }>(h.su,
      `SELECT changes->>'principal' AS principal, changes->>'portal_item_id' AS item, host(ip) AS ip FROM audit_log
        WHERE action = 'portal.document_downloaded' AND entity_id = $1`, [jane.documentId]);
    expect(audit).toEqual([{ principal: 'client', item: jane.itemId, ip: '203.0.113.7' }]);
  });

  it('R-PORTAL-7: an expired token and another client\'s token are refused', async () => {
    const t = await asClient(client, (tx) => issuePortalDocumentStream(tx, jane.itemId));
    await h.su.query(`UPDATE portal_stream_tokens SET created_at = created_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds' WHERE token_hash = $1`, [sha(t!.token)]);
    expect(await asClient(client, (tx) => redeemPortalDocumentStream(tx, t!.token))).toBeNull();
    const t2 = await asClient(client, (tx) => issuePortalDocumentStream(tx, jane.itemId));
    const o = (await signIn(h, w, omar)).client;
    expect(await asClient(o, (tx) => redeemPortalDocumentStream(tx, t2!.token))).toBeNull(); // bound to Jane's account
    expect(await asClient(client, (tx) => redeemPortalDocumentStream(tx, t2!.token))).not.toBeNull(); // still Jane's to use
  });

  it('R-PORTAL-7: the chain is re-checked at download time (unshared after the token was issued: refused)', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Una Unshare');
    const c = (await signIn(h, w, p)).client;
    const t = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE documents SET shared_to_portal = false WHERE id = ${p.documentId}`.execute(tx), { db: h.app });
    expect(await asClient(c, (tx) => redeemPortalDocumentStream(tx, t!.token))).toBeNull();
  });

  it('E125 / R-PORTAL-6: a grant revoked while the client is browsing: the next query and download return nothing', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Gail Revoke');
    const c = (await signIn(h, w, p)).client;
    const t = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE portal_grants SET revoked_at = now(), revoked_by_user_id = ${p.agent.id} WHERE id = ${p.grantId}`.execute(tx), { db: h.app });
    const r = await asClient(c, async (tx) => ({
      grants: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_grants`.execute(tx)).rows[0]!.n,
      items: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_items`.execute(tx)).rows[0]!.n,
      download: await redeemPortalDocumentStream(tx, t!.token),
      reissue: await issuePortalDocumentStream(tx, p.itemId),
    }));
    expect(r).toEqual({ grants: 0, items: 0, download: null, reissue: null });
  });

  it('R-PORTAL-7: a retracted item, a lapsed grant and a client removed from the deal cannot download', async () => {
    const p = await createParty(h, w, w.agents[0]!, 'Ravi Retract');
    const c = (await signIn(h, w, p)).client;
    const second = await publishDocument(h, w, p.agent, p.dealId, p.grantId, 'Addendum.pdf');
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE portal_items SET retracted_at = now() WHERE id = ${p.itemId}`.execute(tx), { db: h.app });
    expect(await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId))).toBeNull();
    const ok = await asClient(c, (tx) => issuePortalDocumentStream(tx, second.itemId));
    expect(ok).not.toBeNull();
    // the deal's primary contact changes to someone else: Ravi is no longer a party (E147 for primary contacts)
    const other = await selfCreated(h.app, w, p.agent, 'New Primary');
    await withTenantTx(p.agent.actor, (tx) => sql`UPDATE deals SET primary_contact_id = ${other} WHERE id = ${p.dealId}`.execute(tx), { db: h.app });
    expect(await asClient(c, (tx) => redeemPortalDocumentStream(tx, ok!.token))).toBeNull();
    expect(await asClient(c, (tx) => issuePortalDocumentStream(tx, second.itemId))).toBeNull();
  });

  it('R-PORTAL-7: a deleted (shredded) object is never streamed', async () => {
    const p = await createParty(h, w, w.agents[1]!, 'Sid Shred');
    const c = (await signIn(h, w, p)).client;
    const t = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
    await h.su.query(`UPDATE stored_objects SET deleted_at = now() WHERE id = $1`, [p.objectId]);
    expect(await asClient(c, (tx) => redeemPortalDocumentStream(tx, t!.token))).toBeNull();
  });
});

describe('the portal audit definer', () => {
  it('R-PORTAL-7: a signed-in client records its own actions; malformed actions are refused', async () => {
    await setPortalCleared(h, true);
    const c = (await signIn(h, w, jane)).client;
    await asClient(c, (tx) => recordPortalAudit(tx, 'portal.timeline_viewed', 'portal_grant', jane.grantId));
    const [row] = await suRows<{ actor_kind: string; actor_via: string; principal: string; account: string }>(h.su,
      `SELECT actor_kind, actor_via, changes->>'principal' AS principal, changes->>'portal_account_id' AS account
         FROM audit_log WHERE action = 'portal.timeline_viewed' AND entity_id = $1`, [jane.grantId]);
    expect(row).toEqual({ actor_kind: 'system', actor_via: 'api', principal: 'client', account: jane.accountId });
    await expect(asClient(c, (tx) => recordPortalAudit(tx, 'portal.X; DROP' as `portal.${string}`, 'portal_grant', jane.grantId))).rejects.toThrow(/PORTAL_BAD_REQUEST/);
    await expect(asClient(c, (tx) => sql`SELECT portal.record_audit('contact.erased', 'contact', NULL)`.execute(tx))).rejects.toThrow(/PORTAL_BAD_REQUEST/);
  });
});

describe('grants on the definer-only tables', () => {
  it('app_user (any staff role, even the Owner) cannot read or write sessions, login tokens or stream tokens', async () => {
    for (const table of ['portal_sessions', 'portal_login_tokens', 'portal_stream_tokens']) {
      await expect(withTenantTx(w.owner.actor, (tx) => sql`SELECT count(*) FROM ${sql.table(table)}`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    }
    await expect(withPreTenant((tx) => sql`SELECT count(*) FROM portal_sessions`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
  });

  it('every portal.* definer is owned by app_definer with a pinned search_path, and nothing is executable by PUBLIC', async () => {
    const rows = await suRows<{ fn: string; owner: string; pinned: boolean; definer: boolean; public_exec: boolean; app_user_exec: boolean }>(h.su, `
      SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
             EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS pinned, p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'portal' ORDER BY 1`);
    expect(rows.map((r) => r.fn.replace(/\(.*/, ''))).toEqual([
      'portal.audit_internal', 'portal.consume_login', 'portal.document_chain_internal', 'portal.document_object', 'portal.end_session',
      'portal.issue_document_stream', 'portal.record_audit', 'portal.request_login', 'portal.resolve_session',
    ]);
    for (const r of rows) {
      expect(r, r.fn).toMatchObject({ owner: 'app_definer', pinned: true, public_exec: false });
      const internal = /_internal\(/.test(r.fn);
      expect(r.definer, r.fn).toBe(!internal);
      expect(r.app_user_exec, r.fn).toBe(!internal);
    }
  });
});
