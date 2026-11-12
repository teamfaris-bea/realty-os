// Roles, actors, actions, the audit-action registry and the capability matrix `can()`
// (BUILD_PLAN module 1; DATA_MODEL §3; R-PERM-1, R-PERM-13, R-PERM-15; R-TEN-3 actor shape).
//
// SHARED REGISTRATION FILE (CONVENTIONS §3). Other modules add:
//   - a new `Action`: one line in ACTIONS **and** its row in MATRIX (the Record type forces it).
//     Coordinate with DATA_MODEL §3; never widen a permission silently.
//   - a new `AuditAction`: one line in AUDIT_ACTIONS.
// Insert new lines above the `// registry: add new entries above this line` markers.
//
// What `can()` decides and what it does not:
// - It decides whether this actor may perform this action on a resource with these FACTS. The
//   facts (own / team / pond / deal …) are established by the caller from RLS-visible rows, so RLS
//   enforces the row sets and `can()` enforces the matrix on top (both must agree to allow).
// - Every permission denial is `NOT_FOUND` (R-PERM-5: never 403, existence is not revealed),
//   except where the actor demonstrably sees the resource and the UI must explain honestly why the
//   tap cannot proceed (OWNER_REQUIRED, ATTESTATION_REQUIRED, SUPPRESSION_NOT_LIFTABLE,
//   PURPOSE_NOT_PERMITTED, FIELDS_NOT_PERMITTED, TARGET_NOT_ELIGIBLE). Those are only returned
//   after the role and relationship checks pass.
// - Re-authentication (R-PERM-13) is checked last, so a stale session never learns more than a
//   fresh one would.
// - Missing facts fail closed.
import type { SupportGrantId, TenantId, UserId } from './ids.js';
import { type Instant, MINUTE_MS } from './time.js';

// ---- roles and actors -------------------------------------------------------------------------

export const ROLES = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const;
export type Role = (typeof ROLES)[number];

export type SystemVia = 'timer' | 'provider' | 'assistant' | 'import' | 'worker';

/**
 * The only actor shapes (R-TEN-3). A user actor is built only from the resolved session; a system
 * actor only in apps/api/src/worker/** (lint `realty/no-system-actor`); a support actor only from a
 * live Owner-issued grant (R-PERM-11). Tenant context is never taken from request input.
 */
export type Actor =
  | { kind: 'user'; userId: UserId; tenantId: TenantId; role: Role; sessionId: string }
  | { kind: 'system'; tenantId: TenantId; via: SystemVia; jobId?: string }
  | { kind: 'support'; userId: UserId; tenantId: TenantId; grantId: string };

export type UserActor = Extract<Actor, { kind: 'user' }>;
export type SystemActor = Extract<Actor, { kind: 'system' }>;
export type SupportActor = Extract<Actor, { kind: 'support' }>;

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

/** R-PERM-15: TCs never own or claim leads. Every other role may own leads. */
export function canOwnLeads(role: Role): boolean {
  return role !== 'tc';
}

/** A human actor (user or support). The assistant/system is never human (R-PERM-10, R-AST-3). */
export function isHumanActor(actor: Actor): actor is UserActor | SupportActor {
  return actor.kind !== 'system';
}

/** audit_log actor columns for an actor (0001 audit_log CHECKs: user/support need a user id). */
export function actorAuditColumns(actor: Actor): {
  actorKind: Actor['kind'];
  actorVia: 'api' | SystemVia;
  actorUserId: UserId | null;
  actorRole: Role | null;
  supportGrantId: SupportGrantId | null;
} {
  switch (actor.kind) {
    case 'user':
      return { actorKind: 'user', actorVia: 'api', actorUserId: actor.userId, actorRole: actor.role, supportGrantId: null };
    case 'system':
      return { actorKind: 'system', actorVia: actor.via, actorUserId: null, actorRole: null, supportGrantId: null };
    case 'support':
      return { actorKind: 'support', actorVia: 'api', actorUserId: actor.userId, actorRole: null, supportGrantId: actor.grantId as SupportGrantId };
  }
}

// ---- actions ----------------------------------------------------------------------------------

