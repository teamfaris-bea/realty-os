// Priority Feed over real Postgres as app_user (BUILD_PLAN module 14: feed visibility after reassignment,
// reasons + one-tap actions, card lifecycle, concurrency; R-PERM-4, R-PERM-5, R-AST-12).
// R-ACC-4 (feed part): the response says how many cards it holds when it shows fewer (`total`); the
// scoreboard denominators themselves are api/accountability's.
import { readFileSync } from 'node:fs';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../worker/systemActor.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { acceptedLead, appointmentEnded, call, command, contactOf, feedOf, taskDueNow, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

async function dueTask(agent: (typeof w.agents)[number], contactId: string | null, title = 'Send the comps'): Promise<string> {
  const t = await call<{ task: { id: string } }>(agent, 'POST', '/tasks', { title, contactId, dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect(t.status).toBe(201);
  await taskDueNow(h, t.body.task.id);
  return t.body.task.id;
}

describe('GET /feed', () => {
  it('shows pinned deadlines first, then scored cards, each with reasons and a one-tap action; no score or confidence', async () => {
    const { contactId, owner } = await acceptedLead(h, w);
    const taskId = await dueTask(owner, contactId);
    const appt = await call<{ appointment: { id: string } }>(owner, 'POST', '/appointments', {
      kind: 'buyer_consult',
      contactId,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    });
    expect(appt.status).toBe(201);
    await appointmentEnded(h, appt.body.appointment.id, 3 * 3_600_000);

    const r = await call(owner, 'GET', '/feed');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/"score"|confidence|"points"/i);
    const f = await feedOf(owner);
    const ft = f.pinned.find((c) => c.itemType === 'first_touch_due' && c.contact?.id === contactId);
    expect(ft).toBeDefined();
    expect(ft!.primaryAction.kind).toBe('call'); // A1: call is one tap
    expect(ft!.reasons[0]!.code).toMatch(/FIRST_TOUCH_(DUE|OVERDUE)/);
    const task = f.scored.find((c) => c.itemType === 'task_due' && c.subjectId === taskId);
    expect(task).toBeDefined();
    expect([task!.primaryAction.kind, ...task!.alternatives.map((a) => a.kind)]).toContain('complete_task');
    const outcome = f.scored.find((c) => c.itemType === 'appointment_outcome' && c.subjectId === appt.body.appointment.id);
    expect(outcome?.primaryAction).toMatchObject({ kind: 'log_outcome', appointmentId: appt.body.appointment.id });
    expect(outcome!.reasons.map((x) => x.code)).toEqual(['OUTCOME_MISSING', 'OUTCOME_OVER_2H']);
    // pinned band strictly before the scored band
    expect(f.all.findIndex((c) => c.band === 'scored')).toBeGreaterThanOrEqual(f.pinned.length);
    expect(f.total).toBeGreaterThanOrEqual(f.all.length);
  });

  it('R-PERM-4: after a reassignment the previous owner loses the card at once (RLS hides it), and the lead shows up for the new owner', async () => {
    const { contactId, owner: a } = await acceptedLead(h, w);
    const b = w.agents.find((x) => x.userId !== a.userId)!;
    expect((await feedOf(a)).all.some((c) => c.contact?.id === contactId)).toBe(true);
    // a task of the new owner on the lead (cards follow the user's own work)
    const re = await command(w.owner, contactId, 'reassign', { toUserId: b.userId });
    expect(re.status).toBe(200);
    const taskB = await dueTask(b, contactId, 'Introduce yourself');

    const fa = await feedOf(a);
    expect(JSON.stringify(fa)).not.toContain(contactId);
    // the previous owner's stored row still exists, but RLS (feed_select: contact visible) hides it from them
    const stale = await h.su.query<{ state: string }>('SELECT state FROM priority_feed_items WHERE contact_id = $1 AND user_id = $2', [contactId, a.userId]);
    expect(stale.rows.length).toBeGreaterThan(0);
    expect((await call(a, 'GET', `/contacts/${contactId}`)).code).toBe('NOT_FOUND');
    const fb = await feedOf(b);
    expect(fb.all.some((c) => c.subjectId === taskB && c.contact?.id === contactId)).toBe(true);
  });

  it('R-PERM-5: acting on another user’s card, or a made-up id, is NOT_FOUND', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const c = await contactOf(a);
    const taskId = await dueTask(a, c.id);
    const card = (await feedOf(a)).all.find((x) => x.subjectId === taskId)!;
    expect((await call(b, 'POST', `/feed/${card.id}/done`)).code).toBe('NOT_FOUND');
    expect((await call(a, 'POST', `/feed/00000000-0000-7000-8000-000000000000/done`)).code).toBe('NOT_FOUND');
  });

  it('pinned cards are live deadlines: Done / Snooze / Dismiss are refused with FEED_ITEM_PINNED', async () => {
    const { contactId, owner } = await acceptedLead(h, w);
    const card = (await feedOf(owner)).pinned.find((c) => c.contact?.id === contactId)!;
    for (const verb of ['done', 'dismiss']) expect((await call(owner, 'POST', `/feed/${card.id}/${verb}`)).code).toBe('FEED_ITEM_PINNED');
    expect((await call(owner, 'POST', `/feed/${card.id}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() })).code).toBe('FEED_ITEM_PINNED');
  });

  it('Done and Dismiss are final for that occurrence: a recompute never reopens them', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const t1 = await dueTask(a, c.id, 'Call about the inspection');
    const t2 = await dueTask(a, c.id, 'Drop off keys');
    const f = await feedOf(a);
    const c1 = f.all.find((x) => x.subjectId === t1)!;
    const c2 = f.all.find((x) => x.subjectId === t2)!;
    expect((await call(a, 'POST', `/feed/${c1.id}/done`)).body).toEqual({ item: { id: c1.id, state: 'done', snoozedUntil: null } });
    expect((await call(a, 'POST', `/feed/${c2.id}/dismiss`)).status).toBe(200);
    // idempotent repeat; a different close of a closed card is refused
    expect((await call(a, 'POST', `/feed/${c1.id}/done`)).status).toBe(200);
    expect((await call(a, 'POST', `/feed/${c1.id}/dismiss`)).code).toBe('FEED_ITEM_NOT_OPEN');
    const again = await feedOf(a);
    expect(again.all.some((x) => x.subjectId === t1 || x.subjectId === t2)).toBe(false);
    const rows = await h.su.query<{ state: string; resolved_by: string }>('SELECT state, resolved_by FROM priority_feed_items WHERE subject_id = ANY ($1) ORDER BY state', [[t1, t2]]);
    expect(rows.rows).toEqual([
      { state: 'dismissed', resolved_by: 'user' },
      { state: 'done', resolved_by: 'user' },
    ]);
  });

  it('a snoozed card stays hidden until its time, then comes back as the same card', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const t = await dueTask(a, c.id, 'Confirm lender');
    const card = (await feedOf(a)).all.find((x) => x.subjectId === t)!;
    expect((await call(a, 'POST', `/feed/${card.id}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).code).toBe('VALIDATION_FAILED');
    expect((await call(a, 'POST', `/feed/${card.id}/snooze`, { until: new Date(Date.now() + 9 * 86_400_000).toISOString() })).code).toBe('VALIDATION_FAILED');
    const s = await call<{ item: { state: string } }>(a, 'POST', `/feed/${card.id}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() });
    expect(s.body.item.state).toBe('snoozed');
    expect((await feedOf(a)).all.some((x) => x.subjectId === t)).toBe(false);
    await h.su.query("UPDATE priority_feed_items SET snoozed_until = now() - interval '1 second' WHERE id = $1", [card.id]);
    const back = (await feedOf(a)).all.find((x) => x.subjectId === t);
    expect(back?.id).toBe(card.id);
  });

  it('a card whose condition stops holding closes by itself and reopens when the same occurrence is due again', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const t = await dueTask(a, c.id, 'Order the appraisal');
    const card = (await feedOf(a)).all.find((x) => x.subjectId === t)!;
    expect((await call(a, 'PATCH', `/tasks/${t}`, { status: 'done' })).status).toBe(200);
    expect((await feedOf(a)).all.some((x) => x.subjectId === t)).toBe(false);
    expect((await h.su.query('SELECT state, resolved_by FROM priority_feed_items WHERE id = $1', [card.id])).rows[0]).toEqual({ state: 'done', resolved_by: 'condition' });
    expect((await call(a, 'PATCH', `/tasks/${t}`, { status: 'open' })).status).toBe(200);
    const back = (await feedOf(a)).all.find((x) => x.subjectId === t);
    expect(back?.id).toBe(card.id);
  });

  it('concurrent refreshes of one user never open the same card twice', async () => {
    const a = w.agents[1]!;
    const c = await contactOf(a);
    const t = await dueTask(a, c.id, 'Book the inspector');
    const results = await Promise.all(Array.from({ length: 6 }, () => call(a, 'GET', '/feed')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const rows = await h.su.query<{ n: string }>("SELECT count(*)::text AS n FROM priority_feed_items WHERE subject_id = $1 AND state IN ('open','snoozed')", [t]);
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('a contact with no phone keeps its card: demoted, with the channel that works as the one tap', async () => {
    const a = w.agents[0]!;
    const r = await call<{ contact: { id: string } }>(a, 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Ema', lastName: 'Only', emails: [`ema-${Date.now()}@example.test`] });
    expect([200, 201]).toContain(r.status);
    const t = await dueTask(a, r.body.contact.id, 'Follow up on the listing');
    const card = (await feedOf(a)).all.find((x) => x.subjectId === t)!;
    expect(card.primaryAction.kind).toBe('email');
    expect(card.reasons.map((x) => x.code)).toContain('CALL_BLOCKED');
    expect(card.reasons.find((x) => x.code === 'CALL_BLOCKED')!.label).toMatch(/No working phone number/);
  });

  it('R-AST-12: a self-reported protected-proxy attribute changes nothing in the feed, and the loader never reads attributes', async () => {
    const a = w.agents[1]!;
    const c1 = await contactOf(a, { firstName: 'Ann' });
    const c2 = await contactOf(a, { firstName: 'Ben' });
    await h.su.query(
      `INSERT INTO contact_attributes (tenant_id, id, contact_id, key, value, sensitivity, self_reported) VALUES ($1, gen_random_uuid(), $2, 'va_loan_interest', 'true', 'protected_proxy', true)`,
      [w.tenantId, c1.id],
    );
    const t1 = await dueTask(a, c1.id, 'Same task');
    const t2 = await dueTask(a, c2.id, 'Same task');
    await h.su.query('UPDATE tasks SET due_at = (SELECT due_at FROM tasks WHERE id = $1) WHERE id = $2', [t1, t2]);
    const f = await feedOf(a);
    const k1 = f.all.find((x) => x.subjectId === t1)!;
    const k2 = f.all.find((x) => x.subjectId === t2)!;
    expect(k1.reasons).toEqual(k2.reasons);
    const scores = await h.su.query<{ subject_id: string; score: number }>('SELECT subject_id, score FROM priority_feed_items WHERE subject_id = ANY ($1)', [[t1, t2]]);
    expect(new Set(scores.rows.map((x) => x.score)).size).toBe(1);
    for (const f of ['repos/feedInputs.ts', 'feed.ts']) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/contact_attributes|protected_proxy|sensitivity/);
    }
  });

  it('R-CONSENT-19: an email open is stored only as a signal (DB CHECK), and a signal never creates a card or answers anything', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Opal' });
    const sys = systemActor(w.tenantId as TenantId, 'provider');
    const insert = (reliability: string, key: string) =>
      withTenantTx(sys, (tx) => sql`INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, source, occurred_at, dedupe_key)
                                     VALUES (app.tenant_id(), ${crypto.randomUUID()}, ${c.id}, 'email_opened', ${reliability}, 'email_pixel', now(), ${key})`.execute(tx), { db: h.database });
    await expect(insert('fact', `open-fact-${c.id}`)).rejects.toThrow(/check constraint/);
    await expect(insert('signal', `open-signal-${c.id}`)).resolves.toBeDefined();
    expect((await feedOf(a)).all.some((x) => x.contact?.id === c.id)).toBe(false);
  });
});
