// Tasks and appointments over real Postgres as app_user (BUILD_PLAN module 14: CRUD, promise tasks show
// evidence, outcome logging; R-AST-5, R-PERM-5).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { appointmentEnded, call, contactOf, feedOf, taskDueNow, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true });
});
afterAll(async () => {
  await h?.close();
});

/** An assistant call-summary action with one promise claim (+ evidence) and its promise task (api/assistant writes these). */
async function assistantPromise(contactId: string, ownerUserId: string, o: { needsReview: boolean; dueInMs: number | null }): Promise<{ taskId: string; claimId: string }> {
  const actionId = randomUUID();
  const claimId = randomUUID();
  const taskId = randomUUID();
  const msgId = randomUUID();
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
       VALUES ($1,$2,$3,'call_summary','internal','internal','proposed',$4,'What was said on the call, with where it was said.','{}')`,
      [w.tenantId, actionId, contactId, ownerUserId],
    );
    await c.query(
      `INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review) VALUES ($1,$2,$3,0,'commitment','You said you would send the comps.',$4)`,
      [w.tenantId, claimId, actionId, o.needsReview],
    );
    await c.query(
      `INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
       VALUES ($1, gen_random_uuid(), $2, 'message', $3, '{"kind":"message"}', 'I will send you the comps by Friday', $4)`,
      [w.tenantId, claimId, msgId, !o.needsReview],
    );
    await c.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, source_action_id, source_claim_id, needs_review)
       VALUES ($1,$2,$3,$4,'promise','Send the comps', CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() + ($5::int * interval '1 millisecond') END, 'assistant', $6, $7, $8)`,
      [w.tenantId, taskId, ownerUserId, contactId, o.dueInMs, actionId, claimId, o.needsReview],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { taskId, claimId };
}

