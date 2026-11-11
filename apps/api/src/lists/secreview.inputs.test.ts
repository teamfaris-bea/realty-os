// Security review: values that pass core validation but that Postgres refuses, so a run ends in a 500
// (stored for every member when it is a team list) instead of a 4xx at save / LIST_CURSOR_INVALID.
import { encodeCursor } from '@realty/core/parity/lists';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, listsWorld, type ListsWorld, run } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;
let dateField: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 1 });
  dateField = (await call<{ field: { id: string } }>(w.admin, 'POST', '/custom-fields', { label: 'Closing date', fieldType: 'date' })).body.field.id;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview: impossible dates in a definition', () => {
  it('a team list with date_on "2025-02-31" is refused at save (never a stored list whose every run is a 500)', async () => {
    const def = { v: 1, all: [{ kind: 'field', fieldId: dateField, op: 'date_on', value: '2025-02-31' }] };
    const save = await call<{ list: { id: string } }>(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'Bad date', definition: def });
    if (save.status === 201) {
      // the flaw: the list is saved, and every member who opens it gets an internal error
      const runs = await Promise.all([w.agentA, w.agentB, w.isa].map((c) => call(c, 'GET', `/people?list=${save.body.list.id}`)));
      expect(runs.map((r) => r.status)).toEqual([422, 422, 422]); // observed: [500, 500, 500]
    }
    expect(save.status).toBe(422);
  });

  it('an ad-hoc run with date_on "0000-01-01" or "2025-13-01" is a 4xx, never a 500', async () => {
    for (const value of ['0000-01-01', '2025-13-01', '2025-02-31']) {
      const r = await run(w.agentA, { v: 1, all: [{ kind: 'field', fieldId: dateField, op: 'date_on', value }] });
      expect(r.status, value).toBeLessThan(500);
    }
  });
});

describe('secreview: forged keyset cursors', () => {
  it('a cursor whose key Date.parse accepts but Postgres does not ("1", "May 5", year -271821) is LIST_CURSOR_INVALID, not a 500', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const key of ['1', 'May 5', '-271821-04-20T00:00:00.000Z', '2020-01-01 (x)']) {
      const r = await run(w.agentA, { v: 1 }, { sort: 'last_activity_desc', cursor: encodeCursor({ sort: 'last_activity_desc', key, id }) });
      expect([r.status, r.code, key]).toEqual([422, 'LIST_CURSOR_INVALID', key]);
    }
  });

  it('a name_asc cursor holding a NUL character is LIST_CURSOR_INVALID, not a 500', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const r = await run(w.agentA, { v: 1 }, { sort: 'name_asc', cursor: encodeCursor({ sort: 'name_asc', key: 'a\u0000b', id }) });
    expect([r.status, r.code]).toEqual([422, 'LIST_CURSOR_INVALID']);
  });
});
