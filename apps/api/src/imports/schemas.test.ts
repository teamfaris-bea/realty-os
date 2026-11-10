// Route table and response schemas of api/imports (R-PERM-1, R-PERM-13, R-AST-13, R-TEN-3).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IMPORTS_RESPONSE_SCHEMAS } from './schemas.js';
import { type ImportWorld, type ImportsHarness, call, importWorld, importsHarness } from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
});
afterAll(async () => {
  await ih?.close();
});

describe('api/imports route table and schemas', () => {
  it('R-PERM-13: every import route is `import.run` (Owner/Admin 🔒) and carries authorize(import.run) (snapshot)', () => {
    const rows = ih.h.app.platform.routeTable.filter((r) => r.url.startsWith('/api/imports') && r.method !== 'HEAD');
    expect(rows.length).toBe(18);
    for (const r of rows) expect([r.url, r.auth, r.authorizes]).toEqual([r.url, 'import.run', 'import.run']);
    expect(rows.map((r) => `${r.method} ${r.url}`).sort()).toMatchSnapshot();
  });

  it('R-TEN-3: no import route input accepts a tenant id; strict bodies refuse an extra tenant_id', async () => {
    for (const r of ih.h.app.platform.routeTable.filter((x) => x.url.startsWith('/api/imports'))) {
      for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    }
    const r = await call(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: 'some-key-123', tenant_id: w.tenantId });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('R-AST-13 R-TEN-3: import response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(IMPORTS_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
