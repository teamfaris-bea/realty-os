// api/duplicates response and request schemas. No tenant id and no confidence field (BUILD_PLAN ground
// rules): a match reason is a fact ("same phone"), never a score.
import { z } from 'zod';

export const IdParams = z.object({ id: z.uuid() });
export const ListQuery = z.strictObject({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export const MATCH_REASONS = ['shared_phone', 'shared_email', 'phone_email_split', 'name_postal', 'trigram_name', 'import'] as const;

const Point = z.object({ kind: z.enum(['phone', 'email']), address: z.string(), label: z.string() });

export const DuplicateSide = z.object({
  id: z.uuid(),
  displayName: z.string(),
  stage: z.string(),
  ownershipState: z.string(),
  owner: z.object({ userId: z.uuid(), displayName: z.string().nullable() }).nullable(),
  ownedAt: z.string().nullable(),
  createdAt: z.string(),
  source: z.string().nullable(),
  /** a person-level "do not contact" (follows the merge; nobody can lift it) */
  doNotContact: z.boolean(),
  phones: z.array(Point),
  emails: z.array(Point),
  counts: z.object({ notes: z.number().int(), tags: z.number().int(), fieldValues: z.number().int(), relationships: z.number().int() }),
});

export const DuplicatePair = z.object({
  id: z.uuid(),
  matchReason: z.enum(MATCH_REASONS),
  /** plain words for the reason ("Same phone number") */
  reasonText: z.string(),
  status: z.enum(['open', 'merged', 'dismissed']),
  createdAt: z.string(),
  /** the suggested survivor: the earlier record (its history and source stay first) */
  suggestedSurvivorId: z.uuid(),
  /** who owns the merged person; `choose` when the two have different owners (Owner/Admin/TL pick) */
  owner: z.discriminatedUnion('rule', [
    z.object({ rule: z.literal('same'), userId: z.uuid().nullable() }),
    z.object({ rule: z.literal('choose'), preselectedUserId: z.uuid(), options: z.array(z.object({ userId: z.uuid(), displayName: z.string().nullable() })) }),
  ]),
  /** whether the caller's role may complete this merge (agents/ISAs cannot merge across owners or pond/offer cards) */
  canMerge: z.boolean(),
  a: DuplicateSide,
  b: DuplicateSide,
});

export const DuplicatesResponse = z.object({ duplicates: z.array(DuplicatePair), nextCursor: z.string().nullable() });
export const DuplicateResponse = z.object({ duplicate: DuplicatePair });
