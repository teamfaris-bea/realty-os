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
  CONFIRMATION_INVALID: 409, // confirmDecisionId does not name this message's own fresh needs_confirmation decision
  CALL_NOT_ACTIVE: 409, // outcome / status for a call that is not this agent's
  CONSENT_ENTRY_INVALID: 422, // the staff consent entry violates R-CONSENT-4 (details.issues)
  NOT_AN_OPT_OUT_LANGUAGE_REVOKE: 409, // R-CONSENT-8: only opt-out-language revokes can be reviewed away
  ALREADY_REVIEWED: 409,
  AUTOMATION_NOT_PAUSED: 409,
  STREAM_TOKEN_INVALID: 404, // unknown, used or expired playback token (R-PERM-9)
  RECORDING_UNAVAILABLE: 409, // not stored (pending copy, quarantined, shredded)
  NUMBER_UNAVAILABLE: 409, // NUMBER_QUARANTINED / already live elsewhere (R-TEN-8)
  PROVIDER_UNAVAILABLE: 503, // the provider rejected or could not be reached for an admin action
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
