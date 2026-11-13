// Run-time wiring of api/comms: deps from the HTTP platform or the worker, and the transaction helpers.
//
// Actors (R-TEN-3): tenant context comes from the session, a webhook resolver or a job row only.
// - system work (inbound webhooks, TX2, reconciliation, assistant/system sends) runs as the system
//   actor built by the worker's factory (worker/systemActor.ts);
// - a HUMAN message dispatched later by the worker (a scheduled text) runs its TX1 as that human: the
//   sender is read from the message row (a job row's referent), and the membership must still be
//   active. RLS then decides, at send time, whether the sender still sees the contact (E15), and the
//   touch is recorded as the sender's own ownership command (R-OWN-14).
import { createHmac } from 'node:crypto';
import type { Instant, Role, SystemVia, UserActor } from '@realty/core/foundation';
import { isRole } from '@realty/core/foundation';
import { type Tx, defaultIds, getDatabase, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { loadConfig } from '../config.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { localKek } from '../crypto/kek.js';
import type { Platform } from '../server.js';
import { systemActor } from '../worker/systemActor.js';
import type { CommsDeps } from './types.js';

/** R-ISA-25: which channels refuse AI ISA sends (AI_ISA_LIVE_SENDS off and a non-fake adapter). */
export function aiIsaLiveOff(c: { aiIsaLiveSends: boolean; providers: { telephony: string; email: string } }): { sms: boolean; email: boolean } {
  return { sms: !c.aiIsaLiveSends && c.providers.telephony !== 'fake', email: !c.aiIsaLiveSends && c.providers.email !== 'fake' };
}

export function depsFromPlatform(p: Platform): CommsDeps {
  return { db: p.db, providers: p.providers, envelope: p.envelope, ids: p.ids, publicBaseUrl: p.config.publicBaseUrl, linkSecret: p.config.sessionSecret, telephonyDailyCap: p.config.providers.telephony === 'twilio', aiIsaLiveOff: aiIsaLiveOff(p.config), errorReporter: p.errorReporter };
}

let runtime: Omit<CommsDeps, 'providers'> | null = null;

/** Worker-side deps (process configuration), built once. Tests pass explicit deps instead. */
export function commsRuntime(): Omit<CommsDeps, 'providers'> {
  if (runtime) return runtime;
  const cfg = loadConfig();
  runtime = { db: getDatabase(), envelope: new EnvelopeService(localKek(cfg.kek, cfg.kekRef)), ids: defaultIds(), publicBaseUrl: cfg.publicBaseUrl, linkSecret: cfg.sessionSecret, telephonyDailyCap: cfg.providers.telephony === 'twilio', aiIsaLiveOff: aiIsaLiveOff(cfg) };
  return runtime;
}

export function asSystem<T>(deps: Pick<CommsDeps, 'db'>, tenantId: string, via: SystemVia, fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  return withTenantTx(systemActor(tenantId, via), fn, { db: deps.db, retries: 2 });
}

export function asUser<T>(deps: Pick<CommsDeps, 'db'>, actor: UserActor, fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  return withTenantTx(actor, fn, { db: deps.db, retries: 2 });
}

/**
 * The human sender of a message, as a user actor for the send-time transaction (see the header), or
 * null when the membership is no longer active (then the send is blocked as the system).
 */
export async function senderActor(tx: Tx, tenantId: string, userId: string, ref: string): Promise<UserActor | null> {
  const r = await sql<{ role: string; status: string }>`
    SELECT role, status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  const m = r.rows[0];
  if (!m || m.status !== 'active' || !isRole(m.role)) return null;
  return { kind: 'user', userId: userId as UserActor['userId'], tenantId: tenantId as UserActor['tenantId'], role: m.role as Role, sessionId: `comms:${ref}` };
}

/** A purpose-bound HMAC of the link secret (stateless email links). */
export function linkMac(secret: Uint8Array, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('base64url').slice(0, 32);
}
