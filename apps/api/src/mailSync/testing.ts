// Test helpers of module 68 (imported by *.test.ts and the web e2e stack only). The Google side is driven through
// the deterministic FakeGmail (issueCode = the person approving in Google's dialog, deliver = mail arriving); the
// application side through the real server as app_user. The superuser only clears the platform pack (no
// application path clears a counsel pack) and reads rows back.
import { randomUUID } from 'node:crypto';
import { call, freshReauth } from '../admin/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';

/** A fixture write the sync itself would make (the user_mail_links guard admits only the system for sync state). */
export async function asSystem(h: ApiHarness, tenantId: string, fn: (tx: Tx) => Promise<unknown>): Promise<void> {
  await withTenantTx(systemActor(tenantId, 'worker'), async (tx) => void (await fn(tx)), { db: h.database });
}
import { HandlerRegistry } from '../worker/registry.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { CURRENT_DISCLOSURE_SHA256 } from './disclosure.js';
import { makeMailSyncHandlers } from './handlers.js';
import { MAIL_SYNC_KIND } from './sync.js';

/** platform:gmail counsel-reviewed AND vendor-ready (Google's verification), as the operator would record it. */
export async function clearGmailPack(h: ApiHarness, cleared = true): Promise<void> {
  await h.su.query(
    `UPDATE jurisdiction_packs SET reviewed_by_counsel_at = CASE WHEN $1::boolean THEN now() ELSE NULL END,
            rules = CASE WHEN $1::boolean THEN rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' ELSE rules - 'vendor_ready_at' END
      WHERE key = 'platform:gmail' AND status = 'published'`,
    [cleared],
  );
}

/** The Owner turns Gmail sync on (through the API, with a fresh re-auth). */
export async function enableMailSync(h: ApiHarness, owner: TestClient, backfillDays = 30): Promise<void> {
  await freshReauth(h, owner);
  const r = await call(owner, 'PUT', '/admin/mail-sync', { enabled: true, backfillDays });
  if (r.status !== 200) throw new Error(`enable mail sync: ${r.status} ${r.code}`);
}

export interface CallbackResult {
  status: number;
  result: string | null;
  location: string;
}

export async function mailCallback(h: ApiHarness, q: Record<string, string>): Promise<CallbackResult> {
  const r = await h.app.inject({ method: 'GET', url: `/api/me/mail-link/callback?${new URLSearchParams(q).toString()}` });
  const loc = String(r.headers.location ?? '');
  return { status: r.statusCode, result: loc ? new URL(loc).searchParams.get('result') : null, location: loc };
}

export interface StartedMailFlow {
  status: number;
  code: string | null;
  state: string;
  challenge: string;
  authorizeUrl: string;
}

export async function startMailConnect(c: TestClient, disclosureSha256 = CURRENT_DISCLOSURE_SHA256): Promise<StartedMailFlow> {
  const r = await call<{ authorizeUrl: string }>(c, 'POST', '/me/mail-link/connect', { disclosureSha256 });
  if (r.status !== 201) return { status: r.status, code: r.code, state: '', challenge: '', authorizeUrl: '' };
  const u = new URL(r.body.authorizeUrl);
  return { status: r.status, code: null, state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')!, authorizeUrl: r.body.authorizeUrl };
}

/** The whole connect: start, the person approves at (fake) Google, Google redirects back. */
export async function connectGmail(h: ApiHarness, c: TestClient, mailbox: string, o: { scopes?: string[] } = {}): Promise<CallbackResult & { flow: StartedMailFlow }> {
  const flow = await startMailConnect(c);
  if (flow.status !== 201) throw new Error(`connect start: ${flow.status} ${flow.code}`);
  const code = h.providers.gmail.issueCode({ codeChallenge: flow.challenge, mailbox, ...(o.scopes ? { scopes: o.scopes } : {}) });
  const cb = await mailCallback(h, { state: flow.state, code });
  return { ...cb, flow };
}

/** Confirms the given email addresses (contact points) for sync, as the mailbox owner (POST /me/mail-sync-points). */
export async function confirmAddresses(c: TestClient, pointIds: string[]): Promise<number> {
  const r = await call<{ confirmed: number }>(c, 'POST', '/me/mail-sync-points', { pointIds });
  if (r.status !== 200) throw new Error(`confirm: ${r.status} ${r.code}`);
  return r.body.confirmed;
}

/** Makes every live link due and runs one mail.sync pass for the tenant (plus comms jobs it may have queued). */
export async function runMailSync(h: ApiHarness, tenantId: string, o: { due?: boolean; now?: () => number } = {}): Promise<void> {
  if (o.due !== false) await asSystem(h, tenantId, (tx) => sql`UPDATE user_mail_links SET next_sync_at = now() - interval '1 second' WHERE tenant_id = app.tenant_id() AND status <> 'revoked'`.execute(tx));
  await withTenantTx(systemActor(tenantId, 'worker'), (tx) => enqueueJob(tx, { queue: 'default', kind: MAIL_SYNC_KIND, payload: {}, dedupeKey: `mail-test:${randomUUID()}` }), { db: h.database });
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeMailSyncHandlers(() => ({ envelope: deps.envelope, ids: deps.ids, ...(o.now ? { now: o.now } : {}) })), ...makeCommsHandlers(() => deps)]);
  await createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `mail-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger }).drain(10);
}

export async function copiesOf(h: ApiHarness, where: { contactId?: string; linkId?: string }): Promise<{ id: string; contact_id: string; gmail_message_id: string; gmail_thread_id: string; sender: string; contact_role: string; other_recipient_count: number; body: string; origin: string; subject: string | null }[]> {
  return (
    await h.su.query(
      `SELECT id, contact_id, gmail_message_id, gmail_thread_id, sender, contact_role, other_recipient_count, body, origin, subject FROM mail_messages
        WHERE ($1::uuid IS NULL OR contact_id = $1) AND ($2::uuid IS NULL OR link_id = $2) ORDER BY internal_at, id`,
      [where.contactId ?? null, where.linkId ?? null],
    )
  ).rows;
}

export async function linkOf(h: ApiHarness, userId: string): Promise<{ id: string; status: string; refresh_enc: Buffer | null; revoke_reason: string | null; history_id: string | null; next_sync_at: Date | null; backfill_done_at: Date | null } | undefined> {
  return (await h.su.query('SELECT id, status, refresh_enc, revoke_reason, history_id, next_sync_at, backfill_done_at FROM user_mail_links WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId])).rows[0];
}
