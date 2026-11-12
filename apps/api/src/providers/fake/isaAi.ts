// FakeIsaAi (lane ISA-2; docs/AI_ISA.md §9.4): the deterministic AI ISA model for tests and dev. It never calls the
// network and never logs prompts. It reads the latest client source handle from the prompt (like parseFakeSources)
// and answers with one strict JSON object (core IsaModelOutputSchema). Script-driven: a test pushes outputs (or
// functions of the request) onto `script`; without a script it returns a short, number-free conversational reply.
// Like FAKE_BAD_QUOTE (fake/ai.ts), every default output also carries ONE wrong quote, so the server's verification
// (verifyQuote, R-ISA-27) is always exercised: that claim must come back unusable.
import type { AiProvider, AiRequest, AiResponse } from '../types.js';

export const FAKE_ISA_BAD_QUOTE = 'we are paying cash for anything';

export interface IsaClientSource {
  handle: string;
  text: string;
}

/** The client own-text sources of an ai_isa.turn prompt, in order (handles S<n> of inbound messages only). */
export function parseIsaSources(user: string): IsaClientSource[] {
  const out: IsaClientSource[] = [];
  const re = /\[(S\d+)\] client \([a-z]+, their own words\):\n<untrusted_[0-9a-f]+>\n([\s\S]*?)\n<\/untrusted_[0-9a-f]+>/g;
  for (let m = re.exec(user); m !== null; m = re.exec(user)) out.push({ handle: m[1]!, text: m[2]! });
  return out;
}

export type IsaScriptStep = Record<string, unknown> | string | ((r: AiRequest, sources: IsaClientSource[]) => Record<string, unknown> | string);

export function defaultIsaOutput(sources: IsaClientSource[]): Record<string, unknown> {
  const last = sources.at(-1);
  return {
    reply: { text: 'Thanks for getting back to me. Which neighborhoods are you most interested in?' },
    qualification: last ? [{ field: 'financing_status_stated', value: 'cash', quote: FAKE_ISA_BAD_QUOTE, source: last.handle }] : [],
    actions: [{ type: 'follow_up', after: '3d' }],
    summary: null,
  };
}

export class FakeIsaAi implements AiProvider {
  readonly calls: AiRequest[] = [];
  readonly script: IsaScriptStep[] = [];
  /** When set, every call fails (provider outage). */
  failing = false;

  async complete(r: AiRequest): Promise<AiResponse> {
    this.calls.push(r);
    if (this.failing) throw new Error('fake ISA model unavailable');
    const sources = parseIsaSources(r.user);
    const next = this.script.shift();
    const v = next === undefined ? defaultIsaOutput(sources) : typeof next === 'function' ? next(r, sources) : next;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return { text, model: 'fake-isa-1', stopReason: 'end_turn', inputTokens: Math.ceil((r.system.length + r.user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}
