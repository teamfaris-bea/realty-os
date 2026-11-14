// GET /ai-isa/handoffs/:id (ISA-4; R-ISA-14, R-PERM-5, R-AST-13): the full package, read-only. Real Postgres through
// the API harness; the fake ISA model and fake telephony only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { call, handoffOf, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from '../isa/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { HandoffPackage, HandoffView, webPackage } from './routes.js';

let h: ApiHarness;
let w: IsaWorld;
let other: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  other = await isaWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function humanRequestHandoff() {
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  await inboundSms(h, l.phone, w.mainNumber, 'AGENT');
  await runIsa(h, w.tenantId);
  const rows = await handoffOf(h, l.id);
  expect(rows.length).toBe(1);
  return { lead: l, handoffId: rows[0]!.id, reason: rows[0]!.reason };
}

type View = { id: string; contactId: string; reason: string; canAcknowledge: boolean; createdAt: string; slaDueAt: string; package: Record<string, unknown>; pendingMessage: { kind: string } | null };

describe('GET /ai-isa/handoffs/:id (R-ISA-14)', () => {
  it('R-ISA-14: the owner reads the package after a human_request end; instants are ISO strings; the conversation keeps seq, status and messageId only', async () => {
    const { lead, handoffId, reason } = await humanRequestHandoff();
    expect(reason).toBe('escalated');
    const r = await call<View>(w.agents[0]!, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(r.status).toBe(200);
    expect(r.body.contactId).toBe(lead.id);
    expect(HandoffView.safeParse(r.body).success).toBe(true);
    expect(r.body.package.escalation).toBe('human_request');
    expect(typeof r.body.package.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(r.body.package.startedAt as string))).toBe(false);
    const conv = r.body.package.conversation as Record<string, unknown>[];
    expect(conv.length).toBeGreaterThan(0);
    for (const t of conv) expect(Object.keys(t).sort()).toEqual(['messageId', 'seq', 'status']);
    expect(r.body.canAcknowledge).toBe(true);
    // batch 13 isa-4 F6: ISA-2b's keys arrive in a real package and are typed by the response schema
    expect(Object.keys(r.body.package)).toEqual(expect.arrayContaining(['appointmentDetail', 'savedSearch', 'recipientUserId', 'endedByUserId', 'inactivityReleaseAt']));
    expect(r.body.package.recipientUserId).toBe(w.agents[0]!.userId);
    expect(Object.keys(HandoffPackage.shape)).toEqual(expect.arrayContaining(['appointmentDetail', 'savedSearch', 'recipientUserId', 'endedByUserId', 'inactivityReleaseAt']));
  });

  it('R-PERM-5 E539: an outside agent, another tenant and a TC all get 404, and so does a forged id', async () => {
    const { handoffId } = await humanRequestHandoff();
    expect((await call(w.agents[1]!, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
    expect((await call(other.owner, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'GET', '/ai-isa/handoffs/01900000-0000-7000-8000-00000000dead')).status).toBe(404);
    const tc = await h.invite(w.owner, 'tc');
    expect((await call(tc, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
  });

  it('E521 V8: canAcknowledge holds for the recipient and Owner/Admin and is false for a team lead who is not the recipient (0080 isa_update)', async () => {
    const { handoffId } = await humanRequestHandoff();
    expect((await call<View>(w.owner, 'GET', `/ai-isa/handoffs/${handoffId}`)).body.canAcknowledge).toBe(true);
    const tl = await call<View>(w.teamLead!, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(tl.status).toBe(200);
    expect(tl.body.canAcknowledge).toBe(false);
    // and the ack route agrees: the TL's UPDATE matches no row
    expect((await call(w.teamLead!, 'POST', `/ai-isa/handoffs/${handoffId}/ack`, {})).status).toBe(404);
  });

  it('E521 V8 (batch 13 isa-4 F14): a recipient the ack route would refuse (an agent who now only collaborates on the lead) gets canAcknowledge false, matching the 404', async () => {
    const { lead, handoffId } = await humanRequestHandoff();
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    // the lead moves to another agent through the ownership engine; the earlier owner stays the handoff's recipient and
    // is added as a collaborator, so the handoff is still visible to them (ai_isa.view: own or collaborator)
    expect((await runOwnershipCommand(w.owner.actor(), lead.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids })).ok).toBe(true);
    expect((await call(a1, 'POST', `/contacts/${lead.id}/collaborators`, { userId: a0.userId })).status).toBe(200);
    const v = await call<View & { recipientUserId: string | null }>(a0, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.recipientUserId).toBe(a0.userId);
    expect((await call(a0, 'POST', `/ai-isa/handoffs/${handoffId}/ack`, {})).status).toBe(404);
    expect(v.body.canAcknowledge).toBe(false);
    // the new owner is not the recipient, but is the current owner of the record (0081 isa_update; b13 review F3): the
    // button shows and the ack succeeds; the Owner may too
    expect((await call<View>(w.owner, 'GET', `/ai-isa/handoffs/${handoffId}`)).body.canAcknowledge).toBe(true);
    expect((await call<View>(a1, 'GET', `/ai-isa/handoffs/${handoffId}`)).body.canAcknowledge).toBe(true);
    expect((await call(a1, 'POST', `/ai-isa/handoffs/${handoffId}/ack`, {})).status).toBe(200);
  });

  it('R-OWN-24 E526 (b13 review F2): after a merge, the survivor\'s agent reads a handoff written on the merged-away record (authorized on the root survivor, as the ack route and the panel); an outside agent still gets 404', async () => {
    const agent = w.agents[0]!;
    const { lead: loser, handoffId } = await humanRequestHandoff();
    const survivor = await isaLead(h, agent);
    const before = await call<View>(agent, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(before.status).toBe(200);
    const { command } = await import('../leads/testing.js');
    expect((await command(w.owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: agent.userId })).status).toBe(200);
    await runIsa(h, w.tenantId);
    const after = await call<View>(agent, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(after.status).toBe(200);
    expect(after.body.id).toBe(handoffId);
    expect(after.body.canAcknowledge).toBe(true);
    expect((await call(w.agents[1]!, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
    expect((await call(agent, 'POST', `/ai-isa/handoffs/${handoffId}/ack`, {})).status).toBe(200);
  });

  it('E521 V8 (b13 review F3): after an owner change and back, the root\'s current owner (0081 isa_update) gets canAcknowledge true and the ack succeeds; the former recipient, no longer on the lead, gets 404', async () => {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const { optInAgent } = await import('../isa/testing.js');
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    await optInAgent(h, a1, w.versionId).catch(() => undefined);
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const ids = depsFromPlatform(h.app.platform).ids;
    expect((await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids })).ok).toBe(true);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffOf(h, l.id);
    expect(ho).toMatchObject({ reason: 'owner_change' });
    expect((await h.su.query<{ r: string }>(`SELECT recipient_user_id AS r FROM ai_isa_handoffs WHERE id = $1`, [ho!.id])).rows[0]!.r).toBe(a1.userId);
    expect((await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a0.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids })).ok).toBe(true);
    await runIsa(h, w.tenantId, 1);
    const g0 = await call<View & { recipientUserId: string }>(a0, 'GET', `/ai-isa/handoffs/${ho!.id}`);
    expect([g0.status, g0.body.canAcknowledge, g0.body.recipientUserId]).toEqual([200, true, a1.userId]);
    expect((await call(a1, 'GET', `/ai-isa/handoffs/${ho!.id}`)).status).toBe(404);
    expect((await call(a0, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {})).status).toBe(200);
  });

  it('E521 R-ISA-30 (batch 13 merge, 0081 B12X-2): a handoff with no deadline (sla_class none) reads as such and is never overdue', async () => {
    const { handoffId } = await humanRequestHandoff();
    // as handoff.ts writes it when D1 leaves no human channel: due at creation, never escalated (0081's CHECK)
    const c = await h.su.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE ai_isa_handoffs SET sla_class = 'none', sla_due_at = created_at, sla_escalation_level = 0 WHERE id = $1`, [handoffId]);
    } finally {
      await c.query('SET session_replication_role = origin');
      c.release();
    }
    const r = await call<View & { slaClass: string; overdue: boolean }>(w.agents[0]!, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(r.status).toBe(200);
    expect(r.body.slaClass).toBe('none');
    expect(r.body.overdue).toBe(false);
    expect(HandoffView.safeParse(r.body).success).toBe(true);
  });

  it('E533: pendingMessage.kind comes from the message category', async () => {
    const { handoffId } = await humanRequestHandoff();
    const row = (await h.su.query<{ pending_message_id: string | null }>(`SELECT pending_message_id FROM ai_isa_handoffs WHERE id = $1`, [handoffId])).rows[0]!;
    const r = await call<View>(w.agents[0]!, 'GET', `/ai-isa/handoffs/${handoffId}`);
    if (row.pending_message_id === null) {
      expect(r.body.pendingMessage).toBeNull();
    } else {
      const cat = (await h.su.query<{ c: string }>(`SELECT action_category AS c FROM messages WHERE id = $1`, [row.pending_message_id])).rows[0]!.c;
      expect(r.body.pendingMessage!.kind).toBe(cat === 'ai_isa_confirmation' ? 'confirmation' : 'holding_line');
    }
  });

  it('E533 (b14 to-do, b13 review F8-ui low): the panel\'s handoff says what its pending message is (a holding line here), so the web never words a holding line as a confirmation', async () => {
    const { lead, handoffId } = await humanRequestHandoff();
    const row = (await h.su.query<{ pending_message_id: string | null; confirmation_status: string }>(`SELECT pending_message_id, confirmation_status FROM ai_isa_handoffs WHERE id = $1`, [handoffId])).rows[0]!;
    expect(row.pending_message_id).not.toBeNull();
    expect((await h.su.query<{ c: string }>(`SELECT action_category AS c FROM messages WHERE id = $1`, [row.pending_message_id])).rows[0]!.c).toBe('ai_isa_holding_line');
    const p = await call<{ handoff: { id: string; confirmationStatus: string; pendingKind?: string | null } | null }>(w.agents[0]!, 'GET', `/contacts/${lead.id}/ai-isa`);
    expect(p.body.handoff).toMatchObject({ id: handoffId, confirmationStatus: row.confirmation_status, pendingKind: 'holding_line' });
  });

  it('R-AST-13 R-TEN-3: no confidence, score or tenant key in the response schema, and the package drops them at any depth', () => {
    const keys = JSON.stringify(Object.keys(HandoffView.shape));
    expect(keys).not.toMatch(/confidence|score|tenant/i);
    const p = webPackage({ startedAt: 1_700_000_000_000, tenantId: 'x', claims: [{ claimId: 'c', confidence: 0.9, field: 'f', value: 1, quote: 'q', messageId: 'm' }], conversation: [{ seq: 1, status: 'sent', decision: { a: 1 }, denied: ['X:y'], messageId: null, score: 3 }] }) as Record<string, unknown>;
    expect(JSON.stringify(p)).not.toMatch(/confidence|score|tenant/i);
    expect(p.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(p.conversation).toEqual([{ seq: 1, status: 'sent', messageId: null }]);
  });

  it('the route declares ai_isa.view and carries authorize(ai_isa.view); it is read-only (GET only, no audit)', () => {
    const e = h.app.platform.routeTable.find((x) => x.method === 'GET' && x.url === '/api/ai-isa/handoffs/:id');
    expect(e).toBeDefined();
    expect(e!.auth).toBe('ai_isa.view');
    expect(e!.authorizes).toBe('ai_isa.view');
    expect(h.app.platform.routeTable.filter((x) => x.url === '/api/ai-isa/handoffs/:id').map((x) => x.method).filter((m) => m !== 'HEAD')).toEqual(['GET']);
  });
});
