// Security review: a definition that core accepted as <= 8 KB (JSON.stringify) but that the smart_lists
// CHECK (octet_length(definition::text) <= 8192, jsonb re-spaced) refused: an unmapped 23514 -> 500.
// Core now measures the jsonb text, and the CHECK maps to LIST_DEFINITION_TOO_LARGE.
import { randomUUID } from 'node:crypto';
import { DEFINITION_MAX_BYTES, validateDefinition } from '@realty/core/parity/lists';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, listsWorld, type ListsWorld } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** Owner clauses of random user ids, filled until JSON.stringify is just under the core limit. */
function nearLimitDefinition() {
  const all: { kind: 'owner'; in: string[] }[] = [];
  const size = () => JSON.stringify({ v: 1, all }).length;
  while (all.length < 20) {
    const c = { kind: 'owner' as const, in: [randomUUID()] };
    all.push(c);
    if (size() > DEFINITION_MAX_BYTES) { all.pop(); break; }
    while (c.in.length < 50) {
      c.in.push(randomUUID());
      if (size() > DEFINITION_MAX_BYTES) { c.in.pop(); break; }
    }
    if (size() > DEFINITION_MAX_BYTES - 60) break;
  }
  return { v: 1, all };
}

describe('secreview: definition size limit', () => {
  it('a definition core accepts is either saved or refused with LIST_DEFINITION_TOO_LARGE (never a 500)', async () => {
    // just under 8 KB as JSON.stringify: before the fix core accepted it and the CHECK refused it (500)
    const def = nearLimitDefinition();
    const accepted = validateDefinition(def, 'personal').ok;
    const r = await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Big', definition: def });
    expect(r.status === 201 ? 201 : r.code).toBe(accepted ? 201 : 'LIST_DEFINITION_TOO_LARGE');
  });
});
