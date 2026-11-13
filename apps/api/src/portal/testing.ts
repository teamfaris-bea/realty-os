// Test helpers of module 45 (used only by *.test.ts). Fakes only: the fake email and telephony providers carry the
// links; platform:portal is cleared in the per-test database by the superuser (platform data has no application
// writer) and set back in a finally.
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { call } from '../admin/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { TEST_ORIGIN, safeJson } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, randomEmail, randomPhone } from '../comms/testing.js';
import { runScan, upload } from '../documents/testing.js';
import { settlePortalSignins } from './signin/routes.js';

export { call, randomEmail, randomPhone };

export type PortalWorld = CommsWorld & { admin: TestClient; tc: TestClient; isa: TestClient };

export async function portalWorld(h: ApiHarness): Promise<PortalWorld> {
  const w = await commsWorld(h, { teamLead: true, others: ['admin', 'tc', 'isa'], rule: false });
  return { ...w, admin: w.others[0]!, tc: w.others[1]!, isa: w.others[2]! };
}

export async function setPortalCleared(h: ApiHarness, on: boolean): Promise<void> {
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${on ? 'now()' : 'NULL'} WHERE key = 'platform:portal' AND status = 'published'`);
}

/** Runs `fn` with platform:portal cleared, and withdraws the clearance afterwards whatever happens. */
export async function withCleared<T>(h: ApiHarness, fn: () => Promise<T>): Promise<T> {
  await setPortalCleared(h, true);
  try {
    return await fn();
  } finally {
    await setPortalCleared(h, false);
  }
}

export async function slugOf(h: ApiHarness, tenantId: string): Promise<string> {
  return (await h.su.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [tenantId])).rows[0]!.slug;
}

export interface Client {
  id: string;
  email: string;
  phone: string;
}

/** A contact the agent owns, with an email and a phone (no consent rows: D1 only checks opt-outs). */
export async function client(agent: TestClient, o: { firstName?: string; email?: string; phone?: string } = {}): Promise<Client> {
  const c = await ownedContact(agent, { consent: false, firstName: o.firstName ?? 'Jane', ...(o.email ? { email: o.email, confirmDistinct: true } : {}), ...(o.phone ? { phone: o.phone } : {}) });
  return { id: c.id, email: c.email, phone: c.phone };
}

export async function deal(agent: TestClient, contactId: string, o: { side?: 'buy' | 'sell' | 'dual'; listingId?: string } = {}): Promise<string> {
  const r = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: contactId, side: o.side ?? 'buy', ...(o.listingId ? { listingId: o.listingId } : {}) });
  if (r.status !== 201) throw new Error(`deal: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.deal.id;
}

export async function milestone(agent: TestClient, dealId: string, dueOn = '2031-03-15', kind = 'inspection'): Promise<string> {
  const r = await call<{ date: { id: string } }>(agent, 'POST', `/deals/${dealId}/dates`, { kind, dueOn });
  if (r.status !== 201) throw new Error(`date: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.date.id;
}

/** A clean, shared document of the deal (uploaded, scanned by the fake scanner, shared). */
export async function sharedDocument(h: ApiHarness, w: { tenantId: string }, agent: TestClient, dealId: string, name = 'Purchase contract.pdf'): Promise<{ id: string; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% synthetic portal test ${randomUUID()}\n%%EOF\n`);
  const u = await upload(agent, `/deals/${dealId}/documents`, { bytes, filename: name });
  if (u.status !== 201) throw new Error(`upload: ${u.status} ${JSON.stringify(u.body)}`);
  await runScan(h, w.tenantId, u.body.document.id);
  const s = await call(agent, 'POST', `/documents/${u.body.document.id}/share`, { shared: true });
  if (s.status !== 200) throw new Error(`share: ${s.status} ${JSON.stringify(s.body)}`);
  return { id: u.body.document.id, bytes };
}

export interface InviteBody {
  account: { id: string; status: string; loginPoint: { id: string; kind: string } | null };
  grant: { id: string; state: string; view: { scope: string | null; title: string } };
  created: { account: boolean; grant: boolean };
  notice: { sent: boolean; text: string; channel: string | null; decision: { reasons: string[] } | null };
}

