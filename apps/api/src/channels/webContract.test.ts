// The web's contract with module 22 (webContract.ts → webContract.json, read by apps/web's contract tests) is exactly
// what the API's Zod schemas say today, and names only real routes: an API change to any of these requests or
// responses fails here until the JSON is regenerated, and the regenerated JSON is what the web's clients are then
// checked against.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ERROR_STATUS } from '../errors.js';
import { WEB_CONTRACT_FILE, webContract, webContractText } from './webContract.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('the web contract of module 22 (webContract.json)', () => {
  it('is exactly what the API schemas generate (regenerate: tsx --conditions=@realty/source src/channels/webContract.ts --write)', () => {
    expect(readFileSync(WEB_CONTRACT_FILE, 'utf8')).toBe(webContractText());
  });

  it('every route it names is a real route of the server, taking exactly the inputs the contract describes', () => {
    const table = new Map(h.app.platform.routeTable.map((e) => [`${e.method} ${e.url}`, e]));
    const routes = Object.entries(webContract().routes);
    expect(routes.length).toBe(9);
    for (const [key, r] of routes) {
      const [method, url] = key.split(' ') as [string, string];
      const entry = table.get(`${method} /api${url}`);
      expect(entry, key).toBeDefined();
      expect(entry!.inputKeys, key).toEqual(r.inputKeys);
    }
    // the visitor's routes need no session (R-TEN-12); the agent's need theirs
    for (const key of routes.map(([k]) => k)) {
      const [method, url] = key.split(' ') as [string, string];
      expect(table.get(`${method} /api${url}`)!.auth === 'public', key).toBe(url.startsWith('/public/chat/'));
    }
  });

  it('carries the status of every error code it names, as errors.ts answers it', () => {
    for (const [code, status] of Object.entries(webContract().errors)) expect(status, code).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
  });
});
