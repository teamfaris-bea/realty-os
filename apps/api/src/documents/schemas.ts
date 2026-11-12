// Zod schemas of the api/documents routes. Responses carry ids, states and the copy sentences; never a tenant id,
// a storage key, key material or a confidence number.
import { z } from 'zod';
import { DOCUMENT_KINDS } from './types.js';

export const IdParams = z.object({ id: z.uuid() });
export const ClaimParams = z.object({ id: z.uuid(), claimId: z.uuid() });

const ScanState = z.enum(['checking', 'waiting_for_scanner', 'clean', 'blocked']);
const Scope = z.object({ kind: z.enum(['deal', 'listing', 'contact']), id: z.uuid() });
const Extraction = z.object({
  status: z.enum(['not_applicable', 'photo', 'not_set_up', 'waiting_for_scan', 'not_started', 'not_visible', 'proposed', 'approved', 'executed', 'rejected', 'superseded', 'invalidated', 'expired', 'blocked']),
  outcome: z.enum(['dates', 'no_text', 'no_dates', 'unreadable']).nullable(),
  claimCount: z.number().int(),
  text: z.string().nullable(),
});

export const DocumentSchema = z.object({
  id: z.uuid(),
  scope: Scope,
  kind: z.enum(DOCUMENT_KINDS),
  displayName: z.string(),
  versionNo: z.number().int(),
  supersedesId: z.uuid().nullable(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  uploadedByUserId: z.uuid(),
  uploadedAt: z.string(),
  scan: ScanState,
  scanText: z.string().nullable(),
  blockedReason: z.enum(['malware', 'unscannable']).nullable(),
  legalHold: z.boolean(),
  retentionUntil: z.string().nullable(),
  portal: z.object({ shared: z.boolean(), portalCleared: z.boolean(), text: z.string().nullable() }),
  extraction: Extraction,
  canShare: z.boolean(),
  canHold: z.boolean(),
});

const Adapter = z.object({ configured: z.boolean(), test: z.boolean(), statusText: z.string() });
export const PlatformSchema = z.object({ scanner: Adapter, extractor: Adapter, portalCleared: z.boolean() });

export const ListResponse = z.object({
  documents: z.array(DocumentSchema.extend({ newerVersion: z.object({ id: z.uuid(), versionNo: z.number().int(), scan: ScanState }).nullable() })),
  platform: PlatformSchema,
});
export const DetailResponse = z.object({ document: DocumentSchema, versions: z.array(DocumentSchema), platform: PlatformSchema });
export const UploadResponse = DetailResponse.extend({ previousVersionShared: z.boolean(), previousVersionSharedText: z.string().nullable() });

export const ShareBody = z.strictObject({ shared: z.boolean() });
export const ShareResponse = DetailResponse.extend({ text: z.string().nullable() });
export const HoldBody = z.strictObject({ hold: z.boolean(), reason: z.string().trim().min(1).max(200) });
const ClaimView = z.object({
  id: z.uuid(),
  ordinal: z.number().int(),
  text: z.string(),
  milestone: z.object({ kind: z.string(), label: z.string(), dueOn: z.string() }).nullable(),
  page: z.number().int().nullable(),
  needsReview: z.boolean(),
  reviewNote: z.string().nullable(),
  reviewStatus: z.enum(['unreviewed', 'confirmed', 'corrected', 'rejected']),
  evidence: z.array(z.object({ sourceType: z.literal('document'), locator: z.object({ kind: z.literal('char_range'), page: z.number().int(), start: z.number().int(), end: z.number().int() }), snippet: z.string().nullable(), verified: z.boolean(), line: z.string().nullable() })),
  liveDates: z.array(z.object({ dateId: z.uuid(), label: z.string().nullable(), dueOn: z.string(), status: z.string(), source: z.string() })),
  appliedDateId: z.uuid().nullable(),
  appliedNote: z.string().nullable(),
});
export const ExtractionResponse = z.object({
  document: DocumentSchema,
  action: z.object({ id: z.uuid(), status: z.string(), outcome: z.enum(['dates', 'no_text', 'no_dates', 'unreadable']).nullable(), text: z.string().nullable() }).nullable(),
  claims: z.array(ClaimView),
  relativeDeadlineText: z.string().nullable(),
  platform: PlatformSchema,
});
export const ConfirmClaimBody = z.strictObject({
  commandId: z.uuid(),
  target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('new') }), z.strictObject({ kind: z.literal('existing'), dateId: z.uuid() })]),
  reminderDaysBefore: z.number().int().min(0).max(60).nullable().optional(),
});
export const RejectClaimBody = z.strictObject({ commandId: z.uuid() });
export const ClaimDecisionResponse = ExtractionResponse.extend({ dateId: z.uuid().nullable() });
export const RetentionBody = z.strictObject({ retentionUntil: z.iso.datetime({ offset: true }) });
