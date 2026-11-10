// DATA_MODEL E56 (R-TEN-3): a user who belongs to two tenants. One active tenant per session; switching
// rotates the session (the old token acts in neither tenant); notifications are tagged by tenant: the
// in-app list follows the session's tenant and a web-push lock-screen payload names its tenant, so the web
// app can offer to switch before opening a deep link from the other tenant.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerPush } from '../admin/testing.js';
import { deliverNotification, lockScreenPayload } from '../workspace/notifications.js';
import { deliveryDeps } from '../workspace/testing.js';
import { type ApiHarness, type TestClient, createApiHarness, tokenHashOf } from './testHarness.js';

let h: ApiHarness;
let user: TestClient; // Owner of tenant A, agent in tenant B
let A: { id: string; slug: string };
let B: { id: string; slug: string };

interface Session {
  tenant: { id: string; slug: string; role: string } | null;
  tenants: { id: string; slug: string; role: string }[];
}

beforeAll(async () => {
  h = await createApiHarness();
  user = await h.signup();
  const ownerB = await h.signup();
  A = { id: user.tenantId!, slug: ((await user.get('/api/auth/session')).json() as Session).tenant!.slug };
  B = { id: ownerB.tenantId!, slug: ((await ownerB.get('/api/auth/session')).json() as Session).tenant!.slug };
  // the user accepts B's invite while signed in: the session rotates into B; switch back to A to start
  const token = await h.inviteToken(ownerB, 'agent', user.email);
  expect((await user.post(`/api/auth/invites/${token}/accept`, {})).statusCode).toBe(200);
  expect((await user.post('/api/auth/tenant-switch', { slug: A.slug })).statusCode).toBe(200);
});
afterAll(async () => {
  await h?.close();
});

/** A notification for the user in `tenantId`, inserted the way notifications.test.ts does (the creator's rows). */
async function notificationIn(tenantId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, subject_type, subject_id, dedupe_key) VALUES ($1,$2,$3,'task_due','normal','A task is due','contact',$4,$5)`,
    [tenantId, id, userId, randomUUID(), `e56:${id}`],
  );
  await h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status) VALUES ($1,$2,$3,'in_app','in_app','delivered')`, [tenantId, randomUUID(), id]);
  return id;
}

const listIds = async (c: TestClient) => {
  const r = await c.get('/api/notifications');
  expect(r.statusCode).toBe(200);
  return (r.json() as { notifications: { id: string }[] }).notifications.map((n) => n.id);
};

const switchTo = async (c: TestClient, slug: string) => {
  const r = await c.post('/api/auth/tenant-switch', { slug });
  expect(r.statusCode).toBe(200);
  return r;
};

