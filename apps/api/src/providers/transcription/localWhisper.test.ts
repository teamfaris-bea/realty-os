// Local transcription adapter: network rules (no cloud, no SSRF), request shape and response handling.
// Synthetic bytes and invented sentences only; no network call is made (an injected fetch answers).
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../types.js';
import { LocalWhisperTranscription, TranscriberConfigError, checkTranscriberUrl, isLoopbackHost, isPrivateTranscriberHost } from './localWhisper.js';
import type { TranscriberFetch } from './localWhisper.js';

const TOKEN = 'synthetic-test-token-0123456789';
const AUDIO = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3]);

function capture(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: Parameters<TranscriberFetch>[1] }[] = [];
  const fetch: TranscriberFetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('transcriber host rules: audio never leaves the team machines', () => {
  it('loopback, private LAN and private overlay addresses are allowed', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.64.0.1', '100.127.255.254', 'fd12:3456::1']) {
      expect(isPrivateTranscriberHost(h)).toBe(true);
    }
  });

  it('public addresses and every DNS name but localhost are refused', () => {
    for (const h of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', 'api.openai.com', 'transcribe.example.com', 'my-pc.local', 'localhost.example.com', '2001:4860::8888', '127.0.0.1.nip.io']) {
      expect(isPrivateTranscriberHost(h)).toBe(false);
    }
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });

  it('a cloud URL is refused at construction', () => {
    expect(() => new LocalWhisperTranscription({ baseUrl: 'https://api.example.com', token: TOKEN })).toThrow(TranscriberConfigError);
  });

  it('a non-loopback transcriber needs a 24+ character token; loopback does not', () => {
    expect(() => checkTranscriberUrl('http://100.70.1.2:8765', undefined)).toThrow(/TRANSCRIPTION_LOCAL_TOKEN/);
    expect(() => checkTranscriberUrl('http://100.70.1.2:8765', 'short')).toThrow(/TRANSCRIPTION_LOCAL_TOKEN/);
    expect(checkTranscriberUrl('http://100.70.1.2:8765/', TOKEN)).toBe('http://100.70.1.2:8765');
    expect(checkTranscriberUrl('http://127.0.0.1:8765', undefined)).toBe('http://127.0.0.1:8765');
  });

  it('credentials, a query, a fragment or another scheme in the URL are refused', () => {
    expect(() => checkTranscriberUrl('http://u:p@127.0.0.1:8765', undefined)).toThrow(TranscriberConfigError);
    expect(() => checkTranscriberUrl('http://127.0.0.1:8765?x=1', undefined)).toThrow(TranscriberConfigError);
    expect(() => checkTranscriberUrl('http://127.0.0.1:8765#f', undefined)).toThrow(TranscriberConfigError);
    expect(() => checkTranscriberUrl('ftp://127.0.0.1', undefined)).toThrow(TranscriberConfigError);
    expect(() => checkTranscriberUrl('not a url', undefined)).toThrow(TranscriberConfigError);
  });
});

