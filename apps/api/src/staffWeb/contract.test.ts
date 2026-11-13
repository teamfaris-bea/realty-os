// The web's contract with the Phase 3 staff screens (module 55; staffWeb/contract.ts → contract.json, read by
// apps/web/src/test/staffContract.ts) is exactly what the API's Zod schemas say today, and names only real routes: an
// API change to any of these requests or responses fails here until the JSON is regenerated.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ERROR_STATUS } from '../errors.js';
import { STAFF_CONTRACT_FILE, STAFF_ROUTES, staffContract, staffContractText } from './contract.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('the staff web contract of module 55 (staffWeb/contract.json)', () => {
  it('R-STAFF-2: is exactly what the API schemas generate (regenerate: tsx --conditions=@realty/source src/staffWeb/contract.ts --write)', () => {
    expect(readFileSync(STAFF_CONTRACT_FILE, 'utf8')).toBe(staffContractText());
  });

  it('R-STAFF-2: every route it names is a real route of the server with a session, taking exactly the inputs the contract describes; no portal and no /likely route', () => {
    const table = new Map(h.app.platform.routeTable.map((e) => [`${e.method} ${e.url}`, e]));
    const routes = Object.entries(staffContract().routes);
    expect(routes.length).toBe(Object.keys(STAFF_ROUTES).length);
    for (const [key, r] of routes) {
      const [method, url] = key.split(' ') as [string, string];
      const entry = table.get(`${method} /api${url}`);
      expect(entry, key).toBeDefined();
      expect(entry!.auth, key).not.toBe('public');
      // a multipart route reads its fields from the form, not from a JSON body
      if (r.multipart === null) expect(entry!.inputKeys, key).toEqual(r.inputKeys);
      expect(url, key).not.toMatch(/^\/(portal|public)\b|^\/likely$/);
    }
  });

  it('R-STAFF-2: every route is bound to the very schema objects the server registered for it (finding F4 of module 22)', () => {
    for (const [key, spec] of Object.entries(STAFF_ROUTES)) {
      const [method, url] = key.split(' ') as [string, string];
      const registered = h.app.platform.routeSchemas.get(`${method} /api${url}`);
      expect(registered, key).toBeDefined();
      if (!spec.multipart) expect(registered!.body, `${key} body`).toBe(spec.body);
      expect(registered!.querystring, `${key} query`).toBe(spec.query);
      // the route table keeps the 200 schema only (server.ts); a 201 route's response is checked by its own route tests
      expect(registered!.response, `${key} response`).toBe(spec.status === 201 ? undefined : spec.response);
    }
  });

  it('carries the status of every error code it names, as errors.ts answers it', () => {
    for (const [code, status] of Object.entries(staffContract().errors)) expect(status, code).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
  });
});
