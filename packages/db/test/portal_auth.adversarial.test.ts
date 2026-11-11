// Adversarial tests for db/p3-portal-auth (module 43, critical): try to break tenancy and the client principal's
// boundary through the portal definers, plus a property test of the download decision (R-PORTAL-7): a client may
// open a document item if and only if none of the chain's conditions fails, both when the token is issued and when
// it is redeemed. Real Postgres, app_user under RLS; the superuser only flips platform data, ages rows and reads.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ClientActor,
  consumePortalLogin,
  issuePortalDocumentStream,
  redeemPortalDocumentStream,
  requestPortalLogin,
  resolvePortalSession,
  withPortalTx,
} from '../src/portalTx.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createParty, type Party, setPortalCleared, signIn } from './portalFixture.js';
import { createHarness, createWorld, type Harness, selfCreated, suFixture, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let wb: World;
let jane: Party;
let bea: Party;
let janeC: ClientActor;
let beaC: ClientActor;

const sha = (s: string) => createHash('sha256').update(s).digest();
const asClient = <T>(c: ClientActor, fn: Parameters<typeof withPortalTx<T>>[1]) => withPortalTx(c, fn, { db: h.app });

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
  wb = await createWorld(h.app, { agents: 1 });
  await setPortalCleared(h, true);
  jane = await createParty(h, w, w.agents[0]!, 'Jane Adversary');
  bea = await createParty(h, wb, wb.agents[0]!, 'Bea Adversary');
  janeC = (await signIn(h, w, jane)).client;
  beaC = (await signIn(h, wb, bea)).client;
});
afterAll(async () => {
  await h?.close();
});