describe('LocalWhisperTranscription', () => {
  it('posts the raw audio with its type and the token, refusing redirects', async () => {
    const m = capture(() => json({ language: 'en', durationMs: 4000, segments: [{ startMs: 0, endMs: 2000, speaker: 'client', text: ' We plan to sell by March. ' }] }));
    const p = new LocalWhisperTranscription({ baseUrl: 'http://100.70.1.2:8765', token: TOKEN, fetch: m.fetch });
    expect(p.configured).toBe(true);
    expect(p.name).toBe('local_whisper');
    const r = await p.transcribe({ audio: AUDIO, contentType: 'audio/wav; rate=8000', languageHint: 'en' });
    expect(r).toEqual({ language: 'en', segments: [{ startMs: 0, endMs: 2000, speaker: 'client', text: 'We plan to sell by March.' }] });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe('http://100.70.1.2:8765/v1/transcribe?language=en');
    expect(m.calls[0]!.init.method).toBe('POST');
    expect(m.calls[0]!.init.redirect).toBe('manual');
    expect(m.calls[0]!.init.headers).toEqual({ 'Content-Type': 'audio/wav', Authorization: `Bearer ${TOKEN}` });
    expect(m.calls[0]!.init.body).toBe(AUDIO);
  });

  it('an odd language hint is dropped, not forwarded', async () => {
    const m = capture(() => json({ language: 'en', segments: [] }));
    await new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: m.fetch }).transcribe({ audio: AUDIO, contentType: 'audio/wav', languageHint: 'en&x=1' });
    expect(m.calls[0]!.url).toBe('http://127.0.0.1:8765/v1/transcribe');
    expect(m.calls[0]!.init.headers.Authorization).toBeUndefined();
  });

  it('sorts segments and drops empty or inverted ones', async () => {
    const m = capture(() =>
      json({
        language: 'en',
        segments: [
          { startMs: 5000, endMs: 6000, speaker: 'agent', text: 'Second.' },
          { startMs: 0, endMs: 1000, speaker: null, text: 'First.' },
          { startMs: 2000, endMs: 2500, speaker: null, text: '   ' },
          { startMs: 3000, endMs: 2000, speaker: null, text: 'Inverted.' },
        ],
      }),
    );
    const r = await new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: m.fetch }).transcribe({ audio: AUDIO, contentType: 'audio/mpeg' });
    expect(r.segments.map((s) => s.text)).toEqual(['First.', 'Second.']);
  });

  it('non-audio content is refused before any request', async () => {
    const m = capture(() => json({}));
    await expect(new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: m.fetch }).transcribe({ audio: AUDIO, contentType: 'application/pdf' })).rejects.toMatchObject({ kind: 'rejected', providerCode: 'TRANSCRIBER_NOT_AUDIO' });
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } }), 'rejected', 'TRANSCRIBER_REDIRECT'],
    ['a wrong token', () => json({ error: 'unauthorized' }, 401), 'rejected', 'TRANSCRIBER_UNAUTHORIZED'],
    ['a too-large file', () => json({ error: 'too_large_or_empty' }, 413), 'rejected', 'TRANSCRIBER_413'],
    ['undecodable audio', () => json({ error: 'transcription_failed' }, 422), 'rejected', 'TRANSCRIBER_422'],
    ['a server error', () => json({}, 500), 'unavailable', 'TRANSCRIBER_500'],
    ['non-JSON', () => new Response('<html>', { status: 200 }), 'unavailable', 'TRANSCRIBER_BAD_JSON'],
    ['a wrong shape', () => json({ language: 'en', segments: [{ startMs: -1, endMs: 0, speaker: 'x', text: 'y' }] }), 'unavailable', 'TRANSCRIBER_BAD_RESPONSE'],
    ['an oversized body', () => new Response('x'.repeat(4 * 1024 * 1024 + 10), { status: 200 }), 'unavailable', 'TRANSCRIBER_RESPONSE_TOO_LARGE'],
  ] as const)('%s is a ProviderError with no response content in it', async (_n, respond, kind, code) => {
    const m = capture(respond);
    const err = await new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: m.fetch }).transcribe({ audio: AUDIO, contentType: 'audio/wav' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind, providerCode: code });
    expect(String((err as Error).message)).not.toMatch(/html|elsewhere/);
  });

  it('an unreachable transcriber and a timeout are told apart', async () => {
    const down: TranscriberFetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: down }).transcribe({ audio: AUDIO, contentType: 'audio/wav' })).rejects.toMatchObject({ kind: 'unavailable', providerCode: 'TRANSCRIBER_UNREACHABLE' });
    const hang: TranscriberFetch = (_u, init) =>
      new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch: hang, timeoutMs: 20 }).transcribe({ audio: AUDIO, contentType: 'audio/wav' })).rejects.toMatchObject({ kind: 'timeout', providerCode: 'TRANSCRIBER_TIMEOUT' });
  });
});
