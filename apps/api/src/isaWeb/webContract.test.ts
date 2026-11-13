// The web's contract with modules 75/76 (webContract.ts → webContract.json, read by apps/web aiCare/api.contract.test)
// is exactly what the API's Zod schemas generate today, and names only real routes bound to the very schema objects
// the server registered. Whichever branch merges second regenerates it:
//   pnpm --filter @realty/api exec tsx --conditions=@realty/source src/isaWeb/webContract.ts --write
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ERROR_STATUS } from '../errors.js';
import { ISA_CONTRACT_ROUTES, ISA_WEB_CONTRACT_FILE, isaWebContract, isaWebContractText, module75Codes } from './webContract.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('the web contract of the AI ISA (isaWeb/webContract.json)', () => {
  it('is exactly what the API schemas generate (regenerate: tsx --conditions=@realty/source src/isaWeb/webContract.ts --write)', () => {
    expect(readFileSync(ISA_WEB_CONTRACT_FILE, 'utf8')).toBe(isaWebContractText());
  });

  it('every route it names is a real route of the server, taking exactly the inputs the contract describes, bound to the same schema objects', () => {
    const table = new Map(h.app.platform.routeTable.map((e) => [`${e.method} ${e.url}`, e]));
    for (const [key, r] of Object.entries(isaWebContract().routes)) {
      const [method, url] = key.split(' ') as [string, string];
      const entry = table.get(`${method} /api${url}`);
      expect(entry, key).toBeDefined();
      expect(entry!.inputKeys, key).toEqual(r.inputKeys);
    }
    for (const [key, spec] of Object.entries(ISA_CONTRACT_ROUTES)) {
      const [method, url] = key.split(' ') as [string, string];
      const registered = h.app.platform.routeSchemas.get(`${method} /api${url}`);
      expect(registered, key).toBeDefined();
      expect(registered!.body, `${key} body`).toBe(spec.body);
      expect(registered!.querystring, `${key} query`).toBe(spec.query);
      expect(registered!.response, `${key} response`).toBe(spec.response);
    }
  });

  it('carries every module-75 error code with its status', () => {
    const codes = module75Codes();
    expect(codes.length).toBeGreaterThan(20);
    for (const c of codes) expect(isaWebContract().errors[c], c).toBe((ERROR_STATUS as Record<string, number>)[c]);
  });
});
