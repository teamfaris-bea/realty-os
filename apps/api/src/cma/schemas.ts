// api/cma request and response schemas (module 71). Strict request bodies: unknown keys are refused, so no listing text,
// person, demographic or school field can reach the engine (R-CMA-2, fair housing). Response schemas carry no tenant id
// and no field named like confidence, score or probability (R-AST-13, R-CMA-4; snapshot-tested).
import { z } from 'zod';
import { CMA_PROPERTY_TYPES, CMA_TIERS } from './deps.js';
import { BLOCKER_CODES } from './gates.js';

const Int = z.number().int();

/**
 * The agent-entered subject facts (strict: no other key is accepted, R-CMA-2 / fair housing). These are the agent-entry
 * bounds; each one fits core/valuation's CmaSubjectSchema field of the same fact (schemas.test.ts checks it), where
 * `subdivision` is the engine's `subdivisionName`.
 */
export const CmaSubjectFactsSchema = z
  .object({
    propertyType: z.enum(CMA_PROPERTY_TYPES).optional(),
    sqft: Int.min(100).max(100_000).optional(),
    beds: Int.min(0).max(50).nullable().optional(),
    bathsX10: Int.min(0).max(500).nullable().optional(),
    yearBuilt: Int.min(1600).max(2100).nullable().optional(),
    lotSqft: Int.min(0).max(1e9).nullable().optional(),
    garageSpacesX10: Int.min(0).max(500).nullable().optional(),
    storiesX10: Int.min(0).max(500).nullable().optional(),
    poolPrivate: z.boolean().nullable().optional(),
    subdivision: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();
export type CmaSubjectFacts = z.infer<typeof CmaSubjectFactsSchema>;

const Id = z.uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Purpose = z.enum(['listing_price', 'buyer_offer', 'other']);
const Inspection = z.enum(['none', 'exterior', 'interior_and_exterior']);
const IdList = z.array(Id).max(100);
const Short = z.string().trim().max(2000).nullable();

export const IdParams = z.object({ id: Id });

const Anchor = z
  .object({
    line1: z.string().trim().min(1).max(200).nullable().optional(),
    line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120).nullable().optional(),
    region: z.string().trim().min(2).max(60),
    postalCode: z.string().trim().min(3).max(12),
  })
  .strict();

export const SubjectBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listing'), listingId: Id, facts: CmaSubjectFactsSchema.optional() }).strict(),
  z.object({ kind: z.literal('contact_address'), contactAddressId: Id, facts: CmaSubjectFactsSchema.optional() }).strict(),
  z.object({ kind: z.literal('entered'), anchor: Anchor, facts: CmaSubjectFactsSchema }).strict(),
]);

export const PrepareBody = z
  .object({ subject: SubjectBody, contactId: Id.optional(), purpose: Purpose, inspection: Inspection.optional(), inspectedOn: Day.nullable().optional() })
  .strict();

export const OneTapBody = z.object({ contactAddressId: Id.optional(), facts: CmaSubjectFactsSchema.optional() }).strict();

export const PatchBody = z
  .object({
    include: IdList.optional(),
    exclude: IdList.optional(),
    subjectFacts: CmaSubjectFactsSchema.optional(),
    purpose: Purpose.optional(),
    inspection: Inspection.optional(),
    inspectedOn: Day.nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    disclosure: z.object({ intendedUsers: Short.optional(), agentInterest: Short.optional(), conflicts: Short.optional(), valueDefinition: Short.optional(), limitingConditions: Short.optional() }).strict().optional(),
    nearMatchDismissed: IdList.optional(),
  })
  .strict();

const Source = z.enum(['mls', 'team', 'agent']).nullable();
const fact = <T extends z.ZodType>(v: T) => z.object({ value: v.nullable(), source: Source });
const Address = z.object({ line1: z.string().nullable(), line2: z.string().nullable(), city: z.string().nullable(), region: z.string().nullable(), postalCode: z.string().nullable() });
const N = z.number().nullable();
const ListingAddress = z.object({ line1: z.string(), line2: z.string().nullable(), city: z.string(), region: z.string(), postalCode: z.string() });
const Support = z.object({ kind: z.enum(['with_without', 'above_below', 'sales_months', 'none']), first: z.number(), second: z.number(), pairs: z.number() });

