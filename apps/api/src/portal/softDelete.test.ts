// Batch 14 round 2, B14-OWN-1 (PHASE2_3_PLAN Q-PORTAL-20; ARCHITECTURE §21.56; migration 0091): a soft-deleted
// client gets no new sign-in link, and their sessions and grants see nothing; restoring the contact restores access.
// The batch 14 review skeptic's sequence, through the API: before 0091, after the Owner's POST /leads/:id/delete the
// account stayed active, an old session's /me answered 200 with its grant, and a new sign-in link was sent and opened
// a session. Fakes only; platform:portal is cleared in the per-test database and withdrawn in afterAll.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { NOT_VISIBLE } from './shared/copy.js';
import { PortalClient, askLink, call, client, deal, invite, json, lastToken, portalWorld, setPortalCleared, signIn, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let slug: string;
let n = 0;
const ip = () => `203.0.113.${(++n % 200) + 20}`;

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

/** What the fakes carried to `address` (emails and texts). */
const carried = (address: string) =>
  h.providers.email.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase()).length + h.providers.telephony.sms.filter((m) => m.to === address).length;

const tokens = async (accountId: string) => Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM portal_login_tokens WHERE portal_account_id = $1', [accountId])).rows[0]!.n);

const partyOk = (accountId: string, dealId: string) =>
  withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => (await sql<{ ok: boolean }>`SELECT app.portal_party_ok(app.tenant_id(), ${accountId}::uuid, ${dealId}::uuid, NULL) AS ok`.execute(tx)).rows[0]!.ok, { db: h.database });

const meGrants = async (pc: PortalClient) => {
  const r = await pc.get('/api/portal/me');
  return { status: r.statusCode, grants: r.statusCode === 200 ? json<{ grants: { id: string }[] }>(r).grants.map((g) => g.id) : null };
};

describe('B14-OWN-1: a soft-deleted client (Q-PORTAL-20, conservative default)', () => {
  it('B14-OWN-1 R-PORTAL-5: after the Owner deletes the lead, an old session sees nothing, a link asked for before opens no session, no new link is sent and the grant is no longer a party\'s; reopening the lead restores each', async () => {
    const agent = w.agents[0]!;
    const c = await client(agent, { firstName: 'Jo' });
    const dealId = await deal(agent, c.id);
    const inv = await invite(agent, dealId, c.id);
    expect(inv.status).toBeLessThan(300);
    const grantId = inv.body.grant.id;
    const accountId = inv.body.account.id;
    const pc = await signIn(h, slug, c.email, new PortalClient(h, ip()));
    expect(await meGrants(pc)).toEqual({ status: 200, grants: [grantId] });
    // a sign-in link asked for before the delete, opened after it
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE portal_account_id = $1 AND used_at IS NOT NULL`, [accountId]);
    expect((await askLink(h, slug, c.email, ip())).statusCode).toBe(202);
    const early = lastToken(h, c.email)!;
    expect(early).toBeTruthy();
    expect(await partyOk(accountId, dealId)).toBe(true);

    const del = await call(w.owner, 'POST', `/leads/${c.id}/delete`, { commandId: randomUUID() });
    expect(del.status).toBeLessThan(300);
    expect((await h.su.query<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM contacts WHERE id = $1', [c.id])).rows[0]!.deleted).toBe(true);
    // the account itself is left as it was, so a restore restores access
    expect((await h.su.query<{ status: string }>('SELECT status FROM portal_accounts WHERE id = $1', [accountId])).rows[0]!.status).toBe('active');

    // 1. the old session sees nothing
    expect(await meGrants(pc)).toEqual({ status: 401, grants: null });
    // 2. the link asked for before the delete opens no session
    const late = await new PortalClient(h, ip()).post('/api/portal/session', { token: early });
    expect(late.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(late).error.code).toBe('PORTAL_LINK_INVALID');
    // 3. a new request answers as for any address, and no link is issued or sent
    const sentBefore = carried(c.email);
    const tokensBefore = await tokens(accountId);
    expect((await askLink(h, slug, c.email, ip())).statusCode).toBe(202);
    expect(carried(c.email)).toBe(sentBefore);
    expect(await tokens(accountId)).toBe(tokensBefore);
    // 4. the grant is no longer a party's (client reads, document chain, the sync's publishing)
    expect(await partyOk(accountId, dealId)).toBe(false);

    // restoring the contact restores access
    const reopen = await call(w.owner, 'POST', `/leads/${c.id}/reopen`, { commandId: randomUUID() });
    expect(reopen.status).toBeLessThan(300);
    expect(await partyOk(accountId, dealId)).toBe(true);
    expect(await meGrants(pc)).toEqual({ status: 200, grants: [grantId] });
    const again = await signIn(h, slug, c.email, new PortalClient(h, ip()));
    expect(await meGrants(again)).toEqual({ status: 200, grants: [grantId] });
  });

  it('b15 (b14 low f): the Owner\'s deal section and preview say the client\'s record is deleted (never "no longer a party"), and live again once it is restored', async () => {
    const agent = w.agents[0]!;
    const c = await client(agent, { firstName: 'Kit' });
    const dealId = await deal(agent, c.id);
    const inv = await invite(agent, dealId, c.id);
    expect(inv.status).toBeLessThan(300);
    const grantId = inv.body.grant.id;
    const state = async () => (await call<{ grants: { id: string; state: string; stateText: string }[] }>(w.owner, 'GET', `/deals/${dealId}/portal`)).body.grants.find((g) => g.id === grantId)!;
    const why = async () => (await call<{ visibleNow: boolean; why: string[] }>(w.owner, 'GET', `/portal-grants/${grantId}/preview`)).body.why;
    expect((await state()).state).toBe('live');
    expect((await call(w.owner, 'POST', `/leads/${c.id}/delete`, { commandId: randomUUID() })).status).toBeLessThan(300);
    expect(await state()).toMatchObject({ state: 'contact_deleted', stateText: NOT_VISIBLE.CONTACT_DELETED });
    expect(NOT_VISIBLE.CONTACT_DELETED).toBe("This person's record is deleted, so the client sees nothing until it is restored.");
    expect(await why()).toContain(NOT_VISIBLE.CONTACT_DELETED);
    expect(await why()).not.toContain(NOT_VISIBLE.NOT_A_PARTY);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reopen`, { commandId: randomUUID() })).status).toBeLessThan(300);
    expect(await state()).toMatchObject({ state: 'live', stateText: 'Live.' });
  });
});
