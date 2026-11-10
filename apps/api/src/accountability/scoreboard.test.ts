// Scoreboard and momentum over real Postgres (BUILD_PLAN module 15; R-ACC-4, R-ACC-5, R-AST-15,
// R-IMPORT-6, R-PERM-5). Numbers are read through the real server as each role.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestClient } from '../auth/testHarness.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { grantConsent, ownedContact } from '../comms/testing.js';
import {
  type AccWorld,
  accWorld,
  acceptedLead,
  call,
  daytimeContact,
  endedAppointment,
  humanTouch,
  leadsWorker,
  ledger,
  sendText,
  setPeriodDeadlines,
  suFixture,
} from './testing.js';

let h: ApiHarness;
let w: AccWorld;
let a0: TestClient;
let a1: TestClient;

interface Board {
  userId: string;
  speedToLead: { medianSeconds: number | null; withinSla: number; total: number; responded: number; pending: number };
  touches: { count: number; calls: number; textsAndEmails: number; days: number };
  appointmentsSet: { count: number; days: number };
  appointmentsHeld: { count: number; of: number };
  agreementsSigned: { count: number; days: number };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await accWorld(h);
  [a0, a1] = w.agents as [TestClient, TestClient];
  // every new lead goes to a0 (a1 is not accepting leads), so the numbers below are a0's alone
  await h.su.query('UPDATE memberships SET accepting_leads = false WHERE user_id = $1', [a1.userId]);
});
afterAll(async () => {
  await h?.close();
});

const board = async (c: TestClient, qs = '') => call<{ range: { key: string; days: number; from: string; to: string }; scoreboard: Board }>(c, 'GET', `/scoreboard${qs}`);

