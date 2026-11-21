// Local call transcription (draft lane): the config switch, the provider build, and the transcribe job with the local
// adapter and the timing-cue hook, end to end on the test harness. Fakes and fictional data only: the "transcriber" is
// an injected fetch returning invented sentences; no network call is made and no real audio exists.
import { randomUUID } from 'node:crypto';
import { instant } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness, testConfig } from '../auth/testHarness.js';
import { ConfigError, loadConfig, redactConfig } from '../config.js';
import { FakeTranscription, LocalWhisperTranscription, UnconfiguredTranscription, createProviders } from '../providers/index.js';
import type { TranscriberFetch } from '../providers/transcription/localWhisper.js';
import type { TranscriptionProvider } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { transcribeRecording } from './recordings.js';
import { depsFromPlatform } from './runtime.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, runJobs, telephonyWebhook } from './testing.js';
import { type TimingCueRecord, timingCueHook } from './transcriptHooks.js';
import type { TranscriptReady } from './types.js';

const TOKEN = 'synthetic-test-token-0123456789';
const clock = { now: () => instant(Date.now()) };
const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', KEK_BASE64: Buffer.alloc(32, 1).toString('base64'), SESSION_SECRET_BASE64: Buffer.alloc(32, 2).toString('base64'), WEB_ORIGIN: 'https://app.test.invalid', LOG_LEVEL: 'silent' };

describe('TRANSCRIPTION_PROVIDER config: local only, no cloud', () => {
  it('defaults to none, and the provider build keeps today’s behaviour (fake in test, unconfigured in production)', () => {
    const c = testConfig();
    expect(c.transcription).toEqual({ provider: 'none' });
    expect(redactConfig(c).transcription).toEqual({ provider: 'none' });
    expect(createProviders(c, { clock: clock as never }).transcription).toBeInstanceOf(FakeTranscription);
    expect(createProviders({ ...c, env: 'production', allowFakeProviders: false }, { clock: clock as never }).transcription).toBeInstanceOf(UnconfiguredTranscription);
  });

  it('local_whisper on a private address with a token builds the local adapter, in production too, and the token is never in the redacted view', () => {
    const c = loadConfig({ ...base, TRANSCRIPTION_PROVIDER: 'local_whisper', TRANSCRIPTION_LOCAL_URL: 'http://100.70.1.2:8765', TRANSCRIPTION_LOCAL_TOKEN: TOKEN });
    expect(c.transcription).toEqual({ provider: 'local_whisper', localUrl: 'http://100.70.1.2:8765', localToken: TOKEN });
    expect(JSON.stringify(redactConfig(c))).not.toContain(TOKEN);
    const p = createProviders({ ...c, env: 'production', allowFakeProviders: false }, { clock: clock as never }).transcription;
    expect(p).toBeInstanceOf(LocalWhisperTranscription);
    expect(p.name).toBe('local_whisper');
  });

  it.each([
    [{ TRANSCRIPTION_PROVIDER: 'local_whisper' }, /needs TRANSCRIPTION_LOCAL_URL/],
    [{ TRANSCRIPTION_PROVIDER: 'local_whisper', TRANSCRIPTION_LOCAL_URL: 'https://speech.example.com' }, /loopback or private address/],
    [{ TRANSCRIPTION_PROVIDER: 'local_whisper', TRANSCRIPTION_LOCAL_URL: 'http://192.168.1.20:8765' }, /TRANSCRIPTION_LOCAL_TOKEN/],
    [{ TRANSCRIPTION_PROVIDER: 'cloud' }, /TRANSCRIPTION_PROVIDER/],
  ])('a bad setting fails at boot: %o', (env, msg) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...env })).toThrow(msg);
  });

  it('a loopback transcriber needs no token', () => {
    expect(loadConfig({ ...base, TRANSCRIPTION_PROVIDER: 'local_whisper', TRANSCRIPTION_LOCAL_URL: 'http://127.0.0.1:8765' }).transcription).toEqual({ provider: 'local_whisper', localUrl: 'http://127.0.0.1:8765' });
  });
});

/** An invented two-channel call: the client states a sell window and a lease. */
const SEGMENTS = [
  { startMs: 0, endMs: 3000, speaker: 'agent', text: 'Hi, this is Alex with the team. Still thinking about selling?' },
  { startMs: 3000, endMs: 6000, speaker: 'client', text: "Yes, we're planning to sell the house." },
  { startMs: 6000, endMs: 9000, speaker: 'client', text: 'Probably by March, once the orders come through.' },
  { startMs: 9000, endMs: 12000, speaker: 'client', text: "We'll rent there for a year first, the lease starts in February." },
];

function localTranscriber(): { provider: TranscriptionProvider; requests: { url: string; type: string; bytes: number }[] } {
  const requests: { url: string; type: string; bytes: number }[] = [];
  const fetch: TranscriberFetch = async (url, init) => {
    requests.push({ url, type: init.headers['Content-Type']!, bytes: init.body.byteLength });
    return new Response(JSON.stringify({ language: 'en', durationMs: 12000, segments: SEGMENTS }), { status: 200 });
  };
  return { provider: new LocalWhisperTranscription({ baseUrl: 'http://127.0.0.1:8765', fetch }), requests };
}

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  for (const a of w.agents) await alertPhone(a);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

