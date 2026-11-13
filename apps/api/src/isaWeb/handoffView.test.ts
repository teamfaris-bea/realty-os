// GET /ai-isa/handoffs/:id (ISA-4; R-ISA-14, R-PERM-5, R-AST-13): the full package, read-only. Real Postgres through
// the API harness; the fake ISA model and fake telephony only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { call, handoffOf, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from '../isa/testing.js';
import { HandoffView, webPackage } from './routes.js';

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
  });

  it('R-PERM-5 E539: an outside agent, another tenant and a TC all get 404, and so does a forged id', async () => {
    const { handoffId } = await humanRequestHandoff();
    expect((await call(w.agents[1]!, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
    expect((await call(other.owner, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'GET', '/ai-isa/handoffs/01900000-0000-7000-8000-00000000dead')).status).toBe(404);
    const tc = await h.invite(w.owner, 'tc');
    expect((await call(tc, 'GET', `/ai-isa/handoffs/${handoffId}`)).status).toBe(404);
  });

  it('E521 V8: canAcknowledge holds for the recipient and Owner/Admin and is false for a team lead who is not the recipient (0190:627)', async () => {
    const { handoffId } = await humanRequestHandoff();
    expect((await call<View>(w.owner, 'GET', `/ai-isa/handoffs/${handoffId}`)).body.canAcknowledge).toBe(true);
    const tl = await call<View>(w.teamLead!, 'GET', `/ai-isa/handoffs/${handoffId}`);
    expect(tl.status).toBe(200);
    expect(tl.body.canAcknowledge).toBe(false);
    // and the ack route agrees: the TL's UPDATE matches no row
    expect((await call(w.teamLead!, 'POST', `/ai-isa/handoffs/${handoffId}/ack`, {})).status).toBe(404);
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