describe('E56: a user in two tenants', () => {
  it('E56 R-TEN-3: one active tenant per session; GET /auth/session lists both tenants and exactly one active', async () => {
    const s = (await user.get('/api/auth/session')).json() as Session;
    expect(s.tenant).toMatchObject({ id: A.id, slug: A.slug, role: 'owner' });
    expect(s.tenants.map((t) => t.id).sort()).toEqual([A.id, B.id].sort());
    expect(s.tenants.find((t) => t.id === B.id)?.role).toBe('agent');
    // the session row itself carries one tenant: the active one
    const row = await h.su.query<{ active_tenant_id: string; revoked_at: Date | null }>('SELECT active_tenant_id, revoked_at FROM sessions WHERE token_hash = $1', [tokenHashOf(user.cookie!)]);
    expect(row.rows).toEqual([{ active_tenant_id: A.id, revoked_at: null }]);
  });

  it('E56 R-TEN-3: switching rotates the session; the old token is revoked (tenant_switch) and acts in neither tenant', async () => {
    const before = user.cookie!;
    const r = await switchTo(user, B.slug);
    expect(user.cookie).not.toBeNull();
    expect(user.cookie).not.toBe(before);
    expect(r.json().session.tenant).toMatchObject({ id: B.id, role: 'agent' });
    const old = await h.su.query<{ revoked_reason: string | null; active_tenant_id: string }>('SELECT revoked_reason, active_tenant_id FROM sessions WHERE token_hash = $1', [tokenHashOf(before)]);
    expect(old.rows).toEqual([{ revoked_reason: 'tenant_switch', active_tenant_id: A.id }]);
    const fresh = await h.su.query<{ active_tenant_id: string; revoked_at: Date | null }>('SELECT active_tenant_id, revoked_at FROM sessions WHERE token_hash = $1', [tokenHashOf(user.cookie!)]);
    expect(fresh.rows).toEqual([{ active_tenant_id: B.id, revoked_at: null }]);
    // replaying the old token: not a session, not A's data, not B's data, and it cannot switch either
    const stale = h.client();
    stale.cookie = before;
    expect((await stale.get('/api/auth/session')).statusCode).toBe(401);
    expect((await stale.get('/api/notifications')).statusCode).toBe(401);
    const live = async () => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.userId])).rows[0]!.n;
    const liveBefore = await live();
    const sw = await stale.post('/api/auth/tenant-switch', { slug: A.slug }, { csrf: user.csrf ?? 'none' });
    expect([401, 403]).toContain(sw.statusCode);
    expect(sw.cookies.find((c) => c.name === '__Host-sid' && c.value !== '')).toBeUndefined();
    expect(await live()).toBe(liveBefore);
    // and the new session still works
    expect(((await user.get('/api/auth/session')).json() as Session).tenant?.id).toBe(B.id);
    await switchTo(user, A.slug);
  });

  it("E56 R-TEN-3: a notification created in tenant B is not listed while A is active, and is listed after switching to B", async () => {
    const inB = await notificationIn(B.id, user.userId!);
    const inA = await notificationIn(A.id, user.userId!);
    expect(((await user.get('/api/auth/session')).json() as Session).tenant?.id).toBe(A.id);
    const whileA = await listIds(user);
    expect(whileA).toContain(inA);
    expect(whileA).not.toContain(inB);
    await switchTo(user, B.slug);
    const whileB = await listIds(user);
    expect(whileB).toContain(inB);
    expect(whileB).not.toContain(inA);
    await switchTo(user, A.slug);
  });

  it('E56 R-TEN-3: a web-push lock-screen payload is tagged with its tenant (slug in the url, tenant id in the tag)', async () => {
    // pure shape
    const p = lockScreenPayload({ id: '0190f5a0-0000-7000-8000-000000000001', kind: 'task_due', title: 'A task is due', subjectType: 'contact', subjectId: '0190f5a0-0000-7000-8000-000000000002', tenant: { id: B.id, slug: B.slug } });
    expect(p.url).toBe(`/contacts/0190f5a0-0000-7000-8000-000000000002?team=${B.slug}`);
    expect(p.tag).toBe(`${B.id}:0190f5a0-0000-7000-8000-000000000001`);
    expect(lockScreenPayload({ id: 'x', kind: 'system', title: 't', subjectType: null, subjectId: null, tenant: { id: A.id, slug: A.slug } }).url).toBe(`/notifications?team=${A.slug}`);
    // end to end: a push from tenant B delivered while the user's web session is in A still names B
    await switchTo(user, B.slug);
    await registerPush(user);
    await switchTo(user, A.slug);
    const id = await notificationIn(B.id, user.userId!);
    const sub = (await h.su.query<{ id: string }>('SELECT id FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [B.id, user.userId])).rows[0]!;
    const d = randomUUID();
    await h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'web_push',$4,'pending',now())`, [B.id, d, id, sub.id]);
    expect(await deliverNotification(d, deliveryDeps(h), B.id)).toEqual({ kind: 'sent' });
    const sent = h.providers.push.delivered.filter((x) => x.payload.tag === `${B.id}:${id}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.url).toMatch(new RegExp(`^/contacts/[0-9a-f-]{36}\\?team=${B.slug}$`));
  });
});
