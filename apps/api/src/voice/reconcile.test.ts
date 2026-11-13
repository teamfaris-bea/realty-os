// Module 48 item 8: voice.reconcile (R-VOICE-7, R-VOICE-21). A runner lost mid-call gives one recovery handback
// and one P1; a re-run writes nothing.
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { Alert } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { makeVoiceHandlers } from './handlers.js';
import { type VoiceWorld, aiCall, callRowOf, handbacksOf, setVoicePack, settled, voiceWorld, waitFor } from './testing.js';
import { SCRIPT_EVENTS as ev } from '@realty/core/voice/testing';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
});
afterAll(async () => {
  await h?.close();
});

async function runReconcile(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const [handler] = makeVoiceHandlers(() => ({ ids: h.app.platform.ids, envelope: h.app.platform.envelope })) as unknown as [{ run: (ctx: unknown) => Promise<void> }];
  const actor = systemActor(w.tenantId, 'provider');
  await handler.run({ actor, now: Date.now(), providers: h.providers, job: { id: 1n, kind: 'voice.reconcile', queue: 'default', attempts: 1 }, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, alerts: { raise: (a: Alert) => alerts.push(a) }, withTx: (fn: never) => withTenantTx(actor, fn, { db: h.database }) });
  return alerts;
}

describe('R-VOICE-21 R-VOICE-7: voice.reconcile recovers a lost session', () => {
  it('R-VOICE-21: a session lost mid-call gets one recovery handback and one P1; a re-run and the late session itself write nothing more', async () => {
    const c = await aiCall(h, w, { name: 'stuck', steps: [ev.disclosed(4000), ev.announced(7000)] }, { faults: { holdBeforeStep: 2 }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the paused session');
    expect(await runReconcile()).toEqual([]); // not lost yet
    // the process running it died long ago: the call ended 11 minutes ago with no handback
    await h.su.query("UPDATE calls SET ended_at = now() - interval '11 minutes' WHERE id = $1", [c.callId]);
    const alerts = await runReconcile();
    expect(alerts).toEqual([expect.objectContaining({ severity: 'P1', code: 'WORKER_ERROR', details: { reason: 'VOICE_HANDBACK_MISSING', count: 1 } })]);
    const hb = await handbacksOf(h, c.callId);
    expect(hb).toHaveLength(1);
    expect(hb[0].payload.voice).toMatchObject({ outcome: 'error', endReason: 'SESSION_LOST', recovered: true });
    expect(await callRowOf(h, c.callSid)).toMatchObject({ voice_outcome: 'error', handback_action_id: hb[0].id });
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE action = 'voice.handback_recovered' AND entity_id = $1", [c.callId])).rows).toHaveLength(1);
    expect((await h.su.query('SELECT priority FROM notifications WHERE subject_id = $1', [hb[0].id])).rows.map((x) => x.priority)).toEqual(['critical']);
    expect(await runReconcile()).toEqual([]);
    h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!.resume();
    await settled(h, w.tenantId, c.callId);
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });

  it('R-VOICE-21: the pass reads the partial index (plain columns, FORCE RLS-safe)', async () => {
    const idx = (await h.su.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'calls_voice_handback_missing'")).rows[0];
    expect(idx.indexdef).toContain("WHERE ((handled_by = 'assistant'::text) AND (handback_action_id IS NULL))");
  });
});
