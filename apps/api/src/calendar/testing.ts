// Test helpers for api/calendar (imported by tests and the e2e stack only). The provider side is driven through
// the deterministic fakes (FakeOAuth.issueCode, FakeCalendar.editExternally), the application side through the
// real server as app_user; the superuser only reads state back.
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import type { FakeTokenShape } from '../providers/integrations/fakes.js';
import { type Worker, createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { CALENDAR_SERVICES, type CalendarProviderKey } from './catalog.js';
import { makeCalendarHandlers } from './handlers.js';

export function calendarWorker(h: ApiHarness): Worker {
  const registry = new HandlerRegistry().registerAll(makeCalendarHandlers(() => h.app.platform.envelope));
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 2, worker: `calendar-test-${Math.random().toString(16).slice(2, 10)}`, idleMs: 10, log: silentLogger });
}

/** Makes pending calendar jobs of the tenant due now and drains them. */
export async function runCalendarJobs(h: ApiHarness, tenantId: string, rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind LIKE 'calendar.%' AND status = 'pending'`, [tenantId]);
    await calendarWorker(h).drain(50);
  }
}

export interface StartedCalendarFlow {
  state: string;
  challenge: string;
  scopes: string[];
  authorizeUrl: string;
}

export async function startCalendarFlow(c: TestClient, provider: CalendarProviderKey): Promise<StartedCalendarFlow> {
  const r = await call<{ authorizeUrl: string }>(c, 'POST', `/me/calendar/${provider}/connect`);
  if (r.status !== 201) throw new Error(`calendar connect start: ${r.status} ${r.code}`);
  const u = new URL(r.body.authorizeUrl);
  return { state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')!, scopes: (u.searchParams.get('scope') ?? '').split(' ').filter(Boolean), authorizeUrl: r.body.authorizeUrl };
}

/** The provider redirect, in the person's own session (the route is 'self'). */
export async function calendarCallback(c: TestClient, provider: string, q: Record<string, string>): Promise<{ status: number; result: string | null; location: string }> {
  const r = await c.request('GET', `/api/me/calendar/${provider}/callback?${new URLSearchParams(q).toString()}`);
  const loc = String(r.headers.location ?? '');
  return { status: r.statusCode, result: loc ? new URL(loc).searchParams.get('result') : null, location: loc };
}

/** The whole happy path: start, the person approves at the (fake) provider with the requested scopes, the redirect. */
export async function connectCalendar(h: ApiHarness, c: TestClient, provider: CalendarProviderKey = 'google_calendar', token: FakeTokenShape = {}): Promise<{ result: string | null; flow: StartedCalendarFlow; code: string }> {
  const flow = await startCalendarFlow(c, provider);
  const oauth = h.providers.integrations.oauth[CALENDAR_SERVICES[provider].oauth];
  const code = oauth.issueCode({ codeChallenge: flow.challenge, accounts: [], token: { scopes: [...CALENDAR_SERVICES[provider].scopes], refresh: true, ...token } });
  const cb = await calendarCallback(c, provider, { state: flow.state, code });
  return { result: cb.result, flow, code };
}

export async function linkRow(h: ApiHarness, userId: string, provider: CalendarProviderKey = 'google_calendar') {
  return (
    await h.su.query<{ id: string; status: string; access_enc: Buffer | null; refresh_enc: Buffer | null; key_version: number | null; scopes: string[]; last_error_code: string | null; purge_after: Date | null }>(
      'SELECT id, status, access_enc, refresh_enc, key_version, scopes, last_error_code, purge_after FROM user_calendar_links WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    )
  ).rows[0];
}

export async function apptSync(h: ApiHarness, id: string) {
  return (
    await h.su.query<{ external_event_ref: string | null; external_etag: string | null; external_sync_status: string; sync_version: number; external_pushed_version: number | null; external_detached_at: Date | null; starts_at: Date }>(
      'SELECT external_event_ref, external_etag, external_sync_status, sync_version, external_pushed_version, external_detached_at, starts_at FROM appointments WHERE id = $1',
      [id],
    )
  ).rows[0]!;
}

export const inHours = (h: number, base = Date.now()) => new Date(Math.floor(base / 60_000) * 60_000 + h * 3_600_000).toISOString();

export async function newAppointment(c: TestClient, o: { startsAt?: string; endsAt?: string; contactId?: string; kind?: string; userId?: string } = {}): Promise<string> {
  const startsAt = o.startsAt ?? inHours(24);
  const endsAt = o.endsAt ?? new Date(Date.parse(startsAt) + 3_600_000).toISOString();
  const r = await call<{ appointment: { id: string } }>(c, 'POST', '/appointments', { kind: o.kind ?? 'buyer_consult', startsAt, endsAt, ...(o.contactId ? { contactId: o.contactId } : {}), ...(o.userId ? { userId: o.userId } : {}) });
  if (r.status !== 201) throw new Error(`appointment: ${r.status} ${r.code}`);
  return r.body.appointment.id;
}
