// Push subscriptions and alert-phone verification (BUILD_PLAN module 8 devices; E54, E60 refusal;
// R-DATA-1 push endpoints encrypted).
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness, safeJson } from './testHarness.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;
let other: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  agent = await h.invite(owner, 'agent');
  other = await h.invite(owner, 'agent');
});
afterAll(async () => {
  await h?.close();
});

const code = (r: { body: string }) => (safeJson(r.body) as { error?: { code?: string } } | null)?.error?.code;
const sub = (path: string) => ({ endpoint: `https://push.example.test/${path}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } });

describe('push subscriptions', () => {
  it('R-DATA-1: a subscription is stored encrypted (endpoint and keys), deduplicated by an HMAC of the endpoint, and decryptable only under its own row binding', async () => {
    const r1 = await agent.post('/api/push-subscriptions', sub('dev-1'));
    expect(r1.statusCode).toBe(201);
    const id = r1.json().id as string;
    const r2 = await agent.post('/api/push-subscriptions', sub('dev-1'));
    expect(r2.json().id).toBe(id); // same device ⇒ same row
    const row = (await h.su.query<{ endpoint_enc: Buffer; keys_enc: Buffer; endpoint_hash: Buffer; key_version: number; user_id: string }>('SELECT * FROM push_subscriptions WHERE id = $1', [id])).rows[0]!;
    expect(row.user_id).toBe(agent.userId);
    expect(row.endpoint_enc.includes(Buffer.from('push.example.test'))).toBe(false);
    expect(row.keys_enc.includes(Buffer.from('tBHItJI5'))).toBe(false);
    expect(row.endpoint_hash).toHaveLength(32);
    await withTenantTx(
      agent.actor(),
      async (tx) => {
        const env = h.app.platform.envelope.inTx(tx, agent.tenantId!);
        expect(Buffer.from(await env.decrypt(agent.tenantId!, { table: 'push_subscriptions', column: 'endpoint_enc', rowId: id }, new Uint8Array(row.endpoint_enc))).toString()).toBe('https://push.example.test/dev-1');
        expect(JSON.parse(Buffer.from(await env.decrypt(agent.tenantId!, { table: 'push_subscriptions', column: 'keys_enc', rowId: id }, new Uint8Array(row.keys_enc))).toString())).toEqual(sub('dev-1').keys);
        await expect(env.decrypt(agent.tenantId!, { table: 'push_subscriptions', column: 'keys_enc', rowId: id }, new Uint8Array(row.endpoint_enc))).rejects.toThrow();
      },
      { db: h.database },
    );
  });

  it('R-PERM-5 E52: deleting someone else’s or a guessed subscription id is 404 (not 403); deleting your own revokes it, and re-registering restores it', async () => {
    const mine = (await agent.post('/api/push-subscriptions', sub('dev-2'))).json().id as string;
    const theirs = (await other.post('/api/push-subscriptions', sub('dev-3'))).json().id as string;
    const cross = await agent.delete(`/api/push-subscriptions/${theirs}`);
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('NOT_FOUND');
    expect((await agent.delete('/api/push-subscriptions/01a1c4ba-0000-7000-8000-00000000beef')).statusCode).toBe(404);
    expect((await agent.delete(`/api/push-subscriptions/${mine}`)).statusCode).toBe(200);
    expect((await agent.delete(`/api/push-subscriptions/${mine}`)).statusCode).toBe(404);
    const revoked = (await h.su.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM push_subscriptions WHERE id = $1', [mine])).rows[0]!;
    expect(revoked.revoked_at).not.toBeNull();
    expect((await agent.post('/api/push-subscriptions', sub('dev-2'))).json().id).toBe(mine);
    expect((await h.su.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM push_subscriptions WHERE id = $1', [mine])).rows[0]!.revoked_at).toBeNull();
    expect((await h.su.query('SELECT revoked_at FROM push_subscriptions WHERE id = $1', [theirs])).rows[0].revoked_at).toBeNull();
  });

  it('only https endpoints and well-formed keys are accepted', async () => {
    expect((await agent.post('/api/push-subscriptions', { ...sub('x'), endpoint: 'http://push.example.test/x' })).statusCode).toBe(422);
    expect((await agent.post('/api/push-subscriptions', { ...sub('x'), keys: { p256dh: 'short', auth: 'x' } })).statusCode).toBe(422);
  });

  it('concurrent registrations of the same device end in one row', async () => {
    const rs = await Promise.all([agent.post('/api/push-subscriptions', sub('race')), agent.post('/api/push-subscriptions', sub('race')), agent.post('/api/push-subscriptions', sub('race'))]);
    const okIds = new Set(rs.filter((r) => r.statusCode === 201).map((r) => r.json().id));
    expect(okIds.size).toBe(1);
    const rows = await h.su.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [agent.userId]);
    const distinct = await withTenantTx(agent.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(DISTINCT endpoint_hash)::int AS n FROM push_subscriptions WHERE user_id = app.user_id()`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(rows.rows[0].n).toBe(distinct);
  });
});

