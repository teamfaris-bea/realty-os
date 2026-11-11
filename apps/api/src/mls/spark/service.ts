// Spark MLS (read-only) connection: save the key, validate it, open the feed (docs/SECURITY.md and
// docs/DEPLOY.md "Spark MLS (read-only)"; R-INT-1..5).
//
//   sparkView            Owner/Admin: deployment settings and the connection in words. Never the token.
//   saveSparkCredential  Owner/Admin 🔒 (route: re-auth, CSRF, DB rate limit). The token is encrypted into
//                        provider_credentials (provider 'mls', AAD bound to the row) and linked to the tenant's
//                        mls_feed connection by the SYSTEM actor (R-INT-3), after re-checking the person's role.
//                        A replaced key is purged in the same transaction; the connection returns to
//                        not_configured until validated.
//   validateSpark        Owner/Admin 🔒: exactly one read-only probe (no retry). With MLS_LIVE_CALLS=false the
//                        result is live_calls_disabled and nothing is decrypted or requested. Result codes only
//                        are written to the connection row and audit_log, never a response body.
//   openSparkFeed        for module 24 (feed sync, worker): the token is decrypted only by the system actor
//                        (R-INT-4) and the feed exists only for a live connection.
//
// The token exists in plaintext only inside this process: in the request body, the encryption call and the
// Authorization header the adapter builds. It is never returned, logged, put in a URL or audited.
import type { Database, Tx } from '@realty/db';
import { withTenantTx } from '@realty/db';
import type { IdGenerator, TenantId, UserActor } from '@realty/core/foundation';
import { audit, redactDiff, redactSnapshot } from '../../audit.js';
import { ciphertextKeyVersion } from '../../crypto/primitives.js';
import type { EnvelopeService } from '../../crypto/envelope.js';
import type { Config } from '../../config.js';
import { AppError } from '../../errors.js';
import { SparkError, SparkResoMlsFeed, type SparkErrorCode } from '../../providers/integrations/spark.js';
import type { IntegrationAdapters } from '../../providers/integrations/types.js';
import { serviceOf, statusSentence } from '../../integrations/catalog.js';
import * as repo from '../../integrations/repos/connections.js';
import { type ConnectionRow, transitionConnection } from '../../integrations/status.js';
import { systemActor } from '../../worker/systemActor.js';

export type SparkAuthScheme = 'Bearer' | 'OAuth';
export type ValidationResult = 'connected' | 'invalid_credentials' | 'replication_endpoint_required' | 'not_licensed_or_role_insufficient' | 'rate_limited' | 'busy' | 'unreachable' | 'live_calls_disabled';
export const VALIDATION_RESULTS: readonly ValidationResult[] = ['connected', 'invalid_credentials', 'replication_endpoint_required', 'not_licensed_or_role_insufficient', 'rate_limited', 'busy', 'unreachable', 'live_calls_disabled'];

/** The Owner's plain-words reading of the last validation code (never Spark's own text). */
export const RESULT_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  REPLICATION_ENDPOINT_REQUIRED: "This key only works on Spark's replication endpoint. Set the replication address in the deployment settings.",
  BUSY: 'Spark was busy. Try again in a minute.',
  RATE_LIMITED: 'Spark asked us to slow down. Try again in a few minutes.',
  INVALID_CREDENTIALS: 'Spark did not accept this key. Check that it is the CRM key and save it again.',
  NOT_LICENSED_OR_ROLE_INSUFFICIENT: 'Spark refused this key for MLS listings. Check the key\'s licence and role with Spark.',
  LIVE_CALLS_DISABLED: 'Live MLS calls are turned off on this deployment, so the key was not tried.',
});

export interface SparkDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  mls: Config['mls'];
  adapters: Pick<IntegrationAdapters, 'mlsTransport'>;
  now: () => number;
}

export const LIVE_CALLS_OFF = 'Live MLS calls are turned off on this deployment.';
/** What a validated Spark key lets the platform do (written by the system only, R-INT-2). */
export const SPARK_CAPABILITIES = { read_listings: true, read_media: true } as const;

const credAad = (id: string) => ({ table: 'provider_credentials', column: 'secret_enc', rowId: id });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface SecretPayload {
  v: 1;
  accessToken: string;
  authScheme: SparkAuthScheme;
}

