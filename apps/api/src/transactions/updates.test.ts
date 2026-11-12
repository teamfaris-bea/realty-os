// Milestone updates over real Postgres (module 31 with module 26; R-TXN-2, R-TXN-4, R-TXN-5, R-GATE-1, R-GATE-14,
// R-GATE-7, R-AST-3, R-NURT-7; E96, E97). Updates are deal_date_upcoming firings of the approved team
// transaction_updates playbook only; they go out through executeTriggerRun → queueOutboundInTx → comms/dispatch.ts
// (D1 opt-outs at send time) to the fake email provider. Nothing in module 31 sends.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { pointId } from '../comms/testing.js';
import { recompute } from '../accountability/testing.js';
import { command } from '../leads/testing.js';
import { executeTriggerRunInTx } from '../nurture/execute.js';
import { reconcileAndRun } from '../nurture/testing.js';
import { systemActor } from '../worker/systemActor.js';
import {
  type TxnWorld,
  approveUpdates,
  call,
  confirmDueSoon,
  dateChanged,
  dateRow,
  deal,
  dealContact,
  enterDate,
  localDay,
  mailTo,
  milestones,
  reconcile,
  runsOfDate,
  txnWorld,
  updatesContent,
} from './testing.js';

let h: ApiHarness;
let w: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await txnWorld(h);
});
afterAll(async () => {
  await h?.close();
});

/** A deal date whose reminder is due now (reminder time already passed), on a deal of agent 0 with the TC on it. */
async function dueDate(d: { dealId: string }, kind = 'closing', label?: string): Promise<string> {
  const e = await enterDate(w.agents[0]!, d.dealId, kind, localDay(w.zone, 20), label);
  expect(e.status).toBe(201);
  expect((await confirmDueSoon(w.tc, e.body.date.id, w.zone)).status).toBe(200);
  return e.body.date.id;
}

async function runTrigger(stepRunId: string) {
  const deps = depsFromPlatform(h.app.platform);
  return withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, deps, w.tenantId, stepRunId, now), { db: h.database });
}

describe('R-TXN-4 only the approved team transaction_updates playbook, only the named roles', () => {
  it('R-TXN-4: an agent\'s own trigger playbook with a deal_date_upcoming step never fires from a deal date', async () => {
    const mine = await approvedPlaybook(w.agents[0]!, { kind: 'trigger', scope: 'agent', name: 'My deal reminders', steps: updatesContent() });
    expect(mine.versionId).toBeDefined();
    const d = await deal(h, w, w.agents[0]!);
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, id)).toEqual([]);
    // nothing planned: the team playbook is not approved yet, and the screen says so
    const m = await milestones(w.tc, d.dealId);
    expect(m.body.dates.find((x) => x.id === id)!.updates[0]!.text).toMatch(/no Milestone updates playbook was approved/);
  });

  it('R-TXN-4 R-NURT-7: only the roles the step names receive updates; "other" and an unowned contact get nothing, and the deal screen says why', async () => {
    await approveUpdates(w.owner, { roles: ['buyer', 'seller', 'co_buyer', 'co_seller', 'lender'] });
    const d = await deal(h, w, w.agents[0]!);
    const coBuyer = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Casey' });
    const other = await dealContact(w.agents[0]!, d.dealId, 'other', { firstName: 'Quinn' });
    const unowned = await dealContact(w.agents[0]!, d.dealId, 'co_buyer', { firstName: 'Avery' });
    expect((await command(w.agents[0]!, unowned.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await runsOfDate(h, id)).map((r) => r.contact_id).sort()).toEqual([d.contactId, coBuyer.id].sort());
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(1);
    expect(mailTo(h, coBuyer.email)).toHaveLength(1);
    expect(mailTo(h, other.email)).toHaveLength(0);
    expect(mailTo(h, unowned.email)).toHaveLength(0);
    const m = await milestones(w.tc, d.dealId);
    const ups = m.body.dates.find((x) => x.id === id)!.updates;
    expect(ups.find((u) => u.contactId === other.id)!.text).toMatch(/does not name the other role/);
    expect(ups.find((u) => u.contactId === unowned.id)!.text).toMatch(/no owner/);
    expect(ups.find((u) => u.contactId === coBuyer.id)!.status).toBe('sent');
  });

  it('R-TXN-4 NOT_A_PARTY: a contact removed from the deal before sending gets nothing', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const co = await dealContact(w.agents[0]!, d.dealId, 'co_buyer');
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, id)).toHaveLength(2);
    await h.su.query('DELETE FROM deal_contacts WHERE deal_id = $1 AND contact_id = $2', [d.dealId, co.id]); // fixture: no removal route
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, co.email)).toHaveLength(0);
    const r = (await runsOfDate(h, id)).find((x) => x.contact_id === co.id)!;
    expect(r.status).toBe('skipped_ineligible');
    expect((r.trigger_ref['skip'] as { reason: string }).reason).toBe('NOT_A_PARTY');
  });
});

