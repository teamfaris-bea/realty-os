// @realty/core/portal — public interface of PHASE2_3_PLAN module 44: what may be published to a
// client's portal grant, and the one deterministic copy of it. Pure: no I/O, no clock, no randomness,
// no tenant input. Module 45 (api/portal: routes, cookie, portal.sync, invite/grant/publish/retract)
// and module 46 (the staff preview) import only from here.
//
// Rules (core parts only)
//   R-PORTAL-3  what may be published and the copy: publishable() and renderPortalItem().
//   R-PORTAL-6  publish-time half: no new item into a revoked or lapsed grant, or for a disabled account.
//               Hiding on the next query is the DB's (RLS, module 43).
//   R-PORTAL-7  publish-time half: a document item only for a clean, shared, deal- or listing-scoped
//               document of the grant. The download re-check stays in module 43's portal.document_object.
//   E89         feedback is never rule-published (the portal half; core/marketing links E89).
//   R-PORTAL-1, -2, -4, -5 have no core part.
//
// publishable() accepts no more than 0018's portal_items CHECKs and app.portal_items_guard() accept:
//   a confirmed milestone of the grant's deal; a document that is shared_to_portal, clean, not
//   contact-scoped and of the grant's own deal (deal grant) or listing (listing grant); a showing or its
//   feedback on the grant's listing or the deal's listing, or attended by the client; an approved or
//   executed seller_update_draft whose trigger_ref.listing_id is the grant's listing or the deal's
//   listing; a task of the grant's deal or listing. Feedback and seller updates only from a person.
// It is STRICTER than the DB in four ways (it only refuses more):
//   (a) the rule path (system, portal.sync) publishes confirmed milestones only (DATA_MODEL §8);
//       documents and showings by the system: PORTAL_RULE_MILESTONES_ONLY.
//   (b) through the deal's listing, showings, feedback and seller updates reach a deal grant only for a
//       seller-side party (a seller or co_seller of the deal); any other client gets only the showings
//       they attended and their feedback: PORTAL_NOT_SELLER_SIDE. The guard accepts these for any grant
//       on a deal naming that listing, and deals may name a listing on the buy side (conflict note 1,
//       a finding for module 45's lane; a DB fix is a reviewed migration there). Fixed by module 45's migration
//       portal_api: app.portal_items_guard now refuses the same case with
//       PORTAL_NOT_SELLER_SIDE (R-PORTAL-19), so core and the DB agree.
//   (c) a revoked or lapsed grant, or a disabled account, takes no new item: PORTAL_GRANT_INACTIVE.
//   (d) next_step is person-published only: R-PORTAL-3's "client-visible next steps" has no column on
//       tasks, so a person sharing the task is the only signal (PORTAL_PERSON_ONLY).
// Also stricter, in shape only: ids must be canonical lower-case UUIDs (an id that differs by case or
// whitespace is PORTAL_SOURCE_INVALID), and verbatim text is refused rather than cut when it is over
// 4000 code points (PORTAL_TEXT_TOO_LONG) or holds a control character or a lone surrogate
// (PORTAL_TEXT_NOT_PLAIN). Visibility to the publisher (the guard's last clause) is RLS's.
//
// renderPortalItem(): the field allowlist is in render.ts. sourceVersion is due_version for a
// deal_date, version_no for a document, 1 otherwise, so a moved date or a new document version is a
// new item (items never change; module 45 retracts the old one). Dates are slots: only occursOn holds
// a date. Titles are trimmed and 1–120 code points (shortened visibly with "…"); bodies ≤ 4000.
//
// VERIFY WITH COUNSEL (C10): what a client may see per item kind (the allowlist: verbatim buyer-agent
// feedback, showing details, task titles); the stricter choices (a)–(d); retention after a grant
// expires; D-FEEDBACK's default (feedback reaches the portal only when a person shares it).
// Platform pack: platform:portal (C10) gates sign-in in module 43 (portal.request_login,
// portal.resolve_session); core/portal is not gated and takes no clearance input.
export * from './types.js';
export { publishable, PERSON_ONLY_KINDS, RULE_PUBLISHED_KINDS, FEEDBACK_PUBLISH_POLICY } from './publishable.js';
export { renderPortalItem } from './render.js';
export { TITLE_MAX, BODY_MAX, codePointLength } from './text.js';
