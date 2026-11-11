// Client-portal transactions (PHASE2_3_PLAN module 43; R-TEN-14, R-PORTAL-4, R-PORTAL-5, R-PORTAL-7).
//
//   const client = await resolvePortalSession(cookieToken);      // null unless a live session
//   if (client) await withPortalTx(client, async (tx, now) => { ... });
//
// - A ClientActor can be obtained ONLY from resolvePortalSession (or consumePortalLogin, which signs in and
//   resolves the new session): its brand is a module-private symbol, so no other code can construct one, and
//   lint (`realty/portal-tx-separation`) keeps withPortalTx out of staff code and withTenantTx out of portal
//   client code.
// - withPortalTx sets exactly app.tenant_id, app.principal_type = 'client' and app.portal_account_id, and
//   clears app.user_id, app.actor_kind and app.ownership_command, transaction-locally (set_config(..., true)):
//   a client transaction never carries a staff GUC, and the pooled connection reads '' afterwards.
// - Raw tokens never reach the database: every function here hashes them (SHA-256) first.
import { createHash, randomBytes } from 'node:crypto';
import type { Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate, parseId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { type Database, getDatabase } from './client.js';
import { ActorContextError, type Tx, isRetryable, withPreTenant } from './tenantTx.js';

declare const clientActorBrand: unique symbol;

/** A signed-in portal client. Built only by this module (resolvePortalSession / consumePortalLogin). */
export interface ClientActor {
  readonly kind: 'client';
  readonly tenantId: TenantId;
  readonly portalAccountId: string;
  readonly contactId: string;
  readonly sessionId: string;
  readonly [clientActorBrand]: true;
}

export interface PortalTxOptions {
  /** retry on serialization_failure / deadlock_detected; default 0 */
  retries?: number;
  db?: Database;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** A fresh 256-bit URL-safe token (magic link, session cookie, stream token). */
export function newPortalToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 of a normalized address (lower-case email or E.164 phone, as core normalizes it). */
export function portalAddressHash(normalizedAddress: string): Buffer {
  return sha256(normalizedAddress);
}

function brand(row: { tenant_id: string; portal_account_id: string; contact_id: string; session_id: string }): ClientActor {
  const tenantId = parseId(row.tenant_id);
  const accountId = parseId(row.portal_account_id);
  const contactId = parseId(row.contact_id);
  const sessionId = parseId(row.session_id);
  if (!tenantId || !accountId || !contactId || !sessionId) throw new ActorContextError('portal session row is malformed');
  // the one place a ClientActor is constructed (the brand makes every other construction a type error)
  return Object.freeze({ kind: 'client', tenantId: tenantId as TenantId, portalAccountId: accountId, contactId, sessionId }) as unknown as ClientActor;
}

export interface PortalLoginLink {
  tenantId: TenantId;
  portalAccountId: string;
  contactId: string;
  loginPointId: string;
  loginKind: 'email' | 'phone';
  /** the raw magic-link token: put it in the link sent through dispatchOutbound, never log it */
  token: string;
}

export class PortalNotClearedError extends Error {
  override readonly name = 'PortalNotClearedError';
}

function rethrow(err: unknown): never {
  if (err instanceof Error && /PORTAL_NOT_CLEARED/.test(err.message)) throw new PortalNotClearedError(err.message);
  throw err;
}

/**
 * Magic-link request (R-PORTAL-5). Returns one link per invited/active account whose current login point has
 * this address (usually zero or one). The caller must answer the HTTP request the same way whatever this
 * returns, and send each link through dispatchOutbound. Throws PortalNotClearedError until platform:portal is
 * counsel-cleared.
 */
export async function requestPortalLogin(
  tenantSlug: string,
  normalizedAddress: string,
  opts: { db?: Database; maxAccounts?: number } = {},
): Promise<PortalLoginLink[]> {
  const tokens = Array.from({ length: Math.min(Math.max(opts.maxAccounts ?? 4, 1), 8) }, newPortalToken);
  const byHash = new Map(tokens.map((t) => [sha256(t).toString('hex'), t]));
  const rows = await withPreTenant(
    (tx) =>
      sql<{ tenant_id: string; portal_account_id: string; contact_id: string; login_point_id: string; login_kind: 'email' | 'phone'; token_hash: Buffer }>`
        SELECT * FROM portal.request_login(${tenantSlug}, ${portalAddressHash(normalizedAddress)}, ${tokens.map(sha256)}::bytea[])`.execute(tx),
    { db: opts.db },
  ).catch(rethrow);
  return rows.rows.map((r) => ({
    tenantId: r.tenant_id as TenantId,
    portalAccountId: r.portal_account_id,
    contactId: r.contact_id,
    loginPointId: r.login_point_id,
    loginKind: r.login_kind,
    token: byHash.get(r.token_hash.toString('hex'))!,
  }));
}

export interface PortalSignIn {
  client: ClientActor;
  /** the raw session token for the __Host-psid cookie */
  sessionToken: string;
  idleExpiresAt: Instant;
  absoluteExpiresAt: Instant;
}

/** Consumes a magic-link token once and opens a session. null when the token is unknown, used, expired or stale. */
export async function consumePortalLogin(
  linkToken: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
  opts: { db?: Database } = {},
): Promise<PortalSignIn | null> {
  const sessionToken = newPortalToken();
  const r = await withPreTenant(
    (tx) =>
      sql<{ session_id: string; tenant_id: string; portal_account_id: string; idle_expires_at: Date; absolute_expires_at: Date }>`
        SELECT * FROM portal.consume_login(${sha256(linkToken)}, ${sha256(sessionToken)}, ${meta.ip ?? null}::inet, ${meta.userAgent ?? null})`.execute(tx),
    { db: opts.db },
  ).catch(rethrow);
  if (r.rows.length === 0) return null;
  const client = await resolvePortalSession(sessionToken, opts);
  if (!client) return null;
  const row = r.rows[0]!;
  return { client, sessionToken, idleExpiresAt: instantFromDate(row.idle_expires_at), absoluteExpiresAt: instantFromDate(row.absolute_expires_at) };
}

/** The only way to obtain a ClientActor: a live session of an active account while platform:portal is cleared. */
export async function resolvePortalSession(sessionToken: string, opts: { db?: Database } = {}): Promise<ClientActor | null> {
  if (typeof sessionToken !== 'string' || sessionToken.length < 16 || sessionToken.length > 128) return null;
  const r = await withPreTenant(
    (tx) =>
      sql<{ session_id: string; tenant_id: string; portal_account_id: string; contact_id: string }>`
        SELECT session_id, tenant_id, portal_account_id, contact_id FROM portal.resolve_session(${sha256(sessionToken)})`.execute(tx),
    { db: opts.db },
  );
  const row = r.rows[0];
  return row ? brand(row) : null;
}

/** Signs out. Returns whether a live session was ended. */
export async function endPortalSession(sessionToken: string, reason: 'logout' | 'rotation' | 'suspicious' = 'logout', opts: { db?: Database } = {}): Promise<boolean> {
  const r = await withPreTenant((tx) => sql<{ ok: boolean }>`SELECT portal.end_session(${sha256(sessionToken)}, ${reason}) AS ok`.execute(tx), { db: opts.db });
  return r.rows[0]?.ok === true;
}

function clientGucs(actor: ClientActor): { tenantId: string; accountId: string } {
  if (actor?.kind !== 'client') throw new ActorContextError('withPortalTx needs a ClientActor from resolvePortalSession');
  const tenantId = parseId(actor.tenantId);
  const accountId = parseId(actor.portalAccountId);
  if (!tenantId || !accountId) throw new ActorContextError('client actor ids must be uuids');
  return { tenantId, accountId };
}

/**
 * One transaction as the client principal. Sets only app.tenant_id, app.principal_type = 'client' and
 * app.portal_account_id (transaction-local); every staff GUC is explicitly empty. RLS then admits only the three
 * portal tables, and only the client's own account, grants and items.
 */
export async function withPortalTx<T>(actor: ClientActor, fn: (tx: Tx, now: Instant) => Promise<T>, opts: PortalTxOptions = {}): Promise<T> {
  const g = clientGucs(actor);
  const db = opts.db ?? getDatabase();
  const retries = opts.retries ?? 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.kysely
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          const r = await sql<{ now: Date }>`
            SELECT set_config('app.tenant_id', ${g.tenantId}, true) AS t,
                   set_config('app.principal_type', 'client', true) AS p,
                   set_config('app.portal_account_id', ${g.accountId}, true) AS a,
                   set_config('app.user_id', '', true) AS u,
                   set_config('app.actor_kind', '', true) AS k,
                   set_config('app.ownership_command', '', true) AS c,
                   clock_timestamp() AS now`.execute(tx);
          return fn(tx, instantFromDate(r.rows[0]!.now));
        });
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20) * (attempt + 1)));
    }
  }
}

