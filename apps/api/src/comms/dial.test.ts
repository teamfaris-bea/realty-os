// Tap-to-call, recordings and transcripts (ARCHITECTURE §9 path 3; R-CONSENT-16, R-PERM-8, R-PERM-9,
// R-DATA-1, R-TEN-9, R-GATE-9; E47).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { type CommsWorld, call, commsWorld, decisionsFor, grantConsent, ownedContact as ownedTextContact, pointId, randomPhone, runJobs, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  for (const a of [...w.agents, w.teamLead!]) await alertPhone(a);
});
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}

type CallRes = { result: string; callId: string | null; bridgeToken: string | null; reason: string | null; decision: { outcome: string; reasons: string[]; explanation: string } };
/** A contact the agent owns with an express basis for texts and calls (a marketing call needs a basis when DNC status is unknown, R-CONSENT-15). */
async function ownedContact(agent: TestClient) {
  const c = await ownedTextContact(agent);
  await grantConsent(agent, c.id, 'voice');
  return c;
}

const dial = (c: TestClient, contactId: string) => call<CallRes>(c, 'POST', `/contacts/${contactId}/calls`, {});
const callsTo = (phone: string) => h.providers.telephony.calls.filter((x) => x.to === phone);

async function providerRef(callId: string): Promise<string> {
  return (await h.su.query<{ r: string }>('SELECT provider_call_ref AS r FROM calls WHERE id = $1', [callId])).rows[0]!.r;
}

const voice = (ref: string, status: string, extra: Record<string, string> = {}) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: ref, From: w.mainNumber, To: '+14155550000', CallStatus: status, Direction: 'outbound-api', ...extra });

