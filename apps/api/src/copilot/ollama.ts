// Ollama adapter for the copilot (CP-10): qwen2.5:14b by default, on the owner's PC or any local box.
//
//   COPILOT_OLLAMA_URL      default http://127.0.0.1:11434 (must be loopback / private network)
//   COPILOT_OLLAMA_MODEL    default qwen2.5:14b
//   COPILOT_OLLAMA_HOSTS    optional comma list of extra local host NAMES (e.g. a docker service)
//   COPILOT_TIMEOUT_MS      default 60000
//
// POST /api/chat with stream:false and format:"json" (one JSON object back), temperature 0.2. Redirects are
// refused so a local URL cannot bounce the request to a remote host. No API key: Ollama is unauthenticated
// on the local network, which is why the host check matters.
import type { CopilotPrompt } from '@realty/core/copilot';
import { assertLocalBaseUrl, type CopilotModel, type CopilotModelAnswer, CopilotModelError } from './model.js';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b';

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  allowHostnames?: readonly string[];
  /** injected for tests; defaults to global fetch */
  fetch?: typeof fetch;
}

export function ollamaCopilotModel(o: OllamaOptions = {}): CopilotModel {
  const base = assertLocalBaseUrl(o.baseUrl ?? DEFAULT_OLLAMA_URL, o.allowHostnames ?? []);
  const model = o.model ?? DEFAULT_OLLAMA_MODEL;
  if (!/^[\w.:/-]{1,100}$/u.test(model)) throw new CopilotModelError('COPILOT_MODEL_UNAVAILABLE', 'bad model tag');
  const doFetch = o.fetch ?? fetch;
  const url = new URL('/api/chat', base);
  return {
    locality: 'local',
    modelId: model,
    async complete(p: CopilotPrompt, opts: { signal: AbortSignal }): Promise<CopilotModelAnswer> {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          redirect: 'error',
          signal: opts.signal,
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            options: { temperature: 0.2, num_predict: p.maxOutputTokens },
            messages: [
              { role: 'system', content: p.system },
              { role: 'user', content: p.user },
            ],
          }),
        });
      } catch {
        throw new CopilotModelError('COPILOT_MODEL_UNAVAILABLE', 'local model did not answer');
      }
      if (!res.ok) throw new CopilotModelError('COPILOT_MODEL_UNAVAILABLE', `local model returned HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new CopilotModelError('COPILOT_MODEL_BAD_RESPONSE', 'local model sent no JSON');
      }
      const msg = (body as { message?: { content?: unknown }; model?: unknown } | null)?.message?.content;
      if (typeof msg !== 'string') throw new CopilotModelError('COPILOT_MODEL_BAD_RESPONSE', 'local model sent no message');
      const tag = (body as { model?: unknown }).model;
      return { text: msg, model: typeof tag === 'string' ? tag : model };
    },
  };
}

/** Reads the COPILOT_* settings; returns null when the copilot model is switched off (COPILOT_OLLAMA_URL=off). */
export function ollamaFromEnv(env: Readonly<Record<string, string | undefined>>, f?: typeof fetch): { model: CopilotModel | null; timeoutMs: number } {
  const timeoutMs = Number(env.COPILOT_TIMEOUT_MS ?? 60_000);
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  if (env.COPILOT_OLLAMA_URL === 'off') return { model: null, timeoutMs: t };
  const hosts = (env.COPILOT_OLLAMA_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { model: ollamaCopilotModel({ baseUrl: env.COPILOT_OLLAMA_URL, model: env.COPILOT_OLLAMA_MODEL, allowHostnames: hosts, fetch: f }), timeoutMs: t };
}
