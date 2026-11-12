// Module 48 item 1: the voice-agent port, its deterministic fake and the unconfigured production stand-in.
import { instant } from '@realty/core/foundation';
import { SCRIPTS } from '@realty/core/voice/testing';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../auth/testHarness.js';
import { createFakeProviders, createProviders } from '../providers/index.js';
import { ProviderError } from '../providers/types.js';
import { FakeVoiceAgent, type FakeVoiceTransport } from './fake.js';
import { UnconfiguredVoiceAgent, VOICE_SESSION_CONTEXT_KEYS, VOICE_VENDOR_NOT_CONFIGURED_TEXT, type VoiceSessionContext } from './provider.js';

const CONTEXT: VoiceSessionContext = {
  disclosure: "Hi, you've reached the team's automated assistant. I'm an AI, not a person.",
  recordingAnnouncement: 'This call is recorded and transcribed by the assistant.',
  enabledTools: ['check_availability', 'book_appointment', 'record_opt_out', 'end_call'],
  maxCallSeconds: 300,
  coveredLanguages: ['en'],
  maxTurnLatencyMs: 1500,
  lineIds: ['truthfulAnswer'],
};
const clock = { now: () => instant(Date.parse('2026-11-12T19:00:00Z')) };

async function drain(t: FakeVoiceTransport, untilMs = 60_000) {
  const out: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const r = await t.next({ until: (t.clock.now() + 250) as never, pending: null });
    if (r === null) break;
    if (r !== 'idle') out.push(r.type);
    if (t.clock.now() - t.startedAt > untilMs) break;
  }
  return out;
}

describe('R-VOICE-11: the voice agent is a source-neutral port with a deterministic fake and an honest unconfigured state', () => {
  it('R-VOICE-11: production without ALLOW_FAKE_PROVIDERS gets UnconfiguredVoiceAgent, whose connect and reconnect refuse with VOICE_VENDOR_NOT_CONFIGURED', async () => {
    expect(createFakeProviders().voiceAgent).toBeInstanceOf(FakeVoiceAgent);
    expect(createProviders(testConfig(), { clock: clock as never }).voiceAgent).toBeInstanceOf(FakeVoiceAgent);
    const prod = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, { clock: clock as never }).voiceAgent;
    expect(prod).toBeInstanceOf(UnconfiguredVoiceAgent);
    expect([prod.configured, prod.statusText]).toEqual([false, VOICE_VENDOR_NOT_CONFIGURED_TEXT]);
    expect(VOICE_VENDOR_NOT_CONFIGURED_TEXT).toBe('No voice vendor is set up on this platform yet (N12). AI answering stays off.');
    await expect(prod.connect({ callRef: 'CA1', sessionId: 's', tenantId: 't', context: CONTEXT })).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'VOICE_VENDOR_NOT_CONFIGURED' });
    await expect(prod.reconnect({ sessionId: 's', tenantId: 't' })).rejects.toBeInstanceOf(ProviderError);
    expect(createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, { clock: clock as never }).voiceAgent).toBeInstanceOf(FakeVoiceAgent);
  });

  it('R-VOICE-13: the session context has the approved content and limits only (no contact field)', () => {
    expect(Object.keys(CONTEXT).sort()).toEqual([...VOICE_SESSION_CONTEXT_KEYS].sort());
    for (const k of VOICE_SESSION_CONTEXT_KEYS) expect(k).not.toMatch(/contact|name|phone|email|address|claim|owner/i);
  });

  it('R-VOICE-11: the fake replays a script on its virtual clock, drops the events module 48 makes and turns claims into raw proposals after a caller turn', async () => {
    const f = new FakeVoiceAgent(clock);
    f.nextCall(SCRIPTS.hotTransfer);
    const { response, transport } = await f.connect({ callRef: 'CA1', sessionId: 'sess-1', tenantId: 't1', context: CONTEXT });
    expect(response).toContain('fake-voice://session/sess-1');
    const t = transport as FakeVoiceTransport;
    const types = await drain(t, 20_000);
    expect(types).toEqual(['disclosure_played', 'announcement_played', 'model_turn', 'caller_turn', 'claim_proposals', 'tool_request']);
    expect(types).not.toContain('transfer_result');
    expect(t.clock.now() - t.startedAt).toBeGreaterThanOrEqual(16_000);
  });

  it('R-VOICE-10: injected faults: a connect failure, a vendor error at step n, model latency and a closed transport', async () => {
    const f = new FakeVoiceAgent(clock);
    f.nextCall(SCRIPTS.booking, { connectFailure: true });
    await expect(f.connect({ callRef: 'CA1', sessionId: 's1', tenantId: 't1', context: CONTEXT })).rejects.toBeInstanceOf(ProviderError);
    f.nextCall(SCRIPTS.booking, { vendorErrorAtStep: 1 });
    const a = (await f.connect({ callRef: 'CA2', sessionId: 's2', tenantId: 't1', context: CONTEXT })).transport as FakeVoiceTransport;
    expect((await drain(a, 5000)).slice(0, 2)).toEqual(['tool_request', 'vendor_error']);
    f.nextCall(SCRIPTS.booking, { latencyMs: 5000 });
    const b = (await f.connect({ callRef: 'CA3', sessionId: 's3', tenantId: 't1', context: CONTEXT })).transport as FakeVoiceTransport;
    let model: unknown = null;
    for (let i = 0; i < 100 && model === null; i++) {
      const r = await b.next({ until: (b.clock.now() + 1000) as never, pending: null });
      if (r && r !== 'idle' && r.type === 'model_turn') model = r;
    }
    expect((model as { latencyMs: number }).latencyMs).toBe(5400);
    f.nextCall(SCRIPTS.booking, { closeAtStep: 2 });
    const c = (await f.connect({ callRef: 'CA4', sessionId: 's4', tenantId: 't1', context: CONTEXT })).transport as FakeVoiceTransport;
    expect(await drain(c)).toEqual(['tool_request', 'disclosure_played']);
    expect(await c.next({ until: (c.clock.now() + 1) as never, pending: null })).toBeNull();
  });

  it('R-VOICE-11: says issued while handed off are queued until reconnect; reconnect of an unknown session refuses', async () => {
    const f = new FakeVoiceAgent(clock);
    const { transport } = await f.connect({ callRef: 'CA1', sessionId: 's1', tenantId: 't1', context: CONTEXT });
    await transport.handOff('<Response/>');
    await transport.say('Hello again', 'script');
    expect(f.sessions[0]!.says[0]).toMatchObject({ queued: true });
    await f.reconnect({ sessionId: 's1', tenantId: 't1' });
    expect(f.sessions[0]!.says[0]).toMatchObject({ queued: false });
    await expect(f.reconnect({ sessionId: 's1', tenantId: 'other-tenant' })).rejects.toMatchObject({ providerCode: 'VOICE_SESSION_UNKNOWN' });
  });
});
