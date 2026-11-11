// Response shapes of the endpoints the lead-admin surfaces call. They mirror the API's Zod response
// schemas (apps/web may import @realty/api types only, and the web package does not depend on it):
//   api/accountability  apps/api/src/accountability/schemas.ts
//   api/admin           apps/api/src/admin/schemas.ts
//   api/leads           apps/api/src/leads/schemas.ts (lead sources, deactivation)
//   api/comms           apps/api/src/comms/schemas.ts (numbers, registrations, domains, identities)
//   api/assistant       apps/api/src/assistant/schemas.ts (playbooks)
//   api/imports         apps/api/src/imports/schemas.ts
// None of them carries a confidence field (R-AST-13), so none appears here either.

// ---- accountability -----------------------------------------------------------------------------

export type ExceptionType = 'untouched_lead' | 'overdue_promise' | 'failed_send' | 'missing_outcome';
export type ExceptionAction = 'resolved' | 'reassigned' | 'verified' | 'reopened';

export interface Person {
  userId: string;
  name: string | null;
}

export interface ExceptionEvidence {
  sourceType: string;
  sourceId: string;
  explanation: string;
  at: string | null;
  locator: Record<string, unknown> | null;
  snippet: string | null;
  needsReview: boolean;
  link: { kind: 'contact' | 'message' | 'call' | 'task' | 'appointment'; id: string; contactId: string | null; offsetMs: number | null } | null;
}

export interface ExceptionEvent {
  action: ExceptionAction;
  note: string | null;
  actor: Person;
  at: string;
}

export interface ExceptionItem {
  id: string;
  dedupeKey: string;
  itemType: ExceptionType;
  subjectType: string;
  subjectId: string;
  contact: { id: string; name: string } | null;
  owner: Person | null;
  detectedAt: string;
  dueAt: string | null;
  ageSeconds: number;
  conditionClearedAt: string | null;
  live: boolean;
  evidence: ExceptionEvidence[];
  /** untouched_lead: whether the missed ownership period is still the lead's current one (false once it moved on) */
  period?: { current: boolean } | null;
  /** the contact's ownership ledger head when the queue was read: sent back with a reassign (stale-UI fence) */
  contactOwnershipSeq: number | null;
  latestEvent: ExceptionEvent | null;
  actions: { resolve: boolean; reassign: boolean; verify: boolean; reopen: boolean };
}

export interface QueueResponse {
  items: ExceptionItem[];
  counts: { live: number; byType: Record<ExceptionType, number> };
  generatedAt: string;
}

export interface ItemResponse {
  item: ExceptionItem;
  events: ExceptionEvent[];
}

export type RangeKey = 'today' | '7d' | '30d' | '90d';

export interface Scoreboard {
  userId: string;
  name: string | null;
  speedToLead: { medianSeconds: number | null; withinSla: number; total: number; responded: number; pending: number };
  touches: { count: number; calls: number; textsAndEmails: number; days: number };
  appointmentsSet: { count: number; days: number };
  appointmentsHeld: { count: number; of: number };
  agreementsSigned: { count: number; days: number };
}

export interface RangeView {
  key: RangeKey;
  from: string;
  to: string;
  days: number;
  zone: string;
}

export interface MomentumNorm {
  medianDays: number;
  sample: number;
  enough: boolean;
}

export interface MomentumResponse {
  rule: { factor: number; minSample: number; windowDays: number };
  norms: (MomentumNorm & { stage: string })[];
  agents: {
    userId: string;
    name: string | null;
    openDeals: number;
    slowDeals: number;
    stages: { stage: string; slow: number; norm: MomentumNorm | null; deals: { dealId: string; name: string; stageEnteredAt: string; dwellDays: number; slow: boolean }[] }[];
  }[];
  generatedAt: string;
}

// ---- admin --------------------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

