// Route table, response schemas and job payloads of api/accountability (R-PERM-1 route declarations,
// R-AST-13, R-TEN-3, R-TEN-7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { handlers } from '../worker/handlers/index.js';
import { HandlerRegistry } from '../worker/registry.js';
import { RecomputePayload, exceptionRecompute } from './handlers.js';
import { ACCOUNTABILITY_RESPONSE_SCHEMAS } from './schemas.js';
import { type AccWorld, accWorld, call } from './testing.js';

let h: ApiHarness;
let w: AccWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await accWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const PREFIXES = ['/api/team/exceptions', '/api/scoreboard', '/api/team/scoreboard', '/api/team/momentum'];
const rows = () => h.app.platform.routeTable.filter((r) => PREFIXES.some((p) => r.url === p || r.url.startsWith(`${p}/`)) && r.method !== 'HEAD');

describe('api/accountability route table and schemas', () => {
  it('R-PERM-1: every accountability route declares a core Action and carries authorize(<that action>) (snapshot)', () => {
    const table = rows().map((r) => `${r.method} ${r.url} ${r.auth}${r.authorizes ? ` authorize(${r.authorizes})` : ''}`);
    expect(table.length).toBe(9);
    for (const r of rows()) expect(r.authorizes).toBe(r.auth);
    expect(table.sort()).toMatchSnapshot();
  });

  it('R-TEN-3: no accountability route input accepts a tenant id; strict bodies and queries refuse an extra tenant_id', async () => {
    for (const r of rows()) for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    const tl = w.teamLead!;
    const key = encodeURIComponent(`promise:${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`);
    expect((await call(tl, 'POST', `/team/exceptions/${key}/resolve`, { note: 'x', tenant_id: w.tenantId })).status).toBe(422);
    expect((await call(tl, 'GET', `/team/exceptions?tenant_id=${w.tenantId}`)).status).toBe(422);
    expect((await call(tl, 'GET', `/scoreboard?tenantId=${w.tenantId}`)).status).toBe(422);
  });

  it('R-AST-13 R-TEN-3: response schemas have no confidence* fields, no score, and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(ACCOUNTABILITY_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"score"|"points"|probability/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });

  it('unauthenticated calls are 401 before validation; unsafe calls without Origin are CSRF_INVALID', async () => {
    const anon = h.client();
    expect((await anon.request('GET', '/api/team/exceptions')).statusCode).toBe(401);
    expect((await anon.request('GET', '/api/scoreboard')).statusCode).toBe(401);
    const r = await w.teamLead!.request('POST', `/api/team/exceptions/${encodeURIComponent(`appt:${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`)}/verify`, {}, { origin: null });
    expect(r.statusCode).toBe(403);
  });

  it('R-TEN-7: the recompute job payload holds a scope code or one id only; it is registered once, as a periodic 60-second per-tenant job', () => {
    expect(RecomputePayload.safeParse({ scope: 'tenant' }).success).toBe(true);
    expect(RecomputePayload.safeParse({ scope: { contactId: '0190a1b2-0000-7000-8000-000000000001' } }).success).toBe(true);
    expect(RecomputePayload.safeParse({ scope: { contactId: 'pat@example.com' } }).success).toBe(false);
    expect(RecomputePayload.safeParse({ scope: 'tenant', name: 'Pat Lead' }).success).toBe(false);
    expect(RecomputePayload.safeParse({ scope: { contactId: '0190a1b2-0000-7000-8000-000000000001', phone: '+14155550123' } }).success).toBe(false);
    expect(exceptionRecompute.every).toEqual({ ms: 60_000 });
    expect(handlers.filter((x) => x.kind === 'exception.recompute')).toHaveLength(1);
    expect(() => new HandlerRegistry().registerAll(handlers)).not.toThrow();
  });
});
