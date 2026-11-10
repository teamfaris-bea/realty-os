// Test helpers for the api/admin integration tests (imported by *.test.ts only). Everything the
// application does goes through the real server as app_user; the superuser pool only ages a
// session's re-authentication (a clock fixture) and reads state back.
import type { Role } from '@realty/core/foundation';
import type { LightMyRequestResponse } from 'fastify';
import { type ApiHarness, TEST_PASSWORD, type TestClient } from '../auth/testHarness.js';

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  code: string | null;
}

export function res<T = Record<string, unknown>>(r: LightMyRequestResponse): Res<T> {
  let body: unknown;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = null;
  }
  const code = (body as { error?: { code?: string } } | null)?.error?.code ?? null;
  return { status: r.statusCode, body: body as T, code };
}

export async function call<T = Record<string, unknown>>(c: TestClient, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Res<T>> {
  return res<T>(await c.request(method, `/api${url}`, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {})));
}

/** Ages the client's re-authentication past the 15-minute window (R-PERM-13). */
export async function staleReauth(h: ApiHarness, c: TestClient): Promise<void> {
  await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [c.userId]);
}

/** Marks the client's sessions as freshly re-authenticated (the /auth/reauth effect, without its rate limit). */
export async function freshReauth(h: ApiHarness, c: TestClient): Promise<void> {
  await h.su.query('UPDATE sessions SET reauthenticated_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [c.userId]);
}

/** Invites through POST /invites, then accepts the emailed link through the API (Owner/Admin enroll MFA). */
export async function inviteViaApi(h: ApiHarness, inviter: TestClient, role: Role, o: { email?: string; mfa?: boolean } = {}): Promise<TestClient> {
  const email = o.email ?? `${role}-${Math.random().toString(16).slice(2, 10)}@example.test`;
  await freshReauth(h, inviter);
  const r = await call(inviter, 'POST', '/invites', { email, role });
  if (r.status !== 201) throw new Error(`invite failed: ${r.status} ${JSON.stringify(r.body)}`);
  const link = h.providers.accountMail.lastLink(email);
  const token = link ? /#token=([^&]+)$/.exec(link)?.[1] : undefined;
  if (!token) throw new Error('no invite link was sent');
  const c = h.client(`192.0.2.${Math.floor(Math.random() * 200) + 20}`);
  c.email = email;
  const acc = await c.post(`/api/auth/invites/${token}/accept`, { displayName: `Member ${role}`, password: TEST_PASSWORD });
  if (acc.statusCode !== 200) throw new Error(`accept failed: ${acc.statusCode} ${acc.body}`);
  if ((role === 'owner' || role === 'admin') && o.mfa !== false) await h.enrollMfa(c);
  return c;
}

export interface AuditRow {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  changes: Record<string, unknown>;
  reason: string | null;
  request_id: string | null;
}

export async function auditRows(h: ApiHarness, tenantId: string, actionPrefix = ''): Promise<AuditRow[]> {
  return (
    await h.su.query<AuditRow>(
      `SELECT action, entity_type, entity_id, actor_user_id, actor_role, changes, reason, request_id FROM audit_log
        WHERE tenant_id = $1 AND action LIKE $2 ORDER BY seq`,
      [tenantId, `${actionPrefix}%`],
    )
  ).rows;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** Replaces ids and instants with stable placeholders (snapshots). */
export function normalize<T>(v: T): T {
  const ids = new Map<string, string>();
  const s = JSON.stringify(v)
    .replace(UUID_RE, (m) => {
      const k = m.toLowerCase();
      if (!ids.has(k)) ids.set(k, `<id${ids.size + 1}>`);
      return ids.get(k)!;
    })
    .replace(ISO_RE, '<instant>');
  return JSON.parse(s) as T;
}

/**
 * A new lead arriving through intake, as the system actor (the path api/leads' intake calls):
 * `applyOwnershipCommand(create via intake)` routes it with the rules configured through the API.
 * Returns where it went: the offeree, or the pond and the routing reason.
 */
export async function routeInquiry(
  h: ApiHarness,
  tenantId: string,
  inquiry: { inquiryType?: 'buy' | 'sell' | 'rent' | 'value' | 'general'; postalCode?: string | null; priceMinCents?: number | null; priceMaxCents?: number | null } = {},
): Promise<{ contactId: string; state: string; offeredTo: string | null; pondId: string | null; reason: string | null; offerExpiresAt: Date | null }> {
  const { applyOwnershipCommand } = await import('@realty/db');
  const { systemActor } = await import('../worker/systemActor.js');
  const { randomUUID } = await import('node:crypto');
  const contactId = randomUUID();
  const r = await applyOwnershipCommand(systemActor(tenantId, 'provider'), contactId as never, { kind: 'create', via: 'intake' }, {
    commandId: randomUUID(),
    newContact: { displayName: 'Pat Lead' },
    inquiry: { leadSourceId: null, inquiryType: inquiry.inquiryType ?? 'buy', postalCode: inquiry.postalCode ?? null, priceMinCents: inquiry.priceMinCents ?? null, priceMaxCents: inquiry.priceMaxCents ?? null },
    db: h.database,
  });
  if (!r.outcome.ok) throw new Error(`intake rejected: ${r.outcome.code}`);
  const c = (
    await h.su.query<{ ownership_state: string; offered_to_user_id: string | null; pond_id: string | null; offer_expires_at: Date | null }>(
      'SELECT ownership_state, offered_to_user_id, pond_id, offer_expires_at FROM contacts WHERE id = $1',
      [contactId],
    )
  ).rows[0]!;
  const e = (await h.su.query<{ reason_code: string | null }>('SELECT reason_code FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1', [contactId])).rows[0];
  return { contactId, state: c.ownership_state, offeredTo: c.offered_to_user_id, pondId: c.pond_id, reason: e?.reason_code ?? null, offerExpiresAt: c.offer_expires_at };
}

/** Registers a Web Push subscription for the client through the device route (R-OWN-11 #4: a working critical channel). */
export async function registerPush(c: TestClient): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 10);
  const r = await c.post('/api/push-subscriptions', { endpoint: `https://push.example.test/sub/${tag}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } });
  if (r.statusCode !== 201) throw new Error(`push subscription failed: ${r.statusCode} ${r.body}`);
}