export interface Member {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  status: 'invited' | 'active' | 'suspended' | 'deactivating' | 'removed';
  acceptingLeads: boolean;
  mfaEnabled: boolean;
  joinedAt: string | null;
  version: number;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MembersResponse {
  members: Member[];
  invites: Invite[];
}

export interface Deactivation {
  userId: string;
  mode: 'preview' | 'run';
  status: string;
  destination: 'team_lead' | 'default_pond' | 'reroute';
  owned: number;
  offered: number;
  ownedWithOpenDeal: number;
  teamLead: { userId: string; displayName: string | null } | null;
  fallbackUserId: string;
  deactivationId: string | null;
}

export type Strategy = 'round_robin' | 'weighted' | 'direct' | 'pond';

export interface RoutingMatch {
  sources?: string[];
  lead_types?: string[];
  zips?: string[];
  price_min?: number;
  price_max?: number;
}

export interface RoutingRule {
  id: string;
  position: number;
  name: string;
  match: RoutingMatch & Record<string, unknown>;
  strategy: Strategy;
  directUserId: string | null;
  targetPondId: string | null;
  fallbackPondId: string | null;
  offerWindowSeconds: number | null;
  maxOffers: number | null;
  enabled: boolean;
  archived: boolean;
  version: number;
  members: { userId: string; weight: number }[];
}

export interface Pond {
  id: string;
  name: string;
  isDefault: boolean;
  openToAll: boolean;
  eligibleRoles: ('agent' | 'team_lead' | 'isa')[];
  claimsPerDay: number;
  claimCooldownHours: number;
  reinquiry: 'reroute' | 'stay';
  archived: boolean;
  memberUserIds: string[];
  waitingLeads: number;
}

export interface Team {
  id: string;
  name: string;
  isDefault: boolean;
  members: { userId: string; isLead: boolean }[];
}

export interface LeadSource {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  hasToken: boolean;
  createdAt: string;
}

export interface Settings {
  version: number;
  defaultTimezone: string;
  routingHoursStart: string;
  routingHoursEnd: string;
  offerWindowSeconds: number;
  maxOffers: number;
  firstTouchSlaSeconds: number;
  firstTouchReleaseSeconds: number | null;
  reinquirySlaAfterDays: number;
  inactivityReleaseDays: number | null;
  inactivityWarningHours: number;
  autoPauseAfterMisses: number;
  uncontactedCapacityCap: number;
  isaAccessAfterHandoffDays: number;
  recordingRetentionDays: number;
  teamLeadRecordingAccess: boolean;
  tcRecordingAccess: boolean;
  notificationDetail: 'none' | 'first_name_initial';
  aiEnabled: boolean;
  activePolicyId: string;
  identity: {
    brokerageLegalName: string;
    teamName: string | null;
    brokerageLicenseNumber: string | null;
    brokeragePostalAddress: string | null;
    missing: 'brokerage_postal_address'[];
  };
}

export const AUTONOMOUS_CATEGORIES = ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'document_chase', 'nurture_step', 'search_alert'] as const;
export type AutonomousCategory = (typeof AUTONOMOUS_CATEGORIES)[number];

/**
 * The tenant compliance policy fields (api/admin PolicyValues). core-compliance/2.0.0 (owner decision)
 * removed the contact window / quiet hours, the human-reply window and the frequency caps.
 */
export interface PolicyValues {
  autonomousCategories: AutonomousCategory[];
  optOutConfirmationSender: 'provider' | 'platform';
  recordingEnabled: boolean;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
}

export interface PolicyVersion extends PolicyValues {
  id: string;
  versionNo: number;
  attested: boolean;
  createdByUserId: string | null;
  createdAt: string;
  active: boolean;
}

export interface PoliciesResponse {
  activePolicyId: string;
  versions: PolicyVersion[];
  defaults: PolicyValues;
  attestationText: string;
  counsel: { allReviewed: boolean; packs: { key: string; version: string; reviewedByCounselAt: string | null }[] };
}

export interface PolicyCreated {
  id: string;
  versionNo: number;
  loosening: boolean;
  loosenedFields: string[];
  active: boolean;
}

// ---- comms admin --------------------------------------------------------------------------------

export interface PhoneNumber {
  id: string;
  e164: string;
  purpose: string;
  numberType: string;
  assignedUserId: string | null;
  registrationId: string | null;
  registrationStatus: string | null;
  smsCapable: boolean;
  voiceCapable: boolean;
  releasedAt: string | null;
}

export interface Registration {
  id: string;
  kind: string;
  status: string;
  useCase: string;
  statusChangedAt: string;
}