export const CmaViewSchema = z.object({
  id: Id,
  contactId: Id.nullable(),
  status: z.enum(['draft', 'shared', 'superseded']),
  purpose: Purpose,
  inspection: Inspection,
  inspectedOn: z.string().nullable(),
  disclosure: z.object({ intendedUsers: z.string().nullable(), agentInterest: z.string().nullable(), conflicts: z.string().nullable(), valueDefinition: z.string().nullable(), limitingConditions: z.string().nullable() }),
  notes: z.string().nullable(),
  createdByUserId: Id,
  mine: z.boolean(),
  canEdit: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sharedAt: z.string().nullable(),
  valuationDate: z.string(),
  mlsDataAsOf: z.string().nullable(),
  mlsDataAsOfSentence: z.string(),
  methodVersion: z.string(),
  subject: z.object({
    kind: z.enum(['listing', 'contact_address', 'entered']),
    listingId: z.string().nullable(),
    contactAddressId: z.string().nullable(),
    address: Address,
    state: z.string().nullable(),
    sizeSentence: z.string(),
    /** stored facts left out because they are outside what the valuation reads, one sentence each */
    factSentences: z.array(z.string()),
    facts: z.object({
      propertyType: fact(z.enum(CMA_PROPERTY_TYPES)),
      sqft: fact(z.number()),
      agentEnteredSqft: N,
      beds: fact(z.number()),
      bathsX10: fact(z.number()),
      yearBuilt: fact(z.number()),
      lotSqft: fact(z.number()),
      garageSpacesX10: fact(z.number()),
      storiesX10: fact(z.number()),
      poolPrivate: fact(z.boolean()),
      subdivision: fact(z.string()),
      mapLocation: z.object({ known: z.boolean(), source: Source }),
    }),
    saleHistory: z.array(z.object({ listingId: z.string(), mlsNumber: z.string().nullable(), status: z.string(), closeDate: z.string().nullable(), closePriceCents: N, listingBrokerageName: z.string().nullable() })),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    nearMatchDismissed: z.array(z.string()),
  }),
  result: z.object({
    available: z.boolean(),
    reason: z.enum(['NO_SALES', 'INSUFFICIENT_COMPS', 'SUBJECT_INCOMPLETE', 'SUBJECT_TYPE_NOT_SUPPORTED']).nullable(),
    sentence: z.string(),
    sentences: z.array(z.string()),
    valueCents: N,
    lowCents: N,
    highCents: N,
    closeDateSpan: z.object({ earliest: z.string(), latest: z.string() }).nullable(),
    distanceSpanM: z.object({ min: z.number(), max: z.number() }).nullable(),
  }),
  comps: z.array(
    z.object({
      listingId: z.string(),
      saleListingId: z.string(),
      sourceLabel: z.enum(['MLS', 'Team']),
      mlsNumber: z.string().nullable(),
      listingBrokerageName: z.string().nullable(),
      address: ListingAddress,
      closePriceCents: N,
      closeDate: z.string().nullable(),
      contractDate: z.string().nullable(),
      distanceM: N,
      tier: z.enum(CMA_TIERS).nullable(),
      facts: z.object({ propertyType: z.string().nullable(), sqft: N, sizeSource: z.string().nullable(), beds: N, bathsX10: N, yearBuilt: N, lotSqft: N, daysOnMarket: N, concessionsCents: N }),
      adjustments: z.array(z.object({ feature: z.string(), subjectValue: N, compValue: N, rate: N, amountCents: z.number(), support: Support, sentence: z.string() })),
      adjustedPriceCents: z.number(),
      grossAdjustmentBps: z.number(),
      weightBasisBps: z.number(),
      weightBps: z.number(),
      why: z.array(z.string()),
      labels: z.array(z.string()),
      saleConditions: z.array(z.string()),
      includedByAgent: z.boolean(),
    }),
  ),
  notUsed: z.array(z.object({ listingId: z.string(), mlsNumber: z.string().nullable(), address: z.string(), reason: z.string(), conditions: z.array(z.string()), distanceM: N, sentence: z.string(), includable: z.boolean() })),
  notUsedTotal: z.number(),
  subjectSales: z.array(z.object({ listingId: z.string(), closeDate: z.string().nullable(), closePriceCents: N, status: z.string() })),
  context: z.array(
    z.object({ listingId: z.string(), sourceLabel: z.enum(['MLS', 'Team']), mlsNumber: z.string().nullable(), listingBrokerageName: z.string().nullable(), status: z.string(), listPriceCents: N, beds: N, bathsX10: N, sqft: N, address: z.string(), why: z.array(z.string()) }),
  ),
  contextSentence: z.string(),
  area: z.object({
    tier: z.enum(CMA_TIERS).nullable(),
    lookbackMonths: z.number(),
    tiersSkipped: z.array(z.enum(CMA_TIERS)),
    reads: z.array(z.object({ tier: z.enum([...CMA_TIERS, 'rate_pool']), ran: z.boolean(), rows: z.number(), limitReached: z.boolean() })),
    recordsLeftOut: z.number(),
    sentences: z.array(z.string()),
  }),
  market: z.object({
    poolTier: z.enum(CMA_TIERS).nullable(),
    poolMonths: z.number(),
    poolSales: z.number(),
    rates: z.array(z.object({ feature: z.string(), applied: z.boolean(), rate: N, support: Support, sentence: z.string() })),
    sentences: z.array(z.string()),
  }),
  backtest: z.object({ salesTested: z.number(), notValued: z.number(), medianMissBps: N, within10PctBps: N, windowStart: z.string(), sentence: z.string() }),
  /** avmDisplayAllowed is null while the record has not been re-read since the feed's flag was added (gates/F4) */
  nearMatches: z.array(z.object({ listingId: z.string(), mlsNumber: z.string().nullable(), address: z.string(), status: z.string(), listingBrokerageName: z.string().nullable(), avmDisplayAllowed: z.boolean().nullable(), dismissed: z.boolean() })),
  /** client readiness (R-CMA-7); D9: nothing is shared in V1, so sharingAvailable is false and the sentence says so */
  clientShare: z.object({
    ready: z.boolean(),
    sharingAvailable: z.literal(false),
    sentence: z.string(),
    estimateSentence: z.string(),
    blockers: z.array(z.object({ code: z.enum(BLOCKER_CODES), sentence: z.string(), count: z.number().optional(), listingIds: z.array(z.string()).optional() })),
  }),
});

export const CmaResponse = z.object({ cma: CmaViewSchema });

export const CmaListResponse = z.object({
  cmas: z.array(
    z.object({
      id: Id,
      contactId: Id.nullable(),
      status: z.string(),
      purpose: z.string(),
      valuationDate: z.string(),
      mlsDataAsOf: z.string().nullable(),
      valueCents: N,
      lowCents: N,
      highCents: N,
      address: z.string().nullable(),
      createdByUserId: Id,
      mine: z.boolean(),
      fromMergedRecord: z.boolean(),
      createdAt: z.string(),
    }),
  ),
});

/** Every response schema of the module (the R-AST-13 snapshot walks these). */
export const CMA_RESPONSE_SCHEMAS = { CmaResponse, CmaListResponse } as const;
