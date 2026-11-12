// Response schemas of api/transactions carry no confidence, score or tenant id fields (R-AST-13, R-TEN-3), and request
// bodies are strict (no tenant id, no confirmer, no version, no instants are ever accepted).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfirmBody, PlanBody, PutTemplatesBody, TRANSACTION_RESPONSE_SCHEMAS } from './schemas.js';

describe('api/transactions schemas', () => {
  it('R-AST-13 R-TEN-3: response schemas have no confidence*, score or tenant id fields', () => {
    for (const [name, schema] of Object.entries(TRANSACTION_RESPONSE_SCHEMAS)) {
      const text = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
      expect([name, /confidence/i.test(text)]).toEqual([name, false]);
      expect([name, /"score"|"points"|probability/i.test(text)]).toEqual([name, false]);
      expect([name, /"tenant_id"|"tenantId"/.test(text)]).toEqual([name, false]);
    }
  });

  it('R-TEN-3 R-TXN-1: strict bodies refuse a tenant id, a confirmer, a version or instants', () => {
    for (const extra of [{ tenantId: 'x' }, { confirmedByUserId: 'x' }, { dueVersion: 2 }, { dueAt: '2027-01-01T00:00:00Z' }, { reminderAt: '2027-01-01T00:00:00Z' }]) {
      expect(ConfirmBody.safeParse(extra).success).toBe(false);
      expect(PlanBody.safeParse({ acceptanceDate: '2027-01-01', templateId: 't', templateVersion: 1, ...extra }).success).toBe(false);
      expect(PutTemplatesBody.safeParse({ templates: [], ...extra }).success).toBe(false);
    }
  });
});
