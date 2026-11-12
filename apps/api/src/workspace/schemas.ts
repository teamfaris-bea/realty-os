// Zod request/response schemas of api/workspace (BUILD_PLAN module 14).
//
// R-TEN-3: no input carries a tenant id (bodies are strict, so an extra `tenant_id` is a 422).
// R-AST-13: no response carries a confidence field; assistant-made work shows evidence and needs-review
// flags instead. The feed shows reasons, not its internal score. Snapshot-tested in schemas.test.ts.
import { OneTapActionSchema } from '@realty/core/priority';
import { z } from 'zod';

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });
const localDate = z.iso.date();
const cents = z.number().int().min(0).max(1e13);

export const IdParams = z.object({ id: uuid });

// ---- feed ---------------------------------------------------------------------------------------------

const Reason = z.object({ code: z.string(), label: z.string() });
export const FeedCardSchema = z.object({
  id: uuid,
  itemType: z.string(),
  band: z.enum(['pinned', 'scored']),
  dueAt: z.string().nullable(),
  contact: z.object({ id: uuid, name: z.string() }).nullable(),
  /** a task or promise card: the task it is about (its title is what the card asks for) */
  task: z.object({ id: uuid, title: z.string() }).nullable(),
  reasons: z.array(Reason).min(1),
  primaryAction: OneTapActionSchema,
  alternatives: z.array(OneTapActionSchema),
  subjectType: z.string(),
  subjectId: z.string(),
  assistantActionId: z.string().nullable(),
  createdAt: z.string(),
});
export const FeedResponse = z.object({ pinned: z.array(FeedCardSchema), scored: z.array(FeedCardSchema), total: z.number().int().min(0), generatedAt: z.string() });
export const SnoozeBody = z.strictObject({ until: isoDate });
export const FeedActionResponse = z.object({ item: z.object({ id: uuid, state: z.string(), snoozedUntil: z.string().nullable() }) });

// ---- evidence (assistant-made tasks) -----------------------------------------------------------------

export const EvidenceSchema = z.object({
  sourceType: z.string(),
  sourceId: z.string(),
  locator: z.record(z.string(), z.unknown()),
  snippet: z.string().nullable(),
  verified: z.boolean(),
  sourceAvailable: z.boolean(),
  label: z.string(),
});

// ---- tasks ----------------------------------------------------------------------------------------------