const voice = (ref: string, status: string, extra: Record<string, string> = {}) =>
  telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: ref, From: w.mainNumber, To: '+14155550125', CallStatus: status, Direction: 'outbound-api', ...extra });

/** A dialer call, announced, answered and recorded and copied, with no transcript yet (the test drives transcription). */
async function recordedCall(agent: TestClient, contactId: string): Promise<{ callId: string; recordingId: string }> {
  const r = await call<{ callId: string | null }>(agent, 'POST', `/contacts/${contactId}/calls`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const callId = r.body.callId!;
  const ref = (await h.su.query<{ r: string }>('SELECT provider_call_ref AS r FROM calls WHERE id = $1', [callId])).rows[0]!.r;
  await voice(ref, 'ringing');
  await voice(ref, 'in-progress', { AnnouncementStatus: 'played' });
  await voice(ref, 'completed', { CallDuration: '61' });
  const recRef = `RE${randomUUID().replace(/-/g, '').slice(0, 30)}`;
  expect((await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: ref, RecordingSid: recRef, RecordingDuration: '60', From: w.mainNumber })).statusCode).toBe(200);
  await runJobs(h, w.tenantId, ['comms.recording_copy']);
  const rec = (await h.su.query<{ id: string; status: string }>('SELECT id, status FROM recordings WHERE call_id = $1', [callId])).rows[0];
  expect(rec?.status).toBe('stored');
  // fixture only: the worker's drain also ran the fake's comms.transcribe; drop that row so the test drives the job
  await h.su.query('DELETE FROM transcripts WHERE recording_id = $1', [rec!.id]);
  return { callId, recordingId: rec!.id };
}

describe('the transcribe job with the local transcriber and the timing-cue hook', () => {
  it('stores the transcript encrypted under provider local_whisper and hands the timing scan ids and ranges, no words', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { callId, recordingId } = await recordedCall(agent, c.id);
    const t = localTranscriber();
    const seen: TranscriptReady[] = [];
    const sunk: TimingCueRecord[] = [];
    const sink = timingCueHook(async (r) => {
      sunk.push(r);
    });
    const deps = { ...depsFromPlatform(h.app.platform), providers: { ...h.providers, transcription: t.provider }, onTranscriptReady: async (e: TranscriptReady) => {
      seen.push(e);
      await sink(e);
    } };
    const actor = systemActor(w.tenantId, 'worker');
    expect(await transcribeRecording(recordingId, deps, actor)).toBe('ready');
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.url).toBe('http://127.0.0.1:8765/v1/transcribe');
    expect(t.requests[0]!.type.startsWith('audio/')).toBe(true);
    const row = (await h.su.query<{ id: string; provider: string; status: string; segments_enc: Buffer }>('SELECT id, provider, status, segments_enc FROM transcripts WHERE recording_id = $1', [recordingId])).rows[0]!;
    expect(row).toMatchObject({ provider: 'local_whisper', status: 'ready' });
    expect(row.segments_enc.toString('utf8')).not.toContain('March');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ transcriptId: row.id, recordingId, callId, contactId: c.id, language: 'en' });
    expect(sunk).toHaveLength(1);
    expect(sunk[0]!.actionable).toEqual({ intent: 'sell', horizonMonths: expect.any(Number), startMs: 6000, endMs: 9000 });
    expect(sunk[0]!.cues.some((x) => x.leaseContext && !x.withinSixMonths)).toBe(true);
    expect(JSON.stringify(sunk)).not.toMatch(/March|orders|rent|lease starts/);
    // a second run finds the transcript and neither transcribes nor fires the hook again
    expect(await transcribeRecording(recordingId, deps, actor)).toBe('skipped');
    expect(t.requests).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('a failing hook is reported with a code only and never fails the job or loses the transcript', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { recordingId } = await recordedCall(agent, c.id);
    const reported: { err: unknown; ctx: unknown }[] = [];
    const deps = {
      ...depsFromPlatform(h.app.platform),
      providers: { ...h.providers, transcription: localTranscriber().provider },
      errorReporter: { capture: (err: unknown, ctx: unknown) => void reported.push({ err, ctx }) },
      onTranscriptReady: async () => {
        throw new Error('Probably by March, once the orders come through.');
      },
    };
    expect(await transcribeRecording(recordingId, deps, systemActor(w.tenantId, 'worker'))).toBe('ready');
    expect((await h.su.query('SELECT 1 FROM transcripts WHERE recording_id = $1', [recordingId])).rows).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.ctx).toEqual({ code: 'TRANSCRIPT_HOOK_FAILED', jobKind: 'comms.transcribe', level: 'warning' });
    expect(JSON.stringify(reported[0])).not.toContain('March');
    expect((reported[0]!.err as Error).message).toBe('TRANSCRIPT_HOOK_FAILED');
  });

  it('the test fake still stores provider fake, and no hook means no scan', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { recordingId } = await recordedCall(agent, c.id);
    expect(await transcribeRecording(recordingId, depsFromPlatform(h.app.platform), systemActor(w.tenantId, 'worker'))).toBe('ready');
    expect((await h.su.query<{ provider: string }>('SELECT provider FROM transcripts WHERE recording_id = $1', [recordingId])).rows[0]!.provider).toBe('fake');
  });
});
