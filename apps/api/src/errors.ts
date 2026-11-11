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
  ASSISTANT_OUTPUT_BLOCKED: 409, // lane prompt-injection: the assistant's suggested reply was discarded for safety (e.g. wiring details); nothing was sent
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
  // ---- lane ops-observability (System page) ----
  JOB_NOT_RETRYABLE: 409, // the job is neither dead nor waiting after a failure (it finished, runs now, or was cancelled)
  JOB_ALREADY_QUEUED: 409, // a newer job for the same work is already queued or running: retrying this one would duplicate it
  JOB_NOT_CANCELLABLE: 409, // only a waiting job can be cancelled; a running one finishes or is reaped
  // ---- api/integrations (module 21) ----
  INTEGRATION_NOT_CONNECTABLE: 409, // this kind is not connected by OAuth (partner, keyed, a later phase, or out of scope by owner decision D2)
  INTEGRATION_NOT_CONFIGURED: 409, // no platform app is configured for this provider on this deployment
  CONNECTION_NOT_CONNECTABLE: 409, // the connection's status does not allow a (re)connect or change
  CONNECTION_ACCOUNT_MISMATCH: 409, // a different external account is a new connection (R-INT-3)
  LEAD_SOURCE_REQUIRED: 422, // an inbound channel needs a lead source before it can go live
  MLS_PROVIDER_NOT_SPARK: 409, // mls/spark: this deployment does not use the Spark adapter (MLS_PROVIDER=fake)
  MLS_CREDENTIAL_MISSING: 409, // mls/spark: no active Spark key is saved for this tenant
  // ---- api/people (FUB parity module 57) ----
  STALE_CONTACT: 409, // R-PAR-43: the contact changed since it was read (row_version in details)
  FIELD_NOT_EDITABLE: 422, // R-PAR-43: ownership, attribution, do-not-contact, imported fields are never patched
  STAGE_NEEDS_CONTACT: 409, // R-PAR-14: reach this routed lead first, or close it
  STAGE_LABEL_INVALID: 422, // R-PAR-13
  POINT_EXISTS: 409, // the phone/email is already on this person
  POINT_UNCHANGED: 422, // a replace with the same address
  POINT_REMOVED: 409, // the point was already removed
  WRONG_NUMBER_NOT_RECORDED: 409, // R-PAR-12: removing as a wrong number needs the ledger's wrong-number report
  WRONG_NUMBER_FINAL: 409, // R-PAR-12: a confirmed wrong number is never restored
  COLLABORATOR_NOT_ELIGIBLE: 422, // not an active member, or the contact's owner
  RELATIONSHIP_EXISTS: 409,
  MENTION_LIMIT: 422, // R-PAR-3: at most 10 people per note
  NOTE_READ_ONLY: 409, // R-PAR-4: imported notes and call summaries are not edited or deleted
  NOTE_AUTHOR_ONLY: 403, // R-PAR-4: only the author edits a note (pin: author or Owner/Admin)
  ACTIVITY_IN_FUTURE: 422, // R-PAR-31 E192
  ACTIVITY_TOO_OLD: 422, // R-PAR-31
  ACTIVITY_OUT_OF_WINDOW: 422, // R-PAR-31 (the DB CHECK notes_activity_at_window)
  OUTCOME_CALLS_ONLY: 422, // R-PAR-30
  NO_ADDRESS_TO_REVOKE: 409, // do-not-contact on a person with no phone or email
  CUSTOM_FIELD_PROTECTED: 422, // api/import-parity (R-PAR-18): a field name reads like a protected fair-housing attribute
  DUPLICATE_ALREADY_DECIDED: 409, // api/duplicates: the pair was already merged, dismissed or restored (status in details)
  // ---- parity api/lists (module 60) ----
  TAG_NAME_EMPTY: 422, // R-PAR-6: a tag needs a name
  TAG_NAME_TOO_LONG: 422, // R-PAR-6: at most 64 characters
  TAG_NAME_INVALID: 422, // R-PAR-6: control characters are not allowed
  TAG_LIMIT: 409, // R-PAR-6: a team has at most 1,000 tags (merge some first)
  CONTACT_TAG_LIMIT: 409, // R-PAR-6: a person has at most 100 tags
  TAG_NAME_TAKEN: 409, // R-PAR-6: a rename collides with another tag's name (case- and width-insensitive); merge instead
  TAG_MERGE_INVALID: 422, // R-PAR-9: a tag merges into a different, existing tag
  TAG_PROTECTION_OWNER_ONLY: 403, // R-PAR-8: only the Owner lifts a tag's fair-housing protection
  AUDIENCE_PROTECTED_PROXY: 422, // R-PAR-8: a protected (fair-housing proxy) tag never defines a bulk send/enroll audience and is never applied in bulk
  CUSTOM_FIELD_LIMIT: 409, // R-PAR-17: at most 50 live custom fields
  CUSTOM_FIELD_LABEL_TAKEN: 409, // R-PAR-17: another live field has this label
  CUSTOM_FIELD_LABEL_INVALID: 422,
  CUSTOM_FIELD_KEY_INVALID: 422,
  CUSTOM_FIELD_TYPE_INVALID: 422,
  CUSTOM_FIELD_OPTIONS_INVALID: 422, // details.path
  CUSTOM_FIELD_ANNUAL_INVALID: 422, // only a date field repeats every year
  CUSTOM_FIELD_IMMUTABLE: 409, // R-PAR-17: a field keeps its key and type
  CUSTOM_FIELD_OPTION_REMOVED: 409, // R-PAR-17: archive an option instead of removing it
  CUSTOM_FIELD_ARCHIVED: 409, // R-PAR-17: an archived field is read-only
  CUSTOM_VALUE_TYPE: 422, // the value does not fit the field type
  CUSTOM_VALUE_TOO_LONG: 422, // text values are at most 1,000 characters
  CUSTOM_VALUE_OPTION: 422, // not a live option of this field
  CUSTOM_VALUE_RANGE: 422, // a number out of range, or too many options
  LIST_DEFINITION_INVALID: 422, // R-PAR-29: details.issues (paths)
  LIST_DEFINITION_TOO_LARGE: 422, // R-PAR-29: at most 8 KB
  LIST_FREE_TEXT_IN_TEAM_LIST: 422, // R-PAR-27: team lists carry no typed names or text values
  LIST_FIELD_UNKNOWN: 422,
  LIST_FIELD_OP_INVALID: 422, // the clause does not fit the field type (e.g. "coming up" on a non-annual date)
  LIST_TAG_UNKNOWN: 422,
  LIST_OPTION_UNKNOWN: 422,
  LIST_CURSOR_INVALID: 422, // the page cursor is malformed or for another sort
  LIST_TOO_SLOW: 503, // R-PAR-29: the list ran past its 3 s statement timeout (narrow it and try again)
  SMART_LIST_IMMUTABLE: 409, // a list keeps its scope and owner (copy it instead)
  SELECTION_TOO_LARGE: 422, // resolveSelection: more people than the action's cap (details.cap)
  // parity module 63 (templates and bulk; DATA_MODEL Part 3 R-PAR-23..42)
  MERGE_FIELD_UNKNOWN: 422, // a template names a merge field outside the closed set, or an unknown custom field
  MERGE_FIELD_MALFORMED: 422, // an unclosed or nested {{…}}
  MERGE_FIELD_FALLBACK_INVALID: 422, // a fallback is empty, too long, or holds a bar or control character
  MERGE_FIELD_TOO_MANY: 422, // more than 100 merge tokens
  MERGE_FIELD_ARCHIVED: 422, // a template names an archived custom field
  MERGE_FIELD_EMPTY: 422, // R-PAR-24: this person has no value for a field and there is no fallback (never "Hi ,")
  TEMPLATE_NAME_INVALID: 422,
  TEMPLATE_NAME_TAKEN: 409, // a live template of that scope and channel already has this name
  TEMPLATE_SUBJECT_REQUIRED: 422,
  TEMPLATE_SUBJECT_NOT_ALLOWED: 422,
  TEMPLATE_SUBJECT_INVALID: 422,
  TEMPLATE_BODY_EMPTY: 422,
  TEMPLATE_BODY_TOO_LONG: 422,
  TEMPLATE_BODY_INVALID: 422,
  TEMPLATE_RENDERED_EMPTY: 422,
  TEMPLATE_RENDERED_TOO_LONG: 422,
  TEMPLATE_ARCHIVED: 409, // the template was archived
  TEMPLATE_STALE: 409, // the template changed since it was opened (details.version)
  SIGNATURE_INVALID: 422, // a signature is 1-1,000 characters of plain text
  BULK_EMPTY: 422, // nobody selected
  BULK_TOO_LARGE: 422, // Q-PAR-7 cap for the kind (details.cap)
  BULK_DAILY_EMAIL_CAP: 409, // Q-PAR-7: the team's bulk-email recipients for today are used up (details.remaining)
  BULK_NOT_PERMITTED: 404, // TCs run no bulk action; only Owner/Admin/TL assign (R-PERM-5 shape)
  BULK_PARAMS_INVALID: 422, // the kind's parameters are missing or wrong (tag, stage, target, playbook, template)
  BULK_NOT_DRAFT: 409, // only a draft is confirmed (details.status)
  BULK_NOT_LIVE: 409, // the action already finished (details.status)
  BULK_NOTHING_TO_DO: 409, // everyone selected is skipped: there is nothing to confirm
  BULK_CONFIRM_ROLE_CHANGED: 409, // R-PAR-33: the creator's role changed since the draft; build a new one
  TAG_PROTECTED: 409, // R-PAR-8 S7: a protected tag is never applied or removed in bulk
  BATCH_TEXT_DISABLED: 409, // R-PAR-40: the Owner has not turned batch texting on
  BATCH_TEXT_ATTESTATION_REQUIRED: 422, // turning batch text on needs the typed attestation
  EMAIL_DOMAIN_UNVERIFIED: 409, // R-PAR-39: a bulk email needs a verified sending domain
  POSTAL_ADDRESS_MISSING: 409, // R-PAR-39: a bulk email needs the brokerage postal address
  BROKERAGE_IDENTITY_MISSING: 409,
  SMS_MARKETING_NOT_REGISTERED: 409, // R-PAR-40: batch text needs an approved registration that covers marketing
  TEMPLATE_CHANNEL_MISMATCH: 422, // an email action needs an email template (and a text action a text one)
  LEAD_SOURCE_NOT_ALLOWED: 422, // D2: a publishing-only connection (facebook_page, instagram_business) never carries a lead source (0025 CHECK)
  // ---- parity module 67: api/stage-automation ----
  AUTO_ENROLL_STAGE_TAKEN: 409, // R-PAR-16: another active playbook of the same scope/owner already starts on this stage
  AUTO_ENROLL_NOT_ALLOWED: 422, // R-PAR-16: a new-lead-response playbook never starts on a stage
  PLAYBOOK_RETIRED: 409, // a retired playbook cannot be given a stage
  // ---- lead-handling follow-ups (erasure, address delete) ----
  PERSON_DO_NOT_CONTACT_UNCARRIED: 409, // D1, R-DATA-4: an erasure would drop a do-not-contact not yet on every address (nothing erased)
  ADDRESS_RESTORE_EXPIRED: 409, // module 57: the Undo of an address delete came after its window (add the address again)
  // ---- module 22 lead-email intake (owner decision D3) ----
  LEAD_EMAIL_NOT_PENDING: 409, // module 22 lead-email: the held email was already accepted or discarded (fresh state in details)
  LEAD_EMAIL_NO_CONTACT_POINT: 422, // module 22 lead-email: accepting needs at least one valid phone or email (R-INBOX-9)
  LEAD_EMAIL_DOMAIN_INVALID: 422, // module 22 lead-email: an allowlisted sender domain must be a registrable domain (no wildcard, no public suffix)
  LEAD_EMAIL_NOT_CONFIGURED: 409, // module 22 lead-email: this deployment has no inbound lead-email domain (LEAD_EMAIL_INBOUND_DOMAIN)
  CHANNEL_NOT_CONNECTED: 409, // module 22: the web-chat widget is not connected (disconnected, revoked or never switched on; R-INBOX-7)
  WEBCHAT_DISCLOSURE_STALE: 409, // module 22: the chat must start after the visitor saw the widget's current disclosure (R-INBOX-5)
  WEBCHAT_SESSION_CLOSED: 410, // module 22: the chat session ended (idle 30 min or closed, E77); start a new chat
  // ---- module 33 api/insights ----
  COST_MONTH_IN_FUTURE: 422, // a lead-source cost for a month that has not started yet in the tenant's zone
  GOAL_PERIOD_START_INVALID: 422, // a goal period must start on a Monday / the 1st / a quarter's or year's first day (details.periodKind)
  GOAL_EXISTS: 409, // the member already has a goal for this period and metric (details.goalId)
  PLAN_ALREADY_ACCEPTED: 409, // the weekly plan was already accepted (its tasks exist)
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
