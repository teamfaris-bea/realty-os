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
  MEMBER_HAS_LISTINGS: 409, // remove / make TC only once the member is listing agent on no open team listing (deactivation moves them; R-OWN-22)
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
  CONTACT_MERGED: 409, // the contact was merged away (mergedInto in details when visible); also an enrollment of a merged-away record (F2, details.reason person_removed)
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
  CANNOT_BE_REACHED: 409, // B9 R-PAR-16 D1: they can't be messaged: every channel this plan messages on is opted out (or do-not-contact) or has no address, so it could never send; nothing was enrolled (details.reason = stage automation's skip reason cannot_be_reached, details.playbookId)
  ENROLLMENT_NOT_LIVE: 409, // the enrollment already ended
  ENROLLMENT_NOT_RESUMABLE: 409, // opt-out, wrong number or revoked approval pauses are not resumed here (details.pauseReason)
  SAVED_SEARCH_INVALID: 422, // the reviewed criteria are empty or invalid
  SAVED_SEARCH_STATE: 409, // wrong state for this saved-search command (details.status)
  SENDER_UNAVAILABLE: 409, // no sending number / email identity for this channel
  SELLER_UPDATE_NEEDS_RECOMMENDATION: 422, // R-AST-17: a seller update goes out only with the agent's own recommendation (an edit)
  SELLER_UPDATE_STALE: 409, // R-SELL-4: showings, feedback, marketing or competing data changed after assembled_through; reassemble (one tap)
  SELLER_UPDATE_RECIPIENTS_CHANGED: 409, // R-SELL-5: who the update can reach changed since the agent looked; nothing was sent
  SELLER_UPDATE_CONFIRM_RECIPIENTS: 409, // R-SELL-5: send from the seller card, which shows who it reaches (the generic approve route cannot)
  SELLER_UPDATE_NO_RECIPIENT: 422, // R-SELL-5: no seller on the listing can be reached (opted out, no address, not visible)
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
  // ---- module 22 lead intake expansion (Lead sources page, Google lead forms, tracking numbers) ----
  NUMBER_NOT_TRACKING: 422, // module 22: only a live number with purpose tracking may be tied to a lead source (R-TRK-1)
  LEAD_SOURCE_OFF: 409, // module 22: the lead source is turned off; turn it on before setting up a path for it (R-LSRC-2)
  GOOGLE_LEAD_FORM_NOT_AVAILABLE: 409, // module 22: this deployment has no public https address for Google to post to (R-GADS-4)
  GOOGLE_LEAD_FORM_ALREADY_ON: 409, // module 22: the source's Google lead form is already on (current state in details; R-GADS-4)
  LEAD_EMAIL_NOT_A_LEAD: 409, // module 22: a held forwarding confirmation is never a lead; it can only be discarded (R-LEM-12)
  WEBHOOK_UNAVAILABLE: 503, // module 22: the webhook could not be checked (database unavailable); the provider should retry (R-GADS-1)
  // ---- module 68 api/mail-sync (D2) ----
  MAIL_SYNC_OFF: 409, // module 68: Gmail sync is off for this team, or platform:gmail is not cleared (R-GMAIL-1)
  MAIL_SYNC_NOT_CLEARED: 409, // module 68: the Owner cannot turn Gmail sync on before platform:gmail is cleared (counsel + Google verification)
  MAIL_PROVIDER_NOT_CONFIGURED: 409, // module 68: this platform has no reviewed Google client yet (honest status)
  MAIL_ALREADY_CONNECTED: 409, // module 68: one live Gmail link per user; disconnect first
  MAIL_NOT_CONNECTED: 404, // module 68: the caller has no live Gmail link
  MAIL_DISCLOSURE_STALE: 409, // module 68: the connect request must carry the hash of the current disclosure text
  MAIL_POINT_NOT_ALLOWED: 422, // module 68: an address that is not a current email of a client you own, collaborate on or share a deal with, or is a team mailbox (S-D2-1)
  // ---- module 29 api/marketing (R-MKT-1..12; DB guard refusals keep their codes) ----
  MARKETING_TEAM_LISTING_ONLY: 422, // only the team's own listings get marketing (R-MKT-5)
  MARKETING_FROZEN: 409, // an approved version cannot change; a change is a new version (R-MKT-2)
  MARKETING_TERMINAL: 409, // retracted / superseded are final
  MARKETING_APPROVE_FIRST: 409, // nothing is published or exported unapproved (R-MKT-1)
  MARKETING_HUMAN_APPROVAL: 403, // a person approves, as themselves
  MARKETING_ASSET_INVALID: 422, // an image that is not a live marketing asset (or not a PNG/JPEG/WebP)
  MARKETING_IDENTITY_IMMUTABLE: 409,
  MARKETING_BORN_DRAFT: 409,
  MARKETING_GUARD_FAILED: 422, // brokerage name, fair-housing wording or a pack rule fails: the reasons are on the piece
  MARKETING_STALE: 409, // the content changed since the person looked; approve what is shown now
  MARKETING_NOT_DRAFT: 409,
  MARKETING_DRAFT_EXISTS: 409, // a newer draft of this kind exists already: edit that one
  MARKETING_NOT_PUBLISHABLE: 422, // this kind is not published (flyers, Marketplace: export; invites: send)
  MARKETING_NOT_LIVE: 409,
  MARKETING_NOT_EXPORTABLE: 422, // an invite is sent, never exported
  MARKETING_NOT_INVITE: 422,
  MARKETING_PIECE_NOT_APPROVED: 409, // invites go out only from an approved open-house invite version (R-MKT-8)
  MARKETING_NOT_FLYER: 422,
  PLATFORM_NOT_CLEARED: 409, // publishing waits for counsel review of platform:fair_housing (R-INT-6): export instead
  PUBLISH_TARGET_INVALID: 422, // a social post goes to a Facebook Page or Instagram business account only
  PUBLISH_NEEDS_IMAGE: 422, // VERIFY: Instagram has no text-only posts
  PUBLICATION_ALREADY_LIVE: 409, // one live publication per version and account (E227: never re-posted)
  PUBLICATION_NOT_LIVE: 409,
  PUBLICATION_RETRACTING: 409, // another retraction of this post is under way; only one asks the provider (R-MKT-12)
  PUBLICATION_HUMAN_TAP: 403,
  PUBLICATION_BORN_PUBLISHING: 409,
  PUBLICATION_SYSTEM_ONLY: 403, // only the system records a provider's outcome
  PUBLICATION_FORWARD_ONLY: 409,
  PUBLICATION_IMMUTABLE: 409,
  PUBLICATION_POST_ID_FINAL: 409,
  LISTING_OFF_MARKET: 409, // sold / withdrawn / expired: nothing new goes out (R-MKT-9)
  FAIR_HOUSING_PACK_UNAVAILABLE: 503, // the fair-housing pack is missing or invalid: fail closed
  CALENDAR_ALREADY_CONNECTED: 409, // module 34: the person already has a calendar connected (one at a time); disconnect it first
  // ---- module 33 api/insights ----
  COST_MONTH_IN_FUTURE: 422, // a lead-source cost for a month that has not started yet in the tenant's zone
  GOAL_PERIOD_START_INVALID: 422, // a goal period must start on a Monday / the 1st / a quarter's or year's first day (details.periodKind)
  GOAL_EXISTS: 409, // the member already has a goal for this period and metric (details.goalId)
  PLAN_ALREADY_ACCEPTED: 409, // the weekly plan was already accepted (its tasks exist)
  COACHING_NOT_CLEARED: 409, // module 36 (R-INT-6): call scoring waits for counsel review of the platform:coaching pack
  TELEPHONY_LIVE_OFF: 409, // R-TWL-1: TELEPHONY_LIVE_REQUESTS=false: the provider request was refused before it was made
  MEDIA_NOT_ALLOWED: 422, // D5a: not a photo or video a text can carry (type, brand or bytes do not match; a file the metadata pass cannot walk)
  MEDIA_TOO_LARGE: 422, // D5a: details {limitBytes, scope: 'item'|'total'} (decimal bytes; R-MMS-3, R-MMS-2)
  MEDIA_LOCATION_NOT_REMOVED: 422, // D5a: metadata or a location survived the cleaning pass, so the file is refused (R-MMS-4, E295)
  MEDIA_UPLOAD_GONE: 409, // D5a: details {uploadId}; the same answer when missing, someone else's, another person's or tenant's, expired, removed or already sent (E291)
  MEDIA_UPLOAD_LIMIT: 409, // D5a: 20 unsent photos or videos waiting for this user (R-MMS-3)
  // ---- api/transactions (module 31; core TransactionErrorCode, R-TXN-1, R-TXN-6) ----
  DATE_HUMAN_CONFIRMATION: 403, // a person confirms, enters and moves milestone dates, as themselves (R-TXN-1)
  DATE_COMPLETED: 409, // a completed milestone is not re-confirmed or moved
  DATE_WAIVED: 409, // a waived milestone is not confirmed again
  REMINDER_INVALID: 422, // reminderDaysBefore outside 0..60
  TEMPLATE_INVALID: 422, // the milestone template does not parse (MilestoneTemplateSchema)
  TEMPLATE_SIDE_MISMATCH: 422, // the template is for another side of the deal
  MILESTONE_TEMPLATE_NOT_FOUND: 422, // no template with this id and version for the deal's side and the tenant's jurisdictions
  MILESTONE_PLAN_OPEN: 409, // another template's proposals are still open on this deal (details.templateId)
  MILESTONE_TEMPLATES_INVALID: 422, // PUT milestone templates: invalid entries by index (details.invalid)
  // ---- api/cma (module 71, D9; R-CMA-6, R-CMA-8) ----
  CMA_VALUATION_NOT_ALLOWED: 409, // the MLS licence pack does not record that sold data may be used for valuations (valuation.agent_cma; E371; details.sentence)
  CMA_NO_MLS_CONNECTION: 409, // no live MLS feed, so there are no sold homes to compare (details.sentence)
  CMA_SUBJECT_INCOMPLETE: 422, // the subject lacks its property type or size, the contact has no address, or a street address lacks the city, state or ZIP its MLS key needs (details.missing, details.sentence; E373, E365)
  CMA_SUBJECT_TYPE_NOT_SUPPORTED: 422, // land and 'other' are not valued in V1 (owner question (g), core/valuation CMA_SUPPORTED_TYPES; details.propertyType)
  CMA_NOT_DRAFT: 409, // a shared or superseded CMA never changes; prepare a new draft (details.status; E377)
  CMA_SUBJECT_ADDRESS_GONE: 409, // the draft's contact address was deleted (S0 keeps the draft open with no address), so it cannot be re-run; prepare a new CMA (details.sentence; F15)
  // ---- api/documents (module 42; R-DOC-1..10) ----
  DOCUMENT_TYPE_NOT_ALLOWED: 422, // not a PDF, JPEG or PNG by its bytes, the declared type differs, or the file is empty (E400)
  DOCUMENT_RETENTION_OUT_OF_RANGE: 422, // retention 3-10 years after the scope's close (or the upload); details {from, to}
  DOCUMENT_TOO_LARGE: 413, // a file part over 10,000,000 bytes (details.limitBytes; E401)
  DOCUMENT_QUARANTINED: 409, // the virus check has not passed yet: nobody opens it, the uploader and the Owner included (R-DOC-3)
  DOCUMENT_NOT_SHAREABLE: 409, // only a clean deal or listing document is shared to the portal (R-DOC-1)
  DOCUMENT_VERSION_CONFLICT: 409, // another new version of this document was uploaded first (E406)
  DOCUMENT_RETAINED: 409, // on legal hold or inside its retention period: erasure and purge refuse (R-DOC-4)
  DOCUMENT_SUPERSEDED: 409, // a clean newer version exists: its dates are confirmed from that one
  DOCUMENT_BLOCKED: 410, // the virus check blocked it: the file is gone or locked for good
  DOCUMENT_HOLD_OWNER_ADMIN: 403, // legal holds and retention are an Owner's or Admin's (R-DOC-4)
  EXTRACTION_EXISTS: 409, // the document was already read for dates
  EXTRACTION_CLOSED: 409, // the extraction was rejected, superseded or invalidated
  EXTRACTION_CLAIM_NEEDS_REVIEW: 409, // not found in the document as quoted: never a date (R-AST-1, E131)
  EXTRACTION_CLAIM_DECIDED: 409, // the claim was already rejected or corrected
  EXTRACTION_TARGET_KIND: 409, // the existing date is another kind of milestone
  EXTRACTION_USE_DOCUMENT: 409, // a contract extraction is decided on its document, never by the generic reject or claim review (details.documentId)
  // ---- module 52 api/ads (the same codes the DB raises; R-ADS-1..13) ----
  ADS_NOT_CLEARED: 409, // platform:ads is not cleared (counsel review AND the vendor check): no approval, no plan (R-ADS-7)
  ADS_GOOGLE_ONLY: 409, // D2: only a Google Ads campaign the caller sees is planned (R-ADS-8)
  ADS_CONNECTION_NOT_LIVE: 409, // the Google Ads connection is not connected or degraded (R-ADS-8)
  AD_APPROVAL_FROZEN: 409, // an approved budget shift is not edited; propose a new one (R-ADS-9)
  AD_CAP_EXCEEDED: 409, // the plan would take the tenant-wide daily total above the cap's daily ceiling (R-ADS-2)
  AD_CAP_VERSION_STALE: 409, // a plan cites a cap version that is no longer in force (R-ADS-2)
  AD_SHIFT_NOT_IN_APPROVAL: 409, // the approval does not name this campaign and amount (R-ADS-2)
  AD_SHIFT_NOT_APPROVED: 409, // nobody approved this shift (R-ADS-2)
  AD_CREATIVE_NOT_APPROVED: 409, // a campaign runs only an approved or published piece of its own listing (R-ADS-4)
  AD_BUDGET_THROUGH_LEDGER: 409, // budgets change only through an approved, applied ledger change (R-ADS-3)
  AD_APPLY_WITHOUT_PLAN: 409, // an outcome that matches no planned row (R-ADS-3)
  ADS_PROPOSAL_STALE: 409, // the proposal no longer matches the cap in force or a campaign's budget; it was superseded (details.reason)
  ADS_APPROVAL_NOT_FROM_ADS: 409, // an ad_reallocation approved outside the ads path is never planned (E444)
  ADS_MONTHLY_CAP_REACHED: 409, // month-to-date spend is at or over the monthly cap: resuming waits for next month or a higher cap (E459)
  ADS_CAMPAIGN_NOT_ELIGIBLE: 409, // the campaign cannot be resumed here (details.blockers); unmanaged campaigns are resumed in Google Ads
  ADS_NO_CAP: 409, // no ad cap is in force yet
  ADS_NO_LEAD_SOURCE: 409, // the Google Ads connection has no lead source, so its spend is not recorded: no budget moves (b11 sends-gates/F2)
  AD_CAP_CHANGED: 409, // another cap version was saved at the same time; reload and try again
  AD_CAP_INVALID: 422, // the daily ceiling is above the monthly cap
  // ---- module 75: AI ISA (D12 proposed; docs/AI_ISA.md §9.1) ----
  AI_ISA_OFF: 409, // the tenant switch or ai_enabled is off
  AI_ISA_NOT_CLEARED: 409, // platform:ai_isa is not counsel-cleared
  AI_ISA_POLICY_NOT_APPROVED: 409, // no approved ai_isa team policy version
  AI_ISA_NO_OPTIN: 409, // the owner has no active opt-in on the current version
  AI_ISA_NOT_OWNER: 404, // only the lead's current owner, as themselves (404 when invisible, R-PERM-5)
  AI_ISA_ALREADY_ACTIVE: 409, // care is already live for this person
  AI_ISA_NO_CHANNEL: 409, // no bindable point passes reply-tier evidence
  AI_ISA_SHARED_ADDRESS: 409, // a point is shared with another live person
  AI_ISA_ACTIVE_CLIENT: 409, // a party to an open deal or active team listing
  AI_ISA_LISTED_ELSEWHERE: 409, // a live listing at the property by another brokerage
  AI_ISA_NOT_ROOT: 409, // a merged-away record
  AI_ISA_CALENDAR_REQUIRED: 409, // book_appointments needs a live calendar
  AI_ISA_FIRST_TOUCH_PENDING: 409, // the human first touch is not recorded yet
  AI_ISA_PERSON_DECLINED: 409, // a person block (opt-out, complaint, declined AI)
  AI_ISA_HANDBACK_STALE: 409, // the handback is no longer current or its reply was queued
  AI_ISA_UNDO_EXPIRED: 409, // the 10-second undo window has passed
  AI_ISA_BOOKING_IN_PROGRESS: 409, // ISA-2b: the AI assistant is booking an agreed time; resume after it finishes
  AI_ISA_NOT_LIVE: 409, // no live or paused assignment to control
  AI_ISA_NOT_PAUSED: 409, // resume needs a paused assignment
  AI_ISA_DO_NOT_CONTACT: 409, // the person asked not to be contacted
  AI_ISA_ATTESTATION_REQUIRED: 422, // turning on or widening needs the typed attestation
  AI_ISA_ROLE_NOT_ELIGIBLE: 403, // TC and the human ISA role cannot opt in (Q-ISA-8)
  AI_ISA_BLOCK_NOT_LIFTABLE: 409, // a block lifts only after a new message from the person
  AI_ISA_HANDOFF_USE_ACK: 409, // an AI handoff card is never decided by the generic approve or reject: it is acknowledged on POST /ai-isa/handoffs/:id/ack and its deadline met by a human touch (details.handoffId)
  SUBJECT_UNCONFIRMED: 409, // seller facts need an agent-confirmed subject (ISA-3)
  CAPABILITY_NOT_AVAILABLE: 422, // a reserved or unavailable capability
  // ---- module 48 api/voice (batch 12; its own header since batch 13, so the AI ISA web contract's module-75 slice ends above) ----
  VOICE_PLAYBOOK_NOT_APPROVED: 409, // module 48: AI answering needs an approved voice_answering version (R-VOICE-1)
  VOICE_ANSWERING_OFF: 409, // module 48: the Owner has not turned AI answering on (R-VOICE-9)
  VOICE_NOT_CLEARED: 409, // module 48: platform:voice is not cleared (counsel review and the vendor latency spike, R-INT-6)
  VOICE_VENDOR_NOT_CONFIGURED: 409, // module 48: no voice vendor is set up on this platform (N12)
  VOICE_FAKE_ON_REAL_TELEPHONY: 409, // module 48: the deterministic fake voice agent never answers real telephony
  VOICE_RECORDING_OFF: 409, // module 48: recording is off in the active policy; an AI call is always announced and recorded (O13)
  AI_DISABLED: 409, // module 48: the team turned the assistant off (tenant_settings.ai_enabled)
  // ---- module 53 api/gbp, module 54 api/coaching-trends ----
  GBP_NOT_CLEARED: 409, // Google Business Profile waits for counsel review of platform:gbp (R-GBP-3)
  GBP_NOT_CONFIGURED: 409, // no Google Business Profile adapter on this platform yet (N15): export instead
  REPLY_PRIVACY: 422, // the reply names the reviewer, a price, an address, a date, contact details or deal terms (R-GBP-1)
  REPLY_STALE: 409, // the review changed at Google after the draft was written (E466)
  REPLY_IN_PROGRESS: 409, // a reply to this review is being posted right now (E464)
  COACHING_TRENDS_SCOPE: 404, // trends of members the caller may not read (R-COACH-8)
  // ---- api/isa/seller (module 75 seller part, ISA-3; R-ISA-18, R-ISA-26; details.sentence on each) ----
  SUBJECT_NOT_IN_MLS: 409, // the seller's home has no MLS record of an admitted connection: no comps; next step "Prepare a CMA (enter type and size)" (E373, E536)
  SUBJECT_INCOMPLETE: 409, // the newest MLS record lacks the property type, beds or size, or they are not displayable to clients (E536)
  SUBJECT_CHANGED: 409, // the home's record, address or default address changed since the owner confirmed it, or the confirm hash is stale (E536)
  SUBJECT_RECORD_OLD: 409, // the newest MLS record of the home is older than 10 years (VERIFY; E536)
  SUBJECT_NOT_SELLER: 409, // the lead is not under seller- or both-side AI care (no live assignment of that side)
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
