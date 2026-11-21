// Local call transcription: the team's own GPU machine runs faster-whisper (tools/transcriber/server.py) and this
// adapter posts the decrypted call audio to it. There is deliberately no cloud transcriber anywhere in this build.
//
// Network rules (no cloud, no SSRF):
//   - the base URL's host must be an IP literal on loopback (127/8, ::1), a private LAN (10/8, 172.16/12,
//     192.168/16, fc00::/7) or the carrier-grade NAT range a private overlay such as Tailscale uses (100.64/10), or
//     the name `localhost`. Any other host name is refused at construction: a DNS name could resolve to a public
//     server, and audio must never leave the team's machines.
//   - http is allowed (loopback, or an encrypted overlay); no credentials, query or fragment in the URL; redirects refused.
//   - a bearer token is required for any non-loopback host.
//   - 10-minute timeout by default (a long call on a busy GPU), a 4 MiB response cap, the response checked with zod.
// Nothing from the audio, the response or the transcript is logged or put in an error.
import { z } from 'zod';
import type { TranscriptSegment, TranscriptionProvider } from '../types.js';
import { ProviderError } from '../types.js';

export type TranscriberFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Uint8Array; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export const LOCAL_WHISPER_TIMEOUT_MS = 10 * 60 * 1000;
export const LOCAL_WHISPER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class TranscriberConfigError extends Error {
  override readonly name = 'TranscriberConfigError';
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/** Loopback only (no token needed). */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const o = ipv4(h);
  return o !== null && o[0] === 127;
}

/** A host the transcriber may live on: loopback, private LAN or a private overlay range. Never a DNS name but localhost. */
export function isPrivateTranscriberHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const o = ipv4(h);
  if (o) {
    const [a, b] = o as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h);
}

/** The transcriber URL the adapter may call, normalised without a trailing slash. Throws TranscriberConfigError. */
export function checkTranscriberUrl(raw: string, token: string | undefined): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TranscriberConfigError('TRANSCRIPTION_LOCAL_URL is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TranscriberConfigError('TRANSCRIPTION_LOCAL_URL must be http or https');
  if (u.username || u.password || u.search || u.hash) throw new TranscriberConfigError('TRANSCRIPTION_LOCAL_URL must not carry credentials, a query or a fragment');
  if (!isPrivateTranscriberHost(u.hostname)) throw new TranscriberConfigError('TRANSCRIPTION_LOCAL_URL must be a loopback or private address (no cloud transcription)');
  if (!isLoopbackHost(u.hostname) && !(token && token.length >= 24)) throw new TranscriberConfigError('TRANSCRIPTION_LOCAL_TOKEN (24+ characters) is required for a non-loopback transcriber');
  return u.toString().replace(/\/+$/, '');
}

const ResponseSchema = z.object({
  language: z.string().min(1).max(16),
  segments: z
    .array(
      z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        speaker: z.enum(['agent', 'client']).nullable(),
        text: z.string().max(20_000),
      }),
    )
    .max(20_000),
});

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new ProviderError('unavailable', 'TRANSCRIBER_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export interface LocalWhisperOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetch?: TranscriberFetch;
}

export class LocalWhisperTranscription implements TranscriptionProvider {
  readonly configured = true;
  /** stored in transcripts.provider */
  readonly name = 'local_whisper';
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: TranscriberFetch;

  constructor(o: LocalWhisperOptions) {
    this.#url = `${checkTranscriberUrl(o.baseUrl, o.token)}/v1/transcribe`;
    this.#token = o.token;
    this.#timeoutMs = o.timeoutMs ?? LOCAL_WHISPER_TIMEOUT_MS;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
  }

  async transcribe(r: { audio: Uint8Array; contentType: string; durationMs?: number; languageHint?: string }): Promise<{ segments: TranscriptSegment[]; language: string }> {
    const type = r.contentType.split(';')[0]!.trim().toLowerCase();
    if (!type.startsWith('audio/')) throw new ProviderError('rejected', 'TRANSCRIBER_NOT_AUDIO');
    const url = r.languageHint && /^[a-z]{2}$/.test(r.languageHint) ? `${this.#url}?language=${r.languageHint}` : this.#url;
    const headers: Record<string, string> = { 'Content-Type': type };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, { method: 'POST', headers, body: r.audio, redirect: 'manual', signal: ac.signal });
    } catch {
      clearTimeout(timer);
      throw ac.signal.aborted ? new ProviderError('timeout', 'TRANSCRIBER_TIMEOUT') : new ProviderError('unavailable', 'TRANSCRIBER_UNREACHABLE');
    }
    try {
      if (res.status >= 300 && res.status < 400) throw new ProviderError('rejected', 'TRANSCRIBER_REDIRECT');
      if (res.status === 401 || res.status === 403) throw new ProviderError('rejected', 'TRANSCRIBER_UNAUTHORIZED');
      if (res.status === 413 || res.status === 415 || res.status === 422) throw new ProviderError('rejected', `TRANSCRIBER_${res.status}`);
      if (res.status !== 200) throw new ProviderError('unavailable', `TRANSCRIBER_${res.status}`);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(await readCapped(res, LOCAL_WHISPER_MAX_RESPONSE_BYTES)).toString('utf8'));
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError('unavailable', 'TRANSCRIBER_BAD_JSON');
      }
      const p = ResponseSchema.safeParse(body);
      if (!p.success) throw new ProviderError('unavailable', 'TRANSCRIBER_BAD_RESPONSE');
      const segments = p.data.segments
        .filter((s) => s.endMs >= s.startMs && s.text.trim() !== '')
        .map((s) => ({ startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text.trim() }))
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      return { language: p.data.language, segments };
    } finally {
      clearTimeout(timer);
    }
  }
}
