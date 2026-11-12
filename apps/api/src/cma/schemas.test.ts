// api/cma schemas (R-AST-13, R-CMA-4, R-TEN-3, R-CMA-2): no response field named like confidence, score or probability, no
// tenant id; a snapshot of every response schema so a new field is a reviewed change; strict request bodies.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CMA_RESPONSE_SCHEMAS, OneTapBody, PatchBody, PrepareBody } from './schemas.js';

describe('api/cma schemas', () => {
  it('R-AST-13 R-CMA-4 R-TEN-3: no response field matches /confidence|score|probab/i, none carries a tenant id', () => {
    for (const [name, schema] of Object.entries(CMA_RESPONSE_SCHEMAS)) {
      const text = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
      const keys = [...text.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
      expect([name, keys.filter((k) => /confidence|score|probab/i.test(k))]).toEqual([name, []]);
      expect([name, /"tenant_id"|"tenantId"/.test(text)]).toEqual([name, false]);
    }
  });

  it('R-AST-13: the response schemas are snapshot-tested', () => {
    for (const [name, schema] of Object.entries(CMA_RESPONSE_SCHEMAS)) expect(z.toJSONSchema(schema, { unrepresentable: 'any' })).toMatchSnapshot(name);
  });

  it('R-TEN-3 R-CMA-2: bodies are strict: no tenant id, no creator, no stored result, no person or listing-text field', () => {
    const subject = { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'condo', sqft: 900 } };
    expect(PrepareBody.safeParse({ subject, purpose: 'listing_price' }).success).toBe(true);
    for (const extra of [{ tenantId: 'x' }, { createdByUserId: 'x' }, { result: {} }, { valueCents: 1 }, { status: 'shared' }]) {
      expect(PrepareBody.safeParse({ subject, purpose: 'listing_price', ...extra }).success).toBe(false);
      expect(PatchBody.safeParse(extra).success).toBe(false);
      expect(OneTapBody.safeParse(extra).success).toBe(false);
    }
    expect(PrepareBody.safeParse({ subject: { ...subject, facts: { ...subject.facts, description: 'x' } }, purpose: 'listing_price' }).success).toBe(false);
    expect(PrepareBody.safeParse({ subject: { kind: 'listing', listingId: '00000000-0000-4000-8000-000000000000', tenantId: 'x' }, purpose: 'listing_price' }).success).toBe(false);
  });
});