/** Every authorized action. One DATA_MODEL §3 row maps to one or more actions (see MATRIX). */
export const ACTIONS = [
  'contact.view', // View contact card
  'contact.view_detail', // View phones, emails, timeline, history
  'contact.create', // Create contact (owned by self)
  'lead.accept', // Accept own offer
  'lead.decline', // Decline own offer
  'lead.claim', // Claim from pond
  'lead.release', // Release own lead
  'lead.reassign', // Reassign (incl. ISA handoff)
  'comms.send', // Text / email (the gate applies at send time)
  'comms.call', // Call (the gate applies at dial time)
  'draft.approve', // Approve own drafts and handbacks
  'playbook.approve', // Approve playbooks
  'recording.play', // Play / download a recording
  'transcript.view', // Read a transcript
  'consent.record', // Record consent (staff entry)
  'suppression.lift', // Lift a suppression
  'consent.reinstate', // Reinstate an opt-out: the person's own action only
  'deal.view',
  'deal.edit',
  'deal.financials', // Commission fields (deal_financials)
  'listing.view',
  'listing.edit',
  'listing.reassign', // Change a team listing's agent (b7 ownership-data/F2; DATA_MODEL §8)
  'import.run', // CSV / FUB import (approve, commit, verify, revert)
  'settings.routing', // Routing rules, ponds, teams, lead timers
  'settings.numbers', // Phone numbers (acquire), sending domains
  'number.release', // Release a phone number
  'settings.compliance', // Compliance policy versions
  'settings.identity', // Brokerage identity, recording settings, MFA roles
  'member.invite',
  'member.role',
  'member.suspend',
  'member.remove',
  'exception.view', // Team Lead exception queue
  'exception.resolve',
  'exception.reassign',
  'exception.verify',
  'scoreboard.view',
  'audit.view', // audit_log
  'ownership_ledger.view', // lead_ownership_events across contacts (Team Lead: team)
  'contact.erase', // Privacy erasure
  'data.export', // Exports (R-PERM-13; not a §3 row: Owner/Admin by default)
  'support.grant',
  'support.revoke',
  'system.view', // lane ops-observability: the System page (failed/dead jobs, stuck messages, late timers, connection health)
  'system.jobs', // lane ops-observability: retry or cancel a failed job from the System page (audited)
  'integration.view', // api/integrations: the Integrations admin page (Phase 2, DATA_MODEL §8)
  'integration.manage', // api/integrations: create, rename, connect (OAuth start), disconnect (DATA_MODEL §8: ✅ 🔒 | ✅ 🔒)
  'contact.edit', // parity (DATA_MODEL §12): names, type, intent, stage, points, addresses, tags, custom values, relationships
  'note.write', // parity 57: write own notes (with mentions) on a contact whose detail the actor sees
  'note.delete', // parity 57: delete own note; tenant-wide roles any (audited)
  'activity.log', // parity 57: log an outside call/text/email (never a touch)
  'collaborator.manage', // parity 57: add/remove collaborators (existing RLS: tenant-wide, Team Leads, the contact owner)
  'settings.stage_labels', // parity 57: tenant display labels of the eight stages
  'tag.create', // parity api/lists: create a tag by typing it (R-PAR-9)
  'tag.manage', // parity api/lists: rename, merge, recolor, protect, delete a tag (R-PAR-9)
  'custom_field.manage', // parity api/lists: define, edit, archive custom fields (R-PAR-17)
  'smart_list.personal', // parity api/lists: own personal smart lists; run any visible list (R-PAR-27)
  'smart_list.team_manage', // parity api/lists: create, edit, archive team lists (R-PAR-27)
  'template.personal', // parity module 63: own personal templates (DATA_MODEL §12: every role)
  'template.team_manage', // parity module 63: create/edit/archive team templates (Owner/Admin; Q-PAR-4)
  'bulk.run', // parity module 63: bulk tag/untag/stage/enroll/email, per person (✅ | ✅ | T | O | O | —)
  'bulk.assign', // parity module 63: bulk assign through the ownership engine (✅ | ✅ | T to team members | — …)
  'bulk.text', // parity module 63: batch text, per person; also needs the Owner's switch (R-PAR-40)
  'settings.batch_text', // parity module 63: the batch-text switch (Owner on 🔒 + attestation; Admin off only)
  'playbook.auto_enroll_stage', // parity module 67: the stage whose entry enrolls (team: Owner/Admin; an agent: own agent playbook)
  'lead_email_review.view', // module 22 lead-email slice: the "Needs review" list of held lead emails (Owner/Admin/Team Lead; support read-only)
  'lead_email_review.decide', // module 22 lead-email slice: accept a held lead email as a lead (same intake path) or discard it
  'mail_sync.manage', // module 68 (D2): the Owner turns Gmail sync on (only while platform:gmail is cleared) and sets the window; an Admin may only turn it off (DB guard; DATA_MODEL §8)
  'owner_view.view', // module 33: the owner view (dollars by source, costs, velocity, forecast): human Owner/Admin only (R-OWNER-1, DATA_MODEL §8)
  'source_cost.edit', // module 33: manual lead-source costs (Owner/Admin as themselves; re-auth for a closed month, R-OWNER-5)
  'goal.view', // module 33: goals and pace (DATA_MODEL agent_goals: self, TL of the user, Owner/Admin)
  'goal.manage', // module 33: create, change or remove a goal (Owner/Admin any member; TL their team)
  'coaching.view', // module 36: the caller's own daily fix and its quotes (R-COACH-3, R-COACH-4; Call reviews row: own calls)
  'coaching.team_view', // module 36: a team's current fixes (Owner/Admin; a Team Lead only while the Owner's tl_sees_call_scores is on, DB-enforced)
  'coaching.settings', // module 36: call scoring on/off, Team Lead visibility, rubric items (Owner; an Admin may only turn call reviews off; widening needs 🔒)
  'milestone.confirm', // module 31 (DATA_MODEL §8 "Confirm or move a milestone date"): plan, confirm, enter, move, complete a deal date
  'milestone_template.manage', // module 31: tenant milestone templates (not a §8 row: Owner/Admin, flagged; R-TXN-6)
  'cma.prepare', // module 71 (D9): prepare, edit or view a CMA (DATA_MODEL §8: ✅ | ✅ | T | O | — | — | —; R-CMA-6)
  'document.upload', // module 42: upload a deal document or a new version (milestone.confirm's grants: Owner, Admin, TL T, agent own/deal, TC deal)
  'document.upload_listing', // module 42: upload a listing document (listing.edit's grants)
  'document.upload_contact', // module 42: upload a contact document (contact.edit's grants without the system)
  'document.view', // module 42: list and read documents (RLS decides which: R-DOC-1, R-DOC-3); support reads metadata
  'document.download', // module 42: stream a clean document's bytes (never support; R-DOC-7)
  'document.share', // module 42: share a clean deal/listing document to the portal (Owner, Admin, TL T, agent own; DB re-checks)
  'document.hold', // module 42 (DATA_MODEL §8 "Legal hold, shorten document retention"): Owner, Admin
  'ads.view', // module 52: the ads page and ledger (human Owner/Admin only; no support, no system: R-ADS-10, DATA_MODEL §8)
  'ads.cap_set', // module 52: a new ad cap version (the Owner, as themselves, re-authenticated, attested: R-ADS-1)
  'ads.shift_decide', // module 52: approve or reject an ad_reallocation (Owner/Admin, one tap each: D-ADS, R-AST-21)
  'ads.campaign_manage', // module 52: link a campaign to a listing and its creative, resume a paused campaign (Owner/Admin)
  'settings.ai_isa', // module 75 (D12 proposed): the AI ISA tenant switch and daily cap (Owner on/raise 🔒 + attestation; Admin off/lower only; DB guard)
  'ai_isa.optin', // module 75: an agent opts in to the AI ISA for their own leads (🔒 on create or widen; never TC or the human ISA role, Q-ISA-8)
  'ai_isa.view', // module 75: "Under AI care" and the per-lead panel (✅ | ✅ | T | O | O | — ; support read-only)
  'ai_isa.start', // module 75: start (or continue) AI care on a lead: the lead's current owner only, as themselves (Q-ISA-9)
  'ai_isa.pause', // module 75: pause AI care (✅ | ✅ | T | O | own | —; Q-ISA-18)
  'ai_isa.resume', // module 75: resume AI care: the lead's owner only (R-ISA-15)
  'ai_isa.control', // module 75: take over or end AI care, and their 10 s undo (✅ | ✅ | T | own | — | —)
  'ai_isa.handoff', // module 75: acknowledge a handoff, resolve a held topic (✅ | ✅ | T | own | — | —)
  // registry: add new entries above this line
] as const;
export type Action = (typeof ACTIONS)[number];

export function isAction(s: string): s is Action {
  return (ACTIONS as readonly string[]).includes(s);
}

// ---- audit actions ----------------------------------------------------------------------------

/**
 * Actions written to audit_log (`^[a-z_]+\.[a-z_.]+$`). R-AUDIT-5 requires every one of the listed
 * kinds to be audited; api/platform's `audit()` accepts only these.
 */
