// The Anthropic adapter against a local node:http stand-in (no network, a synthetic key). What is counted is the
// number of HTTP requests the stand-in received for ONE AiProvider.complete call.
//
// E903 (R-ISA-20; b19 review F2): the AI assistant's turn reserves one model call and then makes at most ONE provider
// request for it (`singleRequest`): a 500 or a timeout is not retried inside the SDK, because a request that timed
// out may already have been processed and billed. Other AI features keep the SDK's two retries.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anthropicAi } from './anthropic.js';
import { type AiRequest, ProviderError } from './types.js';

let server: Server;
let baseUrl: string;
let requests = 0;
let mode: 'ok' | '500' | 'hang' = 'ok';
const open = new Set<ServerResponse>();

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      if (mode === 'hang') {
        open.add(res); // never answered: the client's timeout ends it
        return;
      }
      if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 11, output_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const res of open) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  requests = 0;
  mode = 'ok';
});

const REQUEST: AiRequest = { templateKey: 'synthetic', system: 'synthetic system', user: 'synthetic user', maxOutputTokens: 64 };
const ai = (timeoutMs = 5_000) => anthropicAi({ apiKey: 'sk-ant-synthetic', model: 'synthetic-model', timeoutMs, baseUrl });

describe('E903 anthropic adapter: one provider request for an assistant turn', () => {
  it('a successful call is one request and reports the real token counts', async () => {
    const res = await ai().complete({ ...REQUEST, singleRequest: true });
    expect(res).toMatchObject({ text: 'hello', model: 'synthetic-model', stopReason: 'end_turn', inputTokens: 11, outputTokens: 5 });
    expect(requests).toBe(1);
  });

  it('E903: the server answers 500: exactly one request was made for a single-request call', async () => {
    mode = '500';
    await expect(ai().complete({ ...REQUEST, singleRequest: true })).rejects.toMatchObject({ kind: 'unavailable', providerCode: 'HTTP_500' });
    expect(requests).toBe(1);
  });

  it('E903: the server never answers: exactly one request was made for a single-request call', async () => {
    mode = 'hang';
    const err = await ai(300).complete({ ...REQUEST, singleRequest: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('timeout');
    expect(requests).toBe(1);
  });

  it('the other AI features are unchanged: without singleRequest a 500 is retried twice by the SDK (three requests)', async () => {
    mode = '500';
    await expect(ai().complete(REQUEST)).rejects.toMatchObject({ kind: 'unavailable', providerCode: 'HTTP_500' });
    expect(requests).toBe(3);
  }, 20_000);
});
