// The seller panel API (ISA-3; ISA-4's data; docs/AI_ISA.md §9.1). Agent-only: addresses, prices and brokerage names
// shown here never reach a client from these routes. Codes and sentences; no confidence or score (R-AST-13).
import { z } from 'zod';

const Iso = z.string();
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const ConfirmSubjectBody = z.strictObject({ contactAddressId: z.uuid(), recordListingId: z.uuid(), factsSha256: Sha });
export const NearMatchBody = z.strictObject({ listingIds: z.array(z.uuid()).min(1).max(20) });

export const SubjectView = z.object({
  state: z.string(),
  code: z.string().nullable(),
  sentence: z.string(),
  nextStep: z.string().nullable(),
  contactAddressId: z.string().nullable(),
  addressLine: z.string().nullable(),
  recordListingId: z.string().nullable(),
  recordDate: Iso.nullable(),
  facts: z.object({ type: z.string(), beds: z.number(), baths_x10: z.number().nullable(), sqft: z.number() }).nullable(),
  factsSha256: z.string().nullable(),
  confirmed: z.boolean(),
  confirmedAt: Iso.nullable(),
  disputed: z.boolean(),
  clearedReason: z.string().nullable(),
  /** codes that keep seller facts off now (SUBJECT_UNCONFIRMED, SUBJECT_CHANGED, ...) */
  codes: z.array(z.string()),
});

export const SellerPanel = z.object({
  contactId: z.uuid(),
  assignmentId: z.uuid().nullable(),
  side: z.string().nullable(),
  subject: SubjectView,
  blockers: z.array(z.object({ code: z.string(), sentence: z.string() })),
  lastCompsCheck: z.object({ codes: z.array(z.string()), checkedAt: Iso }).nullable(),
  capabilities: z.object({ comps: z.object({ available: z.boolean(), sentence: z.string() }), competition: z.object({ available: z.boolean(), sentence: z.string() }) }),
  link: z.object({ effect: z.enum(['ok', 'pause', 'end']), code: z.string().nullable(), sentence: z.string(), listingIds: z.array(z.string()) }),
  suspension: z.object({ suspended: z.boolean(), sentence: z.string().nullable() }),
  watch: z.object({ lastRunAt: Iso.nullable(), sentence: z.string() }),
  counts: z.object({ active: z.number(), comingSoon: z.number(), pending: z.number(), sentence: z.string() }).nullable(),
  factsSent: z.array(z.object({ factKind: z.string(), listingId: z.string().nullable(), sentAt: Iso })),
});

export const SellerResult = z.object({ ok: z.literal(true), sentence: z.string() });
