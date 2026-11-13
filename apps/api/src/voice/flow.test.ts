// Module 48 end to end: webhooks → takeover → session against FakeVoiceAgent → one handback (real Postgres).
import { SCRIPTS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type VoiceWorld, aiCall, callRowOf, handbacksOf, ledgerOf, setVoicePack, voiceWorld } from './testing.js';

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

describe('smoke', () => {
  it('R-VOICE-7: booking script ends in one handback', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    expect(c.ringTwiml).toContain('timeout="20"');
    expect(c.answer).toContain('fake-voice://session/');
    const row = await callRowOf(h, c.callSid);
    console.log(row.handled_by, row.voice_outcome, row.status, row.answered_at, row.ai_disclosed_at);
    console.log(await ledgerOf(h, c.callId));
    console.log(JSON.stringify(h.providers.voiceAgent.sessions.at(-1)!.says.map((x) => x.text)));
    const hb = await handbacksOf(h, c.callId);
    console.log(JSON.stringify(hb.map((x) => x.payload)));
    expect(hb).toHaveLength(1);
  });
});

describe('b12 review F5: a merge during an AI-answered call (R-OWN-24, R-VOICE handback; E526)', () => {
  it('R-OWN-24: the record is merged while the AI is on the call: the booked appointment, the handback and its card land on the survivor with the call', async () => {
    const { command } = await import('../leads/testing.js');
    const { ownedContact } = await import('../comms/testing.js');
    const { settled, waitFor } = await import('./testing.js');
    const survivor = await ownedContact(w.agents[0]!, { consent: false });
    const c = await aiCall(h, w, SCRIPTS.booking, { faults: { holdBeforeStep: 3 }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the paused session');
    const m = await command(w.owner, survivor.id, 'merge', { loserId: c.contactId, ownerChoice: w.agents[0]!.userId });
    expect(m.status).toBe(200);
    h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!.resume();
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.appointmentId).toBeTruthy();
    const ids = [c.contactId, survivor.id];
    expect((await h.su.query(`SELECT contact_id FROM calls WHERE id = $1`, [c.callId])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id FROM assistant_actions WHERE kind = 'handback' AND payload ->> 'inboundCallId' = $1`, [c.callId])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id FROM appointments WHERE contact_id = ANY($1::uuid[]) AND created_by_kind = 'assistant'`, [ids])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id, state FROM priority_feed_items WHERE contact_id = ANY($1::uuid[]) AND item_type = 'handback'`, [ids])).rows).toEqual([{ contact_id: survivor.id, state: 'open' }]);
  });
});

describe('b12 recheck R3: a merge in flight when the handback or the booking starts (R-OWN-24, R-VOICE handback; E526)', () => {
  /**
   * Two real transactions: the merge takes both contact locks, re-points the merged-away record (its appointments move
   * with it, 0072) and then waits on the merged-away record's conversation row, which this test holds. So it is in
   * flight, holding the merged-away record's lock, while the handback or the booking starts; then it commits.
   */
  async function mergeInFlight(survivorId: string, loserId: string, during: () => Promise<unknown>) {
    const { command } = await import('../leads/testing.js');
    await h.su.query(`INSERT INTO conversations (tenant_id, id, contact_id) SELECT tenant_id, gen_random_uuid(), id FROM contacts c
      WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = c.id)`, [loserId]);
    const blocker = await h.su.connect();
    try {
      await blocker.query('BEGIN');
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      expect((await blocker.query('SELECT 1 FROM conversations WHERE contact_id = $1 FOR UPDATE', [loserId])).rows).toHaveLength(1);
      const merge = command(w.owner, survivorId, 'merge', { loserId, ownerChoice: w.agents[0]!.userId });
      const blockedBy = async (p: number) => (await h.su.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))', [p])).rows.map((r) => r.pid);
      let mergePid: number | undefined;
      for (let i = 0; i < 500 && mergePid === undefined; i++) {
        mergePid = (await blockedBy(pid))[0];
        if (mergePid === undefined) await new Promise((r) => setTimeout(r, 10));
      }
      expect(mergePid, 'the merge waits on the held conversation row').toBeDefined();
      // the merge holds the contact locks and has re-pointed the record: the other transaction starts now and either
      // finishes or waits behind the merge
      let done = false;
      const other = during().finally(() => { done = true; });
      for (let i = 0; i < 500 && !done && (await blockedBy(mergePid!)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      await blocker.query('COMMIT');
      expect((await merge).status).toBe(200);
      return await other;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  }

  it('R-OWN-24: the handback of an AI call whose record a merge holds when it starts lands, with its card, on the survivor', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { SCRIPT_EVENTS: ev } = await import('@realty/core/voice/testing');
    const { writeHandback } = await import('./handback.js');
    const { recoveryHandback } = await import('./handlers.js');
    const { systemActor } = await import('../worker/systemActor.js');
    const survivor = await ownedContact(w.agents[0]!, { consent: false });
    const c = await aiCall(h, w, { name: 'stuck', steps: [ev.disclosed(4000), ev.announced(7000)] }, { faults: { freezeBeforeStep: 2 }, settle: false });
    const { waitFor, settled } = await import('./testing.js');
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the frozen session');
    const handback = recoveryHandback({ id: c.callId, contact_id: c.contactId, voice_outcome: null, transfer_outcome: null, owner_user_id: w.agents[0]!.userId, voice_playbook_version_id: null });
    const r = await mergeInFlight(survivor.id, c.contactId, () => writeHandback(systemActor(w.tenantId, 'provider'), { db: h.database, ids: h.app.platform.ids, envelope: h.app.platform.envelope }, {
      tenantId: w.tenantId, callId: c.callId, contactId: c.contactId, handback, appointmentId: null, bookingFailureCode: null, unlogged: [], spokeBeforeProcessing: 0,
      providerKind: 'fake', playbookVersionId: null, recovered: true, at: Date.now() as never,
    }));
    expect(r).toBeTruthy();
    const ids = [c.contactId, survivor.id];
    expect((await h.su.query(`SELECT contact_id FROM assistant_actions WHERE kind = 'handback' AND payload ->> 'inboundCallId' = $1`, [c.callId])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT DISTINCT contact_id FROM priority_feed_items WHERE contact_id = ANY($1::uuid[]) AND item_type = 'handback' AND state = 'open'`, [ids])).rows).toEqual([{ contact_id: survivor.id }]);
    h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!.resume();
    await settled(h, w.tenantId, c.callId);
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });

  it('R-OWN-24: a booking of a record a merge holds when it starts lands on the survivor', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { bookSlot } = await import('../calendar/service.js');
    const { voiceDeps } = await import('./runtime.js');
    const survivor = await ownedContact(w.agents[0]!, { consent: false });
    const loser = await ownedContact(w.agents[0]!, { consent: false });
    const start = Math.ceil((Date.now() + 9 * 86_400_000) / 1_800_000) * 1_800_000;
    const r = await mergeInFlight(survivor.id, loser.id, () => bookSlot(voiceDeps(h.app.platform).calendar, w.tenantId, {
      userId: w.agents[0]!.userId!, contactId: loser.id, kind: 'consult', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 1_800_000).toISOString(), createdByKind: 'assistant',
    }));
    expect(r).toMatchObject({ ok: true });
    const id = (r as { appointmentId: string }).appointmentId;
    expect((await h.su.query(`SELECT contact_id FROM appointments WHERE id = $1`, [id])).rows).toEqual([{ contact_id: survivor.id }]);
  });
});