export interface PortalStreamToken {
  documentId: string;
  displayName: string;
  contentType: string;
  byteSize: number;
  /** raw 60-second single-use token for the download URL */
  token: string;
  expiresAt: Instant;
}

/** Inside withPortalTx: a 60 s single-use download token for a document item the client may open now, or null. */
export async function issuePortalDocumentStream(tx: Tx, itemId: string): Promise<PortalStreamToken | null> {
  if (!parseId(itemId)) return null;
  const token = newPortalToken();
  const r = await sql<{ document_id: string; display_name: string; content_type: string; byte_size: string; expires_at: Date }>`
    SELECT * FROM portal.issue_document_stream(${itemId}::uuid, ${sha256(token)})`.execute(tx);
  const row = r.rows[0];
  return row
    ? { documentId: row.document_id, displayName: row.display_name, contentType: row.content_type, byteSize: Number(row.byte_size), token, expiresAt: instantFromDate(row.expires_at) }
    : null;
}

export interface PortalDocumentObject {
  documentId: string;
  displayName: string;
  objectId: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: Buffer;
  dekWrapped: Buffer;
  keyVersion: number;
}

/** Inside withPortalTx: redeems a stream token once, re-checks the whole chain, audits; null when refused. */
export async function redeemPortalDocumentStream(tx: Tx, token: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<PortalDocumentObject | null> {
  const r = await sql<{
    document_id: string; display_name: string; object_id: string; storage_key: string; content_type: string; byte_size: string; sha256: Buffer; dek_wrapped: Buffer; key_version: number;
  }>`SELECT * FROM portal.document_object(${sha256(token)}, ${meta.ip ?? null}::inet, ${meta.userAgent ?? null})`.execute(tx);
  const row = r.rows[0];
  return row
    ? { documentId: row.document_id, displayName: row.display_name, objectId: row.object_id, storageKey: row.storage_key, contentType: row.content_type, byteSize: Number(row.byte_size), sha256: row.sha256, dekWrapped: row.dek_wrapped, keyVersion: row.key_version }
    : null;
}

export type PortalAuditEntity = 'portal_account' | 'portal_grant' | 'portal_item' | 'document';

/** Inside withPortalTx: records what the signed-in client did (the portal audit definer). */
export async function recordPortalAudit(tx: Tx, action: `portal.${string}`, entityType: PortalAuditEntity, entityId: string | null, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<void> {
  await sql`SELECT portal.record_audit(${action}, ${entityType}, ${entityId}::uuid, ${meta.ip ?? null}::inet, ${meta.userAgent ?? null})`.execute(tx);
}
