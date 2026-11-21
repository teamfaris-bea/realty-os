import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { at, fixedClock, instant } from '@realty/core/foundation';
import type { CopilotInput, CopilotPolicy } from '@realty/core/copilot';
import { CopilotModelError, assertLocalBaseUrl, isLocalHost, type CopilotModel } from './model.js';
import { ollamaCopilotModel, ollamaFromEnv } from './ollama.js';
import { runCopilot, runLeadCopilot } from './run.js';
import { NO_TIMING_CUES, NO_TRANSCRIPTS, type CopilotSources } from './sources.js';
import { FakeCopilotModel } from './testing.js';

// synthetic fixtures only (public repo)
const POLICY: CopilotPolicy = { zone: 'America/New_York', brokerageName: 'Example Realty Group', businessOpen: '08:00', businessClose: '19:00' };
const NOW = at('2026-11-23T15:00:00Z');
const clock = fixedClock(NOW);
const INPUT: CopilotInput = {
  lead: {
    id: 'lead-0042', firstName: 'Casey', source: 'website', stage: 'new', createdAt: instant(NOW - 40 * 60_000),
    assignedAgent: { id: 'agent-07', displayName: 'Robin' }, military: false, area: 'Lakeside', hot: false, appointment: null,
    nextStep: null, reachable: { sms: true, email: true }, doNotContact: false,
  },
  activities: [{ id: 'a1', at: instant(NOW - 39 * 60_000), kind: 'automated', direction: 'outbound', byHuman: false, body: 'Welcome drip' }],
  transcripts: [],
  timingCues: [],
};
const GOOD_DRAFT = JSON.stringify({ text: 'Hi Casey, this is Robin with Example Realty Group. Saw your search in Lakeside. Free for a quick call in the next 10 minutes? Thank you' });

describe('CP-10 local models only', () => {
  it('accepts loopback, private-network, CGNAT and explicitly listed hosts; refuses public hosts and credentials', () => {
    for (const h of ['127.0.0.1', 'localhost', '10.0.0.5', '172.20.1.1', '192.168.1.20', '100.100.1.1', '[::1]', 'fd00::1']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', '172.32.0.1', 'api.example.com', 'ollama', '1.1.1.1']) expect(isLocalHost(h), h).toBe(false);
    expect(isLocalHost('ollama', ['ollama'])).toBe(true);
    expect(() => assertLocalBaseUrl('https://api.example.com')).toThrow(CopilotModelError);
    expect(() => assertLocalBaseUrl('http://user:pw@127.0.0.1:11434')).toThrow(/credentials/);
    expect(() => ollamaCopilotModel({ baseUrl: 'http://203.0.113.9:11434' })).toThrow(/private network/);
  });

  it('runCopilot refuses a model whose locality is not local, even if cast into the slot', async () => {
    const cloud = { locality: 'cloud', modelId: 'x', complete: async () => ({ text: GOOD_DRAFT, model: 'x' }) } as unknown as CopilotModel;
    const r = await runCopilot(INPUT, { model: cloud, clock, policy: POLICY });
    expect(r.draftProblem).toBe('MODEL_NOT_LOCAL');
    expect(r.summary.narrativeProblem).toBe('MODEL_NOT_LOCAL');
    expect(r.draft?.origin).toBe('template');
  });

  it('the Ollama adapter posts one non-streamed JSON chat to /api/chat, refuses redirects, and reads message.content', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content: '{"summary":"ok"}' }, done: true }), { status: 200 });
    }) as typeof fetch;
    const m = ollamaCopilotModel({ fetch: f });
    expect(m.modelId).toBe('qwen2.5:14b');
    const r = await m.complete({ key: 'copilot.summary', version: 'v', system: 'S', user: 'U', maxOutputTokens: 50, json: true }, { signal: new AbortController().signal });
    expect(r).toEqual({ text: '{"summary":"ok"}', model: 'qwen2.5:14b' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'qwen2.5:14b', stream: false, format: 'json', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  });

  it('HTTP errors and malformed bodies become typed errors', async () => {
    const bad = (res: Response) => ollamaCopilotModel({ fetch: (async () => res) as unknown as typeof fetch });
    const p = { key: 'copilot.summary' as const, version: 'v', system: 'S', user: 'U', maxOutputTokens: 5, json: true as const };
    const sig = { signal: new AbortController().signal };
    await expect(bad(new Response('x', { status: 500 })).complete(p, sig)).rejects.toMatchObject({ code: 'COPILOT_MODEL_UNAVAILABLE' });
    await expect(bad(new Response('{"nope":1}', { status: 200 })).complete(p, sig)).rejects.toMatchObject({ code: 'COPILOT_MODEL_BAD_RESPONSE' });
  });

  it('env: defaults to local qwen2.5:14b; "off" switches the model off; a public URL fails at startup', () => {
    expect(ollamaFromEnv({}).model?.modelId).toBe('qwen2.5:14b');
    expect(ollamaFromEnv({ COPILOT_OLLAMA_URL: 'off' }).model).toBeNull();
    expect(() => ollamaFromEnv({ COPILOT_OLLAMA_URL: 'https://llm.example.com' })).toThrow(CopilotModelError);
  });
});

