// R-OWN-7 idempotent replay, timers and fences (R-OWN-15, E67, E70), touches in a caller's tx (R-OWN-14).
import type { ContactId, Instant } from '@realty/core/foundation';
import { DAY_MS } from '@realty/core/foundation';
import { fold } from '@realty/core/ownership';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueWork } from '../src/jobs.js';
import { applyOwnershipCommandInTx } from '../src/ownership/apply.js';
import { selectLedger } from '../src/ownership/rows.js';
import { withTenantTx } from '../src/tenantTx.js';
import { BUY, cmd, contactRow, createHarness, createWorld, drainFollowups, type Harness, intakeLead, jobsFor, ledger, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 3, teamLead: true, rule: 'round_robin' });
});
afterAll(async () => {
  await h?.close();
});

const counts = async (contactId: string) => {
  const [r] = await suRows<{ e: string; r: string; a: string; j: string; n: string }>(h.su, `
    SELECT (SELECT count(*) FROM lead_ownership_events WHERE contact_id = $1) AS e,
           (SELECT count(*) FROM ownership_command_rejections WHERE contact_id = $1) AS r,
           (SELECT count(*) FROM audit_log WHERE entity_id = $1) AS a,
           (SELECT count(*) FROM jobs WHERE payload->>'contactId' = $1::text) AS j,
           (SELECT count(*) FROM notifications WHERE subject_id = $1) AS n`, [contactId]);
  return r!;
};

async function foldMatches(contactId: ContactId) {
  const events = await withTenantTx(w.system(), (tx) => selectLedger(tx, contactId), { db: h.app });
  const c = await contactRow(h.su, contactId);
  const p = fold(events);
  expect(p.seq).toBe(Number(c.ownership_seq));
  expect(p.state).toBe(c.ownership_state);
  expect(p.ownerUserId).toBe(c.owner_user_id);
  expect(p.periodSeq).toBe(c.ownership_period_seq === null ? null : Number(c.ownership_period_seq));
  expect(p.firstTouchDueAt).toBe(c.first_touch_due_at ? (c.first_touch_due_at as Date).getTime() : null);
  expect(p.releaseDueAt).toBe(c.release_due_at ? (c.release_due_at as Date).getTime() : null);
  return p;
}

describe('R-OWN-7 idempotent replay', () => {
  it('R-OWN-7: replaying an accepted command returns the stored ledger events and writes nothing', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[0]!;
    const commandId = uuid();
    const first = await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId }, { commandId });
    expect(first.outcome.ok).toBe(true);
    const before = await counts(contactId);
    const again = await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId }, { commandId });
    expect(again.replayed).toBe(true);
    expect(again.outcome.ok).toBe(true);
    if (!first.outcome.ok || !again.outcome.ok) return;
    expect(again.outcome.events.map((e) => e.eventId)).toEqual(first.outcome.events.map((e) => e.eventId));
    expect(await counts(contactId)).toEqual(before);
  });

  it('R-OWN-7: replaying a rejected command returns the stored rejection; the rejection log keeps one row', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const [a, b] = w.agents as [typeof w.agents[0], typeof w.agents[0]];
    expect((await cmd(h.app, a!.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const commandId = uuid();
    const lost = await cmd(h.app, b!.actor, contactId, { kind: 'claim', pondId: w.pondId }, { commandId });
    expect(lost.outcome.ok ? null : lost.outcome.code).toBe('LEAD_ALREADY_CLAIMED');
    const before = await counts(contactId);
    const again = await cmd(h.app, b!.actor, contactId, { kind: 'claim', pondId: w.pondId }, { commandId });
    expect(again.replayed).toBe(true);
    expect(again.outcome.ok ? null : again.outcome.code).toBe('LEAD_ALREADY_CLAIMED');
    if (!lost.outcome.ok && !again.outcome.ok) expect(again.outcome.rejection.id).toBe(lost.outcome.rejection.id);
    expect(await counts(contactId)).toEqual(before);
  });

  it('R-OWN-7: a second accept by the current owner returns ALREADY_OWNER with no events', async () => {
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c = await contactRow(h.su, contactId);
    const offeree = [...w.agents, w.tl!].find((m) => m.id === c.offered_to_user_id)!;
    expect((await cmd(h.app, offeree.actor, contactId, { kind: 'accept', offerId: c.offer_id as string })).outcome.ok).toBe(true);
    const seq = Number((await contactRow(h.su, contactId)).ownership_seq);
    const r = await cmd(h.app, offeree.actor, contactId, { kind: 'accept', offerId: c.offer_id as string });
    expect(r.outcome.ok ? null : r.outcome.code).toBe('ALREADY_OWNER');
    expect(Number((await contactRow(h.su, contactId)).ownership_seq)).toBe(seq);
  });

  it('R-OWN-7 R-PERM-7: the decliner replays its decline after the lead was re-offered elsewhere: stored events, no re-decision', async () => {
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c = await contactRow(h.su, contactId);
    const decliner = [...w.agents, w.tl!].find((m) => m.id === c.offered_to_user_id)!;
    const commandId = uuid();
    const d = await cmd(h.app, decliner.actor, contactId, { kind: 'decline', offerId: c.offer_id as string }, { commandId });
    expect(d.outcome.ok).toBe(true);
    await drainFollowups(h, w);
    expect((await contactRow(h.su, contactId)).offered_to_user_id).not.toBe(decliner.id);
    const before = await counts(contactId);
    const again = await cmd(h.app, decliner.actor, contactId, { kind: 'decline', offerId: c.offer_id as string }, { commandId });
    expect(again.replayed).toBe(true);
    expect(again.projection).toBeNull(); // the decliner no longer sees the contact
    expect(again.outcome.ok && again.outcome.events.map((e) => e.type)).toEqual(['offer_declined']);
    expect(await counts(contactId)).toEqual(before);
  });
});

