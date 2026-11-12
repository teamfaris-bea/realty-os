// Zod schemas of the api/leads routes (BUILD_PLAN module 11). Response schemas are snapshot-tested
// (no confidence* fields, no tenant id fields: R-AST-13, R-TEN-3). Input schemas are strict, so an
// extra `tenant_id` (or anything else) is refused with 422 (E51).
import { z } from 'zod';
import { ReachReasonSchema } from '../comms/schemas.js';

const Iso = z.string();
const Id = z.uuid();

// ---- ownership ---------------------------------------------------------------------------------

export const OwnershipStateEnum = z.enum(['unassigned', 'offered', 'owned', 'in_pond', 'closed']);

/** The ownership projection (ids, states and instants only). */
export const ProjectionView = z.object({
  state: OwnershipStateEnum,
  ownerUserId: Id.nullable(),
  pondId: Id.nullable(),
  offerId: Id.nullable(),
  offeredToUserId: Id.nullable(),
  offerExpiresAt: Iso.nullable(),
  offerRound: z.number().int(),
  ownedAt: Iso.nullable(),
  firstTouchDueAt: Iso.nullable(),
  firstTouchAt: Iso.nullable(),
  firstTouchBreachedAt: Iso.nullable(),
  releaseDueAt: Iso.nullable(),
  closedReason: z.string().nullable(),
  seq: z.number().int(),
});

export const OwnershipEventView = z.object({ seq: z.number().int(), type: z.string(), reasonCode: z.string(), occurredAt: Iso });

export const OwnershipResultResponse = z.object({
  result: z.object({
    contactId: Id,
    replayed: z.boolean(),
    events: z.array(OwnershipEventView),
    /** the projection as the caller sees it after the command (null: the caller no longer sees the contact) */
    projection: ProjectionView.nullable(),
  }),
});

const CommandBase = { commandId: Id, expectedSeq: z.number().int().min(1).optional() };
const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const Note = z.string().trim().min(1).max(500);

export const CommandBodies = {
  accept: z.strictObject({ ...CommandBase, offerId: Id }),
  decline: z.strictObject({ ...CommandBase, offerId: Id, reason: z.enum(['busy', 'not_my_area', 'conflict', 'other']).optional() }),
  claim: z.strictObject({ ...CommandBase, pondId: Id.optional() }),
  release: z.strictObject({
    ...CommandBase,
    reason: z.enum(['not_a_fit', 'wrong_area', 'duplicate', 'unresponsive', 'other']),
    note: Note.optional(),
    toPondId: Id.optional(),
  }),
  reassign: z.strictObject({ ...CommandBase, toUserId: Id, reason: ReasonCode.optional(), note: Note.optional() }),
  handoff: z.strictObject({ ...CommandBase, toUserId: Id, note: Note }),
  close: z.strictObject({ ...CommandBase, reason: z.enum(['spam', 'do_not_contact', 'not_a_lead']) }),
  reopen: z.strictObject({ ...CommandBase }),
  merge: z.strictObject({ ...CommandBase, loserId: Id, ownerChoice: Id.nullable().optional() }),
  delete: z.strictObject({ ...CommandBase }),
} as const;
export type CommandVerb = keyof typeof CommandBodies;

// ---- contacts ----------------------------------------------------------------------------------

const Name = z.string().trim().min(1).max(120);

export const CreateContactBody = z.strictObject({
  commandId: Id,
  displayName: Name.optional(),
  firstName: Name.optional(),
  lastName: Name.optional(),
  phones: z.array(z.string().min(3).max(40)).max(5).optional(),
  emails: z.array(z.string().min(3).max(254)).max(5).optional(),
  intent: z.enum(['buyer', 'seller', 'buyer_seller', 'renter', 'landlord', 'investor']).optional(),
  contactType: z.enum(['lead', 'sphere', 'past_client', 'vendor', 'other']).optional(),
  /** create even though an existing contact shares a phone/email (spouses); a duplicate candidate is recorded */
  confirmDistinct: z.boolean().optional(),
  // FUB parity module 57 (R-PAR-44): set at birth, in the same transaction
  stage: z.enum(['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost']).optional(),
  /** first-touch attribution, once, at birth (a lead source of this tenant) */
  leadSourceId: Id.optional(),
  phoneLabel: z.enum(['mobile', 'home', 'work', 'other']).optional(),
  emailLabel: z.enum(['mobile', 'home', 'work', 'other']).optional(),
  address: z
    .strictObject({
      kind: z.enum(['home', 'mailing', 'property', 'interest']).default('home'),
      line1: z.string().trim().min(1).max(200).optional(),
      line2: z.string().trim().min(1).max(200).optional(),
      city: z.string().trim().min(1).max(120).optional(),
      region: z.string().trim().min(1).max(60).optional(),
      postalCode: z.string().trim().min(3).max(12).optional(),
      country: z.string().regex(/^[A-Z]{2}$/).default('US'),
    })
    .optional(),
});

