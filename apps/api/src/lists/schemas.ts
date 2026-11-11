// Zod schemas of the api/lists routes (PARITY_PLAN module 60). Input schemas are strict (an extra
// tenant id, or anything else, is 422). Response schemas are snapshot-tested: no confidence* fields,
// no tenant id fields (R-AST-13, R-TEN-3).
import { LIST_SORTS } from '@realty/core/parity/lists';
import { FIELD_TYPES } from '@realty/core/parity/fields';
import { TAG_COLORS } from '@realty/core/parity/tags';
import { z } from 'zod';

const Id = z.uuid();
const Iso = z.string();
const Color = z.enum(TAG_COLORS);
const Sort = z.enum(LIST_SORTS);

// ---- tags --------------------------------------------------------------------------------------

export const TagView = z.object({
  id: Id,
  name: z.string(),
  color: Color.nullable(),
  protected: z.boolean(),
  createdByKind: z.enum(['user', 'import']),
  /** live people with this tag that the caller can see (Owner/Admin catalog view only) */
  usage: z.number().int().nullable(),
});
export const TagsResponse = z.object({ tags: z.array(TagView) });
export const TagResponse = z.object({ tag: TagView });
export const TagCreatedResponse = z.object({
  tag: TagView,
  created: z.boolean(),
  /** R-PAR-7: the name reads like an opt-out; a tag never stops messages (offer the real do-not-contact) */
  readsLikeOptOut: z.boolean(),
});
export const CreateTagBody = z.strictObject({ name: z.string().max(200), color: Color.nullable().optional() });
export const PatchTagBody = z.strictObject({ name: z.string().max(200).optional(), color: Color.nullable().optional() });
export const ProtectTagBody = z.strictObject({ protected: z.boolean() });
export const MergeTagBody = z.strictObject({ intoTagId: Id });
export const MergeResultResponse = z.object({ tag: TagView, moved: z.number().int(), alreadyTagged: z.number().int(), listsRewritten: z.number().int() });
export const DeleteResultResponse = z.object({ deleted: z.literal(true), removedLinks: z.number().int() });

// ---- a person's tags -----------------------------------------------------------------------------

export const ContactTagView = z.object({ id: Id, name: z.string(), color: Color.nullable(), protected: z.boolean() });
export const ContactTagsResponse = z.object({ tags: z.array(ContactTagView) });
export const AddContactTagsBody = z.strictObject({
  tagIds: z.array(Id).max(20).optional(),
  /** typed names: existing tags are reused (case-insensitive), new ones created (tag.create) */
  names: z.array(z.string().max(200)).max(20).optional(),
});
export const AddContactTagsResponse = z.object({
  tags: z.array(ContactTagView),
  added: z.array(Id),
  /** R-PAR-7 / E167: added tags that read like an opt-out; the UI offers the person-level do-not-contact */
  optOutLike: z.array(Id),
});
export const RemoveContactTagResponse = z.object({ tags: z.array(ContactTagView), removed: z.boolean() });

// ---- custom fields -------------------------------------------------------------------------------

export const FieldOptionView = z.object({ id: z.string(), label: z.string(), archived: z.boolean() });
export const FieldDefView = z.object({
  id: Id,
  key: z.string(),
  label: z.string(),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(FieldOptionView),
  annual: z.boolean(),
  position: z.number().int(),
  origin: z.enum(['manual', 'fub_import', 'csv_import']),
  archived: z.boolean(),
});
export const FieldDefsResponse = z.object({ fields: z.array(FieldDefView), liveCount: z.number().int(), limit: z.number().int() });
export const FieldDefResponse = z.object({ field: FieldDefView });
export const CreateFieldBody = z.strictObject({
  label: z.string().max(200),
  fieldType: z.enum(FIELD_TYPES),
  key: z.string().max(60).optional(),
  annual: z.boolean().optional(),
  options: z.array(z.strictObject({ label: z.string().max(200) })).max(100).optional(),
});
export const PatchFieldBody = z.strictObject({
  label: z.string().max(200).optional(),
  position: z.number().int().min(0).max(32000).optional(),
  addOptions: z.array(z.strictObject({ label: z.string().max(200) })).max(100).optional(),
  renameOptions: z.record(z.string().max(40), z.string().max(200)).optional(),
  archiveOptions: z.array(z.string().max(40)).max(100).optional(),
  unarchiveOptions: z.array(z.string().max(40)).max(100).optional(),
});
export const ArchiveFieldBody = z.strictObject({ archived: z.boolean() });