describe('R-TXN-2 only confirmed, uncompleted dates drive updates', () => {
  it('R-TXN-2 R-TXN-1: proposed and waived dates send nothing; a date completed after its firing was planned is skipped with DATE_COMPLETED', async () => {
    const d = await deal(h, w, w.agents[0]!);
    // a proposal never gets a reminder (deal_dates_reminder_confirmed) and so never a firing
    const proposed = await enterDate(w.agents[0]!, d.dealId, 'appraisal', localDay(w.zone, 2));
    await h.su.query("UPDATE deal_dates SET source = 'template', status = 'proposed', reminder_at = NULL WHERE id = $1", [proposed.body.date.id]);
    const waived = await dueDate(d, 'inspection');
    await h.su.query("UPDATE deal_dates SET status = 'waived' WHERE id = $1", [waived]);
    expect((await dateRow(h, waived)).reminder_at).toBeNull(); // the guard clears it
    const done = await dueDate(d, 'closing');
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, proposed.body.date.id)).toEqual([]);
    expect(await runsOfDate(h, waived)).toEqual([]);
    expect(await runsOfDate(h, done)).toHaveLength(1);
    // marked done after planning: the date-changed job skips it, and the send-time recheck says DATE_COMPLETED too
    expect((await call(w.tc, 'PATCH', `/deal-dates/${done}`, { completed: true })).status).toBe(200);
    const run = (await runsOfDate(h, done))[0]!;
    // the send-time recheck first (as if the job had not run yet), then the job is a no-op
    await h.su.query("UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 second' WHERE id = $1", [run.id]);
    const out = await runTrigger(run.id);
    expect(out).toMatchObject({ kind: 'skipped', reasons: ['DATE_COMPLETED'] });
    expect(((await runsOfDate(h, done))[0]!.trigger_ref['skip'] as { text: string }).text).toBe('The date was marked done after this update was planned.');
    expect(mailTo(h, d.email)).toHaveLength(0);
  });

  it('R-TXN-2: the date-changed job skips a completed date\'s scheduled firing with DATE_COMPLETED', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    expect((await call(w.tc, 'PATCH', `/deal-dates/${id}`, { completed: true })).status).toBe(200);
    const r = await dateChanged(h, w.tenantId, id);
    expect(r.skipped).toBe(1);
    const run = (await runsOfDate(h, id))[0]!;
    expect([run.status, (run.trigger_ref['skip'] as { reason: string }).reason]).toEqual(['skipped_ineligible', 'DATE_COMPLETED']);
  });
});

describe('E96 R-TXN-5 a moved date', () => {
  it('E96 R-TXN-5 R-TXN-4: a move bumps due_version, the old firing is skipped with its reason and its queued message canceled; exactly one update carries the new date', async () => {
    const d = await deal(h, w, w.agents[0]!, { firstName: 'Jordan' });
    const id = await dueDate(d);
    const v1 = (await dateRow(h, id)).due_version;
    await reconcile(h, w.tenantId);
    const [old] = await runsOfDate(h, id);
    // build the old firing's message (queued, not dispatched yet)
    await h.su.query("UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 second' WHERE id = $1", [old!.id]);
    const built = await runTrigger(old!.id);
    expect(built.kind).toBe('queued');
    const messageId = (built as { messageId: string }).messageId;
    // the closing moves by amendment (the TC types the new date)
    const newOn = localDay(w.zone, 3);
    expect((await call(w.tc, 'PATCH', `/deal-dates/${id}`, { dueOn: newOn })).status).toBe(200);
    const moved = await dateRow(h, id);
    expect(moved.due_version).toBe(v1 + 1);
    expect(moved.reminder_at).not.toBeNull(); // the kept reminder rule, recomputed for the new date
    // the job the move enqueued
    expect((await h.su.query("SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind = 'milestones.date_changed' AND payload->>'dealDateId' = $2", [w.tenantId, id])).rowCount).toBe(1);
    const r = await dateChanged(h, w.tenantId, id);
    expect(r).toEqual({ skipped: 1, canceled: 1 });
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [messageId])).rows[0]!.status).toBe('canceled');
    const oldRun = (await runsOfDate(h, id)).find((x) => x.id === old!.id)!;
    expect([oldRun.status, (oldRun.trigger_ref['skip'] as { reason: string }).reason]).toEqual(['skipped_ineligible', 'DATE_CHANGED']);
    // the new version's reminder: exactly one update, with the new date
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    const mail = mailTo(h, d.email);
    expect(mail).toHaveLength(1);
    const [y, mo, da] = newOn.split('-').map(Number) as [number, number, number];
    expect(mail[0]!.text).toContain(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, mo - 1, da))).replace(',', ''));
    expect((await runsOfDate(h, id)).map((x) => [x.trigger_key.split(':')[2], x.status])).toEqual([
      [`v${v1}`, 'skipped_ineligible'],
      [`v${v1 + 1}`, 'sent'],
    ]);
  });
});