export const AUDIT_ACTIONS = [
  // session
  'session.login',
  'session.logout',
  'session.tenant_switched',
  // membership
  'member.invited',
  'member.invite_revoked',
  'member.role_changed',
  'member.suspended',
  'member.reactivated',
  'member.removed',
  'member.auto_paused', // R-OWN-12
  'member.resumed',
  // human ownership commands (mirror of the ledger; written by applyOwnershipCommand only)
  'ownership.create',
  'ownership.accept',
  'ownership.decline',
  'ownership.claim',
  'ownership.release',
  'ownership.assign',
  'ownership.reassign',
  'ownership.isa_handoff',
  'ownership.close',
  'ownership.reopen',
  'ownership.soft_delete',
  'ownership.merge',
  'ownership.deactivate_owner',
  'ownership.import_assign',
  'ownership.drift_detected', // R-OWN-4
  // consent
  'consent.recorded',
  'consent.opt_out_received',
  'consent.not_opt_out_marked', // R-CONSENT-8
  'consent.reaction_quote_not_read', // R-REACT-3 (D5b)
  'consent.reaction_link_refused', // R-REACT-5 (D5b)
  'suppression.lifted',
  // recordings
  'recording.play',
  'recording.download',
  'transcript.view',
  // imports
  'import.approved',
  'import.committed',
  'import.verified',
  'import.reverted',
  // contacts
  'contact.deleted',
  'contact.restored',
  'contact.merged',
  'contact.erase', // literal used by app.erase_contact in 0001
  'data.exported',
  // settings, policy, routing
  'settings.changed',
  'policy.version_created',
  'policy.activated',
  'routing.changed',
  'pond.changed',
  'team.changed',
  'number.acquired',
  'number.released',
  'domain.changed',
  // assistant
  'playbook.approved',
  'playbook.revoked',
  'draft.approved_with_edits',
  // accountability
  'exception.resolved',
  'exception.reassigned',
  'exception.verified',
  // support
  'support.granted',
  'support.revoked',
  // definer-function maintenance commands
  'definer.maintenance',
  'session.mfa_enrolled', // api/platform: TOTP enrollment confirmed (R-PERM-14)
  'member.alert_phone_verified', // api/platform: alert phone set after code verification (E54)
  'member.deactivation_started', // api/leads: staged deactivation stage 1 (R-OWN-22); completion is member.removed
  'automation.resumed', // api/comms: a human resumed paused automation for a contact (R-AST-9)
  'sender_registration.changed', // api/comms: 10DLC / toll-free registration created or its status refreshed
  'enrollment.changed', // api/assistant: a human enrolled / paused / stopped a contact in a playbook (the assistant then sends on their behalf)
  'saved_search.approved', // api/assistant: a human approved (or activated) saved-search criteria; alerts follow (R-AST-10)
  'deal.financials_changed', // api/workspace: commission fields of a deal written by a human (A7d, R-PERM-10)
  'listing.agent_changed', // api/workspace: an Owner/Admin handed a team listing to another active member (b7 ownership-data/F2)
  'exception.reopened', // api/accountability: a handled exception put back in the live queue (R-ACC-3)
  'session.revoked_all', // api/platform: "log out of all sessions" revoked every live session of the user
  'mfa.recovery_codes_regenerated', // api/platform: the user replaced their MFA recovery codes
  'message.held_send', // api/comms: the sender tapped Send anyway on a message held because the client replied (E27); dispatch still checks it
  'message.held_cancel', // api/comms: the sender canceled a scheduled or held message
  'deal.contact_removed', // lane rule-coverage: the Owner removed a person from a deal before erasure (E59)
  'assistant.output_blocked', // lane prompt-injection: a model output was discarded (wiring details, oversized, not the contract); codes only
  'assistant.output_flagged', // lane prompt-injection: a model draft needs a check (human claim, unsourced link/phone/email, hidden characters); codes only
  'job.retried', // lane ops-observability: an Owner/Admin retried a failed or dead job from the System page
  'job.cancelled', // lane ops-observability: an Owner/Admin cancelled a waiting job from the System page
  'integration.connect_started', // api/integrations: an Owner/Admin started an OAuth connect (R-INT-3)
  'integration.connected', // api/integrations: the provider callback proved control and linked the account (system)
  'integration.connect_refused', // api/integrations: the callback refused (E160 account not managed, live elsewhere, stale state)
  'integration.disconnected', // api/integrations: an Owner/Admin disconnected; credential revoked in the same tx (R-INT-5)
  'integration.changed', // api/integrations: rename or lead source of a connection
  'integration.credential_saved', // mls/spark: an Owner/Admin saved or replaced the Spark key (linked by the system; never the token)
  'integration.validated', // mls/spark: the validation probe's result code (never a response body)
  'contact.update', // parity 57: PATCH /contacts/:id (field names only for PII, R-PAR-43)
  'note.delete', // parity 57: a note deleted (R-PAR-4)
  'collaborator.added', // parity 57: a collaborator added (incl. mention "Share", R-PAR-2)
  'collaborator.removed', // parity 57: a collaborator removed
  'duplicate.dismissed', // api/duplicates: a member marked a duplicate suggestion "not the same person"
  'duplicate.restored', // api/duplicates: Undo of a dismiss
  'tag.rename', // parity api/lists: a tag renamed or recolored (names are PII-classed in the diff)
  'tag.merge', // parity api/lists: a tag merged into another (counts moved, lists rewritten)
  'tag.delete', // parity api/lists: a tag deleted (link count)
  'tag.protect', // parity api/lists: fair-housing protection set or lifted (lifting: Owner only)
  'custom_field.created', // parity api/lists: a custom field defined
  'custom_field.changed', // parity api/lists: label, options or position changed
  'custom_field.archived', // parity api/lists: a custom field archived or restored
  'smart_list.team_changed', // parity api/lists: a team list created, changed or archived
  'template.created', // parity module 63: a template was created (ids, scope, channel; no text)
  'template.updated', // parity module 63: a template's content or name changed (version; text redacted)
  'template.archived', // parity module 63: a template was archived
  'bulk.created', // parity module 63: a bulk action draft was built (kind, counts; no PII)
  'bulk.confirmed', // parity module 63: the creator confirmed a bulk action (frozen target count)
  'bulk.canceled', // parity module 63: a bulk action was canceled (creator or Owner/Admin)
  'bulk.completed', // parity module 63: a bulk action finished (counts by reason)
  'settings.batch_text_changed', // parity module 63: batch text turned on (Owner, re-auth + attestation) or off
  'member.signature_changed', // parity module 63: a member changed their own email signature (text redacted)
  'lead_email.inbox_enabled', // module 22 lead-email slice: an Owner/Admin turned on a lead source's inbound address (key created by the system)
  'lead_email.key_rotated', // module 22 lead-email slice: the inbound address was rotated; the old key routes nothing from then on
  'lead_email.sender_domains_changed', // module 22 lead-email slice: the allowlisted DKIM sender domains of an inbox changed
  'lead_email.review_accepted', // module 22 lead-email slice: a held lead email was accepted as a lead (through intake)
  'lead_email.review_discarded', // module 22 lead-email slice: a held lead email was discarded (its content purged)
  'webchat.widget_created', // module 22: an Owner/Admin created a website chat widget (its key is shown once)
  'webchat.widget_key_rotated', // module 22: the widget key was replaced; the old embed stops working at once
  'webchat.widget_origins_changed', // module 22: the websites a widget may run on changed
  'lead_source.webhook_rotated', // module 22: a lead source's intake URL token and signing secret were replaced (both shown once)
  'google_lead_form.enabled', // module 22: an Owner/Admin turned on a source's Google Ads lead form webhook (key made by the system)
  'google_lead_form.key_rotated', // module 22: the Google lead form key was replaced; the old key is retired forever
  'google_lead_form.changed', // module 22: the Google lead form's inquiry type or consent setting changed
  'google_lead_form.disabled', // module 22: the Google lead form was turned off; its key is retired forever
  'number.lead_source_changed', // module 22: a tracking number was tied to, moved between or untied from lead sources (R-TRK-1)
  'mail.link_connected', // module 68 (D2): the Gmail OAuth callback (system) linked a user's own mailbox (no address, no content)
  'mail.link_disconnected', // module 68: the user disconnected their Gmail (token deleted, copies hidden at once)
  'mail.link_revoked', // module 68: the sync revoked a link (member inactive, switch off, pack uncleared, provider revoked)
  'mail.import_again', // module 68: the user asked to re-run the backfill window (R-GMAIL-8)
  'mail.thread_excluded', // module 68: the mailbox owner removed a thread from Realty OS (R-GMAIL-7; no content)
  'mail.sync_points_confirmed', // module 68: the mailbox owner confirmed client addresses for sync (S-D2-1; counts only)
  'mail.sync_point_removed', // module 68: the mailbox owner stopped syncing an address (S-D2-2)
  'mail.settings_changed', // module 68: the Owner switch or the backfill window changed (R-GMAIL-1, -8)
  'marketing.approved', // module 29: a person approved a marketing piece version (bound to its content hash)
  'marketing.page_published', // module 29: a listing page went live (or moved to a newer approved version)
  'marketing.publish_requested', // module 29: a person tapped Publish to a Facebook Page / Instagram account (TX1)
  'marketing.publication_recorded', // module 29: the system recorded the provider's outcome of a publication (TX2, reconcile)
  'marketing.exported', // module 29: a piece was handed to the agent (export; never a claim that it was posted)
  'marketing.retract_requested', // module 29: a person asked to take an external post down (TX1; recorded before any provider call)
  'marketing.retracted', // module 29: a page taken down, or an external post deleted after the provider confirmed it
  'marketing.invites_sent', // module 29: open-house invites sent as per-recipient gated emails (counts only)
  'calendar.connected', // module 34: a person's own calendar linked after they approved at the provider (system; no token, no calendar id)
  'calendar.disconnected', // module 34: the person disconnected their calendar; token purged in the same tx (R-INT-5)
  'calendar.link_revoked', // module 34: the system revoked and purged a link (GRANT_REVOKED E102, MEMBER_REMOVED R-INT-5)
  'source_cost.changed', // module 33: a manual lead-source cost entered or changed (amounts in cents, the month; closed months need re-auth)
  'goal.changed', // module 33: a goal created, changed or removed (member, period, metric, target)
  'coaching.settings_changed', // module 36: the Owner changed call scoring, Team Lead visibility or the rubric items, or an Admin turned call reviews off (values only)
  'cma.near_match_dismissed', // module 71 (D9): the agent confirmed a live MLS listing is a different home than the CMA's subject (listing ids only; F2)
  'document.uploaded', // module 42: a document or version uploaded (kind, version, size, type; never the name)
  'document.scanned', // module 42: the system recorded the virus check's verdict (status, reason, engine)
  'document.shared', // module 42: a person shared a clean document to the client portal
  'document.unshared', // module 42: a person stopped sharing it (downloads stop at once)
  'document.hold_placed', // module 42: an Owner or Admin placed a legal hold (reason)
  'document.hold_lifted', // module 42: an Owner or Admin lifted it (reason)
  'document.retention_changed', // module 42: an Owner or Admin set the retention date (before and after)
  'document.downloaded', // module 42: a person downloaded a clean document (ids only)
  'ads.cap_set', // module 52: the Owner set a new ad cap version (amounts in cents, version; R-ADS-1)
  'ads.shift_approved', // module 52: an Owner/Admin approved a budget shift; its planned rows are written in the same transaction (run id, counts)
  'ads.shift_rejected', // module 52: an Owner/Admin rejected a budget shift
  'ads.campaign_linked', // module 52: an Owner/Admin linked a campaign to a listing and an approved creative (ids only)
  'ads.campaign_resumed', // module 52: an Owner/Admin resumed a paused campaign (one approved one-change shift; run id)
  'ads.campaign_paused', // module 52: the system paused a campaign at the monthly cap (R-ADS-5; run id, cap version)
  'ai_isa.tenant_enabled', // module 75 (D12 proposed): codes only, never content
  'ai_isa.tenant_disabled', // module 75 (D12 proposed): codes only, never content
  'ai_isa.tenant_cap_changed', // module 75 (D12 proposed): codes only, never content
  'ai_isa.optin_created', // module 75 (D12 proposed): codes only, never content
  'ai_isa.optin_narrowed', // module 75 (D12 proposed): codes only, never content
  'ai_isa.optin_superseded', // module 75 (D12 proposed): codes only, never content
  'ai_isa.optin_revoked', // module 75 (D12 proposed): codes only, never content
  'ai_isa.assignment_started', // module 75 (D12 proposed): codes only, never content
  'ai_isa.assignment_paused', // module 75 (D12 proposed): codes only, never content
  'ai_isa.assignment_resumed', // module 75 (D12 proposed): codes only, never content
  'ai_isa.assignment_taken_over', // module 75 (D12 proposed): codes only, never content
  'ai_isa.assignment_ended', // module 75 (D12 proposed): codes only, never content
  'ai_isa.pause_all', // module 75 (D12 proposed): codes only, never content
  'ai_isa.undo', // module 75 (D12 proposed): codes only, never content
  'ai_isa.slot_booked', // module 75 (D12 proposed): codes only, never content
  'ai_isa.booking_refused', // module 75 (D12 proposed): codes only, never content
  'ai_isa.handoff_created', // module 75 (D12 proposed): codes only, never content
  'ai_isa.handoff_acknowledged', // module 75 (D12 proposed): codes only, never content
  'ai_isa.system_paused', // module 75 (D12 proposed): codes only, never content
  'ai_isa.system_ended', // module 75 (D12 proposed): codes only, never content
  'ai_isa.block_lifted', // module 75 (D12 proposed): codes only, never content
  'ai_isa.escalation_resolved', // module 75 (D12 proposed): codes only, never content
  'ai_isa.hold_started', // module 75 (D12 proposed): codes only, never content
  'ai_isa.hold_ended', // module 75 (D12 proposed): codes only, never content
  'voice.answering_changed', // module 48: the Owner turned AI answering on (attested) or an Owner/Admin turned it off (codes only)
  'voice.session_ended', // module 48: an AI-answered call ended in its one handback (outcome and end reason codes only)
  'voice.test_call', // module 48: a scripted test call against the fake (in memory; nothing placed or saved)
  'voice.handback_recovered', // module 48: voice.reconcile wrote the recovery handback of a call whose session was lost
  // registry: add new entries above this line
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_RE = /^[a-z_]+\.[a-z_.]+$/;

export function isAuditAction(s: string): s is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(s);
}

