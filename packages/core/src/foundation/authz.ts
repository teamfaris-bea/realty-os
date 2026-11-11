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
  /** 🔒: 'always', or only when the compliance change is loosening. */
  reauth?: 'always' | 'when_loosening';
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

  const needsReauth = grant.reauth === 'always' || (grant.reauth === 'when_loosening' && resource.loosening !== false);
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
  return g?.reauth === 'always' || g?.reauth === 'when_loosening';
}