describe('alert phone (E54)', () => {
  it('E54: a new alert phone takes effect only after the code sent to it is confirmed; the change is audited with the number redacted', async () => {
    const r = await agent.post('/api/me/alert-phone', { phone: '(843) 555-0142' });
    expect(r.statusCode).toBe(200);
    const { challenge, maskedPhone } = r.json() as { challenge: string; maskedPhone: string };
    expect(maskedPhone.endsWith('0142')).toBe(true);
    expect(challenge).not.toContain('8435550142');
    const sent = h.providers.telephony.verificationCodes.at(-1)!;
    expect(sent.to).toBe('+18435550142');
    // nothing changed yet
    const m0 = (await h.su.query<{ alert_phone_e164: string | null }>('SELECT alert_phone_e164 FROM memberships WHERE user_id = $1', [agent.userId])).rows[0]!;
    expect(m0.alert_phone_e164).toBeNull();
    expect(code(await agent.post('/api/me/alert-phone/verify', { challenge, code: sent.code === '000000' ? '000001' : '000000' }))).toBe('VERIFICATION_INVALID');
    // another member cannot use this challenge, even with the right code
    expect(code(await other.post('/api/me/alert-phone/verify', { challenge, code: sent.code }))).toBe('VERIFICATION_INVALID');
    const ok = await agent.post('/api/me/alert-phone/verify', { challenge, code: sent.code });
    expect(ok.statusCode).toBe(200);
    const m1 = (await h.su.query<{ alert_phone_e164: string; alert_phone_verified_at: Date }>('SELECT alert_phone_e164, alert_phone_verified_at FROM memberships WHERE user_id = $1', [agent.userId])).rows[0]!;
    expect(m1.alert_phone_e164).toBe('+18435550142');
    expect(m1.alert_phone_verified_at).not.toBeNull();
    const a = (await h.su.query<{ changes: Record<string, unknown> }>("SELECT changes FROM audit_log WHERE action = 'member.alert_phone_verified' AND actor_user_id = $1", [agent.userId])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]!.changes).toEqual({ alert_phone_e164: { changed: true }, alert_phone_verified_at: { from: null, to: expect.any(String) } });
    expect(JSON.stringify(a)).not.toContain('555');
  });

  it('a tampered or expired challenge is refused; attempts are limited', async () => {
    const r = await other.post('/api/me/alert-phone', { phone: '+18435550143' });
    const { challenge } = r.json() as { challenge: string };
    const sent = h.providers.telephony.verificationCodes.at(-1)!;
    const [payload, mac] = challenge.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), p: '+18435550999' })).toString('base64url');
    expect(code(await other.post('/api/me/alert-phone/verify', { challenge: `${forged}.${mac}`, code: sent.code }))).toBe('VERIFICATION_INVALID');
    const expired = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), e: Date.now() - 1000 })).toString('base64url');
    expect(code(await other.post('/api/me/alert-phone/verify', { challenge: `${expired}.${mac}`, code: sent.code }))).toBe('VERIFICATION_INVALID');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await other.post('/api/me/alert-phone/verify', { challenge, code: '999999' === sent.code ? '999998' : '999999' })).statusCode);
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);
    expect((await other.post('/api/me/alert-phone/verify', { challenge, code: sent.code })).statusCode).toBe(429);
  });

  it('a number that opted out of SMS (or has an active SMS suppression) is refused before any code is sent', async () => {
    const tl = await h.invite(owner, 'team_lead');
    const phone = '+18435550177';
    await withTenantTx(
      owner.actor(),
      async (tx) => {
        const hmac = Buffer.from(await h.app.platform.envelope.inTx(tx, owner.tenantId!).hmacAddress(owner.tenantId!, phone));
        await sql`INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, created_by_user_id)
                  VALUES (app.tenant_id(), '01a1c4ba-0000-7000-8000-0000000000f1', 'phone', ${hmac}, '••0177', 'sms', 'internal_dnc', app.user_id())`.execute(tx);
      },
      { db: h.database },
    );
    const before = h.providers.telephony.verificationCodes.length;
    expect(code(await tl.post('/api/me/alert-phone', { phone }))).toBe('ALERT_PHONE_OPTED_OUT');
    expect(h.providers.telephony.verificationCodes.length).toBe(before);
  });

  it('invalid numbers are PHONE_INVALID; sending codes is rate limited per user', async () => {
    const isa = await h.invite(owner, 'isa');
    expect(code(await isa.post('/api/me/alert-phone', { phone: '555-0100' }))).toBe('PHONE_INVALID');
    const st: number[] = [];
    for (let i = 0; i < 4; i++) st.push((await isa.post('/api/me/alert-phone', { phone: `+1843555016${i}` })).statusCode);
    expect(st).toEqual([200, 200, 200, 429]);
  });
});
