// api/transactions over real Postgres (module 31; R-TXN-1..6, R-OWN-27, E95, E96, E143). The application acts through
// the real server as app_user; the reconcile runs as the system actor, as the 5-minute job does; messages go through
// module 26 (executeTriggerRun) and comms/dispatch.ts to the fake email provider only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { firingsDue, reconcileAndRun } from '../nurture/testing.js';
import {
  type TxnWorld,
  approveUpdates,
  call,
  confirmDueSoon,
  dateRow,
  deal,
  dealContact,
  drain,
  enterDate,
  legacyDate,
  localDay,
  mailTo,
  milestones,
  putTemplates,
  reconcile,
  runsOfDate,
  template,
  txnWorld,
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

const DAY = 86_400_000;

/** The local wall time (YYYY-MM-DD HH:MM:SS) of an instant in a zone. */
function wall(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at);
}

describe('R-TXN-1 R-TXN-2 the one confirm path', () => {
  it('R-TXN-2: a date typed on the Phase 1 screen is confirmed by the person who typed it and gets its stored instants at write time', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const dueOn = localDay(w.zone, 20);
    const r = await enterDate(w.agents[0]!, d.dealId, 'closing', dueOn);
    expect(r.status).toBe(201);
    const row = await dateRow(h, r.body.date.id);
    expect(row).toMatchObject({ status: 'confirmed', source: 'manual', due_on: dueOn, due_version: 1, confirmed_by_user_id: w.agents[0]!.userId });
    expect(row.confirmed_at).not.toBeNull();
    expect(wall(row.due_at!, w.zone)).toBe(`${dueOn} 23:59:59`);
    expect(row.basis).toMatchObject({ kind: 'manual', zone: w.zone, dueRule: 'end_of_local_day', reminderRule: null });
    expect(row.reminder_at).toBeNull(); // the deal screen sets no reminder: no update until someone asks for one
  });

  it('R-TXN-2 R-TXN-1: a legacy Phase 1 row (no confirmer, no instants) gets its instants within one reconcile pass; the system never moves it', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const dueOn = localDay(w.zone, 12);
    const id = await legacyDate(h, w.tenantId, d.dealId, 'inspection', dueOn);
    expect((await dateRow(h, id)).due_at).toBeNull();
    const r = await reconcile(h, w.tenantId);
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    const row = await dateRow(h, id);
    expect(row).toMatchObject({ due_on: dueOn, due_version: 1, status: 'confirmed', confirmed_by_user_id: null, reminder_at: null });
    expect(wall(row.due_at!, w.zone)).toBe(`${dueOn} 23:59:59`);
    const second = await reconcile(h, w.tenantId);
    expect((await dateRow(h, id)).due_at!.getTime()).toBe(row.due_at!.getTime());
    expect(second.repaired).toBe(0);
  });

  it('R-TXN-5: moving a confirmed date on the deal screen bumps due_version and recomputes the instants; a label edit keeps the version; completion is completed_at alone', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const r = await enterDate(w.agents[0]!, d.dealId, 'inspection', localDay(w.zone, 9));
    const id = r.body.date.id;
    const label = await call(w.tc, 'PATCH', `/deal-dates/${id}`, { label: 'Home inspection' });
    expect(label.status).toBe(200);
    expect((await dateRow(h, id)).due_version).toBe(1);
    const moved = await call(w.tc, 'PATCH', `/deal-dates/${id}`, { dueOn: localDay(w.zone, 11) });
    expect(moved.status).toBe(200);
    const row = await dateRow(h, id);
    expect(row).toMatchObject({ due_version: 2, due_on: localDay(w.zone, 11), confirmed_by_user_id: w.tc.userId, label: 'Home inspection' });
    expect(wall(row.due_at!, w.zone)).toBe(`${localDay(w.zone, 11)} 23:59:59`);
    const done = await call(w.tc, 'PATCH', `/deal-dates/${id}`, { completed: true });
    expect(done.status).toBe(200);
    expect(await dateRow(h, id)).toMatchObject({ due_version: 2, due_on: localDay(w.zone, 11), reminder_at: null });
    expect((await dateRow(h, id)).completed_at).not.toBeNull();
  });

  it('R-OWN-27: changing the tenant zone moves no stored instant (the reconcile keeps the zone recorded in the basis)', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const r = await enterDate(w.agents[0]!, d.dealId, 'appraisal', localDay(w.zone, 15));
    const before = await dateRow(h, r.body.date.id);
    const other = w.zone === 'Pacific/Auckland' ? 'America/Los_Angeles' : 'Pacific/Auckland';
    await h.su.query('UPDATE tenant_settings SET default_timezone = $2 WHERE tenant_id = $1', [w.tenantId, other]);
    try {
      await reconcile(h, w.tenantId);
      const after = await dateRow(h, r.body.date.id);
      expect(after.due_at!.getTime()).toBe(before.due_at!.getTime());
      expect(after.basis['zone']).toBe(w.zone);
    } finally {
      await h.su.query('UPDATE tenant_settings SET default_timezone = $2 WHERE tenant_id = $1', [w.tenantId, w.zone]);
    }
  });
});

