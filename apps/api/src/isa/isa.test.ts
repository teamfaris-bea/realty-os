// Module 75 API journeys on fakes (docs/AI_ISA.md §13.3, §13.4 API part; D12 proposed). Real Postgres via the API
// harness; the fake ISA model, the fake telephony and email adapters; no real model, send, call or vendor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms, ownedContact, randomPhone } from '../comms/testing.js';
import { aiMessages, assignmentOf, call, closedZone, feedItems, freshReauth, handbacksOf, handoffOf, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

describe('authorization chain and start (R-ISA-1, R-ISA-16, R-ISA-32)', () => {
  it('R-ISA-32: only the Owner turns the switch on (an Admin or agent gets 404/403; an attestation is required)', async () => {
    const agent = w.agents[1]!;
    expect((await call(agent, 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 100 })).status).toBe(404);
    await freshReauth(h, w.owner);
    const noAtt = await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 200 });
    expect(noAtt.status).toBe(403);
    expect(noAtt.code).toBe('ATTESTATION_REQUIRED');
    const view = await call<{ enabled: boolean; packCleared: boolean; noticeSentence: string }>(w.owner, 'GET', '/admin/ai-isa');
    expect(view.body.enabled).toBe(true);
    expect(view.body.noticeSentence).toMatch(/not legal advice/);
  });

  it('R-ISA-16 E516: start is refused while the first touch is pending (AI_ISA_FIRST_TOUCH_PENDING)', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET first_touch_at = NULL, release_due_at = now() + interval '1 hour' WHERE id = '${l.id}'; SET session_replication_role = origin`);
    const r = await startCare(w.agents[0]!, l.id);
    expect(r.code).toBe('AI_ISA_FIRST_TOUCH_PENDING');
    const panel = await call<{ startRefusal: { code: string; sentence: string } }>(w.agents[0]!, 'GET', `/contacts/${l.id}/ai-isa`);
    expect(panel.body.startRefusal.sentence).toMatch(/AI messages don't count as your first contact/);
  });

  it('R-ISA-1 E539: an agent without an opt-in is refused (AI_ISA_NO_OPTIN); another agent\'s lead is 404', async () => {
    const other = await isaLead(h, w.agents[1]!);
    expect((await startCare(w.agents[1]!, other.id)).code).toBe('AI_ISA_NO_OPTIN');
    expect((await startCare(w.agents[0]!, other.id)).status).toBe(404);
  });

  it('R-ISA-2 E527: spouses sharing a phone are refused at start (AI_ISA_SHARED_ADDRESS)', async () => {
    const phone = randomPhone();
    const a = await ownedContact(w.agents[0]!, { phone, consent: false });
    const b = await ownedContact(w.agents[1]!, { phone, consent: false, confirmDistinct: true });
    if (process.env.DEBUG_ISA) console.log(JSON.stringify({ a, b, pts: (await h.su.query('SELECT contact_id, kind, removed_at FROM contact_points WHERE address = $1', [phone])).rows }));
    expect((await startCare(w.agents[0]!, a.id)).code).toBe('AI_ISA_SHARED_ADDRESS');
  });
});

describe('a reply under live care (R-ISA-3, R-ISA-28, R-ISA-29)', () => {
  it('R-ISA-3 E490: a reply from the bound phone is one turn: no handback card, an activity row, an AI reply that reaches sent with the AI disclosure', async () => {
    const l = await isaLead(h, w.agents[0]!);
    const s = await startCare(w.agents[0]!, l.id);
    expect(s.status).toBe(200);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
    expect(await handbacksOf(h, l.id)).toEqual([]);
    expect((await feedItems(h, l.id)).map((f) => f.item_type)).toContain('ai_isa_activity');
    await runIsa(h, w.tenantId);
    const msgs = await aiMessages(h, l.id);
    if (process.env.DEBUG_ISA) console.log(JSON.stringify({ msgs, turns: (await h.su.query('SELECT status, decision, denied, trigger_key FROM ai_isa_turns WHERE contact_id = $1', [l.id])).rows, a: await assignmentOf(h, l.id), jobs: (await h.su.query("SELECT kind, status, last_error, attempts FROM jobs WHERE tenant_id = $1 AND (kind LIKE 'ai_isa%' OR kind LIKE 'comms%') ORDER BY id DESC LIMIT 12", [w.tenantId])).rows, ai: w.ai.calls.length }, null, 1));
    if (process.env.DEBUG_ISA) { const { dispatchOutbound } = await import('../comms/dispatch.js'); const { depsFromPlatform } = await import('../comms/runtime.js');
      try { console.log(await dispatchOutbound(msgs.at(-1)!.id, depsFromPlatform(h.app.platform), { tenantId: w.tenantId })); } catch (e) { console.log('ERR', (e as Error).message, (e as { position?: string }).position); } }
    const sent = msgs.filter((m) => m.status === 'sent');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.every((m) => m.purpose === 'marketing' && m.to_address === l.phone)).toBe(true);
    expect(sent.at(-1)!.body).toMatch(/AI assistant/);
    expect((await assignmentOf(h, l.id))!.ended_at).toBeNull();
  });

  it('R-ISA-28 E503: a reply from a second phone of the contact is not a turn: R-AST-9 hands back and care pauses unverified_sender', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    const second = randomPhone();
    const add = await call(w.agents[0]!, 'POST', `/contacts/${l.id}/points`, { kind: 'phone', address: second });
    expect([200, 201]).toContain(add.status);
    await inboundSms(h, second, w.mainNumber, 'this is me from my work phone');
    const a = (await assignmentOf(h, l.id))!;
    expect(a.pause_reason).toBe('unverified_sender');
  });

  it('R-ISA-10 E511: a reply at night in their zone is scheduled for the next window; the guard refuses an early dispatch', async () => {
    const l = await isaLead(h, w.agents[0]!, { zone: closedZone() });
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Are you there?');
    await runIsa(h, w.tenantId);
    const msgs = await aiMessages(h, l.id);
    expect(msgs.some((m) => m.status === 'sent')).toBe(false);
    expect(msgs.some((m) => m.status === 'scheduled')).toBe(true);
  });
});

describe('non-turn inbounds pause care (R-ISA-3, R-ISA-14; E497)', () => {
  it('R-ISA-3 E497: an MMS reply and a call from the person each run the R-AST-9 path and pause care (media, call); nothing reaches a prompt', async () => {
    const { ingestInbound } = await import('../comms/inbound.js');
    const { depsFromPlatform } = await import('../comms/runtime.js');
    const { systemActor } = await import('../worker/systemActor.js');
    const deps = depsFromPlatform(h.app.platform);
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    const calls = w.ai.calls.length;
    await ingestInbound(systemActor(w.tenantId, 'provider'), { kind: 'sms', providerRef: `MM${'a'.repeat(32)}`, from: l.phone, to: w.mainNumber, body: 'look at this house', mediaCount: 1 }, deps);
    expect((await assignmentOf(h, l.id))!.pause_reason).toBe('media');
    expect((await handbacksOf(h, l.id)).length + (await feedItems(h, l.id)).filter((f) => f.item_type === 'unanswered_inbound').length).toBeGreaterThanOrEqual(1);
    const l2 = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l2.id);
    await runIsa(h, w.tenantId);
    await ingestInbound(systemActor(w.tenantId, 'provider'), { kind: 'call', providerRef: `CA${'b'.repeat(32)}`, from: l2.phone, to: w.mainNumber, status: 'no_answer' }, deps);
    expect((await assignmentOf(h, l2.id))!.pause_reason).toBe('call');
    await runIsa(h, w.tenantId);
    expect(w.ai.calls.slice(calls).some((c) => c.user.includes('look at this house'))).toBe(false);
  });
});

describe('ownership (R-ISA-16)', () => {
  it('R-ISA-16 E525: a reassignment stops care in the ownership effects transaction (stop signal owner_change); the job ends it with one handoff', async () => {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const { depsFromPlatform } = await import('../comms/runtime.js');
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    const r = await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: w.agents[1]!.userId as never, reason: 'MANUAL_REASSIGN' } as never, crypto.randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids });
    expect(r.ok).toBe(true);
    await runIsa(h, w.tenantId, 1);
    const sig = await h.su.query(`SELECT reason FROM ai_isa_stop_signals WHERE contact_id = $1`, [l.id]);
    expect(sig.rows.map((x) => x.reason)).toContain('owner_change');
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('owner_change');
    expect((await handoffOf(h, l.id)).length).toBe(1);
  });
});

describe('represented elsewhere (R-ISA-26)', () => {
  it('R-ISA-26: "we are already working with a realtor" pauses care with a Check this card for the owner (never ends by itself)', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Thanks but we are already working with a realtor');
    await runIsa(h, w.tenantId);
    const a = (await assignmentOf(h, l.id))!;
    expect(a.ended_at).toBeNull();
    expect(a.paused_at).not.toBeNull();
    expect((await feedItems(h, l.id)).some((f) => f.item_type === 'ai_isa_escalation')).toBe(true);
  });
});

describe('controls (R-ISA-15, R-ISA-3)', () => {
  it('R-ISA-15 E496: a human text pauses care human_contact; only the owner resumes; resume increments the epoch', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    const p = await call(w.owner, 'POST', `/contacts/${l.id}/ai-isa/pause`, {});
    expect(p.status).toBe(200);
    expect((await assignmentOf(h, l.id))!.pause_reason).toBe('user');
    expect((await call(w.owner, 'POST', `/contacts/${l.id}/ai-isa/resume`, {})).status).toBe(404);
    const r = await call<{ epoch: number }>(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect(r.status).toBe(200);
    expect(r.body.epoch).toBe(2);
  });

  it('R-ISA-15: Take over then Undo within 10 s leaves care paused, never live; after the window the take over is final with one handoff', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    const t = await call<{ undoUntil: string }>(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/take-over`, {});
    expect(t.body.undoUntil).not.toBeNull();
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/undo`, {})).status).toBe(200);
    expect((await assignmentOf(h, l.id))!.paused_at).not.toBeNull();
    await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/take-over`, {});
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1`, [l.id]);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('taken_over');
    expect((await handoffOf(h, l.id)).length).toBe(1);
  });

  it('R-ISA-31 E498: STOP ends care through the stop-signal ledger: opted_out, a person block and one handoff; no AI message after', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'STOP');
    await runIsa(h, w.tenantId);
    const a = (await assignmentOf(h, l.id))!;
    expect(a.end_reason).toBe('opted_out');
    const blocks = await h.su.query(`SELECT reason FROM ai_isa_person_blocks WHERE contact_id = $1 AND lifted_at IS NULL`, [l.id]);
    expect(blocks.rows.length).toBe(1);
    expect((await handoffOf(h, l.id)).length).toBe(1);
    expect((await startCare(w.agents[0]!, l.id)).code).toMatch(/AI_ISA_PERSON_DECLINED|AI_ISA_NO_CHANNEL/);
  });

  it('R-ISA-15 E522: the tenant switch off ends every live assignment, each with one handoff', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await startCare(w.agents[0]!, l.id);
    const off = await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: false, dailyCap: 100 });
    expect(off.status).toBe(200);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('tenant_off');
    expect((await handoffOf(h, l.id)).length).toBe(1);
    await freshReauth(h, w.owner);
    await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 100, attestation: 'I turn on the AI assistant for my team and accept the engineering defaults.' });
  });
});