describe('CP-1 CP-2 CP-3 running the copilot', () => {
  it('with the local model: narrative kept (UNVERIFIED), model draft used when it passes, flags present, suggestion only', async () => {
    const m = new FakeCopilotModel({ 'copilot.summary': '{"summary":"New website lead, no reply yet."}', 'copilot.draft': GOOD_DRAFT });
    const r = await runCopilot(INPUT, { model: m, clock, policy: POLICY });
    expect(r.suggestionOnly).toBe(true);
    expect(r.summary.narrative?.label).toBe('UNVERIFIED');
    expect(r.draft).toMatchObject({ origin: 'model', agentSendsThemselves: true, issues: [] });
    expect(r.flags.map((f) => f.code)).toContain('SPEED_TO_LEAD_MISSED');
    expect(m.prompts.map((p) => p.key)).toEqual(['copilot.summary', 'copilot.draft']);
  });

  it('a model failure or timeout leaves the deterministic result', async () => {
    const m = new FakeCopilotModel({ 'copilot.summary': new Error('down'), 'copilot.draft': new Error('down') });
    const r = await runCopilot(INPUT, { model: m, clock, policy: POLICY });
    expect(r.summary.narrativeProblem).toBe('MODEL_FAILED');
    expect(r.draft?.origin).toBe('template');
    const slow: CopilotModel = {
      locality: 'local', modelId: 'slow',
      complete: (_p, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    };
    const r2 = await runCopilot(INPUT, { model: slow, clock, policy: POLICY, timeoutMs: 20 });
    expect(r2.draftProblem).toBe('MODEL_FAILED');
    expect(r2.draft?.issues).toEqual([]);
  });

  it('CP-9 timing cues and transcripts come in through their ports; an invisible lead is null', async () => {
    const sources: CopilotSources = {
      history: { load: async (id) => (id === INPUT.lead.id ? { lead: INPUT.lead, activities: [...INPUT.activities], priorFlags: [] } : null) },
      timing: { cuesFor: async () => [{ intent: 'sell', windowStart: null, windowEnd: null, statedAt: instant(NOW - 60_000), evidence: 'might sell next year', origin: { kind: 'transcript', refId: 't1' }, extractor: 'timing-scan/test' }] },
      transcripts: { transcriptsFor: async () => [{ callActivityId: null, at: instant(NOW - 60_000), durationSec: 90, lines: [{ speaker: 'lead', text: 'might sell next year' }], engine: 'stt/test' }] },
    };
    const m = new FakeCopilotModel({ 'copilot.summary': '{"summary":"x"}', 'copilot.draft': GOOD_DRAFT });
    const r = await runLeadCopilot(INPUT.lead.id, sources, { model: m, clock, policy: POLICY });
    expect(r?.summary.facts).toMatchObject({ transcripts: 1, timing: [{ intent: 'sell', status: 'open_ended' }] });
    expect(m.prompts[0]?.user).toContain('might sell next year');
    expect(await runLeadCopilot('other', { ...sources, timing: NO_TIMING_CUES, transcripts: NO_TRANSCRIPTS }, { model: null, clock, policy: POLICY })).toBeNull();
  });

  it('api/copilot never imports a cloud AI provider, comms dispatch or the DB, and calls no send method', () => {
    const dir = new URL('.', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/@anthropic-ai|providers\/anthropic|providers\/index|comms\/|@realty\/db|openai/);
      expect(src, f).not.toMatch(/\b(sendSms|sendEmail|dialCall|deliverPush)\b/);
    }
  });
});
