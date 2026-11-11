// Error codes → HTTP status, and the one error body shape (CONVENTIONS §7).
//
//   { "error": { "code": "...", "requestId": "...", "details"?: {...} } }
//
// The body never carries PII, SQL or stack traces (R-TEN-7): `details` holds ids, codes, counts and
// field paths only. Invisible or nonexistent resources and permission denials are 404 NOT_FOUND,
// never 403 (R-PERM-5).
//
// SHARED REGISTRATION FILE (CONVENTIONS §3). A module registers its codes by adding lines to
// ERROR_STATUS above the `// registry: add new entries above this line` marker, one code per line.

export const ERROR_STATUS = {
  // ---- base (core/foundation BASE_ERROR_CODES) ----
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  REAUTH_REQUIRED: 401,
  MFA_ENROLLMENT_REQUIRED: 403,
  CSRF_INVALID: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  INTERNAL_ERROR: 500,
  // ---- core can() denials shown only after the role/relationship checks pass ----
  OWNER_REQUIRED: 403,
  ATTESTATION_REQUIRED: 403,
  SUPPRESSION_NOT_LIFTABLE: 403,
  PURPOSE_NOT_PERMITTED: 403,
  FIELDS_NOT_PERMITTED: 403,
  TARGET_NOT_ELIGIBLE: 403,
  // ---- core normalize ----
  PHONE_INVALID: 422,
  EMAIL_INVALID: 422,
  // ---- api/platform: auth and sessions ----
  LOGIN_FAILED: 401, // uniform: unknown email, wrong password, locked, disabled
  MFA_REQUIRED: 401, // session exists but the second factor is not verified yet
  MFA_CODE_INVALID: 401,
  MFA_ALREADY_ENABLED: 409,
  MFA_NOT_ENROLLED: 409,
  TENANT_REQUIRED: 403, // signed in, but the session has no active tenant
  PASSWORD_TOO_WEAK: 422,
  PASSWORD_REQUIRED: 422,
  LOGIN_REQUIRED: 401, // an existing user accepts an invite while signed in
  RESET_TOKEN_INVALID: 400,
  INVITE_INVALID: 404,
  SIGNUP_UNAVAILABLE: 409, // email already registered (or similar); deliberately unspecific
  SLUG_TAKEN: 409,
  TIMEZONE_INVALID: 422,
  ALERT_PHONE_OPTED_OUT: 409,
  VERIFICATION_INVALID: 400,
  WEBHOOK_SIGNATURE_INVALID: 403,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // ---- api/admin ----
  LAST_OWNER: 409, // R-PERM-2: the tenant must keep one active Owner
  MEMBER_EXISTS: 409, // invite for someone who is already a member of this team
  INVITE_PENDING: 409, // one pending invite per email: revoke it first
  MEMBER_HAS_LEADS: 409, // remove / make TC only once the member owns or holds no leads (deactivation moves them)
  VERSION_CONFLICT: 409, // optimistic concurrency: the row changed since it was read (fresh row in details)
  RULE_INVALID: 422, // routing rule shape (R-OWN-10): target, members, match
  MEMBER_NOT_ELIGIBLE: 422, // a user who cannot hold this place (TC as a routing/pond member, inactive member, non-lead role as team lead)
  POND_IN_USE: 409, // a live routing rule still sends leads to this pond
  POND_NOT_EMPTY: 409, // leads are still waiting in this pond
  DEFAULT_POND_PROTECTED: 409,
  DEFAULT_TEAM_PROTECTED: 409,
  // ---- api/leads (ownership engine rejections, R-OWN-5/8/16/24; intake; deactivation) ----
  LEAD_OFFER_EXPIRED: 409, // R-OWN-8: accept at/after offer_expires_at (no grace)
  LEAD_OFFER_SUPERSEDED: 409, // the offer id is no longer the live offer
  MEMBERSHIP_INACTIVE: 409, // the actor's membership is not active
  LEAD_ALREADY_CLAIMED: 409, // E1: the other claimer won
  CLAIM_LIMIT_REACHED: 409, // R-OWN-16 claims per tenant-local day
  CLAIM_COOLDOWN: 409, // R-OWN-16: 72 h after releasing / losing this lead
  CAPACITY_REACHED: 409, // R-OWN-16: uncontacted owned leads at the cap
  POND_NOT_ELIGIBLE: 409, // the pond does not take claims from this role / member
  ALREADY_OWNER: 409, // R-OWN-7: a second accept by the current owner
  LEAD_STATE_CHANGED: 409, // stale UI or lost race: the fresh projection is in details
  MERGE_OWNER_REQUIRED: 409, // R-OWN-24: different owners, choose one (preselected in details)
  CONTACT_MERGED: 409, // the contact was merged away (mergedInto in details when visible)
  DUPLICATE_CONTACT: 409, // R-OWN-25 / R-PERM-12: an exact phone/email match exists (owner name only)
  INQUIRY_EMPTY: 422, // intake: no name, no valid phone and no valid email
  DEACTIVATION_NOT_ALLOWED: 409, // the member cannot be deactivated (self, invited, already removed)
  COMMAND_ID_REUSED: 422, // R-OWN-7: the caller's command id already names a different command (other contact / not a create)
  // ---- api/comms ----
  CONTACT_POINT_MISSING: 422, // no active phone / email on the contact for this channel
  SUBJECT_REQUIRED: 422, // an email needs a subject
  SCHEDULE_IN_PAST: 422, // scheduleAt must be in the future
  MESSAGE_NOT_SENDABLE: 409, // the message is no longer scheduled/queued (sent, blocked, canceled …)
  CALL_NOT_ACTIVE: 409, // outcome / status for a call that is not this agent's
  CONSENT_ENTRY_INVALID: 422, // the staff consent entry violates R-CONSENT-4 (details.issues)
  NOT_AN_OPT_OUT_LANGUAGE_REVOKE: 409, // R-CONSENT-8: only opt-out-language revokes can be reviewed away
  ALREADY_REVIEWED: 409,
  AUTOMATION_NOT_PAUSED: 409,
  STREAM_TOKEN_INVALID: 404, // unknown, used or expired playback token (R-PERM-9)
  RECORDING_UNAVAILABLE: 409, // not stored (pending copy, quarantined, shredded)
  NUMBER_UNAVAILABLE: 409, // NUMBER_QUARANTINED / already live elsewhere (R-TEN-8)
  PROVIDER_UNAVAILABLE: 503, // the provider rejected or could not be reached for an admin action
  AGENT_PHONE_MISSING: 422, // tap-to-call bridges the agent's verified phone first; none is set
  // ---- api/imports ----
  IMPORT_STATE_CONFLICT: 409, // the batch or stage is not in a state that allows this step (details.status)
  IMPORT_STAGE_ORDER: 409, // R-IMPORT-3: earlier stages must be verified or skipped first (DB trigger)
  IMPORT_STAGE_BLOCKED: 409, // the dry run has blockers (e.g. USER_MAPPING_INCOMPLETE, R-IMPORT-8)
  SNAPSHOT_CHANGED: 409, // E42: the dry run shown is not the current one (new snapshot / dry run)
  IMPORT_DRY_RUN_STALE: 409, // an earlier stage committed after this dry run: run it again first
  IMPORT_REVIEW_INVALID: 422, // the review decision does not fit the record (details.reason)
  IMPORT_FILE_INVALID: 422, // the uploaded file could not be read (details.reason: CSV_* / JSON)
  FUB_KEY_INVALID: 422, // Follow Up Boss rejected the API key
  IMPORT_MAPPING_INVALID: 422, // a user/pond mapping target is not an eligible member or pond of this team
  RECOUNT_MISMATCH: 409, // R-IMPORT-5: the recount does not match the reviewed plan (details.diffs)
  SPOT_CHECKS_INCOMPLETE: 422, // R-IMPORT-5: every sampled record must be checked
  SPOT_CHECK_FAILED: 409, // R-IMPORT-5: a sampled record did not match
  IMPORT_REVERT_ORDER: 409, // R-IMPORT-10: later stages are reverted first
  // ---- api/assistant ----
  DRAFT_STALE: 409, // R-AST-6: the client wrote since this was drafted (details.inboundSeq: re-review, then approve with reviewedInboundSeq)
  DRAFT_INVALIDATED: 409, // R-AST-7: the lead changed owner / ownership period since this was drafted
  ACTION_NOT_PENDING: 409, // the assistant card was already handled (details.status)
  ASSISTANT_UNAVAILABLE: 409, // the assistant produced nothing (AI switched off for the team, or no usable output)
  PLAYBOOK_INVALID: 422, // core.validatePlaybook issues (details.issues) block saving or approval
  PLAYBOOK_HASH_MISMATCH: 409, // the approval names content that is not this version's exact content
  PLAYBOOK_VERSION_NOT_DRAFT: 409, // only a draft can be approved (frozen after it leaves draft)
  PLAYBOOK_NOT_APPROVED: 409, // no approved version to run / revoke
  PLAYBOOK_OWNER_MISMATCH: 409, // an agent playbook only runs for contacts its agent owns
  ALREADY_ENROLLED: 409, // R-AST-8: the contact is already in this playbook
  ENROLLMENT_REPLACE_NEEDS_CONFIRMATION: 409, // R-AST-8: another live enrollment would be stopped (details.currentPlaybookId)
  ENROLLMENT_NOT_LIVE: 409, // the enrollment already ended
  ENROLLMENT_NOT_RESUMABLE: 409, // opt-out, wrong number or revoked approval pauses are not resumed here (details.pauseReason)
  SAVED_SEARCH_INVALID: 422, // the reviewed criteria are empty or invalid
  SAVED_SEARCH_STATE: 409, // wrong state for this saved-search command (details.status)
  SENDER_UNAVAILABLE: 409, // no sending number / email identity for this channel
  SELLER_UPDATE_NEEDS_RECOMMENDATION: 422, // R-AST-17: a seller update goes out only with the agent's own recommendation (an edit)
  DRAFT_OWNER_ONLY: 409, // R-AST-7: reply drafts are made for the lead's owner (only the owner's draft can be sent)
  // ---- api/workspace ----
  FEED_ITEM_PINNED: 409, // a pinned card is a live deadline (offer, first touch, inactivity): it closes by acting on it, never by Done/Snooze/Dismiss
  FEED_ITEM_NOT_OPEN: 409, // the card was already closed (details.state)
  NOTIFICATION_CRITICAL: 422, // lead offers, first-touch alerts and hot handbacks cannot be muted and keep push or SMS (DB CHECK too)
  DEAL_STAGE_INVALID: 422, // e.g. `lost` without a reason, or a stage change to the current stage
  ASSIGNEE_NOT_ELIGIBLE: 422, // tasks/appointments/deals: the assignee or owner is not an active member the caller may assign to
  // ---- api/accountability ----
  EXCEPTION_STATE_CONFLICT: 409, // the item's latest human event does not allow this action (details.latestAction): e.g. resolving a resolved item
  EXCEPTION_NOT_REASSIGNABLE: 409, // the item is not about a lead (an appointment or task without a contact): nothing to reassign
  CONTACT_ON_DEAL: 409, // lane rule-coverage (E59, R-DATA-4): erasure refused while the person is on a deal; details = deal ids/stages
  DEAL_STILL_OPEN: 409, // lane rule-coverage (E59): the primary contact of an open deal is changed on the deal, not removed
  // ---- api/integrations (module 21) ----
  INTEGRATION_NOT_CONNECTABLE: 409, // this kind is not connected by OAuth (partner, keyed, or a later phase)
  INTEGRATION_NOT_CONFIGURED: 409, // no platform app is configured for this provider on this deployment
  CONNECTION_NOT_CONNECTABLE: 409, // the connection's status does not allow a (re)connect or change
  CONNECTION_ACCOUNT_MISMATCH: 409, // a different external account is a new connection (R-INT-3)
  LEAD_SOURCE_REQUIRED: 422, // an inbound channel needs a lead source before it can go live
  // registry: add new entries above this line
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export function isErrorCode(s: string): s is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, s);
}

export function statusFor(code: string): number {
  return isErrorCode(code) ? ERROR_STATUS[code] : 500;
}

/** Details are ids/codes/counts/paths only. Values are JSON scalars, arrays or plain objects. */
export type ErrorDetails = Record<string, unknown>;

/** An expected failure with a stable code. Thrown by route code; rendered by the error handler. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly details?: ErrorDetails,
  ) {
    super(code);
    this.status = ERROR_STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: string; requestId: string; details?: ErrorDetails };
}

export function errorBody(code: string, requestId: string, details?: ErrorDetails): ErrorBody {
  return { error: details === undefined ? { code, requestId } : { code, requestId, details } };
}

/** Maps a core `{ ok: false, code }` result to an AppError (unknown codes become INTERNAL_ERROR). */
export function fromCoreFailure(r: { code: string }, details?: ErrorDetails): AppError {
  return new AppError(isErrorCode(r.code) ? r.code : 'INTERNAL_ERROR', details);
}
