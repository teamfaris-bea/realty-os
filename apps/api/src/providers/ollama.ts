// A LOCAL AiProvider over an Ollama server (b20 timing cues; DATA_MODEL R-TCUE-1). Used only for the timing scan's
// own provider slot (`Providers.timingAi`), never as `Providers.ai`: note text is read by a model on the team's own
// machine and never sent to a cloud model. The URL is checked again here (loopback or private network only, the
// same rule as config), so a hand-built adapter cannot point at a public host either.
//
// - POST {baseUrl}/api/chat, stream off, `format: "json"`, temperature 0 (same words ⇒ same answer), bounded output.
// - One system + one user turn; no tools.
// - Prompts and outputs are never logged here.
import { localModelUrlProblem } from '../config.js';
import { type AiProvider, type AiRequest, type AiResponse, ProviderError } from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatResponse {
  model?: unknown;
  message?: { content?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

export function ollamaAi(opts: OllamaOptions): AiProvider {
  const problem = localModelUrlProblem(opts.baseUrl);
  if (problem) throw new ProviderError('not_configured', 'TIMING_AI_NOT_LOCAL');
  const endpoint = new URL('/api/chat', opts.baseUrl).toString();
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return {
    async complete(r: AiRequest): Promise<AiResponse> {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            stream: false,
            format: 'json',
            options: { temperature: 0, num_predict: Math.max(64, Math.min(r.maxOutputTokens, 2000)) },
            messages: [
              { role: 'system', content: r.system },
              { role: 'user', content: r.user },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (e) {
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ProviderError('timeout');
        throw new ProviderError('unavailable', 'CONNECTION');
      }
      if (res.status === 404) throw new ProviderError('not_configured', 'MODEL_NOT_FOUND');
      if (res.status >= 400 && res.status < 500) throw new ProviderError('rejected', `HTTP_${res.status}`);
      if (!res.ok) throw new ProviderError('unavailable', `HTTP_${res.status}`);
      let body: ChatResponse;
      try {
        body = (await res.json()) as ChatResponse;
      } catch {
        throw new ProviderError('unavailable', 'BAD_BODY');
      }
      const text = typeof body.message?.content === 'string' ? body.message.content : '';
      const done = body.done_reason;
      return {
        text,
        model: typeof body.model === 'string' ? body.model.slice(0, 80) : opts.model,
        stopReason: done === 'stop' || done === undefined ? 'end_turn' : done === 'length' ? 'max_tokens' : 'other',
        inputTokens: typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : 0,
        outputTokens: typeof body.eval_count === 'number' ? body.eval_count : 0,
      };
    },
  };
}
