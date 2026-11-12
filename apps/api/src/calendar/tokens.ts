// Calendar tokens (module 34; R-INT-4, R-INT-5, R-CAL-2). The ONLY file that encrypts or decrypts a
// user_calendar_links token. Tokens are envelope-encrypted with the tenant field key (as provider_credentials
// and the Spark key are), bound by AAD to the row and column, decrypted only as the system actor, refreshed
// lazily (never on a timer), and never logged, audited or returned (architecture test in calendar.test.ts).
import type { TenantId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { ciphertextKeyVersion } from '../crypto/primitives.js';
import { ProviderError } from '../providers/types.js';
import type { CalendarAuth, IntegrationAdapters, OAuthToken } from '../providers/integrations/types.js';
import { CALENDAR_SERVICES, type CalendarProviderKey } from './catalog.js';
import * as repo from './repos/links.js';

/** What access_enc holds (the access token and its expiry); refresh_enc holds the refresh token alone. */
interface StoredAccess {
  accessToken: string;
  expiresAt: string | null;
}

const aad = (rowId: string, column: 'access_enc' | 'refresh_enc') => ({ table: 'user_calendar_links', column, rowId });
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Refresh when the access token has less than this left (or the provider refuses it once). */
export const REFRESH_MARGIN_MS = 60_000;

export interface SealedToken {
  accessEnc: Uint8Array;
  refreshEnc: Uint8Array | null;
  keyVersion: number;
}

export async function sealToken(envelope: EnvelopeService, tx: Tx, tenantId: TenantId, rowId: string, t: Pick<OAuthToken, 'accessToken' | 'refreshToken' | 'expiresAt'>): Promise<SealedToken> {
  const e = envelope.inTx(tx, tenantId);
  const accessEnc = await e.encrypt(tenantId, aad(rowId, 'access_enc'), enc.encode(JSON.stringify({ accessToken: t.accessToken, expiresAt: t.expiresAt } satisfies StoredAccess)));
  const refreshEnc = t.refreshToken ? await e.encrypt(tenantId, aad(rowId, 'refresh_enc'), enc.encode(t.refreshToken)) : null;
  return { accessEnc, refreshEnc, keyVersion: ciphertextKeyVersion(accessEnc) };
}

/** A grant the provider no longer accepts (E102): the caller revokes and purges the link. */
export class GrantRevokedError extends Error {
  override readonly name = 'GrantRevokedError';
}

export interface LiveAuth {
  auth: CalendarAuth;
  /** force a refresh now (the provider refused the access token): returns the new auth, or throws GrantRevokedError */
  refreshNow(): Promise<CalendarAuth>;
}

function isGrantRefusal(e: unknown): boolean {
  return e instanceof ProviderError && e.kind === 'rejected';
}

/**
 * Decrypts a live link's token as the system actor and refreshes it lazily (expiring within the margin). A
 * refreshed token is stored (encrypted) in the same transaction. Throws GrantRevokedError when the provider
 * refuses the refresh (the person removed the app, E102) or no refresh token exists for an expired token.
 */
export async function liveAuth(deps: { envelope: EnvelopeService; adapters: IntegrationAdapters; now: () => number }, tx: Tx, tenantId: TenantId, link: repo.LinkRow): Promise<LiveAuth> {
  const actorKind = (await sql<{ k: string | null }>`SELECT app.actor_kind() AS k`.execute(tx)).rows[0]?.k;
  if (actorKind !== 'system') throw new Error('calendar tokens are decrypted by the system actor only (R-INT-4)');
  const secrets = await repo.loadSecrets(tx, link.id);
  if (!secrets?.access_enc) throw new GrantRevokedError('no token');
  const e = deps.envelope.inTx(tx, tenantId);
  const stored = JSON.parse(dec.decode(await e.decrypt(tenantId, aad(link.id, 'access_enc'), new Uint8Array(secrets.access_enc)))) as StoredAccess;
  const refreshToken = secrets.refresh_enc ? dec.decode(await e.decrypt(tenantId, aad(link.id, 'refresh_enc'), new Uint8Array(secrets.refresh_enc))) : null;
  const svc = CALENDAR_SERVICES[link.provider as CalendarProviderKey];
  const authOf = (accessToken: string): CalendarAuth => ({ provider: svc.calendar, accessToken, calendarRef: link.external_calendar_ref ?? svc.calendarRef });

  const refresh = async (): Promise<CalendarAuth> => {
    if (!refreshToken) throw new GrantRevokedError('no refresh token');
    let t: OAuthToken;
    try {
      t = await deps.adapters.oauth[svc.oauth].refresh(refreshToken);
    } catch (err) {
      if (isGrantRefusal(err)) throw new GrantRevokedError('refresh refused');
      throw err;
    }
    const sealed = await sealToken(deps.envelope, tx, tenantId, link.id, { accessToken: t.accessToken, refreshToken: t.refreshToken && t.refreshToken !== refreshToken ? t.refreshToken : null, expiresAt: t.expiresAt });
    await repo.storeRefreshed(tx, link.id, sealed);
    return authOf(t.accessToken);
  };

  const expiring = stored.expiresAt !== null && Date.parse(stored.expiresAt) - deps.now() < REFRESH_MARGIN_MS;
  const auth = expiring ? await refresh() : authOf(stored.accessToken);
  return { auth, refreshNow: refresh };
}

/**
 * Runs one provider call with the lazy-refresh rule: the call once, and on an authentication refusal one
 * refresh and one retry. A second refusal means the grant is gone (GrantRevokedError).
 */
export async function withAuth<T>(live: LiveAuth, call: (a: CalendarAuth) => Promise<T>): Promise<T> {
  try {
    return await call(live.auth);
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === 'rejected' && e.providerCode === 'UNAUTHENTICATED')) throw e;
  }
  const fresh = await live.refreshNow();
  try {
    return await call(fresh);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'rejected' && e.providerCode === 'UNAUTHENTICATED') throw new GrantRevokedError('refused after refresh');
    throw e;
  }
}

/** Decrypts the token of a link that is being disconnected, so the grant can be revoked at the provider. */
export async function tokenForRevoke(envelope: EnvelopeService, tx: Tx, tenantId: TenantId, linkId: string): Promise<OAuthToken | null> {
  const secrets = await repo.loadSecrets(tx, linkId);
  if (!secrets?.access_enc) return null;
  const e = envelope.inTx(tx, tenantId);
  const stored = JSON.parse(dec.decode(await e.decrypt(tenantId, aad(linkId, 'access_enc'), new Uint8Array(secrets.access_enc)))) as StoredAccess;
  const refreshToken = secrets.refresh_enc ? dec.decode(await e.decrypt(tenantId, aad(linkId, 'refresh_enc'), new Uint8Array(secrets.refresh_enc))) : null;
  return { accessToken: stored.accessToken, refreshToken, expiresAt: stored.expiresAt, scopes: [] };
}