const TaskKind = z.enum(['todo', 'callback', 'promise', 'follow_up', 'document']);
export const TaskSchema = z.object({
  id: uuid,
  kind: TaskKind,
  title: z.string(),
  notes: z.string().nullable(),
  dueAt: z.string().nullable(),
  dueAllDay: z.boolean(),
  dueTz: z.string().nullable(),
  status: z.enum(['open', 'done', 'canceled']),
  completedAt: z.string().nullable(),
  assigneeUserId: uuid,
  contact: z.object({ id: uuid, name: z.string() }).nullable(),
  dealId: uuid.nullable(),
  listingId: uuid.nullable(),
  createdByKind: z.enum(['user', 'assistant', 'system', 'import']),
  /** an assistant-made promise whose date it could not pin: the agent sets it ("Check this") */
  needsReview: z.boolean(),
  /** where an assistant-made task came from (the claim's evidence), null for tasks people made */
  source: z.object({ actionId: uuid.nullable(), claimText: z.string().nullable(), evidence: z.array(EvidenceSchema) }).nullable(),
  createdAt: z.string(),
});
export const TaskResponse = z.object({ task: TaskSchema });
export const TasksResponse = z.object({ tasks: z.array(TaskSchema) });
export const TasksQuery = z.strictObject({
  status: z.enum(['open', 'done', 'canceled', 'all']).optional(),
  contactId: uuid.optional(),
  dealId: uuid.optional(),
  /** default: the caller's own tasks; `visible` lists every task the caller can see (RLS) */
  scope: z.enum(['mine', 'visible']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const CreateTaskBody = z
  .strictObject({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(['todo', 'callback', 'follow_up', 'document']).optional(),
    notes: z.string().max(5000).nullable().optional(),
    dueAt: isoDate.nullable().optional(),
    dueAllDay: z.boolean().optional(),
    dueTz: z.string().min(1).max(64).nullable().optional(),
    contactId: uuid.nullable().optional(),
    dealId: uuid.nullable().optional(),
    listingId: uuid.nullable().optional(),
    assigneeUserId: uuid.optional(),
  })
  .refine((b) => !b.dueAllDay || (b.dueAt != null && b.dueTz != null), { message: 'an all-day task needs dueAt and dueTz', path: ['dueTz'] });
export const UpdateTaskBody = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().max(5000).nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  dueAllDay: z.boolean().optional(),
  dueTz: z.string().min(1).max(64).nullable().optional(),
  status: z.enum(['open', 'done', 'canceled']).optional(),
  assigneeUserId: uuid.optional(),
});

// ---- appointments ----------------------------------------------------------------------------------------

const ApptKind = z.enum(['buyer_consult', 'listing_appointment', 'consult', 'other']);
export const AppointmentSchema = z.object({
  id: uuid,
  kind: ApptKind,
  startsAt: z.string(),
  endsAt: z.string(),
  location: z.string().nullable(),
  status: z.enum(['scheduled', 'held', 'no_show', 'canceled', 'rescheduled']),
  outcome: z.enum(['agreement_signed', 'follow_up', 'not_a_fit', 'no_decision']).nullable(),
  outcomeNote: z.string().nullable(),
  outcomeLoggedAt: z.string().nullable(),
  userId: uuid,
  contact: z.object({ id: uuid, name: z.string() }).nullable(),
  dealId: uuid.nullable(),
  /** ended, not canceled, and no outcome logged yet */
  awaitingOutcome: z.boolean(),
  createdByKind: z.enum(['user', 'assistant', 'system', 'import']),
});
export const AppointmentResponse = z.object({ appointment: AppointmentSchema });
export const AppointmentsResponse = z.object({ appointments: z.array(AppointmentSchema) });
export const AppointmentsQuery = z.strictObject({ from: isoDate.optional(), to: isoDate.optional(), contactId: uuid.optional(), awaitingOutcome: z.enum(['true', 'false']).optional() });
export const CreateAppointmentBody = z
  .strictObject({
    kind: ApptKind,
    startsAt: isoDate,
    endsAt: isoDate,
    location: z.string().max(300).nullable().optional(),
    contactId: uuid.nullable().optional(),
    dealId: uuid.nullable().optional(),
    userId: uuid.optional(),
  })
  .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export const UpdateAppointmentBody = z.strictObject({
  startsAt: isoDate.optional(),
  endsAt: isoDate.optional(),
  location: z.string().max(300).nullable().optional(),
  status: z.enum(['scheduled', 'canceled', 'rescheduled']).optional(),
});
export const OutcomeBody = z.strictObject({
  result: z.enum(['agreement_signed', 'follow_up', 'not_a_fit', 'no_decision', 'no_show']),
  note: z.string().trim().max(2000).nullable().optional(),
});

// ---- deals ------------------------------------------------------------------------------------------------

const DealStage = z.enum(['prospect', 'agreement_signed', 'active', 'under_contract', 'closed', 'lost']);
const DealSide = z.enum(['buy', 'sell', 'dual', 'lease']);
const DealDateKind = z.enum(['acceptance', 'inspection', 'appraisal', 'financing', 'closing', 'possession', 'custom']);
export const DealDateSchema = z.object({ id: uuid, kind: DealDateKind, label: z.string().nullable(), dueOn: z.string(), completedAt: z.string().nullable() });
export const DealSchema = z.object({
  id: uuid,
  name: z.string(),
  side: DealSide,
  stage: DealStage,
  stageEnteredAt: z.string(),
  primaryContact: z.object({ id: uuid, name: z.string() }).nullable(),
  ownerUserId: uuid,
  listingId: uuid.nullable(),
  priceCents: z.number().int().nullable(),
  expectedCloseDate: z.string().nullable(),
  agreementSignedAt: z.string().nullable(),
  underContractAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  lostReason: z.string().nullable(),
  /** closed-loop attribution copied from the contact when the deal was created; never changes (A7d) */
  attribution: z.object({ leadSourceId: uuid.nullable(), leadSourceName: z.string().nullable(), campaignRef: z.string().nullable(), adRef: z.string().nullable(), sourceInquiryId: uuid.nullable() }),
  rowVersion: z.number().int(),
  createdAt: z.string(),
});
export const DealDetailSchema = DealSchema.extend({
  dates: z.array(DealDateSchema),
  members: z.array(z.object({ userId: uuid, role: z.enum(['co_agent', 'tc', 'isa']) })),
  // module 31 (finding 9): every deal_contacts role 0018 allows, lender, title and attorney included
  contacts: z.array(z.object({ contactId: uuid, role: z.enum(['buyer', 'seller', 'co_buyer', 'co_seller', 'other', 'lender', 'title', 'attorney']) })),
  history: z.array(z.object({ fromStage: z.string().nullable(), toStage: z.string(), changedAt: z.string(), byUserId: uuid.nullable() })),
});
export const DealResponse = z.object({ deal: DealDetailSchema });
export const DealsResponse = z.object({ deals: z.array(DealSchema) });
export const DealsQuery = z.strictObject({ stage: DealStage.optional(), open: z.enum(['true', 'false']).optional(), contactId: uuid.optional(), mine: z.enum(['true', 'false']).optional() });
export const CreateDealBody = z.strictObject({
  primaryContactId: uuid,
  name: z.string().trim().min(1).max(200).optional(),
  side: DealSide,
  contactRole: z.enum(['buyer', 'seller', 'co_buyer', 'co_seller', 'other']).optional(),
  listingId: uuid.nullable().optional(),
  priceCents: cents.nullable().optional(),
  expectedCloseDate: localDate.nullable().optional(),
  ownerUserId: uuid.optional(),
});
export const UpdateDealBody = z.strictObject({
  rowVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  listingId: uuid.nullable().optional(),
  priceCents: cents.nullable().optional(),
  expectedCloseDate: localDate.nullable().optional(),
});
export const StageBody = z.strictObject({ rowVersion: z.number().int().min(1), stage: DealStage, lostReason: z.string().trim().min(1).max(300).optional() });
export const FinancialsSchema = z.object({
  grossCommissionCents: z.number().int().nullable(),
  commissionRateBps: z.number().int().nullable(),
  teamSplitBps: z.number().int().nullable(),
  agentSplitBps: z.number().int().nullable(),
  referralFeeCents: z.number().int().nullable(),
  commissionStatus: z.enum(['estimated', 'confirmed', 'paid']),
  updatedByUserId: uuid,
  updatedAt: z.string(),
});
export const FinancialsResponse = z.object({ financials: FinancialsSchema.nullable() });
export const FinancialsBody = z
  .strictObject({
    grossCommissionCents: cents.nullable().optional(),
    commissionRateBps: z.number().int().min(0).max(10000).nullable().optional(),
    teamSplitBps: z.number().int().min(0).max(10000).nullable().optional(),
    agentSplitBps: z.number().int().min(0).max(10000).nullable().optional(),
    referralFeeCents: cents.nullable().optional(),
    commissionStatus: z.enum(['estimated', 'confirmed', 'paid']).optional(),
  })
  .refine((b) => (b.teamSplitBps ?? 0) + (b.agentSplitBps ?? 0) <= 10000, { message: 'splits add up to more than 100 %', path: ['agentSplitBps'] });
export const DealDateBody = z
  .strictObject({ kind: DealDateKind, label: z.string().trim().min(1).max(120).nullable().optional(), dueOn: localDate })
  .refine((b) => b.kind !== 'custom' || (b.label ?? null) !== null, { message: 'a custom date needs a label', path: ['label'] });
export const UpdateDealDateBody = z.strictObject({ dueOn: localDate.optional(), label: z.string().trim().min(1).max(120).nullable().optional(), completed: z.boolean().optional() });
export const DealDateResponse = z.object({ date: DealDateSchema });
export const DealMemberBody = z.strictObject({ userId: uuid, role: z.enum(['co_agent', 'tc', 'isa']) });
export const DealContactBody = z.strictObject({ contactId: uuid, role: z.enum(['buyer', 'seller', 'co_buyer', 'co_seller', 'other', 'lender', 'title', 'attorney']) });
export const MemberParams = z.object({ id: uuid, userId: uuid });

// ---- listings and showings -------------------------------------------------------------------------------

const ListingStatus = z.enum(['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired']);
const PropertyType = z.enum(['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'manufactured', 'other']);
export const ListingSchema = z.object({
  id: uuid,
  source: z.enum(['team', 'mls']),
  mlsNumber: z.string().nullable(),
  status: ListingStatus,
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  region: z.string(),
  postalCode: z.string(),
  listPriceCents: z.number().int().nullable(),
  beds: z.number().int().nullable(),
  bathsX10: z.number().int().nullable(),
  sqft: z.number().int().nullable(),
  propertyType: PropertyType.nullable(),
  listingAgentUserId: uuid.nullable(),
  description: z.string().nullable(),
  listDate: z.string().nullable(),
  /** the caller may edit it (listing agent, Team Lead, Owner/Admin) */
  editable: z.boolean(),
  createdAt: z.string(),
});
export const ListingDetailSchema = ListingSchema.extend({
  priceHistory: z.array(z.object({ priceCents: z.number().int(), changedAt: z.string() })),
  contacts: z.array(z.object({ contactId: uuid, role: z.enum(['seller', 'co_seller', 'interested']) })),
  showings: z.object({ total: z.number().int(), completed: z.number().int(), withFeedback: z.number().int() }),
});
export const ListingResponse = z.object({ listing: ListingDetailSchema });
export const ListingsResponse = z.object({ listings: z.array(ListingSchema) });
export const ListingsQuery = z.strictObject({ status: ListingStatus.optional(), mine: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
export const CreateListingBody = z.strictObject({
  status: ListingStatus.optional(),
  mlsNumber: z.string().trim().min(1).max(40).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(2).max(40),
  postalCode: z.string().trim().min(3).max(12),
  listPriceCents: cents.nullable().optional(),
  beds: z.number().int().min(0).max(100).nullable().optional(),
  bathsX10: z.number().int().min(0).max(1000).nullable().optional(),
  sqft: z.number().int().min(0).max(10_000_000).nullable().optional(),
  propertyType: PropertyType.nullable().optional(),
  listingAgentUserId: uuid.optional(),
  description: z.string().max(10000).nullable().optional(),
  listDate: localDate.nullable().optional(),
});
export const UpdateListingBody = z.strictObject({
  status: ListingStatus.optional(),
  mlsNumber: z.string().trim().min(1).max(40).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(2).max(40).optional(),
  postalCode: z.string().trim().min(3).max(12).optional(),
  listPriceCents: cents.nullable().optional(),
  beds: z.number().int().min(0).max(100).nullable().optional(),
  bathsX10: z.number().int().min(0).max(1000).nullable().optional(),
  sqft: z.number().int().min(0).max(10_000_000).nullable().optional(),
  propertyType: PropertyType.nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
  listDate: localDate.nullable().optional(),
});
export const ListingContactBody = z.strictObject({ contactId: uuid, role: z.enum(['seller', 'co_seller', 'interested']) });

export const ShowingSchema = z.object({
  id: uuid,
  listingId: uuid,
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  buyerAgentName: z.string().nullable(),
  buyerAgentBrokerage: z.string().nullable(),
  buyerContactId: uuid.nullable(),
  status: z.enum(['scheduled', 'completed', 'canceled', 'no_show']),
  source: z.enum(['manual', 'showing_service', 'import']),
  feedback: z.array(z.object({ id: uuid, rating: z.number().int().nullable(), comments: z.string().nullable(), source: z.string(), receivedAt: z.string() })),
});
export const ShowingResponse = z.object({ showing: ShowingSchema });
export const ShowingsResponse = z.object({ showings: z.array(ShowingSchema) });
export const CreateShowingBody = z
  .strictObject({
    startsAt: isoDate,
    endsAt: isoDate.nullable().optional(),
    buyerAgentName: z.string().trim().max(120).nullable().optional(),
    buyerAgentBrokerage: z.string().trim().max(160).nullable().optional(),
    buyerContactId: uuid.nullable().optional(),
    status: z.enum(['scheduled', 'completed', 'canceled', 'no_show']).optional(),
  })
  .refine((b) => b.endsAt == null || Date.parse(b.endsAt) > Date.parse(b.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export const UpdateShowingBody = z.strictObject({ status: z.enum(['scheduled', 'completed', 'canceled', 'no_show']) });
export const FeedbackBody = z
  .strictObject({ rating: z.number().int().min(1).max(5).nullable().optional(), comments: z.string().trim().max(4000).nullable().optional(), receivedAt: isoDate.optional() })
  .refine((b) => b.rating != null || (b.comments ?? '') !== '', { message: 'a rating or a comment is needed', path: ['comments'] });

// ---- search ----------------------------------------------------------------------------------------------

export const SearchQuery = z.strictObject({ q: z.string().trim().min(2).max(100) });
export const SearchResponse = z.object({
  contacts: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      /** `card`: visible only as a pond/offer card (name masked, no phone or email match, R-PERM-6) */
      view: z.enum(['full', 'card']),
      ownershipState: z.string(),
      matchedOn: z.enum(['name', 'phone', 'email', 'address']),
    }),
  ),
  listings: z.array(z.object({ id: uuid, address: z.string(), city: z.string(), status: z.string(), listPriceCents: z.number().int().nullable() })),
  deals: z.array(z.object({ id: uuid, name: z.string(), stage: z.string() })),
  notes: z.array(z.object({ id: uuid, contactId: uuid.nullable(), dealId: uuid.nullable(), snippet: z.string(), createdAt: z.string() })),
  messages: z.array(z.object({ id: uuid, contactId: uuid, channel: z.string(), direction: z.string(), snippet: z.string(), occurredAt: z.string() })),
  /** entity groups that hit the 300 ms limit and are shown incomplete (honest partial results) */
  incomplete: z.array(z.enum(['contacts', 'listings', 'deals', 'notes', 'messages'])),
});

// ---- notifications ---------------------------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  'lead_offer',
  'first_touch_due',
  'first_touch_escalation',
  'handback',
  'handback_hot',
  'inbound_message',
  'missed_call',
  'pond_new',
  'task_due',
  'promise_due',
  'exception',
  'reassigned_to_you',
  'reassigned_away',
  'inactivity_warning',
  'opt_out',
  'import_ready',
  'system',
] as const;
export const CRITICAL_KINDS = ['lead_offer', 'first_touch_due', 'handback_hot'] as const;
const Channel = z.enum(['in_app', 'web_push', 'sms', 'email']);
export const NotificationSchema = z.object({
  id: uuid,
  kind: z.string(),
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  title: z.string(),
  body: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export const NotificationsResponse = z.object({ notifications: z.array(NotificationSchema), unread: z.number().int().min(0) });
export const NotificationsQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional(), unread: z.enum(['true', 'false']).optional() });
export const ReadBody = z.strictObject({ ids: z.array(uuid).min(1).max(200).optional(), all: z.literal(true).optional() }).refine((b) => (b.ids === undefined) !== (b.all === undefined), { message: 'give ids or all', path: ['ids'] });
export const ReadResponse = z.object({ marked: z.number().int().min(0), unread: z.number().int().min(0) });
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const PreferenceSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  channels: z.array(Channel),
  mutedUntil: z.string().nullable(),
  quietStart: z.string().nullable(),
  quietEnd: z.string().nullable(),
  /** lead offers, first-touch alerts and hot handbacks: never muted, never silenced by quiet hours */
  critical: z.boolean(),
  /** false: no saved preference, these are the defaults */
  saved: z.boolean(),
});
export const PreferencesResponse = z.object({ preferences: z.array(PreferenceSchema) });
export const PreferenceBody = z
  .strictObject({ kind: z.enum(NOTIFICATION_KINDS), channels: z.array(Channel).max(4), mutedUntil: isoDate.nullable().optional(), quietStart: hhmm.nullable().optional(), quietEnd: hhmm.nullable().optional() })
  .refine((b) => (b.quietStart == null) === (b.quietEnd == null), { message: 'quiet hours need a start and an end', path: ['quietEnd'] });
export const PreferenceResponse = z.object({ preference: PreferenceSchema });

/** Every response schema (R-AST-13 / R-TEN-3 snapshot). */
export const WORKSPACE_RESPONSE_SCHEMAS = {
  FeedResponse,
  FeedActionResponse,
  TaskResponse,
  TasksResponse,
  AppointmentResponse,
  AppointmentsResponse,
  DealResponse,
  DealsResponse,
  FinancialsResponse,
  DealDateResponse,
  ListingResponse,
  ListingsResponse,
  ShowingResponse,
  ShowingsResponse,
  SearchResponse,
  NotificationsResponse,
  ReadResponse,
  PreferencesResponse,
  PreferenceResponse,
} as const;