export async function invite(agent: TestClient, dealId: string, contactId: string, extra: Record<string, unknown> = {}, kind: 'deals' | 'listings' = 'deals') {
  return call<InviteBody>(agent, 'POST', `/${kind}/${dealId}/portal/invite`, { contactId, idempotencyKey: randomUUID().replace(/-/g, ''), ...extra });
}

export async function publish(agent: TestClient, kind: string, sourceId: string, grantIds: string[]) {
  return call<{ results: { grantId: string; result: string; itemId: string | null; text: string | null }[] }>(agent, 'POST', '/portal-items', { kind, sourceId, grantIds });
}

/** The portal client: keeps the portal cookie and the portal CSRF token, like module 46 in a browser. */
export class PortalClient {
  cookie: string | null = null;
  csrf: string | null = null;
  constructor(
    readonly h: ApiHarness,
    readonly ip = '198.51.100.77',
  ) {}

  async request(method: string, url: string, body?: unknown, o: { csrf?: string | null; cookie?: string; origin?: string | null; ip?: string; raw?: string; contentType?: string } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { 'user-agent': 'vitest-portal' };
    const origin = o.origin === undefined ? TEST_ORIGIN : o.origin;
    if (origin !== null && method !== 'GET') headers.origin = origin;
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    const cookie = o.cookie ?? (this.cookie ? `__Host-psid=${this.cookie}` : undefined);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined || o.raw !== undefined) headers['content-type'] = o.contentType ?? 'application/json';
    const res = await this.h.app.inject({ method: method as 'GET', url, headers, remoteAddress: o.ip ?? this.ip, ...(o.raw !== undefined ? { payload: o.raw } : body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const set = res.cookies.find((c) => c.name === '__Host-psid');
    if (set) this.cookie = set.value === '' || (set.maxAge !== undefined && set.maxAge <= 0) ? null : set.value;
    const j = safeJson(res.body) as { csrfToken?: string } | null;
    if (j?.csrfToken) this.csrf = j.csrfToken;
    return res;
  }
  get(url: string, o?: Parameters<PortalClient['request']>[3]) {
    return this.request('GET', url, undefined, o);
  }
  post(url: string, body: unknown = {}, o?: Parameters<PortalClient['request']>[3]) {
    return this.request('POST', url, body, o);
  }
}

export const TOKEN_RE = /#token=([A-Za-z0-9_-]{43})/;

/** Asks for a link and waits for the post-reply lookup and delivery. */
export async function askLink(h: ApiHarness, team: string, address: string, ip = '198.51.100.20'): Promise<LightMyRequestResponse> {
  const r = await h.app.inject({ method: 'POST', url: '/api/portal/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, remoteAddress: ip, payload: JSON.stringify({ team, address }) });
  await settlePortalSignins();
  return r;
}

/** The newest link token the fakes carried to `address` (email or phone). */
export function lastToken(h: ApiHarness, address: string): string | null {
  const emails = h.providers.email.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  const texts = h.providers.telephony.sms.filter((m) => m.to === address);
  const bodies = [...emails.map((m) => m.text ?? ''), ...texts.map((m) => m.body)];
  for (let i = bodies.length - 1; i >= 0; i--) {
    const m = TOKEN_RE.exec(bodies[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/** The whole sign-in: ask for a link, read it from the fake, open a session. */
export async function signIn(h: ApiHarness, team: string, address: string, pc = new PortalClient(h)): Promise<PortalClient> {
  await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'`);
  const r = await askLink(h, team, address, pc.ip);
  if (r.statusCode !== 202) throw new Error(`login: ${r.statusCode} ${r.body}`);
  const token = lastToken(h, address);
  if (!token) throw new Error('no link delivered');
  const s = await pc.post('/api/portal/session', { token });
  if (s.statusCode !== 200) throw new Error(`session: ${s.statusCode} ${s.body}`);
  return pc;
}

export const json = <T = Record<string, unknown>>(r: LightMyRequestResponse): T => safeJson(r.body) as T;