// ---- resource facts and decisions ------------------------------------------------------------

/** Re-authentication window for sensitive actions (R-PERM-13). */
export const REAUTH_WINDOW_MS = 15 * MINUTE_MS;

/**
 * What the caller knows about the resource, from RLS-visible rows in the request transaction.
 * Relationship flags describe the ACTOR's relation to the resource; absent means false.
 */
export interface ResourceFacts {
  /** The resource's tenant. When present it must equal the actor's tenant. */
  tenantId?: TenantId;
  /** The actor's own: contact/lead owner, deal owner, own draft, own playbook, own exception, own scoreboard row. */
  own?: boolean;
  /** The actor is a live collaborator on the contact. */
  collaborator?: boolean;
  /** Owned by / offered to / assigned to a member of a team the actor leads. */
  team?: boolean;
  /** Visible to the actor as a pond card (a pond they may claim from; Team Leads: any pond). */
  pond?: boolean;
  /** Offered to the actor (offer card / own offer). */
  offer?: boolean;
  /** The actor is a member of a deal on this contact, or of this deal. */
  deal?: boolean;
  /** The actor was the agent on this call (recordings, transcripts). */
  onCall?: boolean;
  /** The playbook is a team playbook (not a personal one). */
  teamPlaybook?: boolean;
  /** Purpose of the outbound communication (TCs: informational only). */
  purpose?: 'informational' | 'marketing';
  /** Reassign / handoff target, or the member acted on (role = current role). */
  target?: { role: Role; inMyTeam?: boolean; newRole?: Role };
  /** Compliance policy change: true when anything is looser than the current version. Absent = looser. */
  loosening?: boolean;
  /** An Owner loosening attestation accompanies the change. */
  attested?: boolean;
  /** suppressions.reason of the suppression being lifted. */
  suppressionReason?: string;
  /** A deal edit touches only deal dates (TC). */
  datesOnly?: boolean;
  /** Tenant settings that widen a cell. Absent = off (fail closed). */
  settings?: { teamLeadRecordingAccess?: boolean; tcRecordingAccess?: boolean; agentConsentEntryAllowed?: boolean };
  /** Source-cost edit: the month has ended in the tenant's zone (a closed month). Absent = closed (fail closed). */
  closedPeriod?: boolean;
  /** Session re-authentication state, required for 🔒 actions. Absent = not re-authenticated. */
  reauth?: { reauthenticatedAt: Instant | null; now: Instant };
}