function toRow(r: repo.ConnectionDbRow): ConnectionRow {
  return {
    kind: r.kind,
    status: r.status,
    statusReason: r.status_reason,
    externalAccountId: r.external_account_id,
    credentialId: r.credential_id,
    capabilities: r.capabilities,
    connectedAt: iso(r.connected_at),
    disconnectedAt: iso(r.disconnected_at),
    lastErrorCode: r.last_error_code,
  };
}

// ---- view ------------------------------------------------------------------------------------------------

export interface SparkConnectionView {
  id: string;
  status: string;
  statusSentence: string;
  keyLabel: string | null;
  credentialSaved: boolean;
  lastResult: string | null;
  connectedAt: string | null;
}

export interface SparkView {
  provider: 'fake' | 'spark';
  liveCalls: boolean;
  sentence: string;
  authSchemeDefault: SparkAuthScheme;
  connection: SparkConnectionView | null;
}

export function deploymentSentence(mls: Config['mls']): string {
  if (mls.provider !== 'spark') return 'This deployment uses the demo MLS feed (test adapter); a Spark key cannot be saved here.';
  if (!mls.liveCalls) return `${LIVE_CALLS_OFF} An Owner or Admin can save the CRM's own Spark key; nothing is sent to Spark until live calls are turned on and the key is validated.`;
  return "Read-only Spark connection. Use the CRM's own Spark API key, never the website's key.";
}

function connectionSentence(r: repo.ConnectionDbRow, credentialSaved: boolean): string {
  if (r.status === 'not_configured') {
    if (!credentialSaved) return 'Not connected yet. No key is saved and nothing is read.';
    const last = r.last_error_code ? ` Last validation: ${RESULT_SENTENCE[r.last_error_code] ?? 'Spark could not be reached.'}` : '';
    return `A key is saved but not validated yet. Nothing is read until validation succeeds.${last}`;
  }
  const base = statusSentence(r.status, r.status_reason, serviceOf('mls_feed')!, { disconnectedAt: iso(r.disconnected_at) });
  const hint = r.last_error_code ? RESULT_SENTENCE[r.last_error_code] : undefined;
  return hint ? `${base} ${hint}` : base;
}

async function connectionView(tx: Tx, r: repo.ConnectionDbRow): Promise<SparkConnectionView> {
  const cred = r.credential_id ? await repo.credentialFacts(tx, r.credential_id) : null;
  const saved = cred !== null && cred.status === 'active';
  return {
    id: r.id,
    status: r.status,
    statusSentence: connectionSentence(r, saved),
    keyLabel: saved ? cred.key_label : null,
    credentialSaved: saved,
    lastResult: r.last_error_code,
    connectedAt: iso(r.connected_at),
  };
}

/** Runs in the caller's (Owner/Admin) transaction under RLS; reads nonsecret columns only. */
export async function sparkView(tx: Tx, mls: Config['mls']): Promise<SparkView> {
  const row = await repo.getSparkConnection(tx);
  return { provider: mls.provider, liveCalls: mls.liveCalls, sentence: deploymentSentence(mls), authSchemeDefault: mls.spark.authScheme, connection: row ? await connectionView(tx, row) : null };
}

// ---- save the key ----------------------------------------------------------------------------------------------

export interface SaveInput {
  accessToken: string;
  keyLabel: string;
  authScheme?: SparkAuthScheme | undefined;
}

async function requireManager(tx: Tx, userId: string): Promise<void> {
  const role = await repo.activeRole(tx, userId);
  if (role !== 'owner' && role !== 'admin') throw new AppError('NOT_FOUND');
}

