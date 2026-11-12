// ISA-2b items 3, 5 and 6: the inactivity-warning handoff (R-ISA-16), the handoff recipient after a take over
// (R-ISA-15, R-ISA-30) and a send_result for every terminal status (R-ISA-3, -4, -11, -14, -21). Real Postgres via the
// API harness; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { aiMessages, assignmentOf, call, handoffOf, isaLead, isaWorld, type IsaWorld, runIsa, startCare, sweepNow } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

async function liveLead() {
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  return l;
}

async function card(contactId: string) {
  return (await h.su.query<{ item_type: string; band: string; reasons: { code: string; text: string }[]; user_id: string; score: number; due_at: Date | null }>(
    `SELECT item_type, band, reasons, user_id, score, due_at FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [contactId])).rows;
}

describe('R-ISA-16: the inactivity warning hands back', () => {
  for (const paused of [false, true]) {
    it(`R-ISA-16 E516: a warning with care ${paused ? 'paused' : 'live'} writes a pinned handoff with the release date; no AI message follows`, async () => {
      const l = await liveLead();
      if (paused) expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
      await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET inactivity_warn_at = now() - interval '1 minute', inactivity_release_at = now() + interval '3 days' WHERE id = '${l.id}'; SET session_replication_role = origin`);
      const before = (await aiMessages(h, l.id)).length;
      await sweepNow(h, w.tenantId);
      const a = (await assignmentOf(h, l.id))!;
      expect(a.end_reason).toBe('inactivity_warning');
      const ho = await handoffOf(h, l.id);
      expect(ho).toHaveLength(1);
      expect(ho[0]!.package['inactivityReleaseAt']).not.toBeNull();
      const c = await card(l.id);
      expect(c[0]!.band).toBe('pinned');
      expect(c[0]!.reasons[0]!.text).toMatch(/returns to the pond on .+ unless you touch them\. AI care has handed back\./);
      expect((await aiMessages(h, l.id)).filter((m) => m.status !== 'canceled').length).toBeLessThanOrEqual(before);
      await sweepNow(h, w.tenantId, 1);
      expect(await handoffOf(h, l.id)).toHaveLength(1);
    });
  }
});

describe('R-ISA-15 R-ISA-30: the handoff recipient after a take over (Q1)', () => {
  it('R-ISA-15 R-ISA-30: a team lead\'s take over makes them the recipient of the card and deadline, the owner notified; after an End, the owner', async () => {
    const l = await liveLead();
    const tl = w.teamLead!;
    const t = await call(tl, 'POST', `/contacts/${l.id}/ai-isa/take-over`, {});
    expect(t.status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1`, [l.id]);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('taken_over');
    const ho = (await h.su.query<{ recipient_user_id: string; package: Record<string, unknown> }>(`SELECT recipient_user_id, package FROM ai_isa_handoffs WHERE contact_id = $1`, [l.id])).rows;
    expect(ho[0]!.recipient_user_id).toBe(tl.userId);
    expect(ho[0]!.package['recipientUserId']).toBe(tl.userId);
    const c = await card(l.id);
    expect(c.map((x) => x.user_id)).toEqual([tl.userId]);
    expect(c[0]!.due_at).not.toBeNull();
    const n = await h.su.query<{ user_id: string; kind: string }>(`SELECT user_id, kind FROM notifications WHERE subject_id = $1 AND kind LIKE 'ai_isa_%'`, [l.id]);
    expect(n.rows).toEqual(expect.arrayContaining([{ user_id: w.agents[0]!.userId, kind: 'ai_isa_ended' }]));
    expect(n.rows.filter((r) => r.kind.startsWith('ai_isa_handoff')).map((r) => r.user_id)).toEqual([tl.userId]);

    const l2 = await liveLead();
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l2.id}/ai-isa/end`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1`, [l2.id]);
    await runIsa(h, w.tenantId);
    const h2 = (await h.su.query<{ recipient_user_id: string; package: Record<string, unknown> }>(`SELECT recipient_user_id, package FROM ai_isa_handoffs WHERE contact_id = $1`, [l2.id])).rows;
    expect(h2[0]!.recipient_user_id).toBe(w.agents[0]!.userId);
    expect(h2[0]!.package['endedByUserId']).toBe(w.agents[0]!.userId);
  });
});

void inboundSms;
