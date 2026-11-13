// @realty/db — public interface of BUILD_PLAN module 7 (db/client).
//
// - schema.ts: the Kysely `DB` interface for every table and view (generated; drift-tested)
// - tenantTx: withTenantTx(actor, fn) / withPreTenant(fn): the only ways to reach the database as staff
// - portalTx: resolvePortalSession / withPortalTx(client, fn): the only way to act as a portal client (module 43)
// - ownership: applyOwnershipCommand / applyOwnershipCommandInTx / ownership.followup
// - consent: recordConsentEvent (ledger + projection in one transaction)
// - jobs: enqueue / claim / finish / cancel / reap / dueWork
// - locks: lockContact / lockAddress (the global lock order)
// The migration runner is `@realty/db/migrate`; per-test databases are `@realty/db/testing`.
export type * from './schema.js';
export { TABLE_NAMES, VIEW_NAMES } from './schema.js';
export { type Database, type DatabaseOptions, closeDefaultDatabase, configureDatabase, createDatabase, getDatabase } from './client.js';
export {
  ActorContextError,
  type TenantTxOptions,
  type Tx,
  actorGucs,
  dbNow,
  isRetryable,
  setOwnershipCommand,
  withPreTenant,
  withPreTenantThenTenant,
  withTenantTx,
} from './tenantTx.js';
export { hmacBytes, lockAddress, lockAddresses, lockContact, lockContacts } from './locks.js';
export { ConsentLedgerNotVisibleError, ConsentSpecError, loadConsentEvents, recordConsentEvent, upsertConsentState } from './consent.js';
export {
  type ClaimedJob,
  type DueWork,
  type FinishResult,
  JOB_KIND_RE,
  type JobSpec,
  JobPayloadError,
  QUEUES,
  type Queue,
  assertNoPiiInPayload,
  cancel as cancelJobs,
  claim as claimJobs,
  dueWork,
  enqueue as enqueueJob,
  finish as finishJob,
  jobs,
  reap as reapJobs,
  scrubError,
} from './jobs.js';
export {
  MissingNewContactError,
  type OwnershipCommandOptions,
  type OwnershipCommandResult,
  OwnershipWriteConflict,
  type StoredOutcome,
  applyOwnershipCommand,
  applyOwnershipCommandThen,
  applyOwnershipCommandInTx,
  defaultIds,
  derivedCommandId,
} from './ownership/apply.js';
export { FOLLOWUP_JOB_KIND, type FollowupPayload, followupDedupeKey } from './ownership/effects.js';
export { type FollowupResult, FollowupPayloadError, applyOwnershipFollowupInTx, runOwnershipFollowup } from './ownership/followup.js';
export type { MergeStep } from './ownership/merge.js';
export { type NewContactFields, projectionOf, eventOf, selectLedger } from './ownership/rows.js';
export { TenantNotReadyError, importOwnersPending, loadRoutingCandidates, loadRuleMembers, loadRules, loadTenantFacts, type TenantFacts } from './ownership/context.js';
export { type AuditRowSpec, insertAuditRow } from './repos/audit.js';
export { json } from './json.js';
export { APP_ROLE_CHECK_SQL, type AppRoleProblem, type AppRoleRow, NOT_RLS_BOUND, appRoleProblems, tlsFailureMessage } from './rolePreflight.js';
export { type DatabaseTls, DatabaseTlsError, assertDatabaseUrlShape, databaseTlsFromEnv, databaseTlsProblems, databaseUrlShapeProblem, libpqEnvNames, pgSsl } from './tls.js';
export {
  type ClientActor,
  type PortalAuditEntity,
  type PortalDocumentObject,
  type PortalLoginLink,
  PortalNotClearedError,
  type PortalSignIn,
  type PortalStreamToken,
  type PortalTxOptions,
  consumePortalLogin,
  endPortalSession,
  issuePortalDocumentStream,
  newPortalToken,
  portalAddressHash,
  recordPortalAudit,
  redeemPortalDocumentStream,
  requestPortalLogin,
  resolvePortalSession,
  withPortalTx,
} from './portalTx.js';
