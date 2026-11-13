// api/integrations service (PHASE2_3_PLAN §5.4 #21; R-INT-1..5, R-TEN-11, E134-E136, E160).
//
//   listIntegrations   every service with an honest sentence, its connections, the capabilities the
//                      adapter reported (and whether each is usable now), and every platform pack's state
//   startConnect       Owner/Admin 🔒: creates or reuses an unconfigured row, signs the OAuth state (PKCE)
//   oauthCallback      the provider redirect. Runs as the SYSTEM actor of the tenant named by the verified
//                      state (a resolver result, never request input). It is the ONLY writer of
//                      external_account_id, credential_id, live statuses and capabilities (the 0018 guard
//                      refuses anyone else): it first proves that the token manages the requested account
//                      (E160), and the global live-account index keeps an account live in one tenant (E135)
//   disconnect         Owner/Admin 🔒: status `disconnected` and the credential revoked in the SAME
//                      transaction (R-INT-5); the grant is revoked at the provider best effort by a job,
//                      which then purges the secret (the retention sweep purges it within 30 days anyway)
//
// Owner decision D2: Meta connects only the publishing kinds `facebook_page` / `instagram_business`, which
// never take a lead source (0025 CHECK; refused here first, on connect and on rename). The out-of-scope kinds
// (`messenger_page`, `instagram_account`, `meta_lead_ads`, `ads_meta`) cannot start a connect
// (INTEGRATION_NOT_CONNECTABLE) or finish one (STATE_INVALID, before any provider call); existing rows of
// those kinds stay listed and can still be disconnected.
import type { IdGenerator, Instant, UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { randomBytes } from 'node:crypto';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { ciphertextKeyVersion } from '../crypto/primitives.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import type { ConnectionKind, IntegrationAdapters, OAuthProviderName, OAuthToken } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { enqueueTyped } from '../worker/registry.js';
import { type CapabilityView, type MlsDeployment, PER_USER_SERVICES, PUBLISHING_KINDS, SERVICES, capabilityViews, packSentence, serviceOf, serviceSentence, statusSentence, type PlatformPack } from './catalog.js';
import { type OAuthState, STATE_TTL_MS, pkceChallengeOf, pkceVerifier, signState, verifyState } from './oauthState.js';
import * as repo from './repos/connections.js';
import { CONNECTABLE_STATUSES, type ConnectionRow, ConnectionTransitionError, transitionConnection } from './status.js';
import { REVOKE_GRANT_JOB } from './jobs.js';

export interface IntegrationDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  adapters: IntegrationAdapters;
  /** server secret for the OAuth state MAC and the PKCE derivation */
  secret: Uint8Array;
  publicBaseUrl: string;
  /** where the browser lands after the callback */
  webOrigin: string;
  now: () => number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const credAad = (id: string) => ({ table: 'provider_credentials', column: 'secret_enc', rowId: id });

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

// ---- list ---------------------------------------------------------------------------------------------

export interface ConnectionView {
  id: string;
  kind: ConnectionKind;
  displayName: string;
  status: string;
  statusSentence: string;
  externalAccountId: string | null;
  leadSourceId: string | null;
  capabilities: CapabilityView[];
  lastErrorCode: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
}

export interface IntegrationsView {
  adapterMode: 'fake' | 'unconfigured' | 'real';
  services: { kind: ConnectionKind; name: string; connect: string; canConnect: boolean; sentence: string; connections: ConnectionView[] }[];
  platformPacks: { key: string; version: string; reviewed: boolean; sentence: string }[];
  perUser: { key: string; name: string; sentence: string }[];
}

/** The published platform packs as the catalog reads them (the list and every connection view use this). */
export async function loadPlatformPacks(tx: Tx): Promise<PlatformPack[]> {
  return (await repo.listPlatformPacks(tx)).map((p) => ({ key: p.key, version: p.version, reviewedByCounselAt: iso(p.reviewed_by_counsel_at), vendorReadyAt: p.vendor_ready_at }));
}

export function connectionView(r: repo.ConnectionDbRow, packs: readonly PlatformPack[]): ConnectionView {
  const s = serviceOf(r.kind)!;
  return {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    status: r.status,
    statusSentence: statusSentence(r.status, r.status_reason, s, { disconnectedAt: iso(r.disconnected_at) }),
    externalAccountId: r.external_account_id,
    leadSourceId: r.lead_source_id,
    capabilities: capabilityViews(r.kind, r.status, r.capabilities, packs),
    lastErrorCode: r.last_error_code,
    connectedAt: iso(r.connected_at),
    disconnectedAt: iso(r.disconnected_at),
  };
}

export async function listIntegrations(tx: Tx, adapters: IntegrationAdapters, mls?: MlsDeployment): Promise<IntegrationsView> {
  const packs = await loadPlatformPacks(tx);
  const rows = await repo.listConnections(tx);
  return {
    adapterMode: adapters.mode,
    services: SERVICES.map((s) => ({
      kind: s.kind,
      name: s.name,
      connect: s.connect,
      canConnect: s.connect === 'oauth' && adapters.oauth[s.oauthProvider!].configured,
      sentence: serviceSentence(s, adapters, mls),
      connections: rows.filter((r) => r.kind === s.kind).map((r) => connectionView(r, packs)),
    })),
    platformPacks: packs.map((p) => ({ key: p.key, version: p.version, reviewed: p.reviewedByCounselAt !== null, sentence: packSentence(p, packs) })),
    perUser: PER_USER_SERVICES.map((x) => ({ ...x })),
  };
}

// ---- connect (OAuth start) -------------------------------------------------------------------------------

export function redirectUri(publicBaseUrl: string, kind: ConnectionKind): string {
  return new URL(`/api/admin/integrations/${kind}/callback`, publicBaseUrl).toString();
}

export interface StartConnectInput {
  kind: string;
  connectionId?: string | undefined;
  displayName?: string | undefined;
  externalAccountId: string;
  leadSourceId?: string | undefined;
}

export async function startConnect(deps: IntegrationDeps, tx: Tx, actor: UserActor, input: StartConnectInput): Promise<{ connectionId: string; authorizeUrl: string; expiresAt: string }> {
  const s = serviceOf(input.kind);
  if (!s || s.connect !== 'oauth') throw new AppError('INTEGRATION_NOT_CONNECTABLE', { kind: input.kind });
  const connector = deps.adapters.oauth[s.oauthProvider!];
  if (!connector.configured) throw new AppError('INTEGRATION_NOT_CONFIGURED', { kind: s.kind });
  if (input.leadSourceId !== undefined && PUBLISHING_KINDS.includes(s.kind)) throw new AppError('LEAD_SOURCE_NOT_ALLOWED', { kind: s.kind });
  if (input.leadSourceId && !(await repo.leadSourceExists(tx, input.leadSourceId))) throw new AppError('NOT_FOUND');

  let row: repo.ConnectionDbRow | null;
  let connectionId: string;
  if (input.connectionId) {
    connectionId = input.connectionId;
    row = await repo.getConnection(tx, input.connectionId, { forUpdate: true });
    if (!row || row.kind !== s.kind) throw new AppError('NOT_FOUND');
    if (!CONNECTABLE_STATUSES.includes(row.status)) throw new AppError('CONNECTION_NOT_CONNECTABLE', { status: row.status });
    if (row.external_account_id !== null && row.external_account_id !== input.externalAccountId) throw new AppError('CONNECTION_ACCOUNT_MISMATCH');
    if (input.displayName !== undefined || input.leadSourceId !== undefined) {
      await repo.updateLabels(tx, row.id, { ...(input.displayName !== undefined ? { displayName: input.displayName } : {}), ...(input.leadSourceId !== undefined ? { leadSourceId: input.leadSourceId } : {}) });
    }
  } else {
    const id = deps.ids.next<'IntegrationConnectionId'>();
    connectionId = id;
    await repo.insertConnection(tx, { id, kind: s.kind, displayName: input.displayName ?? s.name, leadSourceId: input.leadSourceId ?? null });
    await audit(tx, actor, { action: 'integration.changed', entity: { type: 'integration_connection', id }, changes: redactSnapshot({ kind: s.kind, status: 'not_configured' }), reason: 'CREATED' });
  }
  row = await repo.getConnection(tx, connectionId, { forUpdate: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (s.needsLeadSource && !row.lead_source_id) throw new AppError('LEAD_SOURCE_REQUIRED');

  const expiresAt = deps.now() + STATE_TTL_MS;
  const state: OAuthState = {
    tenantId: actor.tenantId,
    connectionId: row.id,
    userId: actor.userId,
    kind: s.kind,
    externalAccountId: input.externalAccountId,
    fence: row.fence,
    expiresAt,
    nonce: randomBytes(16).toString('base64url'),
  };
  const token = signState(deps.secret, state);
  const authorizeUrl = connector.authorizeUrl({ kind: s.kind, state: token, codeChallenge: pkceChallengeOf(pkceVerifier(deps.secret, state)), redirectUri: redirectUri(deps.publicBaseUrl, s.kind), scopes: s.scopes ?? [] });
  await audit(tx, actor, { action: 'integration.connect_started', entity: { type: 'integration_connection', id: row.id }, changes: redactSnapshot({ kind: s.kind, external_account_id: input.externalAccountId }) });
  return { connectionId: row.id, authorizeUrl, expiresAt: new Date(expiresAt).toISOString() };
}

// ---- callback (system actor; the only writer of routing keys) ----------------------------------------------

export type CallbackOutcome =
  | 'CONNECTED'
  | 'PENDING_REVIEW'
  | 'CANCELLED'
  | 'STATE_INVALID'
  | 'STATE_EXPIRED'
  | 'STATE_STALE'
  | 'NOT_CONNECTABLE'
  | 'STARTER_NOT_AUTHORIZED'
  | 'PROVIDER_REFUSED'
  | 'ACCOUNT_NOT_MANAGED'
  | 'ACCOUNT_LIVE_ELSEWHERE';

export interface CallbackResult {
  outcome: CallbackOutcome;
  connectionId: string | null;
  location: string;
}

function landing(deps: IntegrationDeps, outcome: CallbackOutcome, connectionId: string | null): CallbackResult {
  const u = new URL('/admin/integrations', deps.webOrigin);
  u.searchParams.set('result', outcome);
  if (connectionId) u.searchParams.set('connection', connectionId);
  return { outcome, connectionId, location: u.toString() };
}

type Precheck = { ok: true; row: repo.ConnectionDbRow } | { ok: false; outcome: CallbackOutcome };

async function precheck(tx: Tx, st: OAuthState, forUpdate: boolean): Promise<Precheck> {
  const row = await repo.getConnection(tx, st.connectionId, { forUpdate });
  if (!row || row.kind !== st.kind) return { ok: false, outcome: 'STATE_INVALID' };
  if (row.fence !== st.fence) return { ok: false, outcome: 'STATE_STALE' };
  if (!CONNECTABLE_STATUSES.includes(row.status)) return { ok: false, outcome: 'NOT_CONNECTABLE' };
  if (row.external_account_id !== null && row.external_account_id !== st.externalAccountId) return { ok: false, outcome: 'NOT_CONNECTABLE' };
  const role = await repo.activeRole(tx, st.userId);
  if (role !== 'owner' && role !== 'admin') return { ok: false, outcome: 'STARTER_NOT_AUTHORIZED' };
  return { ok: true, row };
}

async function refuse(deps: IntegrationDeps, st: OAuthState, outcome: CallbackOutcome): Promise<void> {
  const actor = systemActor(st.tenantId, 'provider');
  await withTenantTx(
    actor,
    async (tx) => {
      const row = await repo.getConnection(tx, st.connectionId, { forUpdate: true });
      if (!row || row.fence !== st.fence) return; // another callback already used this state
      transitionConnection(toRow(row), { type: 'proof_failed', code: outcome });
      await repo.recordProofFailure(tx, row.id, outcome);
      await audit(tx, actor, { action: 'integration.connect_refused', entity: { type: 'integration_connection', id: row.id }, changes: redactSnapshot({ external_account_id: st.externalAccountId }), reason: outcome });
    },
    { db: deps.db, retries: 2 },
  );
}

async function revokeQuietly(deps: IntegrationDeps, provider: OAuthProviderName, token: OAuthToken): Promise<void> {
  try {
    await deps.adapters.oauth[provider].revoke(token);
  } catch {
    // best effort: the token was never stored
  }
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const pe = (e && typeof e === 'object' ? e : {}) as { code?: string; constraint?: string };
  return pe.code === '23505' && pe.constraint === constraint;
}

export async function oauthCallback(deps: IntegrationDeps, kindParam: string, q: { state?: string | undefined; code?: string | undefined; error?: string | undefined }): Promise<CallbackResult> {
  const v = verifyState(deps.secret, q.state ?? '', deps.now());
  if (!v.ok) return landing(deps, v.code, null);
  const st = v.state;
  if (st.kind !== kindParam) return landing(deps, 'STATE_INVALID', null);
  const s = serviceOf(st.kind);
  // a state for a kind that is not connected by OAuth (D2: the out-of-scope kinds too) stops here, before any
  // database write or provider exchange
  if (!s || s.connect !== 'oauth') return landing(deps, 'STATE_INVALID', null);
  const provider = s.oauthProvider!;
  // tenant connections are Meta (publishing) or Google (Business Profile); Microsoft is per-user calendar only
  if (provider !== 'meta' && provider !== 'google') return landing(deps, 'STATE_INVALID', null);
  const actor = systemActor(st.tenantId, 'provider');

  const pre = await withTenantTx(actor, (tx) => precheck(tx, st, false), { db: deps.db, retries: 2 });
  if (!pre.ok) return landing(deps, pre.outcome, st.connectionId);
  if (q.error !== undefined || !q.code) {
    await refuse(deps, st, 'CANCELLED');
    return landing(deps, 'CANCELLED', st.connectionId);
  }

  // Outside any transaction: the provider exchange and the proof of control (E160).
  let token: OAuthToken;
  let accounts;
  try {
    token = await deps.adapters.oauth[provider].exchangeCode({ code: q.code, codeVerifier: pkceVerifier(deps.secret, st), redirectUri: redirectUri(deps.publicBaseUrl, st.kind) });
  } catch {
    await refuse(deps, st, 'PROVIDER_REFUSED');
    return landing(deps, 'PROVIDER_REFUSED', st.connectionId);
  }
  try {
    accounts = await deps.adapters.oauth[provider].listManagedAccounts(token, st.kind);
  } catch {
    await revokeQuietly(deps, provider, token);
    await refuse(deps, st, 'PROVIDER_REFUSED');
    return landing(deps, 'PROVIDER_REFUSED', st.connectionId);
  }
  const managed = accounts.find((a) => a.externalAccountId === st.externalAccountId);
  if (!managed) {
    await revokeQuietly(deps, provider, token);
    await refuse(deps, st, 'ACCOUNT_NOT_MANAGED');
    return landing(deps, 'ACCOUNT_NOT_MANAGED', st.connectionId);
  }

  let outcome: CallbackOutcome;
  try {
    outcome = await withTenantTx(
      actor,
      async (tx) => {
        const again = await precheck(tx, st, true);
        if (!again.ok) return again.outcome;
        const credentialId = deps.ids.next<'ProviderCredentialId'>();
        const enc = await deps.envelope.inTx(tx, actor.tenantId).encrypt(actor.tenantId, credAad(credentialId), new TextEncoder().encode(JSON.stringify(token)));
        await repo.insertCredential(tx, { id: credentialId, provider, secretEnc: enc, keyVersion: ciphertextKeyVersion(enc), externalAccountRef: managed.externalAccountId, createdByUserId: st.userId });
        const before = toRow(again.row);
        const next = transitionConnection(before, { type: 'oauth_proved', externalAccountId: managed.externalAccountId, credentialId, capabilities: managed.capabilities, reviewPending: managed.reviewPending, at: new Date(deps.now()).toISOString() });
        await repo.applyProof(tx, again.row.id, {
          status: next.status,
          statusReason: next.statusReason,
          externalAccountId: managed.externalAccountId,
          credentialId,
          capabilities: next.capabilities,
          connectedByUserId: st.userId,
          connected: next.status === 'connected',
        });
        await audit(tx, actor, {
          action: 'integration.connected',
          entity: { type: 'integration_connection', id: again.row.id },
          changes: redactDiff({ status: before.status, external_account_id: before.externalAccountId }, { status: next.status, external_account_id: managed.externalAccountId, started_by_user_id: st.userId }),
          reason: 'PROVIDER_CALLBACK_PROVED_CONTROL',
        });
        return next.status === 'connected' ? 'CONNECTED' : 'PENDING_REVIEW';
      },
      { db: deps.db, retries: 2 },
    );
  } catch (e) {
    if (isUniqueViolation(e, 'integration_connections_live_account')) {
      await revokeQuietly(deps, provider, token);
      await refuse(deps, st, 'ACCOUNT_LIVE_ELSEWHERE');
      return landing(deps, 'ACCOUNT_LIVE_ELSEWHERE', st.connectionId);
    }
    if (e instanceof ConnectionTransitionError) {
      await revokeQuietly(deps, provider, token);
      return landing(deps, 'NOT_CONNECTABLE', st.connectionId);
    }
    throw e;
  }
  if (outcome !== 'CONNECTED' && outcome !== 'PENDING_REVIEW') await revokeQuietly(deps, provider, token);
  return landing(deps, outcome, st.connectionId);
}

// ---- rename / lead source ---------------------------------------------------------------------------------

export async function updateConnection(tx: Tx, actor: UserActor, id: string, p: { displayName?: string | undefined; leadSourceId?: string | null | undefined }): Promise<repo.ConnectionDbRow> {
  const row = await repo.getConnection(tx, id, { forUpdate: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status === 'disconnected') throw new AppError('CONNECTION_NOT_CONNECTABLE', { status: row.status });
  if (p.leadSourceId && PUBLISHING_KINDS.includes(row.kind)) throw new AppError('LEAD_SOURCE_NOT_ALLOWED', { kind: row.kind });
  if (p.leadSourceId && !(await repo.leadSourceExists(tx, p.leadSourceId))) throw new AppError('NOT_FOUND');
  const patch = { ...(p.displayName !== undefined ? { displayName: p.displayName } : {}), ...(p.leadSourceId !== undefined ? { leadSourceId: p.leadSourceId } : {}) };
  await repo.updateLabels(tx, id, patch);
  await audit(tx, actor, {
    action: 'integration.changed',
    entity: { type: 'integration_connection', id },
    changes: redactDiff({ display_name: row.display_name, lead_source_id: row.lead_source_id }, { display_name: p.displayName ?? row.display_name, lead_source_id: p.leadSourceId === undefined ? row.lead_source_id : p.leadSourceId }, { entity: 'integration_connection' }),
  });
  return (await repo.getConnection(tx, id))!;
}

// ---- disconnect (R-INT-5) ---------------------------------------------------------------------------------

export async function disconnect(tx: Tx, actor: UserActor, id: string, now: Instant): Promise<repo.ConnectionDbRow> {
  const row = await repo.getConnection(tx, id, { forUpdate: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status === 'disconnected') return row; // idempotent
  transitionConnection(toRow(row), { type: 'disconnect', at: new Date(now).toISOString() });
  await repo.markDisconnected(tx, id);
  if (row.credential_id && row.kind === 'mls_feed') {
    // an API key (Spark MLS) has no grant to revoke at the provider: revoked AND purged in this transaction
    await repo.revokeCredential(tx, row.credential_id);
    await repo.purgeCredential(tx, row.credential_id);
  } else if (row.credential_id) {
    await repo.revokeCredential(tx, row.credential_id);
    await enqueueTyped(tx, REVOKE_GRANT_JOB, { credentialId: row.credential_id }, { dedupeKey: `integration_revoke:${row.credential_id}` });
  }
  await audit(tx, actor, {
    action: 'integration.disconnected',
    entity: { type: 'integration_connection', id },
    changes: redactDiff({ status: row.status }, { status: 'disconnected', credential_revoked: row.credential_id !== null, credential_purged: row.credential_id !== null && row.kind === 'mls_feed' }),
    reason: 'DISCONNECTED',
  });
  return (await repo.getConnection(tx, id))!;
}
