// Fair housing and evidence-not-scores for core/valuation (R-CMA-2, R-AST-13): the strict input schemas
// refuse any other key at runtime, the allowed keys are pinned at the type level, the shared unions
// match core/listings and the S0 migration, and no result key reads as a confidence, score or probability.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ListingStatus, PropertyType } from '../listings/index.js';
import {
  type CmaRef,
  type CmaSale,
  type CmaSubject,
  CMA_LISTING_STATUSES,
  CMA_PROPERTY_TYPES,
  CMA_SALE_CONDITIONS,
  type CmaListingStatus,
  type CmaPropertyType,
  CmaRefSchema,
  CmaSaleSchema,
  CmaSubjectSchema,
  prepareCma,
} from './index.js';
import { VALUATION_DATE, cand, linearMarket, ref, sale, subject } from './testing/fixtures.js';

interface FileUrl {
  readonly pathname: string;
}
const Url = (globalThis as unknown as { URL: new (path: string, base: string | FileUrl) => FileUrl }).URL;
interface FsLike {
  readdirSync(p: FileUrl): string[];
  readFileSync(p: FileUrl, enc: 'utf8'): string;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;
const HERE = (import.meta as unknown as { url: string }).url;

const FORBIDDEN = ['schoolRating', 'demographics', 'contactId', 'description', 'photoUrls', 'publicRemarks', 'race', 'religion', 'familialStatus', 'crimeIndex', 'predictedScore', 'ownerName'];

const SUBJECT_KEYS = [
  'propertyType', 'sqft', 'sizeSource', 'beds', 'bathsX10', 'yearBuilt', 'lotSqft', 'garageSpacesX10', 'poolPrivate', 'storiesX10',
  'latE6', 'lonE6', 'postalCode', 'city', 'region', 'subdivisionName', 'addressKey', 'ownIdentities', 'ownMlsNumbers',
] as const;
const SALE_KEYS = [
  'status', 'closePriceCents', 'closeDate', 'contractDate', 'listPriceCents', 'originalListPriceCents', 'concessionsCents', 'saleConditions', 'isLease',
  'propertyType', 'sqft', 'sizeSource', 'beds', 'bathsX10', 'yearBuilt', 'lotSqft', 'garageSpacesX10', 'poolPrivate', 'storiesX10',
  'latE6', 'lonE6', 'postalCode', 'city', 'region', 'subdivisionName', 'addressKey', 'daysOnMarket',
] as const;
const REF_KEYS = ['identity', 'source', 'teamListingId', 'mlsNumber', 'connectionId'] as const;

describe('R-CMA-2 fair housing: strict input schemas', () => {
  it('R-CMA-2: CmaSubjectSchema, CmaSaleSchema and CmaRefSchema refuse any extra key', () => {
    for (const key of FORBIDDEN) {
      expect(CmaSubjectSchema.safeParse({ ...subject(), [key]: 'x' }).success).toBe(false);
      expect(CmaSaleSchema.safeParse({ ...sale(), [key]: 'x' }).success).toBe(false);
      expect(CmaRefSchema.safeParse({ ...ref('r1'), [key]: 'x' }).success).toBe(false);
    }
    expect(CmaSubjectSchema.safeParse(subject()).success).toBe(true);
    expect(CmaSaleSchema.safeParse(sale()).success).toBe(true);
    expect(CmaRefSchema.safeParse(ref('r1')).success).toBe(true);
  });

  it('R-CMA-2: prepareCma refuses a subject, a sale or a reference with an extra key', () => {
    const base = { subject: subject(), candidates: [cand('a')], tierReads: [], valuationDate: VALUATION_DATE };
    expect(() => prepareCma({ ...base, subject: { ...subject(), schoolRating: 9 } as CmaSubject })).toThrow();
    expect(() => prepareCma({ ...base, candidates: [{ ref: ref('a'), sale: { ...sale(), demographics: {} } as CmaSale }] })).toThrow();
    expect(() => prepareCma({ ...base, candidates: [{ ref: { ...ref('a'), contactId: 'c1' } as CmaRef, sale: sale() }] })).toThrow();
    expect(() => prepareCma({ ...base, candidates: [{ ref: ref('a'), sale: sale(), photoUrls: [] } as never] })).toThrow();
    expect(() => prepareCma({ ...base, tierReads: [{ tier: 'city', limitReached: false, description: 'x' } as never] })).toThrow();
  });

  it('R-CMA-2: the allowed keys of the three schemas are exactly these (type level and runtime)', () => {
    expectTypeOf<keyof CmaSubject>().toEqualTypeOf<(typeof SUBJECT_KEYS)[number]>();
    expectTypeOf<keyof CmaSale>().toEqualTypeOf<(typeof SALE_KEYS)[number]>();
    expectTypeOf<keyof CmaRef>().toEqualTypeOf<(typeof REF_KEYS)[number]>();
    expect(Object.keys(CmaSubjectSchema.shape).sort()).toEqual([...SUBJECT_KEYS].sort());
    expect(Object.keys(CmaSaleSchema.shape).sort()).toEqual([...SALE_KEYS].sort());
    expect(Object.keys(CmaRefSchema.shape).sort()).toEqual([...REF_KEYS].sort());
  });

  it('CmaPropertyType and CmaListingStatus equal core/listings PropertyType and ListingStatus', () => {
    expectTypeOf<CmaPropertyType>().toEqualTypeOf<PropertyType>();
    expectTypeOf<CmaListingStatus>().toEqualTypeOf<ListingStatus>();
    expect([...CMA_PROPERTY_TYPES].sort()).toEqual(['condo', 'land', 'manufactured', 'multi_family', 'other', 'single_family', 'townhouse']);
    expect(CMA_LISTING_STATUSES).toHaveLength(6);
  });

  it('CmaSaleCondition equals the listings.sale_conditions CHECK of the S0 migration', () => {
    // core/listings SaleCondition arrives with lane V1-A; until then the S0 CHECK is the source of truth.
    const dir = new Url('../../../db/migrations/', HERE);
    const file = fs.readdirSync(dir).find((f) => /_cma_schema\.sql$/.test(f));
    expect(file).toBeDefined();
    const sql = fs.readFileSync(new Url(file as string, dir), 'utf8');
    const m = /sale_conditions <@ ARRAY\[([^\]]+)\]/.exec(sql);
    const values = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...CMA_SALE_CONDITIONS]).toEqual(values);
  });
});

describe('R-AST-13: evidence, not scores', () => {
  function keysDeep(v: unknown, out: Set<string>): Set<string> {
    if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.add(k);
        keysDeep(x, out);
      }
    }
    return out;
  }

  it('R-AST-13: no key in CmaResult matches /confidence|score|probab/i (available and unavailable results)', () => {
    const market = linearMarket({ n: 300, seed: 4, trendCentsPerMonth: 30, poolCents: 2_000_000, noise: 0.03 });
    const results = [
      prepareCma({ subject: subject(), candidates: market, tierReads: [{ tier: 'city', limitReached: true }], valuationDate: VALUATION_DATE }),
      prepareCma({ subject: subject(), candidates: market.slice(0, 2), tierReads: [], valuationDate: VALUATION_DATE }),
      prepareCma({ subject: subject({ sqft: null }), candidates: [], tierReads: [], valuationDate: VALUATION_DATE }),
    ];
    expect(results[0]?.available).toBe(true);
    for (const r of results) {
      const keys = [...keysDeep(r, new Set())];
      expect(keys.length).toBeGreaterThan(20);
      expect(keys.filter((k) => /confidence|score|probab/i.test(k))).toEqual([]);
    }
  });
});
