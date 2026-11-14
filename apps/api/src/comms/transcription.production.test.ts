// b18 item h (acceptance report finding, 2026-11-14): a production build never wires the fake call transcription. No
// transcription vendor is procured, and FakeTranscription invents a canned two-line transcript that the call summary
// and call reviews would then read as if it were the call. With NODE_ENV=production and no ALLOW_FAKE_PROVIDERS the
// provider is UnconfiguredTranscription: a recording gets no transcript, the summary says NO_TRANSCRIPT, a call review
// is ineligible (no_transcript) and the thread says transcription is not set up. Fakes only, fictional numbers.
import { randomUUID } from 'node:crypto';
import { instant } from '@realty/core/foundation';
import { reviewEligible } from '@realty/core/coaching';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarizeCall } from '../assistant/callPipeline.js';
import { type ApiHarness, type TestClient, createApiHarness, testConfig } from '../auth/testHarness.js';
import * as coaching from '../coaching/repos/coaching.js';
import { FakeTranscription, UnconfiguredTranscription, createProviders } from '../providers/index.js';
import { ProviderError, type TranscriptionProvider } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { depsFromPlatform } from './runtime.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, runJobs, telephonyWebhook } from './testing.js';

const clock = { now: () => instant(Date.now()) };
const productionTranscription = (): TranscriptionProvider => createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, { clock: clock as never }).transcription;

describe('b18 item h: the production provider build has no fake transcription (R-VOICE-12 pattern)', () => {
  it('E725: production without ALLOW_FAKE_PROVIDERS gets UnconfiguredTranscription, which refuses; dev, test and a staging demo with fakes allowed keep the fake', async () => {
    const prod = productionTranscription();
    expect(prod).toBeInstanceOf(UnconfiguredTranscription);
    expect(prod).not.toBeInstanceOf(FakeTranscription);
    expect(prod.configured).toBe(false);
    await expect(prod.transcribe({ audio: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' })).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'TRANSCRIPTION_NOT_CONFIGURED' });
    await expect(prod.transcribe({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' })).rejects.toBeInstanceOf(ProviderError);
    expect(createProviders(testConfig(), { clock: clock as never }).transcription).toBeInstanceOf(FakeTranscription);
    expect(createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, { clock: clock as never }).transcription).toBeInstanceOf(FakeTranscription);
    expect(new FakeTranscription().configured).toBe(true);
  });
});

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  for (const a of w.agents) await alertPhone(a);
  // the production build's transcription, on the test harness (everything else stays the fakes)
  (h.providers as { transcription: TranscriptionProvider }).transcription = productionTranscription();
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

/** The agent's tap-to-call, announced, answered and recorded; the copy and transcription jobs run. */
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
  await runJobs(h, w.tenantId, ['comms.recording_copy', 'comms.transcribe']);
  const rec = (await h.su.query<{ id: string; status: string }>('SELECT id, status FROM recordings WHERE call_id = $1', [callId])).rows[0];
  expect(rec?.status, 'the recording itself is stored').toBe('stored');
  return { callId, recordingId: rec!.id };
}

describe('b18 item h: with the production transcription, a recorded call has no transcript and nothing reads one', () => {
  it('E725: the recording is stored, the transcription job ends without a transcript (no retry, no row), the summary says NO_TRANSCRIPT and a call review is ineligible no_transcript', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { callId, recordingId } = await recordedCall(agent, c.id);
    expect((await h.su.query('SELECT 1 FROM transcripts WHERE recording_id = $1', [recordingId])).rows).toHaveLength(0);
    // the job finished (it does not fail and retry until a vendor appears)
    const jobs = (await h.su.query<{ status: string }>("SELECT status FROM jobs WHERE kind = 'comms.transcribe' AND payload->>'recordingId' = $1", [recordingId])).rows;
    expect(jobs.map((j) => j.status)).toEqual(['succeeded']);
    const actor = systemActor(w.tenantId, 'assistant');
    const s = await summarizeCall(actor, callId, depsFromPlatform(h.app.platform));
    expect(s).toEqual({ kind: 'skipped', reason: 'NO_TRANSCRIPT' });
    expect((await h.su.query("SELECT 1 FROM assistant_actions WHERE contact_id = $1 AND kind = 'call_summary'", [c.id])).rows).toHaveLength(0);
    const facts = (await withTenantTx(actor, (tx) => coaching.callReviewFacts(tx, callId), { db: h.database }))!;
    expect(facts.hasTranscript).toBe(false);
    // with every other condition met (pack cleared, scoring on), the review is refused for the missing transcript
    expect(reviewEligible({ handledBy: 'human', agentRole: 'agent', imported: false, recording: { source: 'provider', consentBasis: 'announced_all_parties' }, hasTranscript: facts.hasTranscript, callScoringEnabled: true, coachingPackCleared: true })).toEqual({ eligible: false, reason: 'no_transcript' });
  });

  it('E725: a voicemail with no transcript says transcription is not set up, never that it is not ready yet', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const { callId } = await recordedCall(agent, c.id);
    // fixture only: the stored recording shown as the contact's voicemail (the attachments view lists inbound voicemails)
    await h.su.query(`SET session_replication_role = replica; UPDATE calls SET direction = 'inbound', initiator = 'client', handled_by = 'voicemail' WHERE id = '${callId}'; SET session_replication_role = origin`);
    const r = await call<{ voicemails: { callId: string; transcriptReady: boolean; transcriptUnavailable: boolean }[] }>(agent, 'GET', `/contacts/${c.id}/attachments`);
    expect(r.status).toBe(200);
    const vm = r.body.voicemails.find((v) => v.callId === callId)!;
    expect(vm).toMatchObject({ transcriptReady: false, transcriptUnavailable: true });
  });
});
