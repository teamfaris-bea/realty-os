// Module 48 item 9: Owner enablement and read routes (R-VOICE-9, R-VOICE-20, R-PERM-5; E150).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ATTESTATION_TEXT } from '../admin/policy.js';
import { call, freshReauth, staleReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FIXTURE_HOT_RULE, OWNER_ID, SCRIPTS } from '@realty/core/voice/testing';
import { NO_HOT_RULE_SENTENCE, OWNER_ONLY_DISABLE_SENTENCE, POLICY_COPY_COLUMNS, POLICY_FRESH_COLUMNS, VOICE_ATTESTATION_TEXT } from './answering.js';
import { setVoiceTestSeams } from './runtime.js';
import * as S from './schemas.js';
import { TEST_CALL_SENTENCE } from './routes.js';
import { type VoiceWorld, aiCall, handbacksOf, settled, setVoicePack, voiceWorld } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h, { enable: false });
});
afterAll(async () => {
  await h?.close();
});

type View = { state: string; reasons: { code: string }[]; enabled: { on: boolean; sentence: string }; settings: { answerAfterSeconds: number; answerWhen: string; version: number }; transfers: string; attestationText: string; provider: { configured: boolean } };

describe('R-VOICE-20 R-PERM-5: the AI answering routes', () => {
  it('R-PERM-5: Owner and Admin read the state; a Team Lead or an agent cannot', async () => {
    const admin = await h.invite(w.owner, 'admin');
    const o = await call<View>(w.owner, 'GET', '/voice/answering');
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ state: 'off', enabled: { on: false }, transfers: NO_HOT_RULE_SENTENCE, attestationText: VOICE_ATTESTATION_TEXT, provider: { configured: true } });
    expect(o.body.reasons.map((r) => r.code)).toEqual(['VOICE_ANSWERING_OFF']);
    expect((await call(admin, 'GET', '/voice/answering')).status).toBe(200);
    expect((await call(w.agents[0]!, 'GET', '/voice/answering')).status).not.toBe(200);
  });

  it('R-VOICE-20: enabling needs the Owner, a fresh re-auth and the exact attestation; an Admin cannot', async () => {
    const admin = await h.invite(w.owner, 'admin');
    await freshReauth(h, admin);
    expect((await call(admin, 'POST', '/voice/answering/enable', { attestation: VOICE_ATTESTATION_TEXT })).status).not.toBe(200);
    await staleReauth(h, w.owner);
    expect((await call(w.owner, 'POST', '/voice/answering/enable', { attestation: VOICE_ATTESTATION_TEXT })).code).toBe('REAUTH_REQUIRED');
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', '/voice/answering/enable', { attestation: 'I agree.' })).code).toBe('ATTESTATION_REQUIRED');
    const on = await call<View>(w.owner, 'POST', '/voice/answering/enable', { attestation: VOICE_ATTESTATION_TEXT });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ state: 'on', reasons: [], enabled: { on: true } });
    expect(on.body.enabled.sentence).toMatch(/^Attested by the Owner on \d{4}-\d{2}-\d{2}\.$/);
    const audits = (await h.su.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action IN ('policy.version_created','policy.activated','voice.answering_changed') ORDER BY occurred_at", [w.tenantId])).rows.map((r) => r.action);
    expect(audits).toEqual(['policy.version_created', 'policy.activated', 'voice.answering_changed']);
    const pol = (await h.su.query('SELECT cp.voice_answering_enabled, cp.voice_answering_attestation FROM tenant_settings s JOIN compliance_policy_versions cp ON cp.tenant_id = s.tenant_id AND cp.id = s.active_policy_id WHERE s.tenant_id = $1', [w.tenantId])).rows[0];
    expect(pol).toEqual({ voice_answering_enabled: true, voice_answering_attestation: VOICE_ATTESTATION_TEXT });
  });

  it('R-VOICE-20 O4: answer settings: narrowing is Owner or Admin; widening is the Owner with re-auth and the attestation; stale versions conflict', async () => {
    const admin = await h.invite(w.owner, 'admin');
    const cur = (await call<View>(w.owner, 'GET', '/voice/answering')).body.settings;
    const narrow = await call<View>(admin, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 30, answerWhen: 'after_hours_only', version: cur.version });
    expect(narrow.status).toBe(200);
    expect(narrow.body.settings).toMatchObject({ answerAfterSeconds: 30, answerWhen: 'after_hours_only' });
    const v = narrow.body.settings.version;
    expect((await call(admin, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 15, answerWhen: 'after_hours_only', version: v })).status).not.toBe(200);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 15, answerWhen: 'missed_and_after_hours', version: v })).code).toBe('ATTESTATION_REQUIRED');
    const wide = await call<View>(w.owner, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 20, answerWhen: 'missed_and_after_hours', version: v, attestation: VOICE_ATTESTATION_TEXT });
    expect(wide.status).toBe(200);
    expect((await call(w.owner, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 25, answerWhen: 'missed_and_after_hours', version: v })).code).toBe('VERSION_CONFLICT');
    expect((await call(w.owner, 'PUT', '/voice/answering/settings', { answerAfterSeconds: 5, answerWhen: 'missed_and_after_hours', version: wide.body.settings.version })).status).toBe(422);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'settings.changed' AND entity_type = 'tenant_settings'", [w.tenantId])).rows.length).toBeGreaterThanOrEqual(2);
  });

  it('R-VOICE-20: the policy copy carries every column of compliance_policy_versions (drift test against the catalog)', async () => {
    const cols = (await h.su.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'compliance_policy_versions'")).rows.map((r) => r.column_name).sort();
    expect([...POLICY_COPY_COLUMNS, ...POLICY_FRESH_COLUMNS].sort()).toEqual(cols);
  });

  it('R-AST-13 R-TEN-3: no response schema carries a confidence or a tenant id', () => {
    for (const s of [S.AnsweringResponse, S.CallVoiceResponse, S.TestCallResponse]) {
      const j = JSON.stringify(z.toJSONSchema(s));
      expect(j).not.toMatch(/confidence|tenant/i);
    }
  });

  it('O12: the test call simulates a scripted caller in memory and saves nothing but its audit row', async () => {
    const before = (await h.su.query('SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1', [w.tenantId])).rows[0].n;
    const r = await call<{ sentence: string; lines: { text: string }[]; handback: { outcome: string } }>(w.owner, 'POST', '/voice/test-call', { script: 'priceQuestion' });
    expect(r.status).toBe(200);
    expect(r.body.sentence).toBe(TEST_CALL_SENTENCE);
    expect(r.body.lines[0]!.text).toContain("team's automated assistant");
    expect(r.body.handback.outcome).toBe('message_taken');
    expect((await h.su.query('SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(before);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'voice.test_call'", [w.tenantId])).rows).toHaveLength(1);
    // another tenant's version, or a non-voice one, is 404
    const other = await voiceWorld(h, { enable: false });
    expect((await call(w.owner, 'POST', '/voice/test-call', { script: 'booking', versionId: other.playbookVersionId })).status).toBe(404);
    expect((await call(w.owner, 'POST', '/voice/test-call', { script: 'nope' })).status).not.toBe(200);
    expect((await call(w.agents[0]!, 'POST', '/voice/test-call', { script: 'booking' })).status).not.toBe(200);
  });
});

describe('E150 R-VOICE-9: turned off mid-call, the session finishes; new calls are refused; only the Owner turns it back on', () => {
  it('E150: a session in progress finishes with its handback after AI answering is turned off', async () => {
    const x = await voiceWorld(h);
    await h.su.query("UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59' WHERE tenant_id = $1", [x.tenantId]);
    setVoiceTestSeams(h.app.platform, { hotRuleFor: () => FIXTURE_HOT_RULE });
    const c = await aiCall(h, x, SCRIPTS.ownerNoAnswer, { faults: { idMap: { [OWNER_ID]: x.agents[0]!.userId! }, pauseOnHandOff: true }, settle: false });
    // the session is paused in the transfer hold: turn AI answering off now
    for (let i = 0; i < 200 && !h.providers.voiceAgent.transportOf(x.tenantId, c.callId)?.isHandedOff; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await call(x.owner, 'POST', '/voice/answering/disable', {})).status).toBe(200);
    h.providers.voiceAgent.transportOf(x.tenantId, c.callId)!.resume();
    const r = await settled(h, x.tenantId, c.callId);
    expect(r?.handback.outcome).toBeDefined();
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
    setVoiceTestSeams(h.app.platform, { hotRuleFor: () => null });
    // a new call is refused
    const next = await aiCall(h, x, null);
    expect((await h.su.query('SELECT handled_by, recording_decision FROM calls WHERE id = $1', [next.callId])).rows[0]).toMatchObject({ handled_by: 'voicemail', recording_decision: { voiceTakeover: { code: 'VOICE_ANSWERING_OFF' } } });
    // an Admin cannot turn it back on by re-activating the voice-on version
    const admin = await h.invite(x.owner, 'admin');
    const voiceOn = (await h.su.query('SELECT id FROM compliance_policy_versions WHERE tenant_id = $1 AND voice_answering_enabled ORDER BY version_no DESC LIMIT 1', [x.tenantId])).rows[0].id;
    await freshReauth(h, admin);
    const re = await call(admin, 'POST', `/compliance-policies/${voiceOn}/activate`, {});
    expect(re.status).not.toBe(200);
    expect((await h.su.query('SELECT cp.voice_answering_enabled AS on FROM tenant_settings s JOIN compliance_policy_versions cp ON cp.tenant_id = s.tenant_id AND cp.id = s.active_policy_id WHERE s.tenant_id = $1', [x.tenantId])).rows[0].on).toBe(false);
  });

  it('O14 E150: an Admin turning off an attested (loosened) policy is refused OWNER_REQUIRED, said plainly', async () => {
    const x = await voiceWorld(h, { enable: false });
    await freshReauth(h, x.owner);
    const loose = await call(x.owner, 'POST', '/compliance-policies', { recordingMode: 'one_party_where_permitted', attestation: ATTESTATION_TEXT, activate: true });
    expect(loose.status).toBe(201);
    expect((await call(x.owner, 'POST', '/voice/answering/enable', { attestation: VOICE_ATTESTATION_TEXT })).status).toBe(200);
    const admin = await h.invite(x.owner, 'admin');
    const r = await call<{ error: { details: { sentence: string } } }>(admin, 'POST', '/voice/answering/disable', {});
    expect(r.code).toBe('OWNER_REQUIRED');
    expect(r.body.error.details.sentence).toBe(OWNER_ONLY_DISABLE_SENTENCE);
    // the Owner can
    expect((await call<View>(x.owner, 'POST', '/voice/answering/disable', {})).body.enabled.on).toBe(false);
  });
});
