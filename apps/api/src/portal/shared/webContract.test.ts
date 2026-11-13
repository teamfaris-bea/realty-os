// The portal web contract (webContract.ts → webContract.json) is exactly what the API's Zod schemas say, and names only
// real routes, bound to the very schema objects they registered (R-PORTAL-8, R-PORTAL-16).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { ERROR_STATUS } from '../../errors.js';
import { PORTAL_CONTRACT_ROUTES, PORTAL_WEB_CONTRACT_FILE, portalWebContract, portalWebContractText } from './webContract.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('R-PORTAL-16 the portal web contract (webContract.json)', () => {
  it('R-PORTAL-16: is exactly what the API schemas generate (regenerate: tsx --conditions=@realty/source src/portal/shared/webContract.ts --write)', () => {
    expect(readFileSync(PORTAL_WEB_CONTRACT_FILE, 'utf8')).toBe(portalWebContractText());
  });

  it('R-PORTAL-8: every route it names is a real route with exactly those inputs, bound to the very schema objects it registered', () => {
    const table = new Map(h.app.platform.routeTable.map((e) => [`${e.method} ${e.url}`, e]));
    for (const [key, r] of Object.entries(portalWebContract().routes)) {
      const [method, url] = key.split(' ') as [string, string];
      const entry = table.get(`${method} /api${url}`);
      expect(entry, key).toBeDefined();
      expect(entry!.inputKeys, key).toEqual(r.inputKeys);
      expect(entry!.auth === 'public', key).toBe(r.side !== 'staff');
      const spec = PORTAL_CONTRACT_ROUTES[key]!;
      const reg = h.app.platform.routeSchemas.get(`${method} /api${url}`)!;
      expect(reg.body, `${key} body`).toBe(spec.body);
      expect(reg.querystring, `${key} query`).toBe(spec.query);
      if ((spec.status ?? 200) === 200 && spec.response) expect(reg.response, `${key} response`).toBe(spec.response);
    }
    const portalRoutes = h.app.platform.routeTable.filter((e) => e.method !== 'HEAD' && (e.url.startsWith('/api/portal') || /\/portal(\/invite)?$/.test(e.url)));
    expect(portalRoutes.map((e) => `${e.method} ${e.url.slice(4)}`).sort()).toEqual(Object.keys(PORTAL_CONTRACT_ROUTES).sort());
  });

  it('R-PORTAL-10: carries the status and the sentence of every code', () => {
    for (const [code, e] of Object.entries(portalWebContract().errors)) {
      expect(e.status, code).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
      expect(e.sentence, code).toMatch(/\.$/);
    }
    expect(portalWebContract().errors).toMatchObject({ PORTAL_NOT_AVAILABLE: { status: 503 }, PORTAL_LINK_INVALID: { status: 401 }, CSRF_INVALID: { status: 403 } });
  });
});