export async function saveSparkCredential(deps: SparkDeps, actor: UserActor, input: SaveInput): Promise<SparkConnectionView> {
  if (deps.mls.provider !== 'spark') throw new AppError('MLS_PROVIDER_NOT_SPARK');
  const sys = systemActor(actor.tenantId, 'provider');
  return withTenantTx(
    sys,
    async (tx) => {
      await repo.sparkLock(tx);
      await requireManager(tx, actor.userId); // the session's role, re-read under the system actor
      let row = await repo.getSparkConnection(tx, { forUpdate: true });
      if (!row) {
        const id = deps.ids.next<'IntegrationConnectionId'>();
        await repo.insertConnection(tx, { id, kind: 'mls_feed', displayName: 'MLS (Spark, read-only)', leadSourceId: null });
        await audit(tx, sys, { action: 'integration.changed', entity: { type: 'integration_connection', id }, changes: redactSnapshot({ kind: 'mls_feed', status: 'not_configured', by_user_id: actor.userId }), reason: 'CREATED' });
        row = (await repo.getConnection(tx, id, { forUpdate: true }))!;
      }
      const before = toRow(row);
      const credentialId = deps.ids.next<'ProviderCredentialId'>();
      const externalAccountId = row.external_account_id ?? `spark:${row.id}`;
      const next = transitionConnection(before, { type: 'key_saved', externalAccountId, credentialId }); // throws for a status that cannot take a key
      const payload: SecretPayload = { v: 1, accessToken: input.accessToken, authScheme: input.authScheme ?? deps.mls.spark.authScheme };
      const enc = await deps.envelope.inTx(tx, sys.tenantId).encrypt(sys.tenantId, credAad(credentialId), new TextEncoder().encode(JSON.stringify(payload)));
      await repo.insertMlsCredential(tx, { id: credentialId, secretEnc: enc, keyVersion: ciphertextKeyVersion(enc), keyLabel: input.keyLabel, createdByUserId: actor.userId });
      await repo.linkKeyCredential(tx, row.id, { externalAccountId, credentialId, statusReason: next.statusReason!, connectedByUserId: actor.userId });
      if (row.credential_id) {
        // the replaced key is revoked and purged in this same transaction (status purged, secret_enc NULL)
        await repo.revokeCredential(tx, row.credential_id);
        await repo.purgeCredential(tx, row.credential_id);
      }
      await audit(tx, sys, {
        action: 'integration.credential_saved',
        entity: { type: 'integration_connection', id: row.id },
        changes: redactDiff(
          { status: before.status, credential_id: before.credentialId },
          { status: next.status, credential_id: credentialId, auth_scheme: payload.authScheme, by_user_id: actor.userId, replaced_credential_purged: row.credential_id !== null },
        ),
        reason: row.credential_id ? 'KEY_REPLACED' : 'KEY_SAVED',
      });
      return connectionView(tx, (await repo.getConnection(tx, row.id))!);
    },
    { db: deps.db, retries: 2 },
  );
}

// ---- validate ----------------------------------------------------------------------------------------------

/** Adapter error → validation result (and whether a live connection is revoked). */
export function resultOf(code: SparkErrorCode): { result: ValidationResult; revoke: boolean } {
  switch (code) {
    case 'LIVE_CALLS_DISABLED':
      return { result: 'live_calls_disabled', revoke: false };
    case 'INVALID_CREDENTIALS':
      return { result: 'invalid_credentials', revoke: true };
    case 'REPLICATION_ENDPOINT_REQUIRED':
      return { result: 'replication_endpoint_required', revoke: false };
    case 'NOT_LICENSED_OR_ROLE_INSUFFICIENT':
      return { result: 'not_licensed_or_role_insufficient', revoke: false };
    case 'RATE_LIMITED':
      return { result: 'rate_limited', revoke: false };
    case 'BUSY':
      return { result: 'busy', revoke: false };
    default:
      // 404, 5xx, network, timeout, a redirect, an unreadable body, a refused host/path: Spark was not usable
      return { result: 'unreachable', revoke: false };
  }
}

async function decryptToken(deps: SparkDeps, tx: Tx, tenantId: TenantId, credentialId: string): Promise<SecretPayload> {
  const c = await repo.loadCredential(tx, credentialId);
  if (!c || c.provider !== 'mls' || c.status !== 'active' || !c.secret_enc) throw new AppError('MLS_CREDENTIAL_MISSING');
  const pt = await deps.envelope.inTx(tx, tenantId).decrypt(tenantId, credAad(credentialId), new Uint8Array(c.secret_enc));
  const p = JSON.parse(new TextDecoder().decode(pt)) as SecretPayload;
  if (p.v !== 1 || typeof p.accessToken !== 'string') throw new AppError('MLS_CREDENTIAL_MISSING');
  return p;
}

