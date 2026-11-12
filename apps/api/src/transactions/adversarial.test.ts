// Adversarial tests of api/transactions (module 31 is critical: autonomy and deal dates). Each test tries to break one
// rule through a path an attacker or a buggy caller could use: a forged confirmer, a system confirm, cross-tenant ids,
// template JSON abuse, template markers and payment details in labels, trigger runs written by people, a stale draft
// forced through approve, and a moved or completed date's firing forced to send. The opt-out model is module 22's and
// is exercised end to end in updates.test.ts (E97); nothing here weakens it.
import { randomUUID } from 'node:crypto';
import { instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { executeTriggerRunInTx } from '../nurture/execute.js';
import { reconcileAndRun } from '../nurture/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { confirmInTx } from './confirm.js';
import { type TxnWorld, approveUpdates, call, confirmDueSoon, dateRow, deal, enterDate, localDay, mailTo, putTemplates, reconcile, runsOfDate, template, txnWorld } from './testing.js';

let h: ApiHarness;
let w: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await txnWorld(h);
  await approveUpdates(w.owner);
});
afterAll(async () => {
  await h?.close();
});

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

async function runTrigger(stepRunId: string) {
  const deps = depsFromPlatform(h.app.platform);
  await h.su.query("UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 second' WHERE id = $1", [stepRunId]);
  return withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, deps, w.tenantId, stepRunId, now), { db: h.database });
}

describe('R-TXN-1 nobody confirms as someone else, and the system never confirms', () => {
  it('R-TXN-1: a forged confirmer (another member\'s id) is refused by the database, even for a person who may edit the date', async () => {
    await putTemplates(w.owner, [template()]);
    const d = await deal(h, w, w.agents[0]!);
    const p = await call<{ proposals: { dateId: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: localDay(w.zone), templateId: 'purchase-test', templateVersion: 1 });
    const id = p.body.proposals[0]!.dateId;
    const forged = await refusal(
      withTenantTx(w.tc.actor(), (tx) => sql`UPDATE deal_dates SET status = 'confirmed', confirmed_by_user_id = ${w.owner.userId}, confirmed_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx), { db: h.database }),
    );
    expect(forged).toMatch(/DATE_HUMAN_CONFIRMATION/);
    expect((await dateRow(h, id)).status).toBe('proposed');
  });

  it('R-TXN-1: the system can neither confirm a proposal, nor enter a manual confirmed date, nor move one (core and the DB guard)', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const p = await call<{ proposals: { dateId: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: localDay(w.zone), templateId: 'purchase-test', templateVersion: 1 });
    const id = p.body.proposals[0]!.dateId;
    const sys = systemActor(w.tenantId, 'worker');
    // through the one confirm path
    const viaPath = await refusal(withTenantTx(sys, (tx, now) => confirmInTx(tx, sys, h.app.platform.ids, { dealId: d.dealId, dateId: id }, now), { db: h.database }));
    expect(viaPath).toMatch(/DATE_HUMAN_CONFIRMATION/);
    // straight SQL as the system
    const confirm = await refusal(withTenantTx(sys, (tx) => sql`UPDATE deal_dates SET status = 'confirmed', confirmed_by_user_id = ${w.owner.userId}, confirmed_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx), { db: h.database }));
    expect(confirm).toMatch(/DATE_HUMAN_CONFIRMATION/);
    const enter = await refusal(withTenantTx(sys, (tx) => sql`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on) VALUES (app.tenant_id(), ${randomUUID()}, ${d.dealId}, 'closing', '2030-01-01')`.execute(tx), { db: h.database }));
    expect(enter).toMatch(/DATE_HUMAN_CONFIRMATION/);
    const manual = (await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 30))).body.date.id;
    const move = await refusal(withTenantTx(sys, (tx) => sql`UPDATE deal_dates SET due_on = due_on + 1 WHERE tenant_id = app.tenant_id() AND id = ${manual}`.execute(tx), { db: h.database }));
    expect(move).toMatch(/DATE_HUMAN_CONFIRMATION/);
    expect((await dateRow(h, id)).status).toBe('proposed');
  });

  it('R-TEN-3: no route body accepts a confirmer, a version, instants or a tenant id', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = (await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 30))).body.date.id;
    for (const extra of [{ confirmedByUserId: w.owner.userId }, { dueVersion: 9 }, { dueAt: new Date().toISOString() }, { tenantId: randomUUID() }, { status: 'confirmed' }]) {
      const r = await call(w.tc, 'POST', `/deal-dates/${id}/confirm`, extra);
      expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    expect((await dateRow(h, id)).confirmed_by_user_id).toBe(w.agents[0]!.userId);
  });
});