describe('tap-to-call (path 3)', () => {
  it('R-GATE-10: a call is gated at dial time; allowed ⇒ the call row cites a fresh voice allow, the provider bridges the agent first and announces the recording', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await dial(agent, c.id);
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('dialing');
    expect(r.body.bridgeToken).toMatch(new RegExp(`^${r.body.callId}\\.`));
    const row = (await h.su.query('SELECT status, gate_decision_id, recording_mode, initiator FROM calls WHERE id = $1', [r.body.callId])).rows[0]!;
    expect(row).toMatchObject({ status: 'ringing', recording_mode: 'announced_all_parties', initiator: 'human' });
    const d = (await h.su.query('SELECT channel, outcome, phase FROM gate_decisions WHERE id = $1', [row.gate_decision_id])).rows[0]!;
    expect(d).toEqual({ channel: 'voice', outcome: 'allow', phase: 'send' });
    const placed = callsTo(c.phone);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.record).toBe(true);
    expect(placed[0]!.recordingAnnouncement).toMatch(/recorded/);
  });

  it('R-GATE-10: a denied call creates no call row and never reaches the provider', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const pid = await pointId(h, c.id, 'phone');
    await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'voice', purpose: 'all', evidence: {} });
    const r = await dial(agent, c.id);
    expect(r.body.result).toBe('gate');
    expect(r.body.decision.outcome).toBe('deny');
    expect(r.body.decision.reasons).toContain('CONSENT_REVOKED');
    expect((await h.su.query('SELECT 1 FROM calls WHERE contact_id = $1', [c.id])).rows).toHaveLength(0);
    expect(callsTo(c.phone)).toHaveLength(0);
  });

  it('R-CONSENT-14: more than 3 outbound call attempts in 24 h are denied (CALL_ATTEMPT_LIMIT)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    for (let i = 0; i < 3; i++) expect((await dial(agent, c.id)).body.result).toBe('dialing');
    const r = await dial(agent, c.id);
    expect(r.body.decision.reasons).toContain('CALL_ATTEMPT_LIMIT');
    expect(callsTo(c.phone)).toHaveLength(3);
  });

  it('R-GATE-9: Phase 1 has no AI-originated or AI-handled calls (DB CHECKs)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const conv = (await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [c.id])).rows[0]?.id ?? randomUUID();
    await h.su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [w.tenantId, conv, c.id]);
    const ins = (initiator: string, handled: string) =>
      h.su.query("INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, handled_by, status, started_at, recording_mode, recording_decision) VALUES ($1,$2,(SELECT id FROM conversations WHERE contact_id = $3),$3,'inbound',$4,$5,$6,'ringing',now(),'off','{}')", [w.tenantId, randomUUID(), c.id, c.phone, initiator, handled]);
    await expect(ins('assistant', 'human')).rejects.toThrow(/check/i);
    await expect(ins('client', 'assistant')).rejects.toThrow(/check/i);
  });

  it('R-OWN-14: a gate-allowed call by the owner is the touch (recorded in the dial transaction)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await dial(agent, c.id);
    const t = (await h.su.query<{ t: Date | null }>('SELECT last_human_touch_at AS t FROM contacts WHERE id = $1', [c.id])).rows[0]!.t;
    const started = (await h.su.query<{ s: Date }>('SELECT started_at AS s FROM calls WHERE id = $1', [r.body.callId])).rows[0]!.s;
    expect(t).not.toBeNull();
    expect(Math.abs(t!.getTime() - started.getTime())).toBeLessThan(1000);
  });

  it('R-CONSENT-11: logging "wrong number" after a call marks the point and revokes texts and calls; "do not call" revokes calls', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await dial(agent, c.id);
    expect((await call(agent, 'POST', `/calls/${r.body.callId}/outcome`, { outcome: 'wrong_number' })).status).toBe(200);
    expect((await h.su.query("SELECT status FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.status).toBe('wrong_number');
    const st = (await h.su.query("SELECT DISTINCT channel, status FROM consent_state WHERE address_hmac = (SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'phone')", [c.id])).rows;
    expect(st).toEqual(expect.arrayContaining([{ channel: 'sms', status: 'revoked' }, { channel: 'voice', status: 'revoked' }]));
    const other = w.agents[1]!;
    expect((await call(other, 'POST', `/calls/${r.body.callId}/outcome`, { outcome: 'connected' })).status).toBe(404);
  });

  // E14 (outcome part; the "on a call" banner for the new owner is UI, module 17)
  it('R-PERM-7: after a reassignment during a live call, the old agent\'s outcome becomes a "log outcome" task for the new owner; only the agent on the call can hand it over', async () => {
    const [a, b] = w.agents as [TestClient, TestClient];
    const c = await ownedContact(a);
    const r = await dial(a, c.id);
    await (await import('../admin/testing.js')).freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reassign`, { commandId: randomUUID(), toUserId: b.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    const out = await call<{ recordedAs: string }>(a, 'POST', `/calls/${r.body.callId}/outcome`, { outcome: 'callback_requested' });
    expect(out.status).toBe(200);
    expect(out.body.recordedAs).toBe('task_for_current_owner');
    const t = (await h.su.query('SELECT assignee_user_id, kind, created_by_kind FROM tasks WHERE contact_id = $1', [c.id])).rows;
    expect(t).toEqual([{ assignee_user_id: b.userId, kind: 'follow_up', created_by_kind: 'system' }]);
    expect((await h.su.query('SELECT outcome FROM calls WHERE id = $1', [r.body.callId])).rows[0]!.outcome).toBeNull();
    // the new owner sees the call but it was not theirs
    expect((await call(b, 'POST', `/calls/${r.body.callId}/outcome`, { outcome: 'connected' })).code).toBe('CALL_NOT_ACTIVE');
  });
});

describe('recordings (R-CONSENT-16, R-DATA-1, R-PERM-8, R-PERM-9)', () => {
  async function recordedCall(agent: TestClient, announcement: 'played' | 'failed'): Promise<{ contactId: string; callId: string; recRef: string }> {
    const c = await ownedContact(agent);
    const r = await dial(agent, c.id);
    const ref = await providerRef(r.body.callId!);
    await voice(ref, 'ringing');
    await voice(ref, 'in-progress', { AnnouncementStatus: announcement });
    await voice(ref, 'completed', { CallDuration: '61' });
    const recRef = `RE${randomUUID().replace(/-/g, '').slice(0, 30)}`;
    expect((await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: ref, RecordingSid: recRef, RecordingDuration: '60', From: w.mainNumber })).statusCode).toBe(200);
    await runJobs(h, w.tenantId, ['comms.recording_copy', 'comms.transcribe']);
    return { contactId: c.id, callId: r.body.callId!, recRef };
  }

  it('R-CONSENT-16 E47: when the announcement fails to play, the call is never recorded (mode off; the provider recording is refused)', async () => {
    const x = await recordedCall(w.agents[0]!, 'failed');
    const c = (await h.su.query('SELECT recording_mode, recording_announced_at, status FROM calls WHERE id = $1', [x.callId])).rows[0]!;
    expect(c).toMatchObject({ recording_mode: 'off', recording_announced_at: null, status: 'completed' });
    expect((await h.su.query('SELECT 1 FROM recordings WHERE call_id = $1', [x.callId])).rows).toHaveLength(0);
  });

  it('R-CONSENT-16 R-DATA-1 R-TEN-9: an announced recording is copied into tenant-keyed encrypted storage and transcribed into encrypted segments', async () => {
    const x = await recordedCall(w.agents[0]!, 'played');
    const rec = (await h.su.query<{ id: string; status: string; consent_basis: string; storage_key: string; dek_wrapped: Buffer }>(
      'SELECT r.id, r.status, r.consent_basis, o.storage_key, o.dek_wrapped FROM recordings r JOIN stored_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id WHERE r.call_id = $1', [x.callId])).rows[0]!;
    expect(rec).toMatchObject({ status: 'stored', consent_basis: 'announced_all_parties' });
    expect(rec.storage_key.startsWith(`tenants/${w.tenantId}/recording/`)).toBe(true);
    const blob = await h.providers.storage.get(rec.storage_key);
    const original = (await h.providers.telephony.fetchRecording({ accountRef: 'x', secret: 'x' }, x.recRef)).bytes;
    expect(Buffer.from(blob!).includes(Buffer.from(original.slice(0, 64)))).toBe(false);
    const t = (await h.su.query<{ status: string; segments_enc: Buffer }>('SELECT status, segments_enc FROM transcripts WHERE recording_id = $1', [rec.id])).rows[0]!;
    expect(t.status).toBe('ready');
    expect(t.segments_enc.toString('utf8')).not.toMatch(/"text"/);
  });

  it('R-PERM-9: playback streams through a 60 s single-use token and every play is audited; a second use fails; transcript views are audited', async () => {
    const agent = w.agents[0]!;
    const x = await recordedCall(agent, 'played');
    const recId = (await h.su.query<{ id: string }>('SELECT id FROM recordings WHERE call_id = $1', [x.callId])).rows[0]!.id;
    const tok = await call<{ token: string; url: string; expiresAt: string }>(agent, 'POST', `/recordings/${recId}/stream-token`, { purpose: 'play' });
    expect(tok.status).toBe(200);
    expect(new Date(tok.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    const first = await agent.get(tok.body.url);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('audio/wav');
    expect(first.rawPayload.length).toBe(1024);
    expect((await agent.get(tok.body.url)).statusCode).toBe(404); // single use
    const audits = await h.su.query("SELECT actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'recording.play' AND entity_id = $2", [w.tenantId, recId]);
    expect(audits.rows).toEqual([{ actor_user_id: agent.userId }]);
    const tr = await call<{ status: string; segments: unknown[] }>(agent, 'GET', `/recordings/${recId}/transcript`);
    expect(tr.status).toBe(200);
    expect(tr.body.segments.length).toBeGreaterThan(0);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'transcript.view'", [w.tenantId])).rows.length).toBeGreaterThan(0);
    // an expired token never works (created ≤ 60 s, CHECK; aged here by the fixture clock)
    const tok2 = await call<{ token: string; url: string }>(agent, 'POST', `/recordings/${recId}/stream-token`, { purpose: 'play' });
    await suFixture(h, [{ text: "UPDATE recording_stream_tokens SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE used_at IS NULL", values: [] }]);
    expect((await agent.get(tok2.body.url)).statusCode).toBe(404);
  });

  it('R-PERM-8: recording scope: another agent gets 404; the Team Lead may play team recordings only while the tenant setting is on', async () => {
    const agent = w.agents[0]!;
    const x = await recordedCall(agent, 'played');
    const recId = (await h.su.query<{ id: string }>('SELECT id FROM recordings WHERE call_id = $1', [x.callId])).rows[0]!.id;
    expect((await call(w.agents[1]!, 'POST', `/recordings/${recId}/stream-token`, { purpose: 'play' })).status).toBe(404);
    const tl = w.teamLead!;
    expect((await call(tl, 'POST', `/recordings/${recId}/stream-token`, { purpose: 'play' })).status).toBe(200);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET team_lead_recording_access = false WHERE tenant_id = $1', values: [w.tenantId] }]);
    expect((await call(tl, 'POST', `/recordings/${recId}/stream-token`, { purpose: 'play' })).status).toBe(404);
    expect((await call(tl, 'GET', `/recordings/${recId}/transcript`)).status).toBe(404);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET team_lead_recording_access = true WHERE tenant_id = $1', values: [w.tenantId] }]);
  });
});

void decisionsFor;