describe('R-TXN-6 E95 milestone plans', () => {
  it('R-TXN-6: no templates means no plan, and the deal screen shows none (nothing hard-coded)', async () => {
    await putTemplates(w.owner, []);
    const d = await deal(h, w, w.agents[0]!);
    const m = await milestones(w.tc, d.dealId);
    expect(m.status).toBe(200);
    expect(m.body.templates).toEqual([]);
    const p = await call(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: localDay(w.zone), templateId: 'purchase-test', templateVersion: 1 });
    expect([p.status, p.code]).toEqual([422, 'MILESTONE_TEMPLATE_NOT_FOUND']);
  });

  it('E95 R-TXN-1 R-TXN-6: through the plan route a date that lands on a non-business day keeps its date and shows its rule, the note, and "not reviewed"', async () => {
    // acceptance on a Monday; 5 calendar days later is a Saturday
    const monday = '2027-03-01';
    const t = template({ id: 'weekend-test', rules: [{ key: 'option', kind: 'custom', label: 'Option period ends', offsetDays: 5, dayCount: 'calendar', reminderDaysBefore: 1 }, { key: 'inspection', kind: 'inspection', offsetDays: 5, dayCount: 'business' }] });
    expect((await putTemplates(w.owner, [t])).status).toBe(200);
    const d = await deal(h, w, w.agents[0]!);
    const p = await call<{ proposals: { dateId: string; ruleKey: string; dueOn: string; rule: string; nonBusinessDayNote: string | null; status: string }[]; template: { reviewed: boolean }; calendar: { note: string; reviewed: boolean } }>(
      w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: monday, templateId: 'weekend-test', templateVersion: 1 },
    );
    expect(p.status).toBe(200);
    expect(p.body.template.reviewed).toBe(false);
    expect(p.body.calendar).toMatchObject({ reviewed: false, note: 'Business days: Monday to Friday; holidays are not counted. Not reviewed by counsel.' });
    const option = p.body.proposals.find((x) => x.ruleKey === 'option')!;
    expect(option).toMatchObject({ dueOn: '2027-03-06', rule: '5 days after acceptance (2027-03-01)', status: 'proposed' });
    expect(option.nonBusinessDayNote).toMatch(/2027-03-06 is not a business day.*The date was not moved/);
    expect(p.body.proposals.find((x) => x.ruleKey === 'inspection')).toMatchObject({ dueOn: '2027-03-08', rule: '5 business days after acceptance (2027-03-01)', nonBusinessDayNote: null });
    // stored as proposals: nothing drives anything until a person confirms
    const row = await dateRow(h, option.dateId);
    expect(row).toMatchObject({ status: 'proposed', source: 'template', due_on: '2027-03-06', due_at: null, reminder_at: null, confirmed_by_user_id: null });
    expect(row.basis).toMatchObject({ templateId: 'weekend-test', ruleKey: 'option', anchorDate: monday, reminderDaysBefore: 1, templateReviewed: false });
    const m = await milestones(w.tc, d.dealId);
    expect(m.body.dates.find((x) => x.id === option.dateId)).toMatchObject({ status: 'proposed', risk: null, basis: { rule: '5 days after acceptance (2027-03-01)', templateReviewed: false } });
    expect(m.body.acceptanceDate).toBe(monday);
  });

  it('R-TXN-1: re-planning with the same template updates its proposals in place and inserts new rules; a gone rule stays and is listed; a confirmed date is never touched; another template is refused', async () => {
    const v1 = template({ id: 'replan', rules: [{ key: 'a', kind: 'inspection', offsetDays: 7, dayCount: 'calendar' }, { key: 'b', kind: 'appraisal', offsetDays: 14, dayCount: 'calendar' }, { key: 'c', kind: 'closing', offsetDays: 30, dayCount: 'calendar' }] });
    const v2 = template({ id: 'replan', version: 2, rules: [{ key: 'a', kind: 'inspection', offsetDays: 8, dayCount: 'calendar' }, { key: 'c', kind: 'closing', offsetDays: 31, dayCount: 'calendar' }, { key: 'd', kind: 'possession', offsetDays: 32, dayCount: 'calendar' }] });
    const other = template({ id: 'other' });
    await putTemplates(w.owner, [v1, v2, other]);
    const d = await deal(h, w, w.agents[0]!);
    const acc = '2027-04-01';
    const first = await call<{ proposals: { dateId: string; ruleKey: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: acc, templateId: 'replan', templateVersion: 1 });
    expect(first.status).toBe(200);
    const id = (k: string) => first.body.proposals.find((x) => x.ruleKey === k)!.dateId;
    // a person confirms c
    expect((await call(w.tc, 'POST', `/deal-dates/${id('c')}/confirm`, {})).status).toBe(200);
    const again = await call<{ proposals: { dateId: string; ruleKey: string; dueOn: string; status: string }[]; noLongerInTemplate: { dateId: string; ruleKey: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: acc, templateId: 'replan', templateVersion: 2 });
    expect(again.status).toBe(200);
    expect(again.body.proposals.find((x) => x.ruleKey === 'a')).toMatchObject({ dateId: id('a'), dueOn: '2027-04-09', status: 'proposed' });
    expect(again.body.proposals.find((x) => x.ruleKey === 'c')).toMatchObject({ dateId: id('c'), dueOn: '2027-05-01', status: 'confirmed' });
    expect(again.body.proposals.find((x) => x.ruleKey === 'd')!.status).toBe('proposed');
    expect(again.body.noLongerInTemplate).toEqual([expect.objectContaining({ dateId: id('b'), ruleKey: 'b' })]);
    expect((await dateRow(h, id('c'))).due_on).toBe('2027-05-01'); // untouched
    expect((await dateRow(h, id('b'))).status).toBe('proposed'); // never deleted or waived
    const refused = await call(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: acc, templateId: 'other', templateVersion: 1 });
    expect([refused.status, refused.code]).toEqual([409, 'MILESTONE_PLAN_OPEN']);
  });

  it('R-TXN-1 R-TXN-2: confirming a proposal in one call uses the reminder the proposal showed and stores the instants', async () => {
    await putTemplates(w.owner, [template()]);
    const d = await deal(h, w, w.agents[0]!);
    const acc = localDay(w.zone, 1);
    const p = await call<{ proposals: { dateId: string; ruleKey: string; dueOn: string }[] }>(w.tc, 'POST', `/deals/${d.dealId}/milestones/plan`, { acceptanceDate: acc, templateId: 'purchase-test', templateVersion: 1 });
    const closing = p.body.proposals.find((x) => x.ruleKey === 'closing')!;
    const c = await call(w.tc, 'POST', `/deal-dates/${closing.dateId}/confirm`, {});
    expect(c.status).toBe(200);
    const row = await dateRow(h, closing.dateId);
    expect(row).toMatchObject({ status: 'confirmed', source: 'template', confirmed_by_user_id: w.tc.userId, due_version: 1 });
    expect(wall(row.due_at!, w.zone)).toBe(`${closing.dueOn} 23:59:59`);
    // 5 days before, 09:00 local (the template rule's reminderDaysBefore)
    expect(wall(row.reminder_at!, w.zone)).toBe(`${localDay(w.zone, 26)} 09:00:00`);
    expect(row.basis).toMatchObject({ templateId: 'purchase-test', ruleKey: 'closing', reminderRule: { daysBefore: 5, localTime: '09:00' } });
  });
});