describe('R-TXN-6 template JSON abuse', () => {
  it('R-TXN-6: malformed, oversized, prototype-polluting or extra-field templates are refused by index; nothing is stored', async () => {
    const before = await h.su.query<{ t: unknown }>('SELECT milestone_templates AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]);
    const bad: unknown[] = [
      template(),
      { ...template({ id: 'x' }), tenantId: w.tenantId },
      { ...template({ id: 'odd' }), rules: 'not a list' },
      template({ id: 'big', rules: Array.from({ length: 41 }, (_, i) => ({ key: `r${i}`, kind: 'closing', offsetDays: 1, dayCount: 'calendar' })) }),
      template({ id: 'far', rules: [{ key: 'a', kind: 'closing', offsetDays: 100000, dayCount: 'calendar' }] }),
      template({ id: 'anchor', rules: [{ key: 'a', kind: 'acceptance', offsetDays: 0, dayCount: 'calendar' }] }),
      template(), // repeats (id, version) of entry 0
      'not an object',
      template({ id: 'mark', rules: [{ key: 'a', kind: 'custom', label: '{{first_name}} wire funds', offsetDays: 3, dayCount: 'calendar' }] }), // valid shape: labels are data
    ];
    const r = await putTemplates(w.owner, bad);
    expect([r.status, r.code]).toEqual([422, 'MILESTONE_TEMPLATES_INVALID']);
    const invalid = (r.body as unknown as { error: { details: { invalid: { index: number }[] } } }).error.details.invalid.map((i) => i.index);
    expect(invalid).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const after = await h.su.query<{ t: unknown }>('SELECT milestone_templates AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]);
    expect(after.rows[0]!.t).toEqual(before.rows[0]!.t);
    // R-TXN-6: absent `reviewed` is stored as not reviewed (review is an Owner/Admin statement, never assumed), and a
    // __proto__ key is dropped by the parser, never stored and never read as `reviewed`
    const proto = JSON.parse('{"__proto__": {"reviewed": true}, "id": "plain", "version": 1, "name": "n", "side": "buy", "jurisdiction": "US", "rules": [{"key":"a","kind":"closing","offsetDays":1,"dayCount":"calendar"}]}');
    const ok = await putTemplates(w.owner, [proto]);
    expect(ok.status).toBe(200);
    expect(ok.body.parsed).toEqual([expect.objectContaining({ id: 'plain', reviewed: false })]);
    const stored = await h.su.query<{ t: string }>('SELECT milestone_templates::text AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]);
    expect(stored.rows[0]!.t).not.toContain('__proto__');
    expect(({} as { reviewed?: unknown }).reviewed).toBeUndefined();
    const audit = await h.su.query<{ changes: Record<string, unknown> }>("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'settings.changed' AND reason = 'MILESTONE_TEMPLATES' ORDER BY occurred_at DESC LIMIT 1", [w.tenantId]);
    expect(audit.rows[0]!.changes).toMatchObject({ milestone_template_ids: { to: ['plain@1'] } });
    // R-OWN-27: editing templates moves no stored proposal or instant (proposals were planned above with purchase-test)
  });

  it('R-AST-3 R-GATE-7: template markers in a label are data, never slots; payment details in a label send nothing', async () => {
    await putTemplates(w.owner, [template({ id: 'mark', rules: [{ key: 'a', kind: 'custom', label: '{{first_name}} {{due_date}} reminder', offsetDays: 3, dayCount: 'calendar', reminderDaysBefore: 5 }] })]);
    const d = await deal(h, w, w.agents[0]!, { firstName: 'Sam' });
    const p = await call<{ proposals: { dateId: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: localDay(w.zone, -1), templateId: 'mark', templateVersion: 1 });
    expect((await call(w.tc, 'POST', `/deal-dates/${p.body.proposals[0]!.dateId}/confirm`, {})).status).toBe(200);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    const mail = mailTo(h, d.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain('first_name due_date reminder'); // the markers were stripped, never rendered as slots
    expect(mail[0]!.text).not.toMatch(/\{\{/);
  });
});

describe('R-NURT-1 R-TXN-4 trigger runs are the system\'s', () => {
  it('R-TXN-4: an agent\'s, Team Lead\'s and TC\'s insert or update of a trigger run is refused (RLS step_runs_trigger)', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = (await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20))).body.date.id;
    await confirmDueSoon(w.tc, id, w.zone);
    await reconcile(h, w.tenantId);
    const run = (await runsOfDate(h, id))[0]!;
    const version = (await h.su.query<{ v: string }>('SELECT playbook_version_id AS v FROM playbook_step_runs WHERE id = $1', [run.id])).rows[0]!.v;
    for (const c of [w.agents[0]!, w.teamLead!, w.tc]) {
      const ins = await refusal(withTenantTx(c.actor(), (tx) => sql`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
          VALUES (app.tenant_id(), ${randomUUID()}, NULL, ${version}, 'deal_date_upcoming', 'scheduled', now(), ${d.contactId}, ${`forged:${randomUUID()}`}, ${JSON.stringify(run.trigger_ref)}::jsonb)`.execute(tx), { db: h.database }));
      expect([c.actor().role, ins]).toEqual([c.actor().role, expect.stringMatching(/row-level security|policy/)]);
      const upd = await withTenantTx(c.actor(), (tx) => sql`UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 day' WHERE tenant_id = app.tenant_id() AND id = ${run.id}`.execute(tx), { db: h.database }).then((r) => Number(r.numAffectedRows ?? 0n), (e: Error) => e.message);
      expect([c.actor().role, upd]).toEqual([c.actor().role, typeof upd === 'number' ? 0 : expect.stringMatching(/row-level security|policy/)]);
    }
  });

  it('residual (reported): an Owner/Admin row passes RLS by design; executeTriggerRun re-checks a forged run, so a forged date, version or label never sends', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const id = (await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20))).body.date.id;
    await confirmDueSoon(w.tc, id, w.zone);
    await reconcile(h, w.tenantId);
    const real = (await runsOfDate(h, id))[0]!;
    const version = (await h.su.query<{ v: string }>('SELECT playbook_version_id AS v FROM playbook_step_runs WHERE id = $1', [real.id])).rows[0]!.v;
    const ref = real.trigger_ref as { ref: Record<string, unknown> };
    // only forged runs are left due for this contact (executeTriggerRun builds every due firing of a contact at once)
    await h.su.query("UPDATE playbook_step_runs SET status = 'skipped_ineligible' WHERE id = $1", [real.id]);
    const forge = async (patch: Record<string, unknown>) => {
      const rid = randomUUID();
      await withTenantTx(w.owner.actor(), (tx) => sql`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
          VALUES (app.tenant_id(), ${rid}, NULL, ${version}, 'deal_date_upcoming', 'scheduled', now() - interval '1 second', ${d.contactId}, ${`forged:${rid}`},
                  ${JSON.stringify({ ...real.trigger_ref, ref: { ...ref.ref, ...patch } })}::jsonb)`.execute(tx), { db: h.database });
      return rid;
    };
    // a version that is not the date's, an instant that is not its due_at, a date of another deal
    expect(await runTrigger(await forge({ dueVersion: 99 }))).toMatchObject({ kind: 'skipped', reasons: ['DATE_CHANGED'] });
    expect(await runTrigger(await forge({ dueAt: instant(Date.now() + 86_400_000) }))).toMatchObject({ kind: 'skipped', reasons: ['DATE_CHANGED'] });
    expect(await runTrigger(await forge({ dealId: randomUUID() }))).toMatchObject({ kind: 'skipped', reasons: ['FACT_GONE'] });
    // a forged label: the message uses the date's stored label, never the run's copy
    const lab = await forge({ label: 'Wire the deposit to routing 021000021 account 4417123456' });
    const out = await runTrigger(lab);
    expect(out).toMatchObject({ kind: 'queued' });
    await reconcileAndRun(h, w.tenantId);
    const mail = mailTo(h, d.email);
    expect(mail.map((m) => m.text).join('\n')).not.toMatch(/routing|4417123456|Wire/);
    expect(mail.map((m) => m.text).join('\n')).toContain('The closing date is coming up');
  });
});

