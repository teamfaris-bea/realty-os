// The web's contract with module 22 (webContract.ts → webContract.json, read by apps/web's contract tests) is exactly
// what the API's Zod schemas say today, and names only real routes: an API change to any of these requests or
// responses fails here until the JSON is regenerated, and the regenerated JSON is what the web's clients are then
// checked against.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ERROR_STATUS } from '../errors.js';
import { CONTRACT_ROUTES, WEB_CONTRACT_FILE, webContract, webContractText } from './webContract.js';
import { acceptLead, chatSource, createWidget, openChat, SITE, startChat } from './testing.js';
import { type AssistantWorld, assistantWorld, call } from '../assistant/testing.js';

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
    expect(routes.length).toBe(11);
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

  it('finding F4: every route of the contract is bound to the very schema objects the server registered for it, so a route that swaps its body, query or response for another object (same keys, other limits) fails here', () => {
    for (const [key, spec] of Object.entries(CONTRACT_ROUTES)) {
      const [method, url] = key.split(' ') as [string, string];
      const registered = h.app.platform.routeSchemas.get(`${method} /api${url}`);
      expect(registered, key).toBeDefined();
      expect(registered!.body, `${key} body`).toBe(spec.body);
      expect(registered!.querystring, `${key} query`).toBe(spec.query);
      expect(registered!.response, `${key} response`).toBe(spec.response);
    }
  });

  it('finding F3: a request string the API trims before its length and pattern checks is marked x-trim; one it does not is not', () => {
    const c = webContract();
    const props = (key: string) => (c.routes[key]!.body as { properties: Record<string, Record<string, unknown>> }).properties;
    const start = props('POST /public/chat/:widgetToken/start');
    for (const k of ['name', 'phone', 'email', 'message']) expect(start[k]!['x-trim'], k).toBe(true);
    expect(start.disclosureId!['x-trim']).toBeUndefined();
    expect(props('POST /public/chat/session/:token/messages').message!['x-trim']).toBe(true);
    expect(props('POST /contacts/:id/messages').body!['x-trim']).toBe(true);
    expect(props('POST /contacts/:id/messages').idempotencyKey!['x-trim']).toBeUndefined();
  });

  it('carries the status of every error code it names, as errors.ts answers it', () => {
    for (const [code, status] of Object.entries(webContract().errors)) expect(status, code).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
  });

  it('R-OWN-24 E559: webContract lists CONTACT_MERGED with 409', () => {
    expect(webContract().errors).toMatchObject({ CONTACT_MERGED: 409 });
  });
});

// Rules a handler or a Zod transform applies that a JSON Schema cannot carry (finding F3): the contract names them,
// the web's checker applies them (apps/web/src/test/contract.ts), and this proves the real routes refuse exactly that.
describe('the contract\'s request rules hold on the real routes (finding F3)', () => {
  let w: AssistantWorld;
  let src: { sourceId: string; disclosureId: string };
  let key: string;
  beforeAll(async () => {
    w = await assistantWorld(h, { agents: 1 });
    src = await chatSource(h, w.owner, w.tenantId);
    key = (await createWidget(h, w.owner, src.sourceId, [SITE])).key;
  }, 240_000);

  it('start: exactly one of phone and email (both, or neither, is 422); a string the API trims is checked trimmed', async () => {
    expect(webContract().rules['POST /public/chat/:widgetToken/start']).toEqual({ exactlyOneOf: ['phone', 'email'] });
    const body = { name: 'Pat Lee', message: 'Hello', disclosureId: src.disclosureId };
    expect((await startChat(h, key, { ...body, phone: '+14155550123', email: 'pat@example.test' })).statusCode).toBe(422);
    expect((await startChat(h, key, body)).statusCode).toBe(422);
    expect((await startChat(h, key, { ...body, phone: '+14155550123', message: '   ' })).statusCode).toBe(422);
    expect((await startChat(h, key, { ...body, phone: '+14155550123', name: `${'N'.repeat(120)} ` })).statusCode).toBe(200);
  });

  it('GET /reachability: contactIds is a comma-separated list of 1 to 50 UUIDs', async () => {
    expect(webContract().rules['GET /reachability']).toEqual({ commaList: { key: 'contactIds', minItems: 1, maxItems: 50, items: expect.objectContaining({ format: 'uuid' }) } });
    const c = await openChat(h, key, src.disclosureId, { name: 'Rhea Rule' });
    const agent = await acceptLead(h, w.agents, c.contactId);
    expect((await call(agent, 'GET', `/reachability?contactIds=${c.contactId}`)).status).toBe(200);
    expect((await call(agent, 'GET', '/reachability?contactIds=not-a-uuid')).status).toBe(422);
    expect((await call(agent, 'GET', `/reachability?contactIds=${Array.from({ length: 51 }, () => c.contactId).join(',')}`)).status).toBe(422);
  });
});
