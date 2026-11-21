// The timing scan's local model (b20; DATA_MODEL R-TCUE-1): local hosts only, off by default in production, never the
// cloud vendor's slot. The Ollama adapter is exercised with an injected fetch; nothing here touches a network.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, localModelUrlProblem, redactConfig } from '../config.js';
import { createProviders, ollamaAi } from './index.js';
import { ProviderError } from './types.js';

const clock = { now: () => 1_794_300_000_000 as never };
const env = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://app_user:pw@db/realty',
  KEK_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
  ...o,
});
const req = { templateKey: 'timing_cue.extract', system: 'sys', user: 'words', maxOutputTokens: 600 } as never;

describe('R-TCUE-1 the timing model is local only', () => {
  it('R-TCUE-1: loopback, private and tailnet hosts are accepted; public hosts, paths and credentials are refused', () => {
    for (const ok of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://10.0.0.5:11434', 'http://192.168.1.20:11434', 'http://172.16.4.2:11434', 'http://100.101.1.2:11434', 'http://[::1]:11434', 'http://office-pc:11434', 'http://office-pc.tailnet-example.ts.net:11434', 'http://gpu.internal:11434']) {
      expect(localModelUrlProblem(ok), ok).toBeNull();
    }
    for (const bad of ['https://api.example.com', 'http://8.8.8.8:11434', 'http://172.32.0.1:11434', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434/api', 'ftp://127.0.0.1', 'not a url']) {
      expect(localModelUrlProblem(bad), bad).not.toBeNull();
    }
  });

  it('R-TCUE-1: dev defaults to the fake; a public URL is refused; a local host loads and is shown in the redacted config', () => {
    expect(loadConfig(env()).timingAi).toMatchObject({ provider: 'fake', model: 'qwen2.5:14b' });
    expect(() => loadConfig(env({ TIMING_AI_PROVIDER: 'ollama', TIMING_AI_OLLAMA_URL: 'https://models.example.com' }))).toThrow(/TIMING_AI_OLLAMA_URL/);
    const c = loadConfig(env({ TIMING_AI_PROVIDER: 'ollama', TIMING_AI_OLLAMA_URL: 'http://office-pc:11434' }));
    expect(c.timingAi).toEqual({ provider: 'ollama', baseUrl: 'http://office-pc:11434', model: 'qwen2.5:14b' });
    expect(redactConfig(c).timingAi).toEqual({ provider: 'ollama', baseUrl: 'http://office-pc:11434', model: 'qwen2.5:14b' });
  });

  it('R-TCUE-1: the timing slot is never the cloud model, even with AI_PROVIDER=anthropic', () => {
    const c = loadConfig(env({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', TIMING_AI_PROVIDER: 'off' }));
    const p = createProviders(c, { clock });
    expect(p.timingAi).toBeNull();
    const o = createProviders(loadConfig(env({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', TIMING_AI_PROVIDER: 'ollama' })), { clock });
    expect(o.timingAi).not.toBe(o.ai);
    expect(o.timingAi).not.toBeNull();
  });

  it('R-TCUE-1: the adapter posts one JSON chat to the local host, temperature 0, no redirects, and maps failures', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = ollamaAi({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { content: '{"cues":[]}' }, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4 }), { status: 200 });
      }) as never,
    });
    expect(await ok.complete(req)).toEqual({ text: '{"cues":[]}', model: 'qwen2.5:14b', stopReason: 'end_turn', inputTokens: 10, outputTokens: 4 });
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(seen[0]!.init.redirect).toBe('error');
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({ model: 'qwen2.5:14b', stream: false, format: 'json', options: { temperature: 0 } });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    const failing = (f: () => Promise<Response>) => ollamaAi({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetch: f as never });
    await expect(failing(() => Promise.reject(new TypeError('fetch failed'))).complete(req)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(failing(async () => new Response('', { status: 404 })).complete(req)).rejects.toMatchObject({ kind: 'not_configured' });
    await expect(failing(async () => new Response('', { status: 503 })).complete(req)).rejects.toBeInstanceOf(ProviderError);
    expect(() => ollamaAi({ baseUrl: 'https://api.example.com', model: 'm' })).toThrow(ProviderError);
  });
});
