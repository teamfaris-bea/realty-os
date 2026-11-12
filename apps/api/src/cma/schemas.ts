// api/cma request and response schemas (module 71). Strict request bodies: unknown keys are refused, so no listing text,
// person, demographic or school field can reach the engine (R-CMA-2, fair housing). Response schemas carry no tenant id
// and no field named like confidence, score or probability (R-AST-13, R-CMA-4; snapshot-tested).
import { z } from 'zod';
import { CMA_PROPERTY_TYPES, CMA_TIERS, CmaSubjectFactsSchema } from './deps.js';
import { BLOCKER_CODES } from './gates.js';

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
  result: z.object({ available: z.boolean(), reason: z.enum(['INSUFFICIENT_COMPS']).nullable(), sentence: z.string(), valueCents: N, lowCents: N, highCents: N }),
  comps: z.array(
    z.object({
      listingId: z.string(),
      saleListingId: z.string(),
      sourceLabel: z.enum(['MLS', 'Team']),
      mlsNumber: z.string().nullable(),
      listingBrokerageName: z.string().nullable(),
      address: z.object({ line1: z.string(), line2: z.string().nullable(), city: z.string(), region: z.string(), postalCode: z.string() }),
      closePriceCents: N,
      closeDate: z.string().nullable(),
      contractDate: z.string().nullable(),
      distanceMiles: N,
      distanceSentence: z.string(),
      tier: z.enum(CMA_TIERS),
      facts: z.object({ propertyType: z.string().nullable(), sqft: N, sizeSource: z.string().nullable(), beds: N, bathsX10: N, yearBuilt: N, lotSqft: N, daysOnMarket: N, concessionsCents: N }),
      adjustments: z.array(z.object({ feature: z.string(), amountCents: z.number(), sentence: z.string() })),
      adjustedPriceCents: z.number(),
      weightBps: z.number(),
      why: z.array(z.string()),
      saleConditions: z.array(z.string()),
      includedByAgent: z.boolean(),
    }),
  ),
  notUsed: z.array(z.object({ listingId: z.string(), mlsNumber: z.string().nullable(), address: z.string(), reason: z.string(), sentence: z.string(), includable: z.boolean() })),
  adjustmentRates: z.array(z.object({ feature: z.string(), adjusted: z.boolean(), centsPerUnit: N, unit: z.string(), support: z.object({ below: z.number(), above: z.number(), pairs: z.number() }), sentence: z.string() })),
  context: z.array(
    z.object({ listingId: z.string(), sourceLabel: z.enum(['MLS', 'Team']), mlsNumber: z.string().nullable(), listingBrokerageName: z.string().nullable(), status: z.string(), listPriceCents: N, beds: N, bathsX10: N, sqft: N, address: z.string(), why: z.array(z.string()) }),
  ),
  contextSentence: z.string(),
  area: z.object({ tierUsed: z.enum(CMA_TIERS).nullable(), tiers: z.array(z.object({ tier: z.enum(CMA_TIERS), ran: z.boolean(), count: z.number(), limit: z.number(), limitReached: z.boolean(), sentence: z.string() })) }),
  market: z.object({ sales: z.number(), medianPricePerSqftCents: N, medianDaysOnMarket: N, sentence: z.string() }),
  backtest: z.object({ tested: z.number(), withinPct: z.number(), within: z.number(), sentence: z.string() }),
  nearMatches: z.array(z.object({ listingId: z.string(), mlsNumber: z.string().nullable(), address: z.string(), status: z.string(), listingBrokerageName: z.string().nullable(), avmDisplayAllowed: z.boolean(), dismissed: z.boolean() })),
  clientShare: z.object({
    allowed: z.boolean(),
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