export const SourceView = z.object({ id: Id, name: z.string(), kind: z.string() });

/** R-PERM-6: the card. Pond cards carry the last name as an initial only. */
export const ContactCard = z.object({
  id: Id,
  view: z.literal('card'),
  displayName: z.string(),
  intent: z.string().nullable(),
  source: SourceView.nullable(),
  createdAt: Iso,
  pondSummary: z.string().nullable(),
  ownership: z.object({
    state: OwnershipStateEnum,
    pondId: Id.nullable(),
    pondName: z.string().nullable(),
    offerId: Id.nullable(),
    offerExpiresAt: Iso.nullable(),
    offeredToMe: z.boolean(),
    seq: z.number().int(),
  }),
});

export const PointView = z.object({
  id: Id,
  address: z.string(),
  label: z.string(),
  lineType: z.string(),
  status: z.string(),
  isPrimary: z.boolean(),
});

export const InquiryView = z.object({
  id: Id,
  receivedAt: Iso,
  inquiryType: z.string(),
  source: z.string().nullable(),
  postalCode: z.string().nullable(),
  priceMinCents: z.number().nullable(),
  priceMaxCents: z.number().nullable(),
  campaignRef: z.string().nullable(),
  adRef: z.string().nullable(),
  propertyText: z.string().nullable(),
  message: z.string().nullable(),
  outcome: z.string(),
});

export const ContactFull = z.object({
  id: Id,
  view: z.literal('full'),
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  intent: z.string().nullable(),
  stage: z.string(),
  contactType: z.string(),
  timezone: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: Iso,
  lastHumanTouchAt: Iso.nullable(),
  pondSummary: z.string().nullable(),
  source: SourceView.nullable(),
  attribution: z.object({
    leadSourceId: Id.nullable(),
    campaignRef: z.string().nullable(),
    adRef: z.string().nullable(),
    sourceDetail: z.record(z.string(), z.unknown()),
  }),
  owner: z.object({ userId: Id, displayName: z.string().nullable() }).nullable(),
  ownership: ProjectionView.extend({ pondName: z.string().nullable(), offeredToMe: z.boolean(), ownedByMe: z.boolean() }),
  phones: z.array(PointView),
  emails: z.array(PointView),
  /**
   * module 22 (E77, E154): what visitors typed in this contact's website chats, not a contact point: shown as "typed in
   * chat, not verified" (nothing automated ever goes to it); a person may add it by hand as a phone or email
   */
  typedInChat: z.array(z.object({ kind: z.enum(['phone', 'email']), address: z.string(), typedAt: Iso })),
  inquiries: z.array(InquiryView),
  /**
   * R-OWN-24: this record was merged into another, so nothing is sent from it (CONTACT_MERGED). `mergedIntoContactId`
   * is the record the person lives on now (the end of the merge chain), and only when the caller may open it: null to
   * the loser's collaborator, who is not told about the survivor (R-PERM-5, as the refusal's details.mergedInto).
   */
  merged: z.boolean(),
  mergedIntoContactId: Id.nullable(),
});

export const ContactResponse = z.object({ contact: z.union([ContactCard, ContactFull]) });
/** A replay shows the contact as the caller sees it now (a card once it is only a pond card to them). */
export const ContactCreatedResponse = z.object({ contact: z.union([ContactCard, ContactFull]), replayed: z.boolean() });

const TimelineReactionName = z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'sticker', 'emoji']);
export const TimelineItem = z.object({
  id: Id,
  type: z.string(),
  occurredAt: Iso,
  actor: z.object({ userId: Id, displayName: z.string().nullable() }).nullable(),
  detail: z.string().nullable(),
  preview: z.string().nullable(),
  note: z.string().nullable(),
  provenance: z.string(),
  /** messages only: the delivery status (sent, delivered, scheduled, blocked, failed, ...); null otherwise */
  status: z.string().nullable(),
  /** messages only: messages.status_reason (why it was blocked, failed, canceled or is held); null otherwise */
  statusReason: z.string().nullable(),
  /** messages only: the provider's error code on a failed or undelivered message */
  providerErrorCode: z.string().nullable(),
  /** blocked messages only: the opt-out or suppression the send-time decision rested on, with its evidence */
  blockedBy: ReachReasonSchema.nullable(),
  /** D5b (R-REACT-5, R-REACT-6): an inbound text linked as a phone's reaction to the team's text; null otherwise */
  reaction: z
    .object({
      action: z.enum(['add', 'remove']),
      reaction: TimelineReactionName,
      emoji: z.string().nullable(),
      targetMessageId: Id,
      quote: z.string(),
      raw: z.string(),
      narrowed: z.boolean(),
    })
    .nullable(),
  /** D5b (R-REACT-6): the reaction in force on this (team) text; null otherwise */
  reactedWith: z.object({ reaction: TimelineReactionName, emoji: z.string().nullable(), at: Iso }).nullable(),
});
export const TimelineResponse = z.object({ items: z.array(TimelineItem), nextCursor: z.string().nullable() });