describe('adversarial: tenancy and the client boundary', () => {
  it('a forged client actor naming another tenant (account from tenant A, tenant B) reaches nothing', async () => {
    const forged = { ...janeC, tenantId: wb.tenantId } as ClientActor;
    const r = await asClient(forged, async (tx) => ({
      accounts: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_accounts`.execute(tx)).rows[0]!.n,
      grants: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_grants`.execute(tx)).rows[0]!.n,
      items: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM portal_items`.execute(tx)).rows[0]!.n,
      streamA: await issuePortalDocumentStream(tx, jane.itemId),
      streamB: await issuePortalDocumentStream(tx, bea.itemId),
    }));
    expect(r).toEqual({ accounts: 0, grants: 0, items: 0, streamA: null, streamB: null });
  });

  it('a download token minted in tenant A is worthless in a tenant-B client context, and vice versa', async () => {
    const tA = await asClient(janeC, (tx) => issuePortalDocumentStream(tx, jane.itemId));
    const tB = await asClient(beaC, (tx) => issuePortalDocumentStream(tx, bea.itemId));
    expect(await asClient(beaC, (tx) => redeemPortalDocumentStream(tx, tA!.token))).toBeNull();
    expect(await asClient(janeC, (tx) => redeemPortalDocumentStream(tx, tB!.token))).toBeNull();
    // the rightful owners can still use them: the failed attempts did not burn the tokens
    expect(await asClient(janeC, (tx) => redeemPortalDocumentStream(tx, tA!.token))).not.toBeNull();
    expect(await asClient(beaC, (tx) => redeemPortalDocumentStream(tx, tB!.token))).not.toBeNull();
  });

  it('a staff Owner cannot redeem a client\'s download token or read the token tables', async () => {
    const t = await asClient(janeC, (tx) => issuePortalDocumentStream(tx, jane.itemId));
    const r = await withTenantTx(w.owner.actor, (tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM portal.document_object(${sha(t!.token)})`.execute(tx), { db: h.app });
    expect(r.rows[0]!.n).toBe(0);
    await expect(withTenantTx(w.owner.actor, (tx) => sql`SELECT * FROM portal_stream_tokens`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    expect(await asClient(janeC, (tx) => redeemPortalDocumentStream(tx, t!.token))).not.toBeNull();
  });

  it('guessed, malformed and replayed tokens never resolve or sign in', async () => {
    for (const bad of ['', 'short', 'x'.repeat(43), 'A'.repeat(200), "' OR 1=1 --", jane.accountId]) {
      expect(await resolvePortalSession(bad, { db: h.app })).toBeNull();
      expect(await consumePortalLogin(bad, {}, { db: h.app })).toBeNull();
    }
    // the raw session token is not stored, so the stored hash itself is not a credential
    const [row] = (await h.su.query<{ token_hash: Buffer }>('SELECT token_hash FROM portal_sessions WHERE portal_account_id = $1 LIMIT 1', [jane.accountId])).rows;
    expect(await resolvePortalSession(row!.token_hash.toString('base64url'), { db: h.app })).toBeNull();
    expect(await resolvePortalSession(row!.token_hash.toString('hex'), { db: h.app })).toBeNull();
  });

  it('request_login rejects malformed hashes outright and treats the slug and address as data', async () => {
    await expect(withPreTenant((tx) => sql`SELECT * FROM portal.request_login(${w.slug}, '\\x00'::bytea, ARRAY[${sha('t')}]::bytea[])`.execute(tx), { db: h.app })).rejects.toThrow(/PORTAL_BAD_REQUEST/);
    await expect(withPreTenant((tx) => sql`SELECT * FROM portal.request_login(${w.slug}, ${sha(jane.email)}, ARRAY[]::bytea[])`.execute(tx), { db: h.app })).rejects.toThrow(/PORTAL_BAD_REQUEST/);
    await expect(withPreTenant((tx) => sql`SELECT * FROM portal.request_login(${w.slug}, ${sha(jane.email)}, ARRAY[NULL]::bytea[])`.execute(tx), { db: h.app })).rejects.toThrow(/PORTAL_BAD_REQUEST/);
    expect(await requestPortalLogin(`${w.slug}' OR '1'='1`, jane.email, { db: h.app })).toEqual([]);
    expect(await requestPortalLogin(w.slug, `${jane.email}' OR '1'='1`, { db: h.app })).toEqual([]);
  });

  it('a link issued before the account was disabled never signs in, even after the contact is invited again', async () => {
    const p = await createParty(h, w, w.agents[1]!, 'Vic Reinvite');
    const [old] = await requestPortalLogin(w.slug, p.email, { db: h.app });
    await withTenantTx(p.agent.actor, async (tx) => {
      await sql`UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = 'AGENT_REVOKED' WHERE id = ${p.accountId}`.execute(tx);
      await sql`INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id)
                VALUES (${w.tenantId}, ${uuid()}, ${p.contactId}, ${p.pointId}, 'invited', ${p.agent.id})`.execute(tx);
    }, { db: h.app });
    expect(await consumePortalLogin(old!.token, {}, { db: h.app })).toBeNull();
  });

  it('a client cannot reach its own grant\'s item through a forged item id from another grant of another client', async () => {
    // Omar is a co-buyer on Jane's deal with his own account and grant: Jane still cannot open Omar's items, and
    // Omar's items are on the same deal, so this proves the account binding, not only the deal binding.
    const omarId = await selfCreated(h.app, w, jane.agent, 'Omar CoBuyer');
    const omarPoint = uuid();
    const omarAccount = uuid();
    const omarGrant = uuid();
    const omarItem = uuid();
    await withTenantTx(jane.agent.actor, async (tx) => {
      await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES (${w.tenantId}, ${omarPoint}, ${omarId}, 'email', ${`omar-${uuid().slice(0, 6)}@example.test`}, ${sha(omarPoint)})`.execute(tx);
      await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (${w.tenantId}, ${jane.dealId}, ${omarId}, 'co_buyer')`.execute(tx);
      await sql`INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id) VALUES (${w.tenantId}, ${omarAccount}, ${omarId}, ${omarPoint}, 'invited', ${jane.agent.id})`.execute(tx);
      await sql`INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at) VALUES (${w.tenantId}, ${omarGrant}, ${omarAccount}, ${jane.dealId}, ${jane.agent.id}, now())`.execute(tx);
      await sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, document_id, published_by_kind, published_by_user_id, published_at)
                VALUES (${w.tenantId}, ${omarItem}, ${omarGrant}, 'document', 'Omar copy', 'document', ${jane.documentId}, ${jane.documentId}, 'user', ${jane.agent.id}, now())`.execute(tx);
    }, { db: h.app });
    expect(await asClient(janeC, (tx) => issuePortalDocumentStream(tx, omarItem))).toBeNull();
    const seen = await asClient(janeC, (tx) => sql<{ id: string }>`SELECT id FROM portal_items`.execute(tx));
    expect(seen.rows.map((r) => r.id)).not.toContain(omarItem);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property test: the download decision. Faults are applied after sign-in and after a first token was issued;
// issuing a new token and redeeming the old one must both be refused iff at least one fault holds.
// ---------------------------------------------------------------------------------------------------------------
const FAULTS = ['unshared', 'retracted', 'revoked', 'expired', 'not_a_party', 'account_disabled', 'not_cleared', 'object_deleted', 'tenant_suspended'] as const;
type Fault = (typeof FAULTS)[number];

async function applyFault(p: Party, f: Fault): Promise<void> {
  const a = p.agent;
  const asAgent = (q: ReturnType<typeof sql>) => withTenantTx(a.actor, (tx) => q.execute(tx), { db: h.app });
  switch (f) {
    case 'unshared':
      return void (await asAgent(sql`UPDATE documents SET shared_to_portal = false WHERE id = ${p.documentId}`));
    case 'retracted':
      return void (await asAgent(sql`UPDATE portal_items SET retracted_at = now() WHERE id = ${p.itemId}`));
    case 'revoked':
      return void (await asAgent(sql`UPDATE portal_grants SET revoked_at = now(), revoked_by_user_id = ${a.id} WHERE id = ${p.grantId}`));
    case 'expired':
      // the grant lapsed a minute ago (aged by the superuser: the guard only lets expiry move forward from now)
      return suFixture(h.su, `UPDATE portal_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE id = $1`, [p.grantId]);
    case 'not_a_party': {
      const other = await selfCreated(h.app, w, a, 'Someone Else');
      return void (await asAgent(sql`UPDATE deals SET primary_contact_id = ${other} WHERE id = ${p.dealId}`));
    }
    case 'account_disabled':
      return void (await asAgent(sql`UPDATE portal_accounts SET status = 'disabled', disabled_at = now(), disabled_reason = 'AGENT_REVOKED' WHERE id = ${p.accountId}`));
    case 'not_cleared':
      return setPortalCleared(h, false);
    case 'object_deleted':
      return void (await h.su.query('UPDATE stored_objects SET deleted_at = now() WHERE id = $1', [p.objectId]));
    case 'tenant_suspended':
      return void (await h.su.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [w.tenantId]));
  }
}

async function resetGlobals(): Promise<void> {
  await setPortalCleared(h, true);
  await h.su.query("UPDATE tenants SET status = 'active' WHERE id = $1", [w.tenantId]);
}

describe('property: R-PORTAL-7 a document opens iff the whole chain holds', () => {
  it('every single fault alone refuses both a new token and the redemption of an earlier one', async () => {
    for (const f of FAULTS) {
      const p = await createParty(h, w, w.agents[0]!, `Single ${f}`);
      const c = (await signIn(h, w, p)).client;
      const early = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
      expect(early, f).not.toBeNull();
      await applyFault(p, f);
      expect(await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId)), f).toBeNull();
      expect(await asClient(c, (tx) => redeemPortalDocumentStream(tx, early!.token)), f).toBeNull();
      await resetGlobals();
    }
  });

  it('random fault sets: allowed iff the set is empty (fast-check)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray([...FAULTS], { minLength: 0, maxLength: 4 }), async (faults) => {
        const p = await createParty(h, w, w.agents[1]!, 'Prop Party');
        const c = (await signIn(h, w, p)).client;
        const early = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
        for (const f of faults) await applyFault(p, f);
        const fresh = await asClient(c, (tx) => issuePortalDocumentStream(tx, p.itemId));
        const redeemed = await asClient(c, (tx) => redeemPortalDocumentStream(tx, early!.token));
        await resetGlobals();
        const allowed = faults.length === 0;
        expect(fresh !== null).toBe(allowed);
        expect(redeemed !== null).toBe(allowed);
      }),
      { numRuns: 24, seed: 4301 },
    );
  });
});
