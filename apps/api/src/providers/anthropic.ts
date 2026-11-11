// Real AiProvider over the Anthropic Messages API (@anthropic-ai/sdk). Used when AI_PROVIDER=anthropic
// and ANTHROPIC_API_KEY is set; otherwise the deterministic fake runs. The vendor DPA and retention
// terms are an open contract item (VERIFY WITH COUNSEL / contract, ARCHITECTURE §7).
//
// - One user turn, no tools (R-AST-14): the prompt is core.assistant.buildPrompt's output.
// - Claude Opus 5.5 by default (AI_MODEL overrides). Thinking is always on for this model; effort is
//   set explicitly to `medium` (its default) since assistant tasks are short and latency-sensitive.
// - Server-side refusal fallbacks are enabled ("default" routing), so a policy decline on a benign
//   real-estate message is retried on a fallback model inside the same call. A refusal that survives
//   is reported as stopReason 'refusal' and the caller marks the output needs_review.
// - The system prompt is static per purpose and marked for prompt caching; per-request facts and all
//   untrusted content are in the user turn.
// - Prompts and outputs are never logged here.
import Anthropic from '@anthropic-ai/sdk';
import { type AiProvider, type AiRequest, type AiResponse, ProviderError } from './types.js';

export function anthropicAi(opts: { apiKey: string; model: string; timeoutMs?: number }): AiProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: opts.timeoutMs ?? 60_000 });
  return {
    async complete(r: AiRequest): Promise<AiResponse> {
      try {
        const res = await client.beta.messages.create({
          model: opts.model,
          max_tokens: Math.max(r.maxOutputTokens, 1024),
          // the system prompt is static per purpose (core assistant-prompts/2): mark it cacheable. A prompt
          // shorter than the model's minimum cacheable prefix is simply not cached.
          system: [{ type: 'text', text: r.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: r.user }],
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        let text = '';
        for (const block of res.content) if (block.type === 'text') text += block.text;
        const stop = res.stop_reason;
        return {
          text,
          model: res.model,
          stopReason: stop === 'end_turn' ? 'end_turn' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'other',
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        };
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError('unavailable', 'RATE_LIMITED');
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('timeout');
        if (e instanceof Anthropic.APIConnectionError) throw new ProviderError('unavailable', 'CONNECTION');
        if (e instanceof Anthropic.BadRequestError) throw new ProviderError('rejected', 'BAD_REQUEST');
        if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('not_configured', 'AUTH');
        if (e instanceof Anthropic.APIError) throw new ProviderError('unavailable', `HTTP_${String(e.status ?? 'ERR')}`);
        throw e;
      }
    },
  };
}