export interface SendingDomain {
  id: string;
  domain: string;
  spf: string;
  dkim: string;
  dmarc: string;
  verifiedAt: string | null;
  records: { type: string; name: string; value: string }[];
}

export interface EmailIdentity {
  id: string;
  fromAddress: string;
  displayName: string;
  userId: string | null;
  domainId: string | null;
}

// ---- playbooks ----------------------------------------------------------------------------------

export interface PlaybookStepView {
  stepKey: string;
  channel: 'sms' | 'email';
  delay: { anchor: 'enrollment' | 'previous_step' | 'event'; offsetSeconds: number };
  purpose: 'marketing' | 'informational';
  category: string;
  intent: string;
  template: string;
  subject?: string;
  personalization: 'none' | 'light';
  slots: string[];
  maxLength: number;
  stopIf: string[];
  requires?: string[];
  fallback?: { subject: string; template: string; maxLength: number };
}

export interface PlaybookVersion {
  id: string;
  versionNo: number;
  status: string;
  contentSha256: string;
  steps: unknown[];
  tone: Record<string, unknown>;
  issues: { index: number; stepKey?: string; code: string; detail?: string }[];
  createdAt: string;
}

export interface Playbook {
  id: string;
  kind: string;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  name: string;
  templateKey: string | null;
  approvedVersionId: string | null;
  versions: PlaybookVersion[];
}

// ---- imports ------------------------------------------------------------------------------------

export type ImportCategory = 'contacts' | 'ownership' | 'notes' | 'messages' | 'call_recordings' | 'consent';
export const IMPORT_CATEGORIES: readonly ImportCategory[] = ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'];

export interface ImportIssue {
  code: string;
  severity: string;
  field: string | null;
  sentence: string;
}

export interface ImportStage {
  id: string;
  category: ImportCategory;
  seq: number;
  status: string;
  counts: { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number } | null;
  dryRunSha256: string | null;
  dryRunCompletedAt: string | null;
  blockers: ImportIssue[];
  approvedAt: string | null;
  approvedByUserId: string | null;
  committedAt: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  revert: Record<string, unknown> | null;
}

export interface ImportBatch {
  id: string;
  source: 'csv' | 'fub_api' | 'fub_export';
  status: string;
  sourceCounts: Record<string, number | null>;
  snapshotSha256: string | null;
  snapshotAt: string | null;
  snapshotError: string | null;
  fileLabel: string | null;
  csv: { headers: string[]; mapping: unknown[] } | null;
  createdAt: string;
  createdByUserId: string;
  revertedAt: string | null;
  stages: ImportStage[];
  connectionTest: string[];
}

export type MappingTarget = { kind: 'user'; userId: string | null } | { kind: 'pond'; pondId: string | null } | { kind: 'unassigned' } | null;

export interface MappingsResponse {
  users: { sourceRef: string; label: string; people: number; target: MappingTarget }[];
  ponds: { sourceRef: string; label: string; people: number; target: MappingTarget }[];
  unmapped: number;
  complete: boolean;
}

export interface ImportRecord {
  id: string;
  sourceRef: string;
  outcome: string;
  dryRunOutcome: string | null;
  planned: string | null;
  issues: ImportIssue[];
  record: Record<string, unknown> | null;
  matchContactId: string | null;
  duplicateCandidates: { contactId: string; reason: string }[];
  optOutNote: string | null;
  review: { decision: string; byUserId: string | null; mergeIntoContactId: string | null } | null;
  targetId: string | null;
}

export interface ImportCounts {
  source: number;
  imported: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
}

export interface VerificationResponse {
  expected: ImportCounts;
  db: ImportCounts;
  matches: boolean;
  diffs: { key: string; source: number; db: number }[];
  sample: { sourceRef: string; recordId: string; source: Record<string, unknown>; imported: Record<string, unknown> | null; same: boolean }[];
}

export interface ReportResponse {
  source: string;
  categories: {
    category: ImportCategory;
    status: string;
    phase: 'dry_run' | 'committed' | 'reverted';
    source: number;
    imported: number;
    needsReview: number;
    rejected: number;
    duplicate: number;
    reconciles: boolean;
    lines: string[];
  }[];
}