describe('timers and fences', () => {
  it('R-OWN-15 E70 E6: a breach advances seq but not the period; the auto-release fence still matches and fires', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[1]!;
    expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const c0 = await contactRow(h.su, contactId);
    const period = Number(c0.ownership_period_seq);
    // an early wake is a no-op that reschedules at the stored deadline
    const early = await cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'first_touch_breach', fence: { periodSeq: period, dueAt: (c0.first_touch_due_at as Date).getTime() as Instant } });
    expect(early.outcome.ok && early.outcome.events.length).toBe(0);
    // fixture: both deadlines in the past (projection and the period-start ledger event alike)
    await suFixture(h.su, `UPDATE contacts SET first_touch_due_at = now() - interval '20 minutes', release_due_at = now() - interval '1 minute' WHERE id = $1`, [contactId]);
    await suFixture(h.su, `UPDATE lead_ownership_events e SET deadline_at = c.first_touch_due_at,
                             payload = e.payload || jsonb_build_object('releaseDueAt', (extract(epoch FROM c.release_due_at) * 1000)::bigint)
                             FROM contacts c WHERE c.id = e.contact_id AND e.contact_id = $1 AND e.seq = $2`, [contactId, period]);
    const c1 = await contactRow(h.su, contactId);
    const breachFence = { periodSeq: period, dueAt: (c1.first_touch_due_at as Date).getTime() as Instant };
    const releaseFence = { periodSeq: period, dueAt: (c1.release_due_at as Date).getTime() as Instant };
    // E6: a lost timer job is found from data by the sweeper's due_work
    const due = await dueWork(Date.now() as Instant, 1000, { db: h.app });
    expect(due.filter((d) => d.refId === contactId).map((d) => d.workKind).sort()).toEqual(['auto_release', 'first_touch_breach']);
    const b = await cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'first_touch_breach', fence: breachFence });
    expect(b.outcome.ok && b.outcome.events.map((e) => e.type)).toEqual(['first_touch_breached']);
    const c2 = await contactRow(h.su, contactId);
    expect(Number(c2.ownership_seq)).toBe(Number(c1.ownership_seq) + 1);
    expect(Number(c2.ownership_period_seq)).toBe(period);
    // the breach notified the owner (critical) and every lead of the owner's team (the TL, and the
    // Owner, who provisioning made lead of the default team)
    const n = await suRows<{ user_id: string; kind: string; priority: string }>(h.su, `SELECT user_id, kind, priority FROM notifications WHERE subject_id = $1 AND kind IN ('first_touch_due','first_touch_escalation') ORDER BY kind, user_id`, [contactId]);
    expect(n).toEqual([
      { user_id: a.id, kind: 'first_touch_due', priority: 'critical' },
      ...[w.tl!.id, w.owner.id].sort().map((u) => ({ user_id: u, kind: 'first_touch_escalation', priority: 'high' })),
    ]);
    // a duplicate breach timer is a no-op (E6)
    const dup = await cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'first_touch_breach', fence: breachFence });
    expect(dup.outcome.ok && dup.outcome.events.length).toBe(0);
    // a mismatched fence is a no-op
    const stale = await cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'auto_release', fence: { ...releaseFence, dueAt: (releaseFence.dueAt + 1) as Instant } });
    expect(stale.outcome.ok && stale.outcome.events.length).toBe(0);
    const rel = await cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'auto_release', fence: releaseFence });
    expect(rel.outcome.ok && rel.outcome.events.map((e) => e.type)).toEqual(['auto_released']);
    const c3 = await contactRow(h.su, contactId);
    expect(c3.ownership_state).toBe('in_pond');
    expect(c3.inactivity_release_at).toBeNull();
    await foldMatches(contactId);
  });

  it('R-OWN-15 R-OWN-23 E67: lowering inactivity_release_days never moves stored deadlines; new periods use the new value', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[2]!;
    const r = await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId });
    expect(r.outcome.ok).toBe(true);
    const c0 = await contactRow(h.su, contactId);
    const rel0 = (c0.inactivity_release_at as Date).getTime();
    expect(rel0 - (c0.owned_at as Date).getTime()).toBeGreaterThan(29 * DAY_MS);
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`UPDATE tenant_settings SET inactivity_release_days = 14 WHERE tenant_id = ${w.tenantId}`.execute(tx);
    }, { db: h.app });
    expect(((await contactRow(h.su, contactId)).inactivity_release_at as Date).getTime()).toBe(rel0);
    const due = await dueWork((Date.now() + 20 * DAY_MS) as Instant, 1000, { db: h.app });
    expect(due.some((d) => d.workKind === 'inactivity' && d.refId === contactId)).toBe(false);
    // a new ownership period after the change uses 14 days
    const { contactId: c2 } = await intakeLead(h.app, w);
    expect((await cmd(h.app, a.actor, c2, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const n = await contactRow(h.su, c2);
    const days = ((n.inactivity_release_at as Date).getTime() - (n.owned_at as Date).getTime()) / DAY_MS;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`UPDATE tenant_settings SET inactivity_release_days = 30 WHERE tenant_id = ${w.tenantId}`.execute(tx);
    }, { db: h.app });
  });

  it('R-OWN-14: a gate-allowed human send records the first touch, last_human_touch_at and new inactivity deadlines in the caller transaction', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[0]!;
    expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const c0 = await contactRow(h.su, contactId);
    const r = await withTenantTx(a.actor, async (tx, now) =>
      applyOwnershipCommandInTx(tx, a.actor, contactId, { kind: 'touch', via: 'sms', refId: uuid(), at: now }, { commandId: uuid() }), { db: h.app });
    expect(r.outcome.ok && r.outcome.events.map((e) => e.type)).toEqual(['first_touch_recorded']);
    const c1 = await contactRow(h.su, contactId);
    expect(c1.first_touch_at).not.toBeNull();
    expect(c1.last_human_touch_at).not.toBeNull();
    expect((c1.inactivity_release_at as Date).getTime()).toBeGreaterThanOrEqual((c0.inactivity_release_at as Date).getTime());
    // the period's breach / release timers were cancelled in the same transaction
    const js = await jobsFor(h.su, w.tenantId);
    const period = Number(c1.ownership_period_seq);
    for (const k of [`ownership.first_touch_breach:${contactId}:${period}`, `ownership.auto_release:${contactId}:${period}`]) {
      expect(js.find((j) => j.dedupe_key === k)?.status).toBe('cancelled');
    }
    // a second touch adds no ledger event (only the first is ledgered) but refreshes the activity columns
    const r2 = await withTenantTx(a.actor, async (tx, now) =>
      applyOwnershipCommandInTx(tx, a.actor, contactId, { kind: 'touch', via: 'call', refId: uuid(), at: now }, { commandId: uuid() }), { db: h.app });
    expect(r2.outcome.ok && r2.outcome.events.length).toBe(0);
    expect(((await contactRow(h.su, contactId)).last_human_touch_at as Date).getTime()).toBeGreaterThan((c1.last_human_touch_at as Date).getTime());
    // the assistant never counts as a touch
    const { contactId: c3 } = await intakeLead(h.app, w);
    expect((await cmd(h.app, a.actor, c3, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const ra = await cmd(h.app, w.system('assistant'), c3, { kind: 'touch', via: 'sms', refId: uuid(), at: Date.now() as Instant });
    expect(ra.outcome.ok && ra.outcome.events.length).toBe(0);
    expect((await contactRow(h.su, c3)).first_touch_at).toBeNull();
    await foldMatches(contactId);
  });

  it('R-OWN-26 E62: soft delete is an ownership command (closed/deleted, purge_after); the contact disappears for the agent', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const a = w.agents[0]!;
    expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
    const r = await cmd(h.app, a.actor, contactId, { kind: 'soft_delete' });
    expect(r.outcome.ok).toBe(true);
    const c = await contactRow(h.su, contactId);
    expect([c.ownership_state, c.closed_reason, c.deleted_by_user_id]).toEqual(['closed', 'deleted', a.id]);
    expect((c.purge_after as Date).getTime() - (c.deleted_at as Date).getTime()).toBe(30 * DAY_MS);
    const seen = await withTenantTx(a.actor, async (tx) => (await sql<{ n: string }>`SELECT count(*) AS n FROM contacts WHERE id = ${contactId}`.execute(tx)).rows[0]!.n, { db: h.app });
    expect(Number(seen)).toBe(0);
    const audit = await suRows<{ action: string }>(h.su, 'SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY seq', [contactId]);
    expect(audit.map((x) => x.action)).toEqual(['ownership.claim', 'ownership.soft_delete']);
    expect((await ledger(h.su, contactId)).at(-1)?.type).toBe('closed');
  });
});