function feedOf(deps: SparkDeps, p: SecretPayload): SparkResoMlsFeed {
  return new SparkResoMlsFeed({
    baseUrl: deps.mls.spark.baseUrl,
    allowedHosts: deps.mls.spark.allowedHosts,
    authScheme: p.authScheme,
    liveCalls: deps.mls.liveCalls,
    accessToken: p.accessToken,
    ...(deps.adapters.mlsTransport ? { fetch: deps.adapters.mlsTransport } : {}),
  });
}

export async function validateSpark(deps: SparkDeps, actor: UserActor): Promise<{ result: ValidationResult; connection: SparkConnectionView }> {
  if (deps.mls.provider !== 'spark') throw new AppError('MLS_PROVIDER_NOT_SPARK');
  const sys = systemActor(actor.tenantId, 'provider');
  // 1. read the connection (and decrypt the key only when a request may actually be made)
  const pre = await withTenantTx(
    sys,
    async (tx) => {
      await requireManager(tx, actor.userId);
      const row = await repo.getSparkConnection(tx);
      if (!row || !row.credential_id) throw new AppError('MLS_CREDENTIAL_MISSING');
      const secret = deps.mls.liveCalls ? await decryptToken(deps, tx, sys.tenantId, row.credential_id) : null;
      if (!secret) {
        const cred = await repo.credentialFacts(tx, row.credential_id);
        if (!cred || cred.status !== 'active') throw new AppError('MLS_CREDENTIAL_MISSING');
      }
      return { connectionId: row.id, credentialId: row.credential_id, secret };
    },
    { db: deps.db, retries: 2 },
  );

  // 2. the probe, outside any transaction: exactly one GET, no retry (none at all with live calls off)
  let code: SparkErrorCode | null = null;
  if (!pre.secret) code = 'LIVE_CALLS_DISABLED';
  else {
    try {
      await feedOf(deps, pre.secret).probe();
    } catch (e) {
      code = e instanceof SparkError ? e.code : 'UNREACHABLE';
    }
  }
  pre.secret = null;
  const outcome = code === null ? { result: 'connected' as const, revoke: false } : resultOf(code);

  // 3. record the result code (never a body) if the same key is still linked
  return withTenantTx(
    sys,
    async (tx) => {
      const row = await repo.getConnection(tx, pre.connectionId, { forUpdate: true });
      if (!row || row.credential_id !== pre.credentialId || row.status === 'disconnected') throw new AppError('CONNECTION_NOT_CONNECTABLE', { status: row?.status ?? 'missing' });
      const before = toRow(row);
      // a busy Spark (finding 7) says nothing about the key: the status does not move, only the code is recorded
      const next =
        code === null
          ? transitionConnection(before, { type: 'key_validated', capabilities: { ...SPARK_CAPABILITIES }, at: new Date(deps.now()).toISOString() })
          : code === 'BUSY'
            ? { ...before, lastErrorCode: code }
            : transitionConnection(before, { type: 'key_rejected', code, revoke: outcome.revoke });
      await repo.applyKeyValidation(tx, row.id, { status: next.status, statusReason: next.statusReason, capabilities: next.capabilities, lastErrorCode: next.lastErrorCode, connected: next.status === 'connected' });
      await audit(tx, sys, {
        action: 'integration.validated',
        entity: { type: 'integration_connection', id: row.id },
        changes: redactDiff({ status: before.status }, { status: next.status, result: outcome.result, by_user_id: actor.userId }),
        reason: code ?? 'CONNECTED',
      });
      return { result: outcome.result, connection: await connectionView(tx, (await repo.getConnection(tx, row.id))!) };
    },
    { db: deps.db, retries: 2 },
  );
}

// ---- the feed for module 24 (worker, system actor) --------------------------------------------------------------

/** The read-only feed of a live Spark connection, for a system-actor job (R-INT-4); null when not live. */
export async function openSparkFeed(deps: SparkDeps, tx: Tx, tenantId: TenantId): Promise<SparkResoMlsFeed | null> {
  if (deps.mls.provider !== 'spark') return null;
  const row = await repo.getSparkConnection(tx);
  if (!row || !row.credential_id || (row.status !== 'connected' && row.status !== 'degraded')) return null;
  return feedOf(deps, await decryptToken(deps, tx, tenantId, row.credential_id));
}
