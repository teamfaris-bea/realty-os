// Admin request and response schemas (BUILD_PLAN module 10). Response schemas are snapshot-tested:
// no confidence* fields and no tenant id anywhere (R-AST-13, R-TEN-3). Request schemas are strict, so
// an extra `tenant_id` (or anything else) is a 422, and they never accept a tenant id (R-TEN-3).
import { ROLES } from '@realty/core/foundation';
import { z } from 'zod';

export const RoleEnum = z.enum(ROLES);
export const Uuid = z.uuid();
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'HH:MM');
export const Label = z.string().trim().min(1).max(120);

// ---- members and invites ---------------------------------------------------------------------

export const Member = z.object({
  userId: Uuid,
  displayName: z.string(),
  email: z.string(),
  role: RoleEnum,
  status: z.enum(['invited', 'active', 'suspended', 'deactivating', 'removed']),
  acceptingLeads: z.boolean(),
  mfaEnabled: z.boolean(),
  joinedAt: z.string().nullable(),
  version: z.number().int(),
});

export const Invite = z.object({
  id: Uuid,
  email: z.string(),
  role: RoleEnum,
  invitedByUserId: Uuid,
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const MembersResponse = z.object({ members: z.array(Member), invites: z.array(Invite) });
/** emailSent is honest: false when the account mailer failed (the invite exists; revoke and resend). */
export const InviteCreatedResponse = z.object({ invite: Invite, emailSent: z.boolean() });
export const MemberResponse = z.object({ member: Member });

// ---- routing rules ---------------------------------------------------------------------------

export const RuleMember = z.object({ userId: Uuid, weight: z.number().int().min(1).max(100) });

export const RoutingRule = z.object({
  id: Uuid,
  position: z.number().int(),
  name: z.string(),
  /** routing_rules.match as stored: { sources?, lead_types?, zips?, price_min?, price_max? } (cents) */
  match: z.record(z.string(), z.unknown()),
  strategy: z.enum(['round_robin', 'weighted', 'direct', 'pond']),
  directUserId: Uuid.nullable(),
  targetPondId: Uuid.nullable(),
  fallbackPondId: Uuid.nullable(),
  offerWindowSeconds: z.number().int().nullable(),
  maxOffers: z.number().int().nullable(),
  enabled: z.boolean(),
  archived: z.boolean(),
  version: z.number().int(),
  members: z.array(RuleMember),
});

export const RoutingRulesResponse = z.object({ rules: z.array(RoutingRule) });
export const RoutingRuleResponse = z.object({ rule: RoutingRule });

// ---- ponds and teams -------------------------------------------------------------------------

export const PondRole = z.enum(['agent', 'team_lead', 'isa']);

export const Pond = z.object({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  openToAll: z.boolean(),
  eligibleRoles: z.array(PondRole),
  claimsPerDay: z.number().int(),
  claimCooldownHours: z.number().int(),
  reinquiry: z.enum(['reroute', 'stay']),
  archived: z.boolean(),
  memberUserIds: z.array(Uuid),
  /** leads waiting in this pond now (a count with nothing hidden behind it) */
  waitingLeads: z.number().int(),
});

export const PondsResponse = z.object({ ponds: z.array(Pond) });
export const PondResponse = z.object({ pond: Pond });

export const Team = z.object({
  id: Uuid,
  name: z.string(),
  isDefault: z.boolean(),
  members: z.array(z.object({ userId: Uuid, isLead: z.boolean() })),
});

export const TeamsResponse = z.object({ teams: z.array(Team) });
export const TeamResponse = z.object({ team: Team });

// ---- settings and identity -------------------------------------------------------------------

export const Settings = z.object({
  version: z.number().int(),
  defaultTimezone: z.string(),
  routingHoursStart: z.string(),
  routingHoursEnd: z.string(),
  offerWindowSeconds: z.number().int(),
  maxOffers: z.number().int(),
  firstTouchSlaSeconds: z.number().int(),
  firstTouchReleaseSeconds: z.number().int().nullable(),
  reinquirySlaAfterDays: z.number().int(),
  inactivityReleaseDays: z.number().int().nullable(),
  inactivityWarningHours: z.number().int(),
  autoPauseAfterMisses: z.number().int(),
  uncontactedCapacityCap: z.number().int(),
  isaAccessAfterHandoffDays: z.number().int(),
  recordingRetentionDays: z.number().int(),
  teamLeadRecordingAccess: z.boolean(),
  tcRecordingAccess: z.boolean(),
  notificationDetail: z.enum(['none', 'first_name_initial']),
  aiEnabled: z.boolean(),
  activePolicyId: Uuid,
  identity: z.object({
    brokerageLegalName: z.string(),
    teamName: z.string().nullable(),
    brokerageLicenseNumber: z.string().nullable(),
    brokeragePostalAddress: z.string().nullable(),
    /** what marketing still needs: the postal address is required before any marketing email (R-GATE-12) */
    missing: z.array(z.enum(['brokerage_postal_address'])),
  }),
});

export const SettingsResponse = z.object({ settings: Settings });

// ---- compliance policy -----------------------------------------------------------------------

export const AUTONOMOUS_CATEGORY_VALUES = ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'document_chase', 'nurture_step', 'search_alert'] as const;

export const PolicyValues = z.object({
  autonomousCategories: z.array(z.enum(AUTONOMOUS_CATEGORY_VALUES)),
  optOutConfirmationSender: z.enum(['provider', 'platform']),
  recordingEnabled: z.boolean(),
  recordingMode: z.enum(['announce_all', 'one_party_where_permitted']),
});

export const PolicyVersion = PolicyValues.extend({
  id: Uuid,
  versionNo: z.number().int(),
  attested: z.boolean(),
  createdByUserId: Uuid.nullable(),
  createdAt: z.string(),
  active: z.boolean(),
});

export const PoliciesResponse = z.object({
  activePolicyId: Uuid,
  versions: z.array(PolicyVersion),
  /** shipped defaults (strict) */
  defaults: PolicyValues,
  /** the exact sentence an Owner confirms for a looser policy (VERIFY WITH COUNSEL) */
  attestationText: z.string(),
  /** jurisdiction packs in force and whether counsel reviewed them; the UI says so plainly */
  counsel: z.object({
    allReviewed: z.boolean(),
    packs: z.array(z.object({ key: z.string(), version: z.string(), reviewedByCounselAt: z.string().nullable() })),
  }),
});

export const PolicyCreatedResponse = z.object({
  id: Uuid,
  versionNo: z.number().int(),
  loosening: z.boolean(),
  loosenedFields: z.array(z.string()),
  active: z.boolean(),
});

export const PolicyActivatedResponse = z.object({ activePolicyId: Uuid, loosening: z.boolean(), changed: z.boolean() });

export const OkResponse = z.object({ ok: z.literal(true) });

/** Every response schema the admin routes use (schema snapshot test). */
export const ADMIN_RESPONSE_SCHEMAS = {
  MembersResponse,
  InviteCreatedResponse,
  MemberResponse,
  RoutingRulesResponse,
  RoutingRuleResponse,
  PondsResponse,
  PondResponse,
  TeamsResponse,
  TeamResponse,
  SettingsResponse,
  PoliciesResponse,
  PolicyCreatedResponse,
  PolicyActivatedResponse,
  OkResponse,
} as const;
