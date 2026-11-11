// R-PAR-43: what PATCH /contacts/:id may change. Names, contact type, intent, timezone, stage and the
// pond summary, with an optimistic row_version. Never ownership, attribution, merge or delete state,
// do_not_contact_*, tags (the tag lane) or imported_fields: a known protected key is refused with
// FIELD_NOT_EDITABLE (so a caller learns why), anything else unknown with VALIDATION_FAILED.
import { z } from 'zod';
import { ianaZone } from '../../foundation/tz.js';
import { STAGES } from './stage.js';

export const CONTACT_TYPES = ['lead', 'sphere', 'past_client', 'vendor', 'other'] as const;
export const INTENTS = ['buyer', 'seller', 'buyer_seller', 'renter', 'landlord', 'investor'] as const;

/** Keys that look like contact columns but are never edited by a patch (R-PAR-43). */
export const PROTECTED_CONTACT_KEYS = [
  'ownershipState', 'ownerUserId', 'pondId', 'offerId', 'offeredToUserId', 'ownershipSeq', 'firstTouchDueAt', 'firstTouchAt',
  'releaseDueAt', 'closedReason', 'mergedIntoContactId', 'deletedAt', 'doNotContactAt', 'doNotContactEventId',
  'originalLeadSourceId', 'originalCampaignRef', 'originalAdRef', 'originalSourceDetail', 'leadSourceId', 'attribution',
  'importedFields', 'importBatchId', 'createdByUserId', 'createdAt', 'tags', 'tenantId', 'id',
] as const;

function buildSchema() {
  const Name = z.string().trim().min(1).max(120);
  const NullableName = z.union([Name, z.null()]);
  return z.strictObject({
    rowVersion: z.number().int().min(1),
    displayName: Name.optional(),
    firstName: NullableName.optional(),
    lastName: NullableName.optional(),
    contactType: z.enum(CONTACT_TYPES).optional(),
    intent: z.union([z.enum(INTENTS), z.null()]).optional(),
    timezone: z.union([z.string().min(1).max(64), z.null()]).optional(),
    stage: z.enum(STAGES).optional(),
    pondSummary: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
  });
}
let schema: ReturnType<typeof buildSchema> | null = null;
/**
 * Built on first use, never at import: Zod 4 probes `new Function` when it builds an object schema, which a
 * browser bundle importing this module (the web's mention and activity helpers) must not do under its CSP.
 */
export function contactPatchSchema(): ReturnType<typeof buildSchema> {
  return (schema ??= buildSchema());
}
export type ContactPatch = z.infer<ReturnType<typeof buildSchema>>;

/** The editable fields (everything but rowVersion). */
export const PATCH_FIELDS = ['displayName', 'firstName', 'lastName', 'contactType', 'intent', 'timezone', 'stage', 'pondSummary'] as const;
export type PatchField = (typeof PATCH_FIELDS)[number];

export interface PatchIssue {
  path: string;
  code: string;
}

export type ContactPatchResult =
  | { ok: true; patch: ContactPatch; fields: PatchField[] }
  | { ok: false; code: 'FIELD_NOT_EDITABLE' | 'VALIDATION_FAILED'; issues: PatchIssue[] };

/** Validates a PATCH body strictly. A patch that changes nothing is VALIDATION_FAILED (`/`: empty). */
export function validateContactPatch(input: unknown): ContactPatchResult {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const protectedKeys = Object.keys(input).filter((k) => (PROTECTED_CONTACT_KEYS as readonly string[]).includes(k));
    if (protectedKeys.length > 0) return { ok: false, code: 'FIELD_NOT_EDITABLE', issues: protectedKeys.sort().map((k) => ({ path: `/${k}`, code: 'not_editable' })) };
  }
  const parsed = contactPatchSchema().safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_FAILED', issues: parsed.error.issues.map((i) => ({ path: `/${i.path.join('/')}`, code: i.code })) };
  }
  const patch = parsed.data;
  if (patch.timezone != null && ianaZone(patch.timezone) === null) return { ok: false, code: 'VALIDATION_FAILED', issues: [{ path: '/timezone', code: 'invalid_zone' }] };
  const fields = PATCH_FIELDS.filter((f) => patch[f] !== undefined);
  if (fields.length === 0) return { ok: false, code: 'VALIDATION_FAILED', issues: [{ path: '/', code: 'empty' }] };
  return { ok: true, patch, fields };
}

/** The pond summary is the owner's or a Team Lead's words on the pond card (R-PAR-43). */
export function pondSummaryEditable(rel: { own: boolean; teamLeadOrWider: boolean }): boolean {
  return rel.own || rel.teamLeadOrWider;
}
