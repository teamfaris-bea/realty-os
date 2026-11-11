// Route table and response schemas of api/workspace (R-PERM-1 route declarations, R-AST-13, R-TEN-3).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { WORKSPACE_RESPONSE_SCHEMAS } from './schemas.js';
import { call, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 1, teamLead: false, rule: false });
});
afterAll(async () => {
  await h?.close();
});

const PREFIXES = ['/api/feed', '/api/tasks', '/api/appointments', '/api/deals', '/api/deal-dates', '/api/listings', '/api/showings', '/api/search', '/api/notifications', '/api/notification-preferences'];
const rows = () => h.app.platform.routeTable.filter((r) => PREFIXES.some((p) => r.url === p || r.url.startsWith(`${p}/`)) && r.method !== 'HEAD');

describe('api/workspace route table and schemas', () => {
  it('every workspace route declares its authorization; Action routes carry authorize(<that action>) (snapshot)', () => {
    const table = rows().map((r) => `${r.method} ${r.url} ${r.auth}${r.authorizes ? ` authorize(${r.authorizes})` : ''}`);
    expect(table.length).toBe(39); // + GET /listings/:id/competing (module 24, mls/routes.ts)
    for (const r of rows()) if (r.auth !== 'self') expect(r.authorizes).toBe(r.auth);
    expect(table.sort()).toMatchSnapshot();
  });

  it('R-TEN-3: no workspace route input accepts a tenant id; strict bodies refuse an extra tenant_id', async () => {
    for (const r of rows()) for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    const a = w.agents[0]!;
    for (const [method, url] of [['POST', '/tasks'], ['POST', '/appointments'], ['POST', '/listings'], ['PUT', '/notification-preferences']] as const) {
      const r = await call(a, method, url, { tenant_id: w.tenantId });
      expect([url, r.status, r.code]).toEqual([url, 422, 'VALIDATION_FAILED']);
    }
  });

  it('R-AST-13 R-TEN-3: response schemas have no confidence* fields, no score, and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(WORKSPACE_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"score"|"points"/);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });

  it('unauthenticated calls are 401 before validation; unsafe calls without Origin are CSRF_INVALID', async () => {
    const anon = h.client();
    expect((await anon.request('GET', '/api/feed')).statusCode).toBe(401);
    expect((await anon.request('GET', '/api/search?q=x')).statusCode).toBe(401);
    const a = w.agents[0]!;
    const r = await a.request('POST', '/api/tasks', { title: 'x' }, { origin: null });
    expect(r.statusCode).toBe(403);
  });
});
