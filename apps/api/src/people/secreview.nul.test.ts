// secreview: a NUL character (U+0000) in a free-text body is a 500 INTERNAL_ERROR on api/people writes
// (Postgres text cannot hold it: 22021). The strict Zod inputs should refuse it as a 422.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact } from '../comms/testing.js';
import { call } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview: NUL bytes in api/people inputs', () => {
  it('note, logged activity, contact patch and address writes with U+0000 are a 422, never a 500', async () => {
    const c = await ownedContact(agent, { consent: false });
    const probes: [string, string, unknown][] = [
      ['POST', `/contacts/${c.id}/notes`, { body: 'a\u0000b' }],
      ['POST', `/contacts/${c.id}/activities`, { kind: 'call', at: new Date().toISOString(), body: 'a\u0000b' }],
      ['PATCH', `/contacts/${c.id}`, { rowVersion: 1, firstName: 'a\u0000b' }],
      ['POST', `/contacts/${c.id}/addresses`, { kind: 'home', city: 'a\u0000b' }],
    ];
    const got: Record<string, number> = {};
    for (const [m, u, b] of probes) got[`${m} ${u.replace(c.id, ':id')}`] = (await call(agent, m as 'POST', u, b)).status;
    expect(got).toEqual({ 'POST /contacts/:id/notes': 422, 'POST /contacts/:id/activities': 422, 'PATCH /contacts/:id': 422, 'POST /contacts/:id/addresses': 422 });
  });

  it('a crafted notes cursor (bad timestamp, or a 36-dash "uuid") is a 422 VALIDATION_FAILED, never a 500', async () => {
    const c = await ownedContact(agent, { consent: false });
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const bad = [enc({ p: false, a: 'not-a-date', i: '00000000-0000-0000-0000-000000000000' }), enc({ p: false, a: '2026-01-01T00:00:00Z', i: '-'.repeat(36) })];
    const got = [];
    for (const cur of bad) got.push((await call(agent, 'GET', `/contacts/${c.id}/notes?cursor=${cur}`)).status);
    expect(got).toEqual([422, 422]);
  });
});

