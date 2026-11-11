// Zod schemas of api/people (PARITY_PLAN module 57). Input schemas are strict (an extra tenant id or any
// other key is a 422). Response schemas are snapshot-tested: no confidence* fields, no tenant id fields.
import { ACTIVITY_DIRECTIONS, ACTIVITY_KINDS, CALL_OUTCOMES, POINT_LABELS, STAGES } from '@realty/core/parity/people';
import { z } from 'zod';
import { AutomationOutcomeSchema } from '../stageAutomation/index.js';

const Id = z.uuid();
const Iso = z.string();

export const IdParams = z.object({ id: Id });
export const PointParams = z.object({ id: Id, pointId: Id });
export const AddressParams = z.object({ id: Id, addressId: Id });
export const CollaboratorParams = z.object({ id: Id, userId: Id });
export const RelationshipParams = z.object({ id: Id, relationshipId: Id });

/** PATCH /contacts/:id is validated by core validateContactPatch (strict; FIELD_NOT_EDITABLE for protected keys). */
export const PatchBody = z.record(z.string().max(64), z.unknown());

const Label = z.enum(POINT_LABELS);
export const AddPointBody = z.strictObject({ kind: z.enum(['phone', 'email']), address: z.string().min(3).max(254), label: Label.optional() });
export const ReplacePointBody = z.strictObject({ address: z.string().min(3).max(254), label: Label.optional() });
export const RemovePointBody = z.strictObject({ reason: z.enum(['old', 'wrong_number']).default('old') });
export const LabelPointBody = z.strictObject({ label: Label });

const Line = z.string().trim().min(1).max(200).nullable().optional();
export const AddressBody = z.strictObject({
  kind: z.enum(['home', 'mailing', 'property', 'interest']),
  line1: Line,
  line2: Line,
  city: z.string().trim().min(1).max(120).nullable().optional(),
  region: z.string().trim().min(1).max(60).nullable().optional(),
  postalCode: z.string().trim().min(3).max(12).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).default('US'),
});

export const CollaboratorBody = z.strictObject({ userId: Id, role: z.enum(['isa', 'tc', 'co_agent']).optional() });

export const StageBody = z.strictObject({ stage: z.enum(STAGES), rowVersion: z.number().int().min(1).optional() });
export const StageLabelsBody = z.strictObject({ labels: z.record(z.string(), z.string()) });

export const RelationshipBody = z
  .strictObject({
    relatedContactId: Id,
    kind: z.enum(['spouse_partner', 'family', 'household', 'co_buyer', 'co_seller', 'referred_by', 'other']),
    label: z.string().trim().min(1).max(40).optional(),
  })
  .refine((b) => (b.kind === 'other') === (b.label !== undefined), { message: 'a label is required for kind other, and only for it', path: ['label'] });