export type DenyCode =
  | 'NOT_FOUND'
  | 'REAUTH_REQUIRED'
  | 'OWNER_REQUIRED'
  | 'ATTESTATION_REQUIRED'
  | 'SUPPRESSION_NOT_LIFTABLE'
  | 'PURPOSE_NOT_PERMITTED'
  | 'FIELDS_NOT_PERMITTED'
  | 'TARGET_NOT_ELIGIBLE';

export type CanResult = { ok: true } | { ok: false; code: DenyCode; reauth?: true };

// ---- the matrix -------------------------------------------------------------------------------

/** Relationship scopes. A grant allows the action when ANY of its scopes holds. */
type Scope = 'all' | 'own' | 'collab' | 'team' | 'pond' | 'offer' | 'deal' | 'on_call' | 'team_playbook';
type SettingKey = keyof NonNullable<ResourceFacts['settings']>;
type ScopeEntry = Scope | readonly [Scope, SettingKey];

type Check =
  | 'informational_only' // TC communication
  | 'dates_only' // TC deal edit
  | 'not_owner_target' // Admin on member actions
  | 'not_loosening' // Admin on compliance policy
  | 'attest_when_loosening' // Owner on compliance policy
  | 'target_in_team' // Team Lead reassign
  | 'handoff_target' // ISA handoff
  | 'not_team_playbook'; // personal playbooks only

interface Grant {
  scopes: readonly ScopeEntry[];
  checks?: readonly Check[];
  /** The cell needs a setting that is on (e.g. agent consent entry). */
  setting?: SettingKey;
  /** 🔒: 'always', only when the compliance change is loosening, or only for a closed period (source costs). */
  reauth?: 'always' | 'when_loosening' | 'when_closed_period';
}

type ActionCheck = 'liftable' | 'target_can_own';

interface ActionRule {
  roles: Partial<Record<Role, Grant>>;
  /** System vias that may perform the action (tenant-wide). Absent: never the system actor. */
  system?: readonly SystemVia[];
  /** Support (read-only, tenant-wide with a live grant) may perform it. */
  support?: true;
  /** Checks that apply to every actor that passed the role/relationship stage. */
  checks?: readonly ActionCheck[];
}

const ALL_VIAS: readonly SystemVia[] = ['timer', 'provider', 'assistant', 'import', 'worker'];

const ALL: Grant = { scopes: ['all'] };
const ALL_REAUTH: Grant = { scopes: ['all'], reauth: 'always' };
const OWN: Grant = { scopes: ['own'] };
const OFFER: Grant = { scopes: ['offer'] };
const POND: Grant = { scopes: ['pond'] };
const DEAL: Grant = { scopes: ['deal'] };
/** T: own + team members' (collaborating counts as own). */
const T: Grant = { scopes: ['own', 'collab', 'team'] };
/** O: own / collaborating. */
const O: Grant = { scopes: ['own', 'collab'] };
/** Recording scope `own` (R-PERM-8): the contact owner or the agent on the call. */
const REC_OWN: readonly ScopeEntry[] = ['own', 'on_call'];

const TENANT_WIDE_READ = { owner: ALL, admin: ALL } as const;

/**
 * DATA_MODEL §3, cell by cell. The matrix test (authz.test.ts) carries the §3 table verbatim and
 * checks every cell against this table.
 */
