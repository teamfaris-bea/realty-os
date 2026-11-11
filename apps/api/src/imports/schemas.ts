// Zod request/response schemas of api/imports. Inputs never carry a tenant id (R-TEN-3); responses
// carry no confidence fields (R-AST-13) and no tenant id. Snapshot-tested in imports.schemas.test.ts.
import { z } from 'zod';
import { ColumnTargetSchema, MAX_CSV_BYTES } from './csv.js';

/** Longest fileBase64 accepted: the padded base64 of a MAX_CSV_BYTES file. */
export const MAX_FILE_BASE64_CHARS = Math.ceil(MAX_CSV_BYTES / 3) * 4;

/**
 * Strict, padded standard base64 (what `btoa` and Buffer produce). Node's decoder silently skips any
 * other character, so without this the stored bytes could differ from what the client sent.
 */
const FileBase64 = z
  .string()
  .min(4)
  .max(MAX_FILE_BASE64_CHARS)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((s) => s.length % 4 === 0, { message: 'base64 length' });

export const CategoryParam = z.enum(['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent']);
export const IdParams = z.strictObject({ id: z.uuid() });
export const StageParams = z.strictObject({ id: z.uuid(), category: CategoryParam });
export const RecordParams = z.strictObject({ id: z.uuid(), rid: z.uuid() });

export const CreateImportBody = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('fub_api'), apiKey: z.string().trim().min(8).max(200) }),
  z.strictObject({ source: z.literal('csv'), fileName: z.string().min(1).max(200), fileBase64: FileBase64, mapping: z.array(ColumnTargetSchema).max(500).optional() }),
  z.strictObject({ source: z.literal('fub_export'), fileName: z.string().min(1).max(200), fileBase64: FileBase64 }),
]);

export const MappingsBody = z.strictObject({
  mappings: z
    .array(
      z.strictObject({
        sourceRef: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
        kind: z.enum(['user', 'pond']).default('user'),
        target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('user'), userId: z.uuid() }), z.strictObject({ kind: z.literal('pond'), pondId: z.uuid() }), z.strictObject({ kind: z.literal('unassigned') })]),
      }),
    )
    .max(2000),
});

