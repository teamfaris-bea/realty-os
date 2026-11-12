// Shared runtime of api/ads (module 52): the dependencies, the system transaction of one tenant, the account token
// (decrypted in a short system transaction, R-INT-4) and the bounded provider wait.
import { type IdGenerator, type Instant, type TenantId, instant } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
import { ProviderError } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import type { AdsAccount, AdsProvider } from './provider.js';
import * as repo from './repo.js';

export interface AdsDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  ads: AdsProvider;
  /** the pass clock (month boundaries, staleness, "not checked"); production: the job's DB clock. Tests inject the fake's. */
  now?: () => Instant;
  /** tests: how long one budget or pause call is waited for (default APPLY_TIMEOUT_MS) */
  applyTimeoutMs?: number;
}

export const clockOf = (d: Pick<AdsDeps, 'now'>): Instant => (d.now ? d.now() : instant(Date.now()));

/** One transaction as the system actor of `tenantId` (System transactions outside the worker: via 'provider', publish.ts:59). */
export function asSystem<T>(d: Pick<AdsDeps, 'db'>, tenantId: string, fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  return withTenantTx(systemActor(tenantId, 'provider'), fn, { db: d.db, retries: 2 });
}

const credAad = (id: string) => ({ table: 'provider_credentials', column: 'secret_enc', rowId: id });

/** The account a call names: the external id and the decrypted access token (never logged, never stored elsewhere). */
export async function accountIn(tx: Tx, d: Pick<AdsDeps, 'envelope'>, tenantId: string, c: { externalAccountId: string | null; credentialId: string | null }): Promise<AdsAccount | null> {
  if (!c.externalAccountId || !c.credentialId) return null;
  const enc = await repo.credentialCipher(tx, c.credentialId);
  if (!enc) return null;
  const pt = await d.envelope.inTx(tx, tenantId as TenantId).decrypt(tenantId as TenantId, credAad(c.credentialId), new Uint8Array(enc));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { accessToken?: unknown };
  return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 ? { externalAccountId: c.externalAccountId, accessToken: parsed.accessToken } : null;
}

export function account(d: Pick<AdsDeps, 'db' | 'envelope'>, tenantId: string, c: { externalAccountId: string | null; credentialId: string | null }): Promise<AdsAccount | null> {
  return asSystem(d, tenantId, (tx) => accountIn(tx, d, tenantId, c));
}

/** The provider's answer, or ProviderError('timeout') after `ms` (the call itself is not waited for any longer). */
export async function withinBound<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ProviderError('timeout', 'ADS_CALL_TIMEOUT')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** An UPPER_SNAKE code for the ledger and the connection (provider codes are untrusted text). */
export function safeCode(c: string | undefined, fallback: string): string {
  return c && /^[A-Z][A-Z0-9_]{0,59}$/.test(c) ? c : fallback;
}