export const PondCardsResponse = z.object({
  pond: z.object({ id: Id, name: z.string(), claimable: z.boolean() }),
  cards: z.array(ContactCard),
  nextCursor: z.string().nullable(),
});

/** GET /me/ponds: the ponds the caller may claim from, and what blocks a claim there now (R-OWN-16). */
export const MyPondsResponse = z.object({
  ponds: z.array(
    z.object({
      id: Id,
      name: z.string(),
      isDefault: z.boolean(),
      claimsPerDay: z.number().int(),
      blockedBy: z.enum(['CLAIM_LIMIT_REACHED', 'CAPACITY_REACHED']).nullable(),
    }),
  ),
  /** the caller's own claims since the tenant-local day began, out of each pond's claimsPerDay */
  claimsToday: z.number().int(),
  /** the caller's leads still waiting for a first touch, out of capacityCap */
  uncontactedOwned: z.number().int(),
  capacityCap: z.number().int(),
});

// ---- intake + lead sources ----------------------------------------------------------------------

const Cents = z.number().int().min(0).max(1_000_000_000_00);
const DetailValue = z.union([z.string().max(200), z.number(), z.boolean()]);

/**
 * The exact consent language the person saw (R-CONSENT-4, E38). Stored verbatim in
 * consent_disclosures (sha256-verified); `namesSeller` is the entity the text names. Scope defaults to
 * every channel and both purposes when the source does not say (history only since D1; VERIFY WITH
 * COUNSEL). Never carries a tenant id (strict).
 */
export const ConsentDisclosureInput = z.strictObject({
  text: z.string().min(1).max(10_000).refine((s) => s.trim() !== '', { message: 'blank' }),
  namesSeller: z.string().min(1).max(300).refine((s) => s.trim() !== '', { message: 'blank' }),
  channels: z.array(z.enum(['sms', 'voice', 'email'])).min(1).max(3).optional(),
  purposes: z.array(z.enum(['marketing', 'informational'])).min(1).max(2).optional(),
});

/** What a lead source posts (portal, website form, ads). Identity comes from the URL token only. */
export const IntakeBody = z.strictObject({
  externalId: z.string().trim().min(1).max(200).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  inquiryType: z.enum(['buy', 'sell', 'rent', 'value', 'general']).default('general'),
  fullName: Name.optional(),
  firstName: Name.optional(),
  lastName: Name.optional(),
  phones: z.array(z.string().min(3).max(40)).max(5).default([]),
  emails: z.array(z.string().min(3).max(254)).max(5).default([]),
  message: z.string().max(4000).optional(),
  propertyText: z.string().max(500).optional(),
  postalCode: z.string().regex(/^[0-9]{5}(-[0-9]{4})?$/).optional(),
  priceMinCents: Cents.optional(),
  priceMaxCents: Cents.optional(),
  campaignRef: z.string().max(200).optional(),
  adRef: z.string().max(200).optional(),
  sourceDetail: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), DetailValue).optional(),
  consentDisclosure: ConsentDisclosureInput.optional(),
});

export const IntakeResponse = z.object({
  contactId: Id,
  inquiryId: Id.nullable(),
  outcome: z.enum(['new_contact', 'attached', 'reinquiry', 'duplicate_ignored']),
});

export const LeadSourceView = z.object({ id: Id, name: z.string(), kind: z.string(), active: z.boolean(), hasToken: z.boolean(), createdAt: Iso });
export const LeadSourcesResponse = z.object({ sources: z.array(LeadSourceView) });
export const LeadSourceCreatedResponse = z.object({ source: LeadSourceView, ingestToken: z.string(), intakePath: z.string() });

// ---- deactivation ------------------------------------------------------------------------------

export const DeactivateBody = z.strictObject({
  mode: z.enum(['preview', 'run']),
  destination: z.enum(['team_lead', 'default_pond', 'reroute']).default('team_lead'),
});

export const DeactivationResponse = z.object({
  deactivation: z.object({
    userId: Id,
    mode: z.enum(['preview', 'run']),
    status: z.string(),
    destination: z.enum(['team_lead', 'default_pond', 'reroute']),
    owned: z.number().int(),
    offered: z.number().int(),
    ownedWithOpenDeal: z.number().int(),
    /** where contacts go that cannot go to a pond (open deals) or when there is no Team Lead */
    teamLead: z.object({ userId: Id, displayName: z.string().nullable() }).nullable(),
    fallbackUserId: Id,
    deactivationId: Id.nullable(),
  }),
});

export const LEADS_RESPONSE_SCHEMAS = {
  OwnershipResultResponse,
  ContactResponse,
  ContactCreatedResponse,
  TimelineResponse,
  PondCardsResponse,
  MyPondsResponse,
  IntakeResponse,
  LeadSourcesResponse,
  LeadSourceCreatedResponse,
  DeactivationResponse,
} as const;