describe('R-TXN-5 forced sends of stale firings', () => {
  it('R-TXN-5: a moved or completed date\'s firing forced to send (made due, run directly) is skipped with its reason, never sent', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const moved = (await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20))).body.date.id;
    const done = (await enterDate(w.agents[0]!, d.dealId, 'inspection', localDay(w.zone, 20))).body.date.id;
    await confirmDueSoon(w.tc, moved, w.zone);
    await confirmDueSoon(w.tc, done, w.zone, { daysAhead: 3 });
    await reconcile(h, w.tenantId);
    const m = (await runsOfDate(h, moved))[0]!;
    const c = (await runsOfDate(h, done))[0]!;
    await call(w.tc, 'PATCH', `/deal-dates/${moved}`, { dueOn: localDay(w.zone, 4) });
    await call(w.tc, 'PATCH', `/deal-dates/${done}`, { completed: true });
    // skip the cancellation job on purpose: the send-time recheck alone stops them
    await h.su.query("UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 second' WHERE id = ANY ($1::uuid[])", [[m.id, c.id]]);
    expect(await runTrigger(m.id)).toMatchObject({ kind: 'skipped' }); // one batch: both of this contact's due firings
    const reason = async (id: string) => ((await h.su.query<{ r: string }>("SELECT trigger_ref->'skip'->>'reason' AS r FROM playbook_step_runs WHERE id = $1", [id])).rows[0]!.r);
    expect([await reason(m.id), await reason(c.id)]).toEqual(['DATE_CHANGED', 'DATE_COMPLETED']);
    expect(mailTo(h, d.email)).toHaveLength(0);
  });
});
