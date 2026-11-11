import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as assistant from './index.js';

const schemas = {
  PlaybookStepSchema: assistant.PlaybookStepSchema,
  ToneSchema: assistant.ToneSchema,
  SearchCriteriaSchema: assistant.SearchCriteriaSchema,
  ModelOutputSchema: assistant.ModelOutputSchema,
  TriggerStepSchema: assistant.TriggerStepSchema,
  VoiceContentSchema: assistant.VoiceContentSchema,
};

function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

// R-AST-13 for core data schemas; api/* snapshot-tests the agent-facing response schemas.
describe('core/assistant schemas', () => {
  it.each(Object.entries(schemas))('%s has no confidence fields and no tenant_id (snapshot)', (name, schema) => {
    const json = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' });
    const keys = [...keysDeep(json)];
    expect(keys.filter((k) => /confidence|probability|tenant_?id/i.test(k))).toEqual([]);
    expect(json).toMatchSnapshot(name);
  });

  it('the public module surface exposes the BUILD_PLAN interface', () => {
    for (const fn of [
      'verifyQuote',
      'normalizeClaims',
      'authorizeAutonomousAction',
      'contentGuard',
      'validatePlaybook',
      'contentSha256',
      'renderStep',
      'proposeSearch',
      'matchListing',
      'buildPrompt',
      'validatePlaybookContent',
      'storedContent',
    ] as const) {
      expect(typeof assistant[fn]).toBe('function');
    }
  });
});
