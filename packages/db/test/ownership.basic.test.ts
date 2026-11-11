// applyOwnershipCommand end-to-end through app_user (RLS) on a real per-test database.
import type { ContactId } from '@realty/core/foundation';
import { fold } from '@realty/core/ownership';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPeople } from '../src/ownership/context.js';
import { applyOwnershipCommand } from '../src/ownership/apply.js';
import { selectLedger } from '../src/ownership/rows.js';
import { withTenantTx } from '../src/tenantTx.js';
import { BUY, cmd, contactRow, createHarness, createWorld, type Harness, intakeLead, jobsFor, ledger, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2, teamLead: true, rule: 'round_robin' });
});
afterAll(async () => {
  await h?.close();
});

describe('ownership command path', () => {
  it('R-OWN-2 R-OWN-3: intake to the pond writes ledger row(s) then the projection at the ledger head', async () => {
    const { contactId, result } = await intakeLead(h.app, w);
    expect(result.outcome.ok).toBe(true);
    const c = await contactRow(h.su, contactId);
    const l = await ledger(h.su, contactId);
    expect(l.map((e) => e.type)).toEqual(['created', 'sent_to_pond']);
    expect(l.map((e) => Number(e.seq))).toEqual([1, 2]);
    expect(Number(c.ownership_seq)).toBe(2);
    expect(c.ownership_state).toBe('in_pond');
    expect(c.pond_id).toBe(w.pondId);
  });

  it('R-OWN-19: a self-created contact is owned by its creator with no SLA, and the human command is audited', async () => {
    const agent = w.agents[0]!;
    const id = await selfCreated(h.app, w, agent);
    const c = await contactRow(h.su, id);
    expect(c.ownership_state).toBe('owned');
    expect(c.owner_user_id).toBe(agent.id);
    expect(c.first_touch_due_at).toBeNull();
    const audit = await suRows<{ action: string; actor_user_id: string }>(h.su, 'SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1', [id]);
    expect(audit).toEqual([{ action: 'ownership.create', actor_user_id: agent.id }]);
  });

  it('R-OWN-4: fold(ledger) equals the stored projection after a claim / release / claim sequence', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[0]!;
    const b = w.agents[1]!;
    expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    expect((await cmd(h.app, a.actor, contactId, { kind: 'release', reason: 'not_a_fit' })).outcome.ok).toBe(true);
    const r = await cmd(h.app, b.actor, contactId, { kind: 'claim', pondId: w.pondId });
    expect(r.outcome.ok).toBe(true);
    const events = await withTenantTx(w.system(), (tx) => selectLedger(tx, contactId), { db: h.app });
    expect(fold(events)).toEqual(r.projection);
    const c = await contactRow(h.su, contactId);
    expect(c.owner_user_id).toBe(b.id);
    expect(Number(c.ownership_seq)).toBe(events.length);
  });

  it('intake with a matching rule offers the lead to one agent with a timer job and a critical notification', async () => {
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c = await contactRow(h.su, contactId);
    expect(c.ownership_state).toBe('offered');
    const l = await ledger(h.su, contactId);
    const offered = l.find((e) => e.type === 'offered')!;
    expect(Array.isArray(offered.payload.candidates)).toBe(true);
    const js = await jobsFor(h.su, w.tenantId);
    expect(js.some((j) => j.kind === 'ownership.offer_expiry' && j.dedupe_key === `ownership.offer_expiry:${contactId}:${c.offer_id}`)).toBe(true);
    const n = await suRows<{ kind: string; priority: string; user_id: string; title: string }>(h.su, 'SELECT kind, priority, user_id, title FROM notifications WHERE subject_id = $1', [contactId]);
    expect(n).toEqual([{ kind: 'lead_offer', priority: 'critical', user_id: c.offered_to_user_id, title: 'New lead offer' }]);
    const d = await suRows<{ channel: string }>(h.su, `SELECT d.channel FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.subject_id = $1 ORDER BY 1`, [contactId]);
    expect(d.map((x) => x.channel)).toEqual(['in_app', 'web_push']);
  });

  it('accept by the offeree owns the lead with first-touch timers (R-OWN-13)', async () => {
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c = await contactRow(h.su, contactId);
    const offeree = [...w.agents, w.tl!].find((m) => m.id === c.offered_to_user_id)!;
    const r = await applyOwnershipCommand(offeree.actor, contactId as ContactId, { kind: 'accept', offerId: c.offer_id as string }, { commandId: uuid(), db: h.app });
    expect(r.outcome.ok).toBe(true);
    const after = await contactRow(h.su, contactId);
    expect(after.ownership_state).toBe('owned');
    expect(after.first_touch_due_at).not.toBeNull();
    const js = await jobsFor(h.su, w.tenantId);
    const keys = js.filter((j) => j.status === 'pending').map((j) => j.dedupe_key);
    expect(keys).toContain(`ownership.first_touch_breach:${contactId}:${after.ownership_period_seq}`);
    expect(keys).toContain(`ownership.auto_release:${contactId}:${after.ownership_period_seq}`);
    expect(js.find((j) => j.dedupe_key === `ownership.offer_expiry:${contactId}:${c.offer_id}`)?.status).toBe('cancelled');
  });
});