describe('tasks', () => {
  it('create, read, list, edit and complete a task about a contact', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Tess' });
    const r = await call<{ task: { id: string; status: string; contact: { id: string; name: string }; source: unknown; needsReview: boolean } }>(a, 'POST', '/tasks', {
      title: 'Call back about financing',
      kind: 'callback',
      contactId: c.id,
      dueAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ status: 'open', contact: { id: c.id, name: 'Tess Doe' }, source: null, needsReview: false });
    const id = r.body.task.id;
    const list = await call<{ tasks: { id: string }[] }>(a, 'GET', '/tasks');
    expect(list.body.tasks.map((t) => t.id)).toContain(id);
    const byContact = await call<{ tasks: { id: string }[] }>(a, 'GET', `/tasks?contactId=${c.id}`);
    expect(byContact.body.tasks.map((t) => t.id)).toEqual([id]);
    const done = await call<{ task: { status: string; completedAt: string | null } }>(a, 'PATCH', `/tasks/${id}`, { status: 'done', notes: 'Talked to the lender' });
    expect(done.body.task.status).toBe('done');
    expect(done.body.task.completedAt).not.toBeNull();
    expect((await call<{ tasks: unknown[] }>(a, 'GET', `/tasks?contactId=${c.id}`)).body.tasks).toHaveLength(0);
    expect((await call<{ tasks: unknown[] }>(a, 'GET', `/tasks?contactId=${c.id}&status=all`)).body.tasks).toHaveLength(1);
  });

  it('R-PERM-5: a task about a contact, deal or listing the caller cannot see is NOT_FOUND (the FK never reveals it exists)', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const theirs = await contactOf(b);
    for (const body of [{ contactId: theirs.id }, { contactId: randomUUID() }, { dealId: randomUUID() }, { listingId: randomUUID() }]) {
      const r = await call(a, 'POST', '/tasks', { title: 'Peek', ...body });
      expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    }
    const t = await call<{ task: { id: string } }>(b, 'POST', '/tasks', { title: 'Mine', contactId: theirs.id });
    expect((await call(a, 'GET', `/tasks/${t.body.task.id}`)).code).toBe('NOT_FOUND');
    expect((await call(a, 'PATCH', `/tasks/${t.body.task.id}`, { status: 'done' })).code).toBe('NOT_FOUND');
  });

  it('assignment: agents assign to themselves; a Team Lead to their team; the Owner to anyone active', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    expect((await call(a, 'POST', '/tasks', { title: 'For Ben', assigneeUserId: b.userId })).code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const c = await contactOf(b);
    const tl = await call<{ task: { assigneeUserId: string } }>(w.teamLead!, 'POST', '/tasks', { title: 'From your TL', assigneeUserId: b.userId, contactId: c.id });
    expect(tl.status).toBe(201);
    expect(tl.body.task.assigneeUserId).toBe(b.userId);
    const own = await call(w.owner, 'POST', '/tasks', { title: 'From the owner', assigneeUserId: a.userId });
    expect(own.status).toBe(201);
    expect((await call(w.owner, 'POST', '/tasks', { title: 'Nobody', assigneeUserId: randomUUID() })).code).toBe('ASSIGNEE_NOT_ELIGIBLE');
  });

  it('R-AST-5: an unpinned promise has no due date (DB CHECK), shows "Check this" with its evidence, and only the agent setting a date pins it', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const { taskId } = await assistantPromise(c.id, a.userId!, { needsReview: true, dueInMs: null });
    // the DB refuses a due date on an open needs-review promise
    await expect(h.su.query("UPDATE tasks SET due_at = now() + interval '1 day' WHERE id = $1", [taskId])).rejects.toThrow(/check constraint/);
    const t = await call<{ task: { needsReview: boolean; dueAt: string | null; source: { claimText: string; evidence: { snippet: string; verified: boolean; label: string }[] } } }>(a, 'GET', `/tasks/${taskId}`);
    expect(t.body.task.needsReview).toBe(true);
    expect(t.body.task.dueAt).toBeNull();
    expect(t.body.task.source.claimText).toBe('You said you would send the comps.');
    expect(t.body.task.source.evidence[0]).toMatchObject({ snippet: 'I will send you the comps by Friday', verified: false });
    expect(t.body.task.source.evidence[0]!.label).toMatch(/^Not found in the source: /);
    expect(JSON.stringify(t.body)).not.toMatch(/confidence/i);
    const card = (await feedOf(a)).all.find((x) => x.subjectId === taskId)!;
    expect(card.reasons[0]!.code).toBe('PROMISE_NEEDS_DATE');
    expect(card.primaryAction).toMatchObject({ kind: 'open_task', label: 'Set the date' });
    const pinned = await call<{ task: { needsReview: boolean; dueAt: string } }>(a, 'PATCH', `/tasks/${taskId}`, { dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(pinned.status).toBe(200);
    expect(pinned.body.task.needsReview).toBe(false);
    expect(pinned.body.task.dueAt).not.toBeNull();
  });

  it('a verified promise shows where it was promised (quote + source) on its feed card', async () => {
    const a = w.agents[1]!;
    const c = await contactOf(a);
    const { taskId } = await assistantPromise(c.id, a.userId!, { needsReview: false, dueInMs: 3_600_000 });
    await taskDueNow(h, taskId, 10 * 60_000);
    const card = (await feedOf(a)).all.find((x) => x.subjectId === taskId)!;
    expect(card.itemType).toBe('promise_due');
    const src = card.reasons.find((x) => x.code === 'PROMISE_SOURCE');
    expect(src?.label).toContain('I will send you the comps by Friday');
    const t = await call<{ task: { source: { evidence: { verified: boolean; label: string }[] } } }>(a, 'GET', `/tasks/${taskId}`);
    expect(t.body.task.source.evidence[0]).toMatchObject({ verified: true });
  });

  it('strict bodies: an all-day task needs a zone; unknown fields are refused', async () => {
    const a = w.agents[0]!;
    expect((await call(a, 'POST', '/tasks', { title: 'x', dueAllDay: true, dueAt: new Date().toISOString() })).code).toBe('VALIDATION_FAILED');
    expect((await call(a, 'POST', '/tasks', { title: 'x', kind: 'promise' })).code).toBe('VALIDATION_FAILED'); // promises come from the assistant with evidence
    expect((await call(a, 'POST', '/tasks', { title: 'x', tenant_id: w.tenantId })).code).toBe('VALIDATION_FAILED');
  });
});