export const CsvMappingBody = z.strictObject({ mapping: z.array(ColumnTargetSchema).max(500) });
export const RecordsQuery = z.strictObject({
  outcome: z.enum(['will_import', 'imported', 'needs_review', 'rejected', 'duplicate', 'reverted']).optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ReviewBody = z.strictObject({ decision: z.enum(['import', 'merge', 'reject']), mergeIntoContactId: z.uuid().optional() });
export const ApproveBody = z.strictObject({ snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/) });
export const VerifyBody = z.strictObject({ spotChecks: z.array(z.strictObject({ sourceRef: z.string().min(1).max(300), matches: z.boolean() })).max(100) });
const Stage8 = z.enum(['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost']);
const FieldTypeEnum = z.enum(['text', 'number', 'date', 'single_select', 'multi_select']);
const SourceKey = z.string().trim().min(1).max(200);
const FieldActionBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({ action: z.literal('create'), type: FieldTypeEnum, label: z.string().trim().min(1).max(60).refine((v) => ![...v].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f), 'control_character') }),
  z.strictObject({ action: z.literal('existing'), fieldId: z.uuid() }),
]);
/** PUT /imports/:id/parity (R-PAR-46): labels and keys only, never contact data. */
export const ParityBody = z.strictObject({
  stageMap: z.record(z.string().trim().min(1).max(200), Stage8).refine((m) => Object.keys(m).length <= 500, 'too_many'),
  keepStageAsTag: z.boolean(),
  fields: z.record(SourceKey, FieldActionBody).refine((m) => Object.keys(m).length <= 200, 'too_many'),
});
const ParityRow = z.object({ category: z.enum(['stages', 'tags', 'custom_fields']), source: z.number(), imported: z.number(), needsReview: z.number(), rejected: z.number(), duplicate: z.number() });
const FieldActionView = z.union([
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('create'), type: FieldTypeEnum, label: z.string() }),
  z.object({ action: z.literal('existing'), fieldId: z.string() }),
]);
export const ParityResponse = z.object({
  options: z.object({ stageMap: z.record(z.string(), Stage8), keepStageAsTag: z.boolean(), fields: z.record(z.string(), FieldActionView) }),
  stages: z.array(z.object({ label: z.string(), people: z.number(), suggested: Stage8.nullable(), mapped: Stage8.nullable() })),
  tags: z.object({ distinct: z.number(), existing: z.number(), toCreate: z.number(), overLimit: z.number(), sourceLinks: z.number(), links: z.number(), protectedNew: z.number(), optOutTagged: z.number(), overLimitNames: z.array(z.string()) }),
  fields: z.array(
    z.object({
      sourceKey: z.string(),
      label: z.string(),
      people: z.number(),
      suggestedType: FieldTypeEnum,
      protected: z.boolean(),
      action: FieldActionView,
      fit: z.number(),
      misfit: z.number(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  existingFields: z.array(z.object({ id: z.string(), key: z.string(), label: z.string(), type: FieldTypeEnum })),
  blockers: z.array(z.string()),
  lines: z.array(z.string()),
  report: z.array(ParityRow),
});
export const RevertBody = z.strictObject({ category: CategoryParam.optional() });

// ---- responses ----------------------------------------------------------------------------------

const Issue = z.object({ code: z.string(), severity: z.string(), field: z.string().nullable(), sentence: z.string() });
const StageCounts = z.object({ source: z.number(), willImport: z.number(), imported: z.number().nullable(), needsReview: z.number(), rejected: z.number(), duplicate: z.number() }).nullable();
const Stage = z.object({
  id: z.string(),
  category: CategoryParam,
  seq: z.number(),
  status: z.string(),
  counts: StageCounts,
  dryRunSha256: z.string().nullable(),
  dryRunCompletedAt: z.string().nullable(),
  blockers: z.array(Issue),
  approvedAt: z.string().nullable(),
  approvedByUserId: z.string().nullable(),
  committedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedByUserId: z.string().nullable(),
  revert: z.record(z.string(), z.unknown()).nullable(),
});
export const Batch = z.object({
  id: z.string(),
  source: z.enum(['csv', 'fub_api', 'fub_export']),
  status: z.string(),
  sourceCounts: z.record(z.string(), z.number().nullable()),
  snapshotSha256: z.string().nullable(),
  snapshotAt: z.string().nullable(),
  snapshotError: z.string().nullable(),
  fileLabel: z.string().nullable(),
  csv: z.object({ headers: z.array(z.string()), mapping: z.array(z.unknown()) }).nullable(),
  createdAt: z.string(),
  createdByUserId: z.string(),
  revertedAt: z.string().nullable(),
  stages: z.array(Stage),
  connectionTest: z.array(z.string()),
});
export const BatchResponse = z.object({ batch: Batch });
export const BatchListResponse = z.object({ batches: z.array(Batch) });
export const AcceptedResponse = z.object({ batch: Batch, queued: z.string() });

const Target = z.union([z.object({ kind: z.literal('user'), userId: z.string().nullable() }), z.object({ kind: z.literal('pond'), pondId: z.string().nullable() }), z.object({ kind: z.literal('unassigned') })]).nullable();
const SourceUser = z.object({ sourceRef: z.string(), label: z.string(), people: z.number(), target: Target });
export const MappingsResponse = z.object({ users: z.array(SourceUser), ponds: z.array(SourceUser), unmapped: z.number(), complete: z.boolean() });

export const ImportRecord = z.object({
  id: z.string(),
  sourceRef: z.string(),
  outcome: z.string(),
  dryRunOutcome: z.string().nullable(),
  planned: z.string().nullable(),
  issues: z.array(Issue),
  record: z.record(z.string(), z.unknown()).nullable(),
  matchContactId: z.string().nullable(),
  duplicateCandidates: z.array(z.object({ contactId: z.string(), reason: z.string() })),
  optOutNote: z.string().nullable(),
  review: z.object({ decision: z.string(), byUserId: z.string().nullable(), mergeIntoContactId: z.string().nullable() }).nullable(),
  targetId: z.string().nullable(),
});
export const RecordsResponse = z.object({ records: z.array(ImportRecord), next: z.string().nullable() });
export const RecordResponse = z.object({ record: ImportRecord });

const Counts = z.object({ source: z.number(), imported: z.number(), needs_review: z.number(), rejected: z.number(), duplicate: z.number() });
export const ApproveResponse = z.object({ batch: Batch, expected: Counts });
export const VerificationResponse = z.object({
  /** what the approval expected, with the documented commit outcomes applied (owner decision B4, E230) */
  expected: Counts,
  /** what the approval expected */
  approved: Counts,
  /** commit outcomes the approved plan could not predict, documented on their records (a count and a sentence) */
  documented: z.array(z.object({ code: z.string(), count: z.number(), sentence: z.string() })),
  db: Counts,
  matches: z.boolean(),
  diffs: z.array(z.object({ key: z.string(), source: z.number(), db: z.number() })),
  sample: z.array(z.object({ sourceRef: z.string(), recordId: z.string(), source: z.record(z.string(), z.unknown()), imported: z.record(z.string(), z.unknown()).nullable(), same: z.boolean() })),
});
export const ReportResponse = z.object({
  source: z.string(),
  categories: z.array(
    z.object({
      category: CategoryParam,
      status: z.string(),
      phase: z.enum(['dry_run', 'committed', 'reverted']),
      source: z.number(),
      imported: z.number(),
      needsReview: z.number(),
      rejected: z.number(),
      duplicate: z.number(),
      reconciles: z.boolean(),
      lines: z.array(z.string()),
      /** ownership (owner decision B4, E231): the people the commit brought in unassigned; "Assign these people" selects `contactIds` */
      unassigned: z
        .object({
          total: z.number(),
          stillUnassigned: z.number(),
          contactIds: z.array(z.string()),
          people: z.array(z.object({ contactId: z.string(), name: z.string(), sentence: z.string(), stillUnassigned: z.boolean() })),
        })
        .nullable(),
    }),
  ),
  /** PARITY 65 (R-PAR-46): stages, tags and custom fields: source vs imported vs needs review vs rejected */
  parity: z.object({ phase: z.enum(['dry_run', 'committed', 'reverted']), rows: z.array(ParityRow), lines: z.array(z.string()) }).nullable(),
});
export const CreatedResponse = z.object({ batch: Batch });

export const IMPORTS_RESPONSE_SCHEMAS = {
  BatchResponse,
  BatchListResponse,
  AcceptedResponse,
  MappingsResponse,
  RecordsResponse,
  RecordResponse,
  ApproveResponse,
  VerificationResponse,
  ReportResponse,
  CreatedResponse,
  ParityResponse,
};

export const IMPORTS_REQUEST_SCHEMAS = { CreateImportBody, MappingsBody, CsvMappingBody, RecordsQuery, ReviewBody, ApproveBody, VerifyBody, RevertBody, ParityBody };