describe('R-AST-3 R-GATE-7 wording', () => {
  it('R-AST-3: a label with contract or money wording becomes a draft for the contact owner, never an automatic send', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = await dueDate(d, 'custom', 'Contract addendum signatures');
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(0);
    const run = (await runsOfDate(h, id))[0]!;
    expect(run.status).toBe('converted_to_draft');
    const a = await h.su.query<{ kind: string; owner_user_id: string; status: string }>('SELECT kind, owner_user_id, status FROM assistant_actions WHERE id = $1', [run.assistant_action_id]);
    expect(a.rows[0]).toEqual({ kind: 'message_draft', owner_user_id: w.agents[0]!.userId, status: 'proposed' });
    const m = await milestones(w.tc, d.dealId);
    expect(m.body.dates.find((x) => x.id === id)!.updates[0]!.status).toBe('drafted');
  });

  it('R-GATE-7: payment details in a label send nothing at all (not even a draft)', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = await dueDate(d, 'custom', 'Send funds: routing 021000021 account 4417123456');
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(0);
    const run = (await runsOfDate(h, id))[0]!;
    expect([run.status, run.assistant_action_id]).toEqual(['skipped_ineligible', null]);
    expect((run.trigger_ref['skip'] as { reason: string }).reason).toBe('PAYMENT_INSTRUCTIONS');
  });
});

describe('E97 an opted-out lender: the R-GATE-14 path test (the DB dispatch guard itself is module 22 and comms)', () => {
  it('E97 R-TXN-4 R-GATE-14: the lender asked for no email: the update is blocked at send (gate_decisions written, provider never called), failed_send reaches the deal owner, the TC sees "not sent"', async () => {
    const d = await deal(h, w, w.agents[0]!);
    // the lender contact is the deal owner's (otherwise failed_send goes to the lender contact's owner, see the report)
    const lender = await dealContact(w.agents[0]!, d.dealId, 'lender', { firstName: 'Lee' });
    const pid = await pointId(h, lender.id, 'email');
    const rev = await call(w.agents[0]!, 'POST', `/contacts/${lender.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'email', purpose: 'all', evidence: { note: 'asked for no more email' } });
    expect(rev.status).toBe(200);
    const sentBefore = h.providers.email.sent.length;
    const id = await dueDate(d);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, lender.email)).toHaveLength(0);
    expect(mailTo(h, d.email)).toHaveLength(1); // the buyer still gets theirs
    expect(h.providers.email.sent.length).toBe(sentBefore + 1);
    const run = (await runsOfDate(h, id)).find((x) => x.contact_id === lender.id)!;
    const msg = await h.su.query<{ id: string; status: string; gate_decision_id: string | null }>('SELECT id, status, gate_decision_id FROM messages WHERE id = $1', [run.message_id]);
    expect(msg.rows[0]!.status).toBe('blocked');
    const gd = await h.su.query<{ outcome: string; reason_codes: string[] }>('SELECT outcome, reason_codes FROM gate_decisions WHERE id = $1', [msg.rows[0]!.gate_decision_id]);
    expect(gd.rows[0]!.outcome).toBe('deny');
    expect(gd.rows[0]!.reason_codes).toContain('CONSENT_REVOKED');
    await recompute(h, w.tenantId);
    const item = await h.su.query<{ owner_user_id: string }>("SELECT owner_user_id FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send' AND dedupe_key = $2", [w.tenantId, `send:${msg.rows[0]!.id}`]);
    expect(item.rows[0]!.owner_user_id).toBe(w.agents[0]!.userId);
    const m = await milestones(w.tc, d.dealId);
    const up = m.body.dates.find((x) => x.id === id)!.updates.find((u) => u.contactId === lender.id)!;
    expect(up.status).toBe('blocked');
    expect(up.text).toMatch(/^Not sent: /);
  });

  it('D1 note (reported): a marketing-only email unsubscribe does not block an informational milestone update', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const pid = await pointId(h, d.contactId, 'email');
    expect((await call(w.agents[0]!, 'POST', `/contacts/${d.contactId}/consent`, { kind: 'revoke', pointId: pid, channel: 'email', purpose: 'marketing', evidence: { note: 'unsubscribed from newsletters' } })).status).toBe(200);
    await dueDate(d);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    expect(mailTo(h, d.email)).toHaveLength(1);
  });
});

export { randomUUID };
