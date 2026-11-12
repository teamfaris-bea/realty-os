// Test helpers of module 48 (imported by *.test.ts only). The telephony side is driven through the real webhooks with
// the fake telephony provider's shared secret; the voice side through FakeVoiceAgent's scripts on its virtual clock.
// The superuser only clears the platform:voice pack in the test's own disposable database (no application path clears
// a counsel pack, D11) and reads rows back.
import { randomUUID } from 'node:crypto';
import type { VoiceScript } from '@realty/core/voice/testing';
import { approvedPlaybook } from '../assistant/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact, randomPhone, telephonyWebhook } from '../comms/testing.js';
import type { FakeFaults } from './fake.js';
import { enableAnswering } from './answering.js';
import { voiceDeps } from './runtime.js';

export interface VoiceWorld extends CommsWorld {
  ownerPhone: string;
  playbookVersionId: string;
}

let n = 0;
export const sid = (p = 'CA') => `${p}${(Date.now().toString(16) + String(++n).padStart(6, '0') + randomUUID().replace(/-/g, '')).slice(0, 32)}`;

export async function verifyAlertPhone(h: ApiHarness, c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}

/** platform:voice as counsel-review and a vendor check would leave it (test DB only). */
export async function setVoicePack(h: ApiHarness, o: { reviewed: boolean; vendorReady: boolean; maxTurnLatencyMs?: unknown }): Promise<void> {
  await h.su.query(
    `UPDATE jurisdiction_packs SET reviewed_by_counsel_at = CASE WHEN $1::boolean THEN now() ELSE NULL END,
            rules = (CASE WHEN $2::boolean THEN rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' ELSE rules - 'vendor_ready_at' END)
                    || jsonb_build_object('max_turn_latency_ms', $3::jsonb)
      WHERE key = 'platform:voice' AND status = 'published'`,
    [o.reviewed, o.vendorReady, JSON.stringify(o.maxTurnLatencyMs ?? 1500)],
  );
}

/** A tenant with an approved voice playbook, AI answering turned on by the Owner, and agent 0 ringable. */
export async function voiceWorld(h: ApiHarness, o: { enable?: boolean; agents?: number } = {}): Promise<VoiceWorld> {
  const w = await commsWorld(h, { agents: o.agents ?? 2 });
  const ownerPhone = await verifyAlertPhone(h, w.agents[0]!);
  const pb = await approvedPlaybook(w.owner, { templateKey: 'voice_answering' });
  if (o.enable !== false) await enableAnswering(w.owner.actor(), voiceDeps(h.app.platform));
  return { ...w, ownerPhone, playbookVersionId: pb.versionId };
}

/** The path + query of an absolute callback URL found in TwiML (attribute values are XML-escaped). */
export function hookPath(twiml: string, attr: string): string {
  const m = new RegExp(`${attr}="([^"]+)"`).exec(twiml);
  if (!m) throw new Error(`no ${attr} in ${twiml}`);
  const u = new URL(m[1]!.replace(/&amp;/g, '&'));
  return u.pathname.replace(/^\/api/, '') + u.search;
}

export const ringing = (h: ApiHarness, w: CommsWorld, callSid: string, from: string) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: w.mainNumber, CallStatus: 'ringing', Direction: 'inbound' });
export const callStatus = (h: ApiHarness, w: CommsWorld, callSid: string, from: string, status: string, extra: Record<string, string> = {}) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: w.mainNumber, CallStatus: status, Direction: 'inbound', ...extra });
export const callRowOf = (h: ApiHarness, callSid: string) => h.su.query('SELECT * FROM calls WHERE provider_call_ref = $1', [callSid]).then((r) => r.rows[0]);

export interface AiCall {
  callSid: string;
  callId: string;
  contactId: string;
  from: string;
  ringTwiml: string;
  answer: string;
}

/** A caller rings agent 0's contact; nobody presses 1; the dial result hands the call to the assistant. */
export async function aiCall(h: ApiHarness, w: VoiceWorld, script: VoiceScript | null, o: { faults?: FakeFaults; contact?: { id: string; phone: string }; settle?: boolean } = {}): Promise<AiCall> {
  const c = o.contact ?? (await ownedContact(w.agents[0]!, { consent: false }));
  if (script) h.providers.voiceAgent.nextCall(script, o.faults ?? {});
  const callSid = sid();
  const ring = await ringing(h, w, callSid, c.phone);
  if (ring.statusCode !== 200) throw new Error(`ring: ${ring.statusCode} ${ring.body}`);
  const row = await callRowOf(h, callSid);
  let answer = ring.body;
  if (ring.body.includes('<Dial')) answer = (await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body;
  if (o.settle !== false) await voiceDeps(h.app.platform).registry.settled(w.tenantId, row.id);
  return { callSid, callId: row.id, contactId: c.id, from: c.phone, ringTwiml: ring.body, answer };
}

export async function settled(h: ApiHarness, tenantId: string, callId: string): Promise<void> {
  await voiceDeps(h.app.platform).registry.settled(tenantId, callId);
}

export const handbacksOf = (h: ApiHarness, callId: string) => h.su.query("SELECT * FROM assistant_actions WHERE kind = 'handback' AND payload ->> 'inboundCallId' = $1 ORDER BY created_at", [callId]).then((r) => r.rows);
export const ledgerOf = (h: ApiHarness, callId: string) => h.su.query('SELECT seq, tool, args, decision, reason_code FROM voice_tool_calls WHERE call_id = $1 ORDER BY seq', [callId]).then((r) => r.rows as { seq: number; tool: string; args: Record<string, string>; decision: string; reason_code: string }[]);