describe('scoreboard', () => {
  it('R-ACC-4 R-AST-15: speed-to-lead median and SLA compliance carry their denominators; a missed lead that was auto-released still counts against its agent; only human sends are touches', async () => {
    const inTime = await acceptedLead(h, w);
    expect(inTime.owner.userId).toBe(a0.userId);
    await humanTouch(h, a0, inTime.contactId);
    const missed = await acceptedLead(h, w);
    await setPeriodDeadlines(h, missed.contactId, -2_000, -1_000);
    await leadsWorker(h).drain();
    expect((await ledger(h, missed.contactId)).at(-1)?.type).toBe('auto_released');
    await acceptedLead(h, w); // still inside its first-touch window: pending, not counted against a0

    // one human text, and one assistant message attributed to the same agent (never a touch)
    await daytimeContact(h, inTime.contactId);
    await grantConsent(a0, inTime.contactId, 'sms');
    const sent = await sendText(a0, inTime.contactId, 'Hi Pat, it was great to talk');
    expect(sent.body.result).toBe('sent');
    await suFixture(h, [
      {
        text: `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
                                     initiator, initiated_by_user_id, purpose, assistant_action_id, gate_decision_id, dispatched_at, occurred_at)
               VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, 'sms', 'outbound', $3, '+14155550100', '+14155550101', 'Checking in', 'delivered',
                       'assistant', $4, 'informational', gen_random_uuid(), gen_random_uuid(), now(), now())`,
        values: [w.tenantId, inTime.contactId, w.mainNumberId, a0.userId],
      },
    ]);

    const r = await board(a0);
    expect(r.status).toBe(200);
    expect(r.body.range).toMatchObject({ key: '7d', days: 7 });
    const s = r.body.scoreboard;
    expect(s.userId).toBe(a0.userId);
    expect(s.speedToLead).toMatchObject({ withinSla: 1, total: 2, responded: 1, pending: 1 });
    expect(s.speedToLead.medianSeconds).not.toBeNull();
    expect(s.speedToLead.medianSeconds!).toBeLessThan(600);
    expect(s.touches).toEqual({ count: 1, calls: 0, textsAndEmails: 1, days: 7 });
    // the reason the numbers come from the aggregate function: under a0's own RLS the missed, released
    // lead is gone from the ledger view, which would have shown a flattering 1 of 1
    const viaView = await withTenantTx(a0.actor(), (tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM v_speed_to_lead WHERE user_id = ${a0.userId}::uuid`.execute(tx), { db: h.database });
    expect(viaView.rows[0]!.n).toBeLessThan(3);
  });

  it('R-ACC-4 R-IMPORT-6: appointments set, held of due, and agreements signed; imported appointments never count', async () => {
    const before = (await board(a0)).body.scoreboard;
    const c = await ownedContact(a0, { consent: false });
    const held = await endedAppointment(h, a0, c.id, 3 * 3_600_000);
    await endedAppointment(h, a0, c.id, 3_600_000); // due, no outcome yet
    const future = await call(a0, 'POST', '/appointments', { kind: 'consult', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), contactId: c.id });
    expect(future.status).toBe(201);
    expect((await call(a0, 'POST', `/appointments/${held}/outcome`, { result: 'follow_up' })).status).toBe(200);
    await h.su.query(
      `INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, status, created_by_kind)
       VALUES ($1, $2, $3, $4, 'consult', now() - interval '5 hours', now() - interval '4 hours', 'held', 'import')`,
      [w.tenantId, randomUUID(), c.id, a0.userId],
    );
    const deal = await call<{ deal: { id: string; rowVersion: number } }>(a0, 'POST', '/deals', { primaryContactId: c.id, side: 'buy' });
    expect(deal.status).toBe(201);
    expect((await call(a0, 'POST', `/deals/${deal.body.deal.id}/stage`, { rowVersion: deal.body.deal.rowVersion, stage: 'agreement_signed' })).status).toBe(200);

    const s = (await board(a0)).body.scoreboard;
    expect(s.appointmentsSet).toEqual({ count: before.appointmentsSet.count + 3, days: 7 });
    expect(s.appointmentsHeld).toEqual({ count: before.appointmentsHeld.count + 1, of: before.appointmentsHeld.of + 2 });
    expect(s.agreementsSigned).toEqual({ count: before.agreementsSigned.count + 1, days: 7 });
    const today = (await board(a0, '?range=today')).body;
    expect(today.range).toMatchObject({ key: 'today', days: 1 });
    expect(today.scoreboard.appointmentsSet.count).toBeGreaterThanOrEqual(3);
    expect((await call(a0, 'GET', '/scoreboard?range=year')).status).toBe(422);
  });

  it('R-ACC-4 R-PERM-5: agents see only their own numbers; a Team Lead sees their team (not an outsider); the Owner anyone; a TC nobody', async () => {
    const tl = w.teamLead!;
    expect((await board(a0, `?userId=${a1.userId}`)).code).toBe('NOT_FOUND');
    expect((await board(tl, `?userId=${a0.userId}`)).status).toBe(200);
    expect((await board(tl, `?userId=${w.outsider.userId}`)).code).toBe('NOT_FOUND');
    expect((await board(w.owner, `?userId=${w.outsider.userId}`)).status).toBe(200);
    expect((await board(w.owner, `?userId=${randomUUID()}`)).code).toBe('NOT_FOUND');
    const tc = await h.invite(w.owner, 'tc');
    expect((await board(tc)).code).toBe('NOT_FOUND');
    expect((await call(tc, 'GET', '/team/scoreboard')).code).toBe('NOT_FOUND');

    const team = async (c: TestClient) => (await call<{ members: Board[] }>(c, 'GET', '/team/scoreboard?range=30d')).body.members.map((m) => m.userId).sort();
    expect(await team(tl)).toEqual([a0.userId, a1.userId, tl.userId].sort());
    expect(await team(a0)).toEqual([a0.userId]);
    expect(await team(w.owner)).toEqual([w.owner.userId, a0.userId, a1.userId, tl.userId, w.outsider.userId].sort());

    // the aggregate functions themselves drop ids the caller may not see (no oracle, no numbers)
    const rows = await withTenantTx(a0.actor(), (tx) => sql`SELECT * FROM app.scoreboard_activity(${[a1.userId, w.outsider.userId]}::uuid[], now() - interval '30 days', now())`.execute(tx), { db: h.database });
    expect(rows.rows).toEqual([]);
    const speed = await withTenantTx(tl.actor(), (tx) => sql`SELECT * FROM app.scoreboard_speed(${[w.outsider.userId]}::uuid[], now() - interval '30 days', now())`.execute(tx), { db: h.database });
    expect(speed.rows).toEqual([]);
  });
});

describe('momentum', () => {
  it('R-ACC-5: a deal is slow when its stage dwell is over 1.5× the tenant median resting on ≥ 5 transitions in 180 days; fewer never flag; agents see the norm but never other agents\' deals', async () => {
    // a1's history makes the tenant norms: 5 prospect stays of 2 days; 4 agreement_signed stays of 1 day
    const deals: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await ownedContact(a1, { consent: false });
      const d = await call<{ deal: { id: string } }>(a1, 'POST', '/deals', { primaryContactId: c.id, side: 'buy', name: `A1 deal ${i}` });
      expect(d.status).toBe(201);
      deals.push(d.body.deal.id);
    }
    const statements: { text: string; values?: unknown[] }[] = [{ text: 'DELETE FROM deal_stage_history WHERE deal_id = ANY ($1::uuid[])', values: [deals] }];
    deals.forEach((id, i) => {
      const toActive = i < 4;
      statements.push(
        { text: `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage, to_stage, actor_kind, changed_at) VALUES ($1, $2, NULL, 'prospect', 'user', now() - interval '10 days')`, values: [w.tenantId, id] },
        { text: `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage, to_stage, actor_kind, changed_at) VALUES ($1, $2, 'prospect', 'agreement_signed', 'user', now() - interval '8 days')`, values: [w.tenantId, id] },
        ...(toActive ? [{ text: `INSERT INTO deal_stage_history (tenant_id, deal_id, from_stage, to_stage, actor_kind, changed_at) VALUES ($1, $2, 'agreement_signed', 'active', 'user', now() - interval '7 days')`, values: [w.tenantId, id] }] : []),
        {
          text: `UPDATE deals SET stage = $2, stage_entered_at = now() - ($3::int * interval '1 day'), agreement_signed_at = now() - interval '8 days' WHERE id = $1`,
          values: [id, toActive ? 'active' : 'agreement_signed', toActive ? 7 : 8],
        },
      );
    });
    await suFixture(h, statements);

    // a0: one prospect sitting 4 days (> 1.5 × 2), one sitting 1 day
    const mk = async (days: number, name: string) => {
      const c = await ownedContact(a0, { consent: false });
      const d = await call<{ deal: { id: string } }>(a0, 'POST', '/deals', { primaryContactId: c.id, side: 'buy', name });
      await h.su.query(`UPDATE deals SET stage_entered_at = now() - ($2::int * interval '1 day') WHERE id = $1`, [d.body.deal.id, days]);
      return d.body.deal.id;
    };
    const slowId = await mk(4, 'Slow prospect');
    const okId = await mk(1, 'Fresh prospect');

    type M = { norms: { stage: string; medianDays: number; sample: number; enough: boolean }[]; agents: { userId: string; openDeals: number; slowDeals: number; stages: { stage: string; slow: number; norm: unknown; deals: { dealId: string; name: string; dwellDays: number; slow: boolean }[] }[] }[]; rule: { factor: number; minSample: number } };
    const mine = await call<M>(a0, 'GET', '/team/momentum');
    expect(mine.status).toBe(200);
    expect(mine.body.rule).toMatchObject({ factor: 1.5, minSample: 5 });
    // (the deal signed in the previous test adds one ~0-day prospect stay: the median stays 2)
    const norm = (stage: string) => mine.body.norms.find((n) => n.stage === stage);
    expect(norm('prospect')).toMatchObject({ medianDays: 2, enough: true });
    expect(norm('prospect')!.sample).toBeGreaterThanOrEqual(5);
    expect(norm('agreement_signed')).toEqual({ stage: 'agreement_signed', medianDays: 1, sample: 4, enough: false });
    expect(mine.body.agents.map((a) => a.userId)).toEqual([a0.userId]);
    const prospect = mine.body.agents[0]!.stages.find((s) => s.stage === 'prospect')!;
    const byId = new Map(prospect.deals.map((d) => [d.dealId, d]));
    expect(byId.get(slowId)).toMatchObject({ slow: true, name: 'Slow prospect' });
    expect(byId.get(okId)).toMatchObject({ slow: false });
    expect(JSON.stringify(mine.body)).not.toContain('A1 deal');

    const tl = await call<M>(w.teamLead!, 'GET', '/team/momentum');
    const a1Row = tl.body.agents.find((a) => a.userId === a1.userId)!;
    expect(a1Row.openDeals).toBe(5);
    // 8 days in agreement_signed vs a 1-day median, but only 4 transitions: never flagged
    expect(a1Row.stages.find((s) => s.stage === 'agreement_signed')!.deals[0]).toMatchObject({ slow: false });
    expect(a1Row.slowDeals).toBe(0);
    expect(tl.body.agents.find((a) => a.userId === a0.userId)!.slowDeals).toBeGreaterThanOrEqual(1);
    // the view's own flag agrees with core.momentum for every visible deal
    const viewFlags = (await withTenantTx(a0.actor(), (tx) => sql<{ deal_id: string; is_slow: boolean | null }>`SELECT deal_id, is_slow FROM v_pipeline_momentum WHERE deal_id = ANY (${[slowId, okId]}::uuid[])`.execute(tx), { db: h.database })).rows;
    expect(Object.fromEntries(viewFlags.map((x) => [x.deal_id, x.is_slow === true]))).toEqual({ [slowId]: true, [okId]: false });
  });
});