const NoteBodyText = z.string().max(20_000);
export const CreateNoteBody = z.strictObject({ body: NoteBodyText.refine((s) => s.trim().length > 0, { message: 'blank' }), pinned: z.boolean().optional(), noteId: Id.optional() });
export const UpdateNoteBody = z.strictObject({
  body: NoteBodyText.refine((s) => s.trim().length > 0, { message: 'blank' }).optional(),
  activityAt: z.iso.datetime({ offset: true }).optional(),
  activityDirection: z.enum(ACTIVITY_DIRECTIONS).optional(),
  activityOutcome: z.enum(CALL_OUTCOMES).nullable().optional(),
});
export const PinBody = z.strictObject({ pinned: z.boolean() });
export const NotesQuery = z.strictObject({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

export const ActivityBody = z.strictObject({
  kind: z.enum(ACTIVITY_KINDS),
  direction: z.enum(ACTIVITY_DIRECTIONS).optional(),
  at: z.iso.datetime({ offset: true }),
  outcome: z.enum(CALL_OUTCOMES).nullable().optional(),
  body: z.string().max(20_000).optional(),
  remindInDays: z.number().int().min(1).max(365).optional(),
  noteId: Id.optional(),
});

export const DoNotContactBody = z.strictObject({ reason: z.enum(['asked_in_person', 'asked_on_call', 'asked_in_writing', 'other']).default('other') });

// ---- responses -----------------------------------------------------------------------------------------

export const ContactEditView = z.object({
  id: Id,
  rowVersion: z.number().int(),
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  contactType: z.string(),
  intent: z.string().nullable(),
  timezone: z.string().nullable(),
  stage: z.string(),
  pondSummary: z.string().nullable(),
});
export const ContactEditResponse = z.object({ contact: ContactEditView, changed: z.array(z.string()) });

export const PointDetail = z.object({ id: Id, kind: z.enum(['phone', 'email']), address: z.string(), label: z.string(), status: z.string(), isPrimary: z.boolean() });
/** A removed point shows only its last digits/characters and why it still blocks (R-PAR-12). */
export const RemovedPointView = z.object({ id: Id, kind: z.enum(['phone', 'email']), tail: z.string(), reason: z.string().nullable(), stillBlocks: z.boolean(), optedOut: z.boolean(), removedAt: Iso });
export const DuplicateWarning = z.object({ contactId: Id.nullable(), ownerDisplayName: z.string().nullable() });
export const PointResponse = z.object({ point: PointDetail, removedPointId: Id.nullable(), duplicates: z.array(DuplicateWarning) });
export const PointsResponse = z.object({ points: z.array(PointDetail), removed: z.array(RemovedPointView) });

export const AddressView = z.object({ id: Id, kind: z.string(), line1: z.string().nullable(), line2: z.string().nullable(), city: z.string().nullable(), region: z.string().nullable(), postalCode: z.string().nullable(), country: z.string() });
export const AddressResponse = z.object({ address: AddressView });
export const OkResponse = z.object({ ok: z.literal(true) });

export const CollaboratorView = z.object({ userId: Id, displayName: z.string().nullable(), role: z.string(), expiresAt: Iso.nullable() });
export const CollaboratorsResponse = z.object({ collaborators: z.array(CollaboratorView) });

export const StageInfo = z.object({ stage: z.string(), label: z.string(), locked: z.array(z.string()), lockedReason: z.string().nullable() });
// parity module 67 (flagged edit): what the stage entry started, or why not (null: no plan for this stage)
export const StageResponse = z.object({ stage: StageInfo, previousStage: z.string(), rowVersion: z.number().int(), automation: AutomationOutcomeSchema });
export const StageLabelsResponse = z.object({ labels: z.record(z.string(), z.string()), stages: z.array(z.object({ key: z.string(), label: z.string() })) });

export const RelationshipView = z.object({ id: Id, kind: z.string(), label: z.string().nullable(), direction: z.enum(['outgoing', 'incoming']), other: z.object({ id: Id, displayName: z.string() }), createdAt: Iso });
export const RelationshipsResponse = z.object({ relationships: z.array(RelationshipView) });
export const RelationshipResponse = z.object({ relationship: RelationshipView });

export const DetailsResponse = z.object({
  details: z.object({
    contactId: Id,
    rowVersion: z.number().int(),
    doNotContact: z.boolean(),
    stage: StageInfo,
    stageLabels: z.record(z.string(), z.string()),
    addresses: z.array(AddressView),
    collaborators: z.array(CollaboratorView),
    relationships: z.array(RelationshipView),
    removedPoints: z.array(RemovedPointView),
    canEdit: z.boolean(),
    canManageCollaborators: z.boolean(),
  }),
});

export const LoggedActivityView = z.object({ kind: z.string(), direction: z.string().nullable(), at: Iso, outcome: z.string().nullable(), verified: z.literal(false) });
export const NoteView = z.object({
  id: Id,
  contactId: Id,
  body: z.string(),
  pinned: z.boolean(),
  source: z.string(),
  author: z.object({ userId: Id, displayName: z.string().nullable() }).nullable(),
  createdAt: Iso,
  editedAt: Iso.nullable(),
  /** logged outside activity (R-PAR-30): never a touch, shown "Logged by …" and not verified */
  loggedActivity: LoggedActivityView.nullable(),
  mentions: z.array(z.object({ userId: Id, displayName: z.string().nullable() })),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canPin: z.boolean(),
});
export const MentionOutcome = z.object({ userId: Id, displayName: z.string().nullable(), status: z.enum(['notified', 'no_access', 'already_notified']) });
export const NoteResponse = z.object({ note: NoteView, mentions: z.array(MentionOutcome), replayed: z.boolean() });
export const NotesResponse = z.object({ notes: z.array(NoteView), nextCursor: z.string().nullable(), audience: z.string() });
export const MentionCandidatesResponse = z.object({ members: z.array(z.object({ userId: Id, displayName: z.string().nullable(), role: z.string(), canSee: z.boolean() })) });
export const ActivityResponse = z.object({ note: NoteView, taskId: Id.nullable(), suggestDoNotContact: z.boolean(), replayed: z.boolean() });
export const DoNotContactResponse = z.object({ doNotContact: z.literal(true), alreadySet: z.boolean(), revokedPoints: z.number().int() });

export const PEOPLE_RESPONSE_SCHEMAS = {
  ContactEditResponse,
  PointResponse,
  PointsResponse,
  AddressResponse,
  OkResponse,
  CollaboratorsResponse,
  StageResponse,
  StageLabelsResponse,
  RelationshipsResponse,
  RelationshipResponse,
  DetailsResponse,
  NoteResponse,
  NotesResponse,
  MentionCandidatesResponse,
  ActivityResponse,
  DoNotContactResponse,
} as const;
