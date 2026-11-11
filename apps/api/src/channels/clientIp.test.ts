// E137 behind the production proxies (finding chat-xff-ratelimit-bypass): the per-IP limits of the public chat routes
// count the client's real address, never one the client wrote itself. The API runs with the TRUST_PROXY that
// deploy/env.production.example ships, and every request arrives the way it does in the compose stack: from the web
// container (nginx, a private address) or, for a client that reaches the API some other way, from its own address.
// The same req.ip keys the global limiter and the per-IP auth limits (signup, reset, invite) and fills the audit IP.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { chatSource, createWidget, SITE } from './testing.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** what production sets: the value in deploy/env.production.example, parsed as the API parses it */
const PRODUCTION_TRUST = /^TRUST_PROXY=(.*)$/m.exec(readFileSync(resolve(repo, 'deploy/env.production.example'), 'utf8'))?.[1] ?? '';
/** the web container (nginx), as the API sees it in the compose network */
const NGINX = '172.18.0.4';

let h: ApiHarness;
let a: AssistantWorld;
let src: { sourceId: string; disclosureId: string };

beforeAll(async () => {
  h = await createApiHarness({ config: { trustProxy: testConfig({}, { TRUST_PROXY: PRODUCTION_TRUST }).trustProxy } });
  a = await assistantWorld(h, { agents: 1 });
  src = await chatSource(h, a.owner, a.tenantId);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** Starts from one machine: `remoteAddress` is who connects to the API, `xff` the X-Forwarded-For it receives. */
async function starts(n: number, remoteAddress: string, xff: (i: number) => string | null): Promise<number[]> {
  const w = await createWidget(h, a.owner, src.sourceId, [SITE]);
  const codes: number[] = [];
  for (let i = 1; i <= n; i++) {
    const x = xff(i);
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/public/chat/${w.key}/start`,
      headers: { 'content-type': 'application/json', origin: SITE, ...(x !== null ? { 'x-forwarded-for': x } : {}) },
      payload: JSON.stringify({ name: 'Real Looking', phone: '+14155550123', message: `Is Elm St available? ${i}`, disclosureId: src.disclosureId }),
      remoteAddress,
    });
    codes.push(r.statusCode);
  }
  return codes;
}

const FIVE_THEN_429 = [200, 200, 200, 200, 200, 429, 429, 429];

describe('E137: the per-IP start limit counts the client, not what the client wrote in X-Forwarded-For', () => {
  it('E137: through the proxy, a client-chosen X-Forwarded-For prefix (an appending proxy in front: "<forged>, <real>") changes nothing: 5 starts a minute, then 429', async () => {
    expect(await starts(8, NGINX, (i) => `203.0.113.${i}, 198.51.100.77`)).toEqual(FIVE_THEN_429);
    // three hops: the forged prefix, the real client, the load balancer's own private address
    expect(await starts(8, NGINX, (i) => `203.0.113.${100 + i}, 198.51.100.78, 10.0.0.5`)).toEqual(FIVE_THEN_429);
    // not even a string that is no address at all
    expect(await starts(8, NGINX, (i) => `not-an-ip-${i}, 198.51.100.79`)).toEqual(FIVE_THEN_429);
  });

  it('E137: the address nginx states is believed: two real visitors behind the proxy keep separate buckets', async () => {
    const one = await starts(5, NGINX, () => '198.51.100.80');
    const two = await starts(5, NGINX, () => '198.51.100.81');
    expect([...one, ...two].every((s) => s === 200)).toBe(true);
  });

  it('E137: a client that reaches the API directly is its own socket address, whatever X-Forwarded-For it sends', async () => {
    expect(await starts(8, '203.0.113.50', (i) => `198.51.100.${150 + i}`)).toEqual(FIVE_THEN_429);
  });
});