const MATRIX: Record<Action, ActionRule> = {
  // View contact card: ✅ | ✅ | T + P | O + P + Off + D | O + P + Off | D
  'contact.view': {
    roles: { ...TENANT_WIDE_READ, team_lead: { scopes: ['own', 'collab', 'team', 'pond'] }, agent: { scopes: ['own', 'collab', 'pond', 'offer', 'deal'] }, isa: { scopes: ['own', 'collab', 'pond', 'offer'] }, tc: DEAL },
    system: ALL_VIAS,
    support: true,
  },
  // View phones, emails, timeline, history: ✅ | ✅ | T + pond | O + D | O | D
  'contact.view_detail': {
    roles: { ...TENANT_WIDE_READ, team_lead: { scopes: ['own', 'collab', 'team', 'pond'] }, agent: { scopes: ['own', 'collab', 'deal'] }, isa: O, tc: DEAL },
    system: ALL_VIAS,
    support: true,
  },
  // Create contact (owned by self): ✅ ✅ ✅ ✅ ✅ —
  'contact.create': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL }, system: ['provider', 'import', 'worker'] },
  // Accept/decline own offer: ✅ ✅ ✅ ✅ ✅ —
  'lead.accept': { roles: { owner: OFFER, admin: OFFER, team_lead: OFFER, agent: OFFER, isa: OFFER } },
  'lead.decline': { roles: { owner: OFFER, admin: OFFER, team_lead: OFFER, agent: OFFER, isa: OFFER } },
  // Claim from pond: — (assigns) | — (assigns) | ✅ | ✅ | ✅ | —
  'lead.claim': { roles: { team_lead: POND, agent: POND, isa: POND } },
  // Release own lead: ✅ ✅ ✅ ✅ ✅ —
  'lead.release': { roles: { owner: OWN, admin: OWN, team_lead: OWN, agent: OWN, isa: OWN } },
  // Reassign: ✅ | ✅ | within team | — | handoff own → agent/TL | —
  'lead.reassign': {
    roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['own', 'team'], checks: ['target_in_team'] }, isa: { scopes: ['own'], checks: ['handoff_target'] } },
    system: ['worker', 'import'], // deactivation (R-OWN-22) and import assignment
    checks: ['target_can_own'], // R-PERM-15
  },
  // Text/email/call: ✅ | ✅ | T | O | O | D (informational)
  'comms.send': {
    roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O, tc: { scopes: ['deal'], checks: ['informational_only'] } },
    system: ['assistant', 'timer', 'worker', 'provider'], // imports never send (ARCHITECTURE §9.10)
  },
  'comms.call': {
    // Phase 1 has no AI-originated calls (R-GATE-9): no system actor.
    roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O, tc: { scopes: ['deal'], checks: ['informational_only'] } },
  },
  // Approve own drafts and handbacks: ✅ for every role (own)
  'draft.approve': { roles: { owner: OWN, admin: OWN, team_lead: OWN, agent: OWN, isa: OWN, tc: OWN } },
  // Approve playbooks: team + own | team + own | own | own | own | —
  'playbook.approve': {
    roles: {
      owner: { scopes: ['team_playbook', 'own'] },
      admin: { scopes: ['team_playbook', 'own'] },
      team_lead: { scopes: ['own'], checks: ['not_team_playbook'] },
      agent: { scopes: ['own'], checks: ['not_team_playbook'] },
      isa: { scopes: ['own'], checks: ['not_team_playbook'] },
    },
  },
  // Play recording / read transcript: ✅ | ✅ | T (setting on) | O / on-call | O / on-call | D (setting off)
  // Scopes follow app.recording_scope() (R-PERM-8): own = contact owner or agent on the call.
  'recording.play': {
    roles: { ...TENANT_WIDE_READ, team_lead: { scopes: [...REC_OWN, ['team', 'teamLeadRecordingAccess']] }, agent: { scopes: REC_OWN }, isa: { scopes: REC_OWN }, tc: { scopes: [...REC_OWN, ['deal', 'tcRecordingAccess']] } },
  },
  'transcript.view': {
    roles: { ...TENANT_WIDE_READ, team_lead: { scopes: [...REC_OWN, ['team', 'teamLeadRecordingAccess']] }, agent: { scopes: REC_OWN }, isa: { scopes: REC_OWN }, tc: { scopes: [...REC_OWN, ['deal', 'tcRecordingAccess']] } },
  },
  // Record consent (agent entry ≤ express): ✅ | ✅ | T | O (setting on) | O (setting on) | —
  'consent.record': {
    roles: { owner: ALL, admin: ALL, team_lead: T, agent: { ...O, setting: 'agentConsentEntryAllowed' }, isa: { ...O, setting: 'agentConsentEntryAllowed' } },
    system: ['provider', 'import', 'worker'],
  },
  // Lift suppression (not spam complaint): ✅ | ✅ | — | — | — | —
  'suppression.lift': { roles: { owner: ALL, admin: ALL }, checks: ['liftable'] },
  // Reinstate an opt-out: person's own action only (START, new disclosed form, signed document),
  // processed by the system from the provider/intake. No staff role can (R-CONSENT-10).
  'consent.reinstate': { roles: {}, system: ['provider'] },
  // Deals view / edit: ✅/✅ | ✅/✅ | T/T | O+D/O | D/— | D/dates
  'deal.view': { roles: { ...TENANT_WIDE_READ, team_lead: T, agent: { scopes: ['own', 'collab', 'deal'] }, isa: DEAL, tc: DEAL }, system: ALL_VIAS, support: true },
  'deal.edit': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, tc: { scopes: ['deal'], checks: ['dates_only'] } } },
  // Commission (deal_financials): ✅ | ✅ | T | own deals | — | —. Human actors only (R-PERM-10).
  'deal.financials': { roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['own', 'team'] }, agent: OWN } },
  // Listings view / edit: ✅/✅ | ✅/✅ | ✅/✅ | ✅/own | ✅/— | ✅/—
  'listing.view': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL, tc: ALL }, system: ALL_VIAS, support: true },
  'listing.edit': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: OWN } },
  // b7 ownership-data/F2: a listing keeps its agent when the member leaves; an Owner/Admin hands it to an active member
  'listing.reassign': { roles: { owner: ALL, admin: ALL } },
  // Imports (CSV, FUB): ✅ 🔒 | ✅ 🔒 | — …
  'import.run': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // Routing, ponds, teams, numbers, domains: ✅ | ✅ | — …  (number release is 🔒 per R-PERM-13)
  'settings.routing': { roles: { owner: ALL, admin: ALL } },
  'settings.numbers': { roles: { owner: ALL, admin: ALL } },
  'number.release': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // Compliance policy: ✅ (looser needs 🔒 + attestation) | stricter only | — …
  'settings.compliance': {
    roles: { owner: { scopes: ['all'], checks: ['attest_when_loosening'], reauth: 'when_loosening' }, admin: { scopes: ['all'], checks: ['not_loosening'] } },
  },
  // Brokerage identity, recording settings, MFA roles: ✅ 🔒 | — …
  'settings.identity': { roles: { owner: ALL_REAUTH } },
  // Invite/remove users, change roles: ✅ 🔒 | ✅ 🔒 (not Owners) | — …
  'member.invite': { roles: { owner: ALL_REAUTH, admin: { scopes: ['all'], checks: ['not_owner_target'], reauth: 'always' } } },
  'member.role': { roles: { owner: ALL_REAUTH, admin: { scopes: ['all'], checks: ['not_owner_target'], reauth: 'always' } } },
  'member.suspend': { roles: { owner: ALL_REAUTH, admin: { scopes: ['all'], checks: ['not_owner_target'], reauth: 'always' } } },
  'member.remove': { roles: { owner: ALL_REAUTH, admin: { scopes: ['all'], checks: ['not_owner_target'], reauth: 'always' } } },
  // TL exception queue view / resolve / reassign / verify: ✅ | ✅ | T | own/own/—/— | own/own/—/— | —
  'exception.view': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN, isa: OWN }, system: ALL_VIAS, support: true },
  'exception.resolve': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN, isa: OWN } },
  'exception.reassign': { roles: { owner: ALL, admin: ALL, team_lead: T } },
  'exception.verify': { roles: { owner: ALL, admin: ALL, team_lead: T } },
  // Scoreboard: ✅ | ✅ | T | self | self | —
  'scoreboard.view': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN, isa: OWN }, system: ALL_VIAS, support: true },
  // Audit log: ✅ | ✅ | ownership ledger for T | — …
  'audit.view': { roles: { owner: ALL, admin: ALL }, support: true },
  'ownership_ledger.view': { roles: { owner: ALL, admin: ALL, team_lead: T }, support: true },
  // Erase a contact (privacy): ✅ 🔒 | ✅ 🔒 | — …
  'contact.erase': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // Exports: not a §3 row; R-PERM-13 requires re-auth. Owner/Admin only (fail closed).
  'data.export': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // Grant support access: ✅ 🔒 | — …  Revoking only ever reduces access: Owner, no re-auth.
  'support.grant': { roles: { owner: ALL_REAUTH } },
  'support.revoke': { roles: { owner: ALL } },
  // System page (lane ops-observability; not a §3 row): Owner/Admin only, like the audit log. Support
  // access stays out (fail closed); job commands only ever re-run or stop the tenant's own idempotent jobs.
  'system.view': { roles: { owner: ALL, admin: ALL } },
  'system.jobs': { roles: { owner: ALL, admin: ALL } },
  // Phase 2 integrations (DATA_MODEL §8): Owner/Admin read; create, rename, connect and disconnect are 🔒.
  // Linking an external account is never an Action: only the provider callback does it, as the system.
  'integration.view': { roles: { owner: ALL, admin: ALL } },
  'integration.manage': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // module 68 (D2): Owner turns Gmail sync on and sets the window; Admin turns it off only (enforced by the 0025 tenant_settings guard). 🔒 both.
  'mail_sync.manage': { roles: { owner: ALL_REAUTH, admin: ALL_REAUTH } },
  // Module 33 (DATA_MODEL §8): Owner view ✅ | ✅ | — …; Source costs ✅ | ✅ (re-auth for closed months) | — ….
  // Human actors only: no system via and no support (R-OWNER-1: the system never reads financials or manual costs).
  // The closed-month re-auth applies to both Owner and Admin (PHASE2_3_PLAN §5.4 states it for the route).
  'owner_view.view': { roles: { owner: ALL, admin: ALL } },
  'source_cost.edit': { roles: { owner: { scopes: ['all'], reauth: 'when_closed_period' }, admin: { scopes: ['all'], reauth: 'when_closed_period' } } },
  // Module 52 (DATA_MODEL §8 ads rows): human Owner/Admin only; no system via and no support (a support session reads the
  // ownerless ad_reallocation rows through RLS only, never through these routes). The cap is the Owner's, 🔒 always.
  'ads.view': { roles: { owner: ALL, admin: ALL } },
  'ads.cap_set': { roles: { owner: ALL_REAUTH } },
  'ads.shift_decide': { roles: { owner: ALL, admin: ALL } },
  'ads.campaign_manage': { roles: { owner: ALL, admin: ALL } },
  // Goals (agent_goals RLS: self, the user's TL, tenant-wide): view self / TL own+team / Owner, Admin all; manage:
  // Owner/Admin any member, a TL the members of a team they lead (RLS goals_write decides the row set).
  'goal.view': { roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['own', 'team'] }, agent: OWN, isa: OWN, tc: OWN } },
  'goal.manage': { roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['team'] } } },
  // Module 22 lead-email slice (DATA_MODEL §8 lead-email row, R-LEM-6): the held-email list. Team Leads triage it too;
  // support reads it (read-only) and never decides. The system never "decides" (it holds or creates on arrival).
  'lead_email_review.view': { roles: { owner: ALL, admin: ALL, team_lead: ALL }, support: true },
  'lead_email_review.decide': { roles: { owner: ALL, admin: ALL, team_lead: ALL } },
  // FUB parity (DATA_MODEL §12 capability matrix; not §3 rows). Each module tests its own row.
  // note.write: ✅ | ✅ | T + pond detail | O + D | O | D
  'note.write': { roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['own', 'collab', 'team', 'pond'] }, agent: { scopes: ['own', 'collab', 'deal'] }, isa: O, tc: DEAL } },
  // note.delete: ✅ (any) | ✅ (any) | own | own | own | own  (own = the actor wrote the note)
  'note.delete': { roles: { owner: ALL, admin: ALL, team_lead: OWN, agent: OWN, isa: OWN, tc: OWN } },
  // activity.log: ✅ | ✅ | T | O | O | —
  'activity.log': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O } },
  // collaborator.manage (existing RLS): ✅ | ✅ | ✅ | contact owner | — | —
  'collaborator.manage': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: OWN } },
  // settings.stage_labels: ✅ | ✅ | — …
  'settings.stage_labels': { roles: { owner: ALL, admin: ALL } },
  // FUB parity (DATA_MODEL §12). contact.edit: ✅ | ✅ | T | O | O | —
  'contact.edit': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O }, system: ['import'] },
  // tag.create (by typing): ✅ ✅ ✅ ✅ ✅ —; tag.manage: ✅ ✅ — — — —
  'tag.create': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL }, system: ['import'] },
  'tag.manage': { roles: { owner: ALL, admin: ALL } },
  // custom_field.manage: ✅ ✅ — — — — (imports define fields as the system)
  'custom_field.manage': { roles: { owner: ALL, admin: ALL }, system: ['import'] },
  // smart_list.personal: ✅ ✅ ✅ ✅ ✅ ✅ (D: a TC's runs return deal contacts only, by RLS); team_manage: ✅ ✅ ✅ — — —
  'smart_list.personal': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL, tc: ALL } },
  'smart_list.team_manage': { roles: { owner: ALL, admin: ALL, team_lead: ALL } },
  // FUB parity (DATA_MODEL §12). template.personal: ✅ for every role (own templates only, RLS).
  'template.personal': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL, tc: ALL } },
  // template.team_manage: ✅ | ✅ | — … (Q-PAR-4: Team Leads copy to personal)
  'template.team_manage': { roles: { owner: ALL, admin: ALL } },
  // bulk.run (tag, untag, stage, enroll, email), per person: ✅ | ✅ | T | O | O | —
  'bulk.run': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O } },
  // bulk.assign: ✅ | ✅ | T (to team members) | — | — | —; never to a TC (R-PERM-15)
  'bulk.assign': { roles: { owner: ALL, admin: ALL, team_lead: { scopes: ['own', 'collab', 'team'], checks: ['target_in_team'] } }, checks: ['target_can_own'] },
  // bulk.text: ✅ | ✅ | T | O | O | — (and the Owner's switch, checked by the API and the DB)
  'bulk.text': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O } },
  // settings.batch_text: ✅ 🔒 (on needs re-auth + attestation) | off only | — … ("loosening" = turning it on)
  'settings.batch_text': { roles: { owner: { scopes: ['all'], checks: ['attest_when_loosening'], reauth: 'when_loosening' }, admin: { scopes: ['all'], checks: ['not_loosening'] } } },
  // playbook.auto_enroll_stage (R-PAR-16): team ✅ | team ✅ | — | own agent playbook | — | —
  'playbook.auto_enroll_stage': { roles: { owner: { scopes: ['team_playbook'] }, admin: { scopes: ['team_playbook'] }, agent: { scopes: ['own'], checks: ['not_team_playbook'] } } },
  // Module 36 (DATA_MODEL Part 2 matrix "Call reviews": ✅ | ✅ | T only if tl_sees_call_scores | own calls | own calls | — | —).
  // coaching.view is the caller's own fix (every role that takes calls). coaching.team_view lets a Team Lead ask; what
  // they then read is decided by call_scores RLS (only while the Owner's setting is on).
  'coaching.view': { roles: { owner: OWN, admin: OWN, team_lead: OWN, agent: OWN, isa: OWN } },
  'coaching.team_view': { roles: { owner: ALL, admin: ALL, team_lead: T } },
  // Coaching settings (owner decision 2026-11-11, the Gmail sync rule): ✅ 🔒 | off only | — … The Owner changes them;
  // turning anything on (scoring, Team Lead visibility) is widening and needs re-auth, turning it off does not. An
  // Admin acts only when nothing loosens, with no re-auth (off only tightens); the API lets an Admin turn call reviews
  // off and nothing else, and the DB trigger refuses anyone else.
  'coaching.settings': { roles: { owner: { scopes: ['all'], reauth: 'when_loosening' }, admin: { scopes: ['all'], checks: ['not_loosening'] } } },
  // Module 31 (DATA_MODEL §8): Confirm or move a milestone date: ✅ | ✅ | T | O / D | — | D. The agent cell reads as
  // "own deals or deals they are a member of" (deals have no collaborators); a person only, never the system (R-TXN-1).
  'milestone.confirm': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: { scopes: ['own', 'deal'] }, tc: DEAL } },
  // Milestone templates (R-TXN-6; §8 names no role): Owner/Admin, like the other tenant settings. Flagged for the owner.
  'milestone_template.manage': { roles: { owner: ALL, admin: ALL } },
  // Module 71 (D9, DATA_MODEL §8 "Prepare, edit or view a CMA"): ✅ | ✅ | T | O | — | — | —. A person only, never the system;
  // support reads through RLS only (R-CMA-6).
  'cma.prepare': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O } },
  // Module 42 (PHASE2_3_PLAN §5.4 #42). Each upload action mirrors an existing row so a TC never reaches contact
  // documents through contactFacts.deal: deal documents as milestone.confirm, listing documents as listing.edit,
  // contact documents as contact.edit without the system. A person only; the DB binds the uploader (0069).
  'document.upload': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: { scopes: ['own', 'deal'] }, tc: DEAL } },
  'document.upload_listing': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: OWN } },
  'document.upload_contact': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: O } },
  // what a role reads is RLS's (documents_select, documents_clean_only); support lists metadata but never downloads
  'document.view': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL, tc: ALL }, support: true },
  'document.download': { roles: { owner: ALL, admin: ALL, team_lead: ALL, agent: ALL, isa: ALL, tc: ALL } },
  // DATA_MODEL §8 (sharing as publishing): ✅ | ✅ | T | own deals/listings | — | — (TCs and ISAs never share)
  'document.share': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN } },
  // DATA_MODEL §8 "Legal hold, shorten document retention": ✅ | ✅ | — …
  'document.hold': { roles: { owner: ALL, admin: ALL } },
  // module 75 (D12 proposed; docs/AI_ISA.md §3.5). The DB guards are the backstop: only the Owner turns the switch
  // on (tenant_settings_ai_isa_guard), only the owner starts and resumes (ai_isa_assignments_guard).
  'settings.ai_isa': { roles: { owner: { scopes: ['all'], checks: ['attest_when_loosening'], reauth: 'when_loosening' }, admin: { scopes: ['all'], checks: ['not_loosening'] } } },
  'ai_isa.optin': { roles: { owner: { scopes: ['all'], reauth: 'when_loosening' }, admin: { scopes: ['all'], reauth: 'when_loosening' }, team_lead: { scopes: ['all'], reauth: 'when_loosening' }, agent: { scopes: ['all'], reauth: 'when_loosening' } } },
  'ai_isa.view': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: OWN }, system: ['assistant', 'worker'], support: true },
  'ai_isa.start': { roles: { owner: OWN, admin: OWN, team_lead: OWN, agent: OWN } },
  'ai_isa.pause': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: O, isa: OWN }, system: ['assistant', 'worker', 'timer'] },
  'ai_isa.resume': { roles: { owner: OWN, admin: OWN, team_lead: OWN, agent: OWN } },
  'ai_isa.control': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN }, system: ['assistant', 'worker', 'timer'] },
  'ai_isa.handoff': { roles: { owner: ALL, admin: ALL, team_lead: T, agent: OWN } },
};