describe('loadPeople (one statement since lane perf-misses)', () => {
  it('returns exactly what the former two statements returned, for every actor (admins sorted; team leads of each member sorted)', async () => {
    const legacy = async (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0]) => {
      const admins = await sql<{ user_id: string }>`
        SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND role IN ('owner', 'admin') AND status = 'active'
         ORDER BY user_id`.execute(tx);
      const leads = await sql<{ member: string; lead: string }>`
        SELECT DISTINCT tm.user_id AS member, l.user_id AS lead
          FROM team_members tm
          JOIN team_members l ON l.tenant_id = tm.tenant_id AND l.team_id = tm.team_id AND l.is_lead
          JOIN memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active'
         WHERE tm.tenant_id = app.tenant_id()
         ORDER BY 1, 2`.execute(tx);
      const teamLeadsOf: Record<string, string[]> = {};
      for (const row of leads.rows) (teamLeadsOf[row.member] ??= []).push(row.lead);
      return { admins: admins.rows.map((a) => a.user_id), teamLeadsOf };
    };
    for (const actor of [w.owner.actor, w.tl!.actor, ...w.agents.map((m) => m.actor), w.system()]) {
      const [now, before] = await withTenantTx(actor, async (tx) => [await loadPeople(tx), await legacy(tx)] as const, { db: h.app });
      expect(now).toEqual(before);
    }
    const mine = await withTenantTx(w.owner.actor, (tx) => loadPeople(tx), { db: h.app });
    expect(mine.admins).toContain(w.owner.id);
    expect(Object.keys(mine.teamLeadsOf).length).toBeGreaterThan(0);
  });
});

describe('timer enqueues of one command (batched since lane perf-misses)', () => {
  it('a claim writes its timers as jobs in the order of the decision\'s enqueueTimer effects, with their run_at, payload and dedupe keys; the audit mirror and ledger row are written once', async () => {
    const wd = await createWorld(h.app, { agents: 1 });
    const { contactId } = await intakeLead(h.app, wd);
    const before = new Set((await jobsFor(h.su, wd.tenantId)).map((j) => j.id));
    const r = await cmd(h.app, wd.agents[0]!.actor, contactId, { kind: 'claim', pondId: wd.pondId });
    if (!r.outcome.ok || r.replayed) throw new Error('claim refused');
    const timers = r.outcome.effects.filter((e) => e.kind === 'enqueueTimer');
    expect(timers.length).toBeGreaterThanOrEqual(2);
    const jobs = (await jobsFor(h.su, wd.tenantId)).filter((j) => !before.has(j.id) && j.kind !== 'ownership.followup');
    expect(jobs.map((j) => [j.kind, j.dedupe_key, j.run_at.getTime(), j.payload])).toEqual(timers.map((t) => [t.jobKind, t.dedupeKey, t.runAt, { ...t.fence }]));
    expect((await ledger(h.su, contactId)).map((e) => e.type)).toEqual(['created', 'sent_to_pond', 'claimed']);
    expect(await suRows(h.su, `SELECT action FROM audit_log WHERE entity_id = $1`, [contactId])).toEqual([{ action: 'ownership.claim' }]);
  });
});

