// The copilot's model provider interface (CP-10): LOCAL models only.
//
// Lead history (notes, messages, call transcripts) must never reach a cloud LLM. The copilot therefore does
// not use the shared `providers.ai` (which may be a cloud model); it takes a `CopilotModel`, whose
// `locality` is the literal 'local', and runLeadCopilot refuses anything else at run time too. The one
// adapter is Ollama (ollama.ts), whose base URL must be a loopback or private-network address; a public host
// is refused when the adapter is built, and redirects are refused on every request.
import type { CopilotPrompt } from '@realty/core/copilot';

export interface CopilotModelAnswer {
  text: string;
  /** the model tag that answered, e.g. "qwen2.5:14b" */
  model: string;
}

export interface CopilotModel {
  /** only local models exist for the copilot; there is no 'cloud' value to choose */
  readonly locality: 'local';
  readonly modelId: string;
  complete(prompt: CopilotPrompt, opts: { signal: AbortSignal }): Promise<CopilotModelAnswer>;
}

export class CopilotModelError extends Error {
  constructor(readonly code: 'COPILOT_MODEL_NOT_LOCAL' | 'COPILOT_MODEL_UNAVAILABLE' | 'COPILOT_MODEL_BAD_RESPONSE', message: string) {
    super(message);
    this.name = 'CopilotModelError';
  }
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/**
 * Whether a host is on this machine or the private network: loopback, RFC 1918, CGNAT 100.64/10 (Tailscale,
 * WSL bridges), link-local, IPv6 loopback/ULA, "localhost", or a name the operator listed explicitly
 * (`allowHostnames`, e.g. a docker service name). Any other DNS name is refused: it could resolve anywhere.
 */
export function isLocalHost(hostname: string, allowHostnames: readonly string[] = []): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (allowHostnames.map((x) => x.toLowerCase()).includes(h)) return true;
  const v4 = ipv4(h);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{2}:/u.test(h) || /^fe[89ab][0-9a-f]:/u.test(h);
  return false;
}

export function assertLocalBaseUrl(raw: string, allowHostnames: readonly string[] = []): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CopilotModelError('COPILOT_MODEL_NOT_LOCAL', 'copilot model URL is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CopilotModelError('COPILOT_MODEL_NOT_LOCAL', 'copilot model URL must be http(s)');
  if (u.username !== '' || u.password !== '') throw new CopilotModelError('COPILOT_MODEL_NOT_LOCAL', 'copilot model URL must not carry credentials');
  if (!isLocalHost(u.hostname, allowHostnames)) throw new CopilotModelError('COPILOT_MODEL_NOT_LOCAL', 'copilot model must run on this machine or the private network');
  return u;
}