const DENY_NOT_FOUND: CanResult = { ok: false, code: 'NOT_FOUND' };
const ALLOW: CanResult = { ok: true };

function scopeHolds(scope: Scope, f: ResourceFacts): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'own':
      return f.own === true;
    case 'collab':
      return f.collaborator === true;
    case 'team':
      return f.team === true;
    case 'pond':
      return f.pond === true;
    case 'offer':
      return f.offer === true;
    case 'deal':
      return f.deal === true;
    case 'on_call':
      return f.onCall === true;
    case 'team_playbook':
      return f.teamPlaybook === true;
  }
}

function settingOn(key: SettingKey, f: ResourceFacts): boolean {
  return f.settings?.[key] === true;
}

function anyScope(scopes: readonly ScopeEntry[], f: ResourceFacts): boolean {
  return scopes.some((entry) => {
    if (typeof entry === 'string') return scopeHolds(entry, f);
    const [scope, setting] = entry;
    return settingOn(setting, f) && scopeHolds(scope, f);
  });
}

function runCheck(check: Check, f: ResourceFacts): DenyCode | null {
  switch (check) {
    case 'informational_only':
      return f.purpose === 'informational' ? null : 'PURPOSE_NOT_PERMITTED';
    case 'dates_only':
      return f.datesOnly === true ? null : 'FIELDS_NOT_PERMITTED';
    case 'not_owner_target':
      if (!f.target) return 'TARGET_NOT_ELIGIBLE';
      return f.target.role === 'owner' || f.target.newRole === 'owner' ? 'OWNER_REQUIRED' : null;
    case 'not_loosening':
      return f.loosening === false ? null : 'OWNER_REQUIRED';
    case 'attest_when_loosening':
      return f.loosening === false || f.attested === true ? null : 'ATTESTATION_REQUIRED';
    case 'target_in_team':
      return f.target?.inMyTeam === true ? null : 'TARGET_NOT_ELIGIBLE';
    case 'handoff_target':
      return f.target && (f.target.role === 'agent' || f.target.role === 'team_lead') ? null : 'TARGET_NOT_ELIGIBLE';
    case 'not_team_playbook':
      return f.teamPlaybook === true ? 'NOT_FOUND' : null;
  }
}