export const FieldValueView = z.object({
  fieldId: Id,
  text: z.string().nullable(),
  number: z.number().nullable(),
  date: z.string().nullable(),
  optionIds: z.array(z.string()).nullable(),
  updatedByKind: z.enum(['user', 'bulk', 'import']),
  updatedAt: Iso,
});
export const ContactFieldsResponse = z.object({ values: z.array(FieldValueView) });
export const SetFieldValueBody = z.strictObject({
  /** text, number, YYYY-MM-DD, an option id, or option ids; null / '' / [] clears */
  value: z.union([z.string().max(2000), z.number(), z.array(z.string().max(40)).max(60), z.null()]),
});
export const SetFieldValueResponse = z.object({ value: FieldValueView.nullable(), changed: z.boolean() });

// ---- smart lists ---------------------------------------------------------------------------------

export const SmartListView = z.object({
  id: Id,
  scope: z.enum(['team', 'personal']),
  mine: z.boolean(),
  name: z.string(),
  definition: z.unknown(),
  sort: Sort,
  position: z.number().int(),
  updatedAt: Iso,
  /** R-PAR-8: references a protected-proxy tag, so it never defines a bulk send/enroll audience */
  audienceProtected: z.boolean(),
});
export const SmartListsResponse = z.object({ lists: z.array(SmartListView) });
export const SmartListResponse = z.object({ list: SmartListView });
export const CreateSmartListBody = z.strictObject({
  scope: z.enum(['team', 'personal']),
  name: z.string().max(200),
  definition: z.unknown(),
  sort: Sort.optional(),
  position: z.number().int().min(0).max(32000).optional(),
});
export const PatchSmartListBody = z.strictObject({
  name: z.string().max(200).optional(),
  definition: z.unknown().optional(),
  sort: Sort.optional(),
  position: z.number().int().min(0).max(32000).optional(),
});

// ---- people (list runs) --------------------------------------------------------------------------

export const PersonView = z.object({
  id: Id,
  displayName: z.string(),
  stage: z.string(),
  intent: z.string().nullable(),
  contactType: z.string(),
  owner: z.object({ userId: Id, displayName: z.string().nullable() }).nullable(),
  sourceName: z.string().nullable(),
  lastActivityAt: Iso.nullable(),
  createdAt: Iso,
  nextTaskDueAt: Iso.nullable(),
  tags: z.array(z.object({ id: Id, name: z.string(), color: Color.nullable() })),
});
export const PeoplePageResponse = z.object({
  people: z.array(PersonView),
  nextCursor: z.string().nullable(),
  sort: Sort,
  list: z.object({ id: Id, name: z.string(), scope: z.enum(['team', 'personal']) }).nullable(),
  /** R-PAR-28: the page holds only people whose detail the caller sees ("Showing people you can see") */
  scope: z.literal('people_you_can_see'),
  audienceProtected: z.boolean(),
});
export const PeopleCountResponse = z.object({ count: z.number().int(), capped: z.boolean() });
export const PeopleQuery = z.strictObject({ list: Id.optional(), cursor: z.string().max(3000).optional(), sort: Sort.optional() });
export const PeopleCountQuery = z.strictObject({ list: Id.optional() });
export const PeopleQueryBody = z.strictObject({ definition: z.unknown(), cursor: z.string().max(3000).optional(), sort: Sort.optional() });
export const PeopleCountBody = z.strictObject({ definition: z.unknown() });

export const LISTS_RESPONSE_SCHEMAS = {
  TagsResponse,
  TagResponse,
  TagCreatedResponse,
  MergeResultResponse,
  DeleteResultResponse,
  ContactTagsResponse,
  AddContactTagsResponse,
  RemoveContactTagResponse,
  FieldDefsResponse,
  FieldDefResponse,
  ContactFieldsResponse,
  SetFieldValueResponse,
  SmartListsResponse,
  SmartListResponse,
  PeoplePageResponse,
  PeopleCountResponse,
};