describe('appointments and outcomes', () => {
  it('schedule, move, then log the outcome in one tap: the feed card closes and nothing stays missing', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const start = Date.now() + 86_400_000;
    const r = await call<{ appointment: { id: string; awaitingOutcome: boolean } }>(a, 'POST', '/appointments', { kind: 'listing_appointment', contactId: c.id, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(), location: 'Their house' });
    expect(r.status).toBe(201);
    const id = r.body.appointment.id;
    expect(r.body.appointment.awaitingOutcome).toBe(false);
    // an outcome before it happened is refused
    expect((await call(a, 'POST', `/appointments/${id}/outcome`, { result: 'follow_up' })).code).toBe('VALIDATION_FAILED');
    const moved = await call<{ appointment: { startsAt: string } }>(a, 'PATCH', `/appointments/${id}`, { startsAt: new Date(start + 7_200_000).toISOString(), endsAt: new Date(start + 10_800_000).toISOString() });
    expect(moved.status).toBe(200);
    expect((await call(a, 'PATCH', `/appointments/${id}`, { endsAt: new Date(start).toISOString() })).code).toBe('VALIDATION_FAILED');
    await appointmentEnded(h, id, 3 * 3_600_000);
    const listed = await call<{ appointments: { id: string; awaitingOutcome: boolean }[] }>(a, 'GET', '/appointments?awaitingOutcome=true');
    expect(listed.body.appointments.find((x) => x.id === id)?.awaitingOutcome).toBe(true);
    expect((await feedOf(a)).all.some((x) => x.subjectId === id && x.itemType === 'appointment_outcome')).toBe(true);
    const o = await call<{ appointment: { status: string; outcome: string; outcomeLoggedAt: string; awaitingOutcome: boolean } }>(a, 'POST', `/appointments/${id}/outcome`, { result: 'agreement_signed', note: 'Signed the listing agreement' });
    expect(o.status).toBe(200);
    expect(o.body.appointment).toMatchObject({ status: 'held', outcome: 'agreement_signed', awaitingOutcome: false });
    const row = (await h.su.query('SELECT outcome_logged_by_user_id FROM appointments WHERE id = $1', [id])).rows[0];
    expect(row.outcome_logged_by_user_id).toBe(a.userId);
    expect((await feedOf(a)).all.some((x) => x.subjectId === id)).toBe(false);
  });

  it('a no-show is an outcome too; a canceled appointment cannot get one', async () => {
    const a = w.agents[1]!;
    const c = await contactOf(a);
    const mk = async () => {
      const r = await call<{ appointment: { id: string } }>(a, 'POST', '/appointments', { kind: 'consult', contactId: c.id, startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString() });
      await appointmentEnded(h, r.body.appointment.id, 60_000);
      return r.body.appointment.id;
    };
    const ns = await mk();
    const o = await call<{ appointment: { status: string; outcome: string | null; outcomeLoggedAt: string | null } }>(a, 'POST', `/appointments/${ns}/outcome`, { result: 'no_show' });
    expect(o.body.appointment).toMatchObject({ status: 'no_show', outcome: null });
    expect(o.body.appointment.outcomeLoggedAt).not.toBeNull();
    const cx = await mk();
    expect((await call(a, 'PATCH', `/appointments/${cx}`, { status: 'canceled' })).status).toBe(200);
    expect((await call(a, 'POST', `/appointments/${cx}/outcome`, { result: 'follow_up' })).code).toBe('VALIDATION_FAILED');
  });

  it('R-PERM-5: another agent’s appointment is NOT_FOUND, and so is an appointment on a contact the caller cannot see', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const c = await contactOf(b);
    const r = await call<{ appointment: { id: string } }>(b, 'POST', '/appointments', { kind: 'consult', contactId: c.id, startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString() });
    expect((await call(a, 'POST', `/appointments/${r.body.appointment.id}/outcome`, { result: 'follow_up' })).code).toBe('NOT_FOUND');
    expect((await call(a, 'PATCH', `/appointments/${r.body.appointment.id}`, { status: 'canceled' })).code).toBe('NOT_FOUND');
    expect((await call(a, 'POST', '/appointments', { kind: 'consult', contactId: c.id, startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString() })).code).toBe('NOT_FOUND');
  });
});