function runActionCheck(check: ActionCheck, f: ResourceFacts): DenyCode | null {
  switch (check) {
    case 'liftable':
      // R-CONSENT-9: a spam complaint is never liftable; an unknown reason fails closed.
      return typeof f.suppressionReason === 'string' && f.suppressionReason !== 'spam_complaint' ? null : 'SUPPRESSION_NOT_LIFTABLE';
    case 'target_can_own':
      // R-PERM-15: a lead can never be reassigned to a TC.
      return f.target && canOwnLeads(f.target.role) ? null : 'TARGET_NOT_ELIGIBLE';
  }
}

function reauthFresh(f: ResourceFacts): boolean {
  const r = f.reauth;
  if (!r || r.reauthenticatedAt === null) return false;
  const age = r.now - r.reauthenticatedAt;
  return age >= 0 && age <= REAUTH_WINDOW_MS;
}

/**
 * Authorizes `actor` to perform `action` on a resource described by `resource` (DATA_MODEL §3).
 * Pure and total: unknown or missing facts deny.
 */
export function can(actor: Actor, action: Action, resource: ResourceFacts): CanResult {
  const rule = MATRIX[action];
  if (!rule) return DENY_NOT_FOUND;
  if (resource.tenantId !== undefined && resource.tenantId !== actor.tenantId) return DENY_NOT_FOUND;

  if (actor.kind === 'system') {
    if (!rule.system?.includes(actor.via)) return DENY_NOT_FOUND;
    return finish(rule, resource);
  }
  if (actor.kind === 'support') {
    // R-PERM-11: read-only; the grant's validity is established when the support session resolves.
    return rule.support ? finish(rule, resource) : DENY_NOT_FOUND;
  }

  const grant = rule.roles[actor.role];
  if (!grant) return DENY_NOT_FOUND;
  if (grant.setting && !settingOn(grant.setting, resource)) return DENY_NOT_FOUND;
  if (!anyScope(grant.scopes, resource)) return DENY_NOT_FOUND;
  for (const check of grant.checks ?? []) {
    const code = runCheck(check, resource);
    if (code) return { ok: false, code };
  }
  const actionCode = actionChecks(rule, resource);
  if (actionCode) return { ok: false, code: actionCode };

  const needsReauth =
    grant.reauth === 'always' ||
    (grant.reauth === 'when_loosening' && resource.loosening !== false) ||
    (grant.reauth === 'when_closed_period' && resource.closedPeriod !== false);
  if (needsReauth && !reauthFresh(resource)) return { ok: false, code: 'REAUTH_REQUIRED', reauth: true };
  return ALLOW;
}

function actionChecks(rule: ActionRule, f: ResourceFacts): DenyCode | null {
  for (const check of rule.checks ?? []) {
    const code = runActionCheck(check, f);
    if (code) return code;
  }
  return null;
}

function finish(rule: ActionRule, f: ResourceFacts): CanResult {
  const code = actionChecks(rule, f);
  return code ? { ok: false, code } : ALLOW;
}

/** Whether the action is 🔒 for this role in any case (UI: prompt for re-auth before the tap). */
export function requiresReauth(role: Role, action: Action): boolean {
  const g = MATRIX[action].roles[role];
  return g?.reauth === 'always' || g?.reauth === 'when_loosening' || g?.reauth === 'when_closed_period';
}