describe('R-TXN-4 updates go out only through module 26 (finding 1: at the stored reminder time)', () => {
  it('R-TXN-4: with no approved Milestone updates playbook a due reminder plans nothing, is not retried, and the deal screen says why', async () => {
    const d = await deal(h, w, w.agents[0]!);
    const e = await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20));
    expect((await confirmDueSoon(w.tc, e.body.date.id, w.zone)).status).toBe(200);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, e.body.date.id)).toEqual([]);
    expect((await dateRow(h, e.body.date.id)).reminder_at).toBeNull();
    const m = await milestones(w.tc, d.dealId);
    const up = m.body.dates.find((x) => x.id === e.body.date.id)!.updates.find((u) => u.contactId === d.contactId)!;
    expect(up).toMatchObject({ status: 'not_planned' });
    expect(up.text).toMatch(/no Milestone updates playbook was approved when the reminder came due/);
  });

  it('finding 1 R-TXN-4 E143: a firing is scheduled at its date\'s reminder_at, turned into firings once, and the email shows the contract date', async () => {
    await approveUpdates(w.owner);
    const d = await deal(h, w, w.agents[0]!, { firstName: 'Morgan' });
    const e = await enterDate(w.agents[0]!, d.dealId, 'inspection', localDay(w.zone, 20));
    const dueOn = localDay(w.zone, 2);
    expect((await confirmDueSoon(w.tc, e.body.date.id, w.zone)).status).toBe(200);
    const stored = await dateRow(h, e.body.date.id);
    expect(stored.reminder_at).not.toBeNull();
    await reconcile(h, w.tenantId);
    const runs = await runsOfDate(h, e.body.date.id);
    expect(runs.map((r) => r.trigger_key)).toEqual([`deal_date:${e.body.date.id}:v2:deal_date_upcoming:${d.contactId}`]);
    expect(runs[0]!.scheduled_for.getTime()).toBe(stored.reminder_at!.getTime());
    expect((await dateRow(h, e.body.date.id)).reminder_at).toBeNull();
    // a second pass writes nothing; a re-confirm (same date) never sends twice
    await reconcile(h, w.tenantId);
    expect((await call(w.tc, 'POST', `/deal-dates/${e.body.date.id}/confirm`, {})).status).toBe(200);
    await reconcile(h, w.tenantId);
    expect(await runsOfDate(h, e.body.date.id)).toHaveLength(1);
    await reconcileAndRun(h, w.tenantId);
    const mail = mailTo(h, d.email);
    expect(mail).toHaveLength(1);
    const [y, mo, da] = dueOn.split('-').map(Number) as [number, number, number];
    const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, mo - 1, da))).replace(',', '');
    expect(mail[0]!.text).toContain(`The inspection deadline is coming up on ${shown}`);
    expect(mail[0]!.subject).toBe('A date on your transaction is coming up');
    expect((await runsOfDate(h, e.body.date.id))[0]!.status).toBe('sent');
    const m = await milestones(w.tc, d.dealId);
    expect(m.body.dates.find((x) => x.id === e.body.date.id)!.updates.find((u) => u.contactId === d.contactId)).toMatchObject({ status: 'sent' });
  });

  it('E143: a contact in a zone east of the tenant\'s is told the contract date, not the next day', async () => {
    const d = await deal(h, w, w.agents[0]!, { firstName: 'Kiri' });
    await h.su.query("UPDATE contacts SET timezone = 'Pacific/Kiritimati' WHERE id = $1", [d.contactId]);
    const e = await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20));
    const dueOn = localDay(w.zone, 2);
    await confirmDueSoon(w.tc, e.body.date.id, w.zone);
    await reconcile(h, w.tenantId);
    await reconcileAndRun(h, w.tenantId);
    const [y, mo, da] = dueOn.split('-').map(Number) as [number, number, number];
    const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, mo - 1, da))).replace(',', '');
    expect(mailTo(h, d.email).map((m) => m.text).join('\n')).toContain(`The closing date is coming up on ${shown}`);
  });
});

export { DAY, firingsDue, drain, dealContact };
