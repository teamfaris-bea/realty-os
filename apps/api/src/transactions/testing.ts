// Test helpers for api/transactions (imported by *.test.ts only). Fakes only: the fake email and telephony providers
// of the harness; no real provider, lead or network call. The application acts through the real server as app_user;
// the superuser pool only reads state back, moves stored instants into the past (clock fixtures) and writes rows
// that have no application path (a legacy Phase 1 date without instants, a deal contact removed before sending).
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { approvedPlaybook } from '../assistant/testing.js';
import { makeAssistantHandlers } from '../assistant/handlers.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { call, ownedContact } from '../comms/testing.js';
import { makeNurtureHandlers } from '../nurture/handlers.js';
import { type NurtureWorld, nurtureWorld } from '../nurture/testing.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { makeTransactionHandlers } from './handlers.js';
import { dateChangedInTx, milestonesReconcileInTx } from './reconcile.js';

export { call };

export interface TxnWorld extends NurtureWorld {
  admin: TestClient;
  tc: TestClient;
  isa: TestClient;
  zone: string;
}

export async function txnWorld(h: ApiHarness): Promise<TxnWorld> {
  const w = await nurtureWorld(h, { others: ['admin', 'tc', 'isa'] });
  const z = await h.su.query<{ z: string }>('SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]);
  return { ...w, admin: w.others[0]!, tc: w.others[1]!, isa: w.others[2]!, zone: z.rows[0]!.z };
}

/** Today's local date in the tenant zone, plus `days`. */
export function localDay(zone: string, days = 0, from = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(from));
  const [y, m, d] = parts.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface TestDeal {
  dealId: string;
  contactId: string;
  email: string;
}

/** A deal of `agent` on a new contact they own (role buyer for a buy deal); the TC is a member unless `tc: false`. */
export async function deal(h: ApiHarness, w: TxnWorld, agent: TestClient, o: { side?: 'buy' | 'sell' | 'dual' | 'lease'; tc?: boolean; firstName?: string } = {}): Promise<TestDeal> {
  const c = await ownedContact(agent, { consent: false, firstName: o.firstName ?? 'Robin' });
  const d = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: c.id, side: o.side ?? 'buy' });
  if (d.status !== 201) throw new Error(`deal: ${d.status} ${JSON.stringify(d.body)}`);
  if (o.tc !== false) {
    const m = await call(w.owner, 'POST', `/deals/${d.body.deal.id}/members`, { userId: w.tc.userId, role: 'tc' });
    if (m.status !== 200) throw new Error(`member: ${m.status} ${JSON.stringify(m.body)}`);
  }
  return { dealId: d.body.deal.id, contactId: c.id, email: c.email };
}

/** Adds a new contact owned by `owner` to the deal in `role`. */
export async function dealContact(agent: TestClient, dealId: string, role: string, o: { owner?: TestClient; firstName?: string } = {}): Promise<{ id: string; email: string }> {
  const c = await ownedContact(o.owner ?? agent, { consent: false, firstName: o.firstName ?? 'Pat' });
  const r = await call(agent, 'POST', `/deals/${dealId}/contacts`, { contactId: c.id, role });
  if (r.status !== 200) throw new Error(`deal contact: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: c.id, email: c.email };
}

/** A fictional tenant template (test data only; no state's contract defaults). */
export function template(o: { id?: string; version?: number; side?: string; jurisdiction?: string; reviewed?: boolean; rules?: unknown[] } = {}): Record<string, unknown> {
  return {
    id: o.id ?? 'purchase-test',
    version: o.version ?? 1,
    name: 'Purchase (test data)',
    side: o.side ?? 'buy',
    jurisdiction: o.jurisdiction ?? 'US',
    ...(o.reviewed === undefined ? {} : { reviewed: o.reviewed }),
    rules: o.rules ?? [
      { key: 'inspection', kind: 'inspection', offsetDays: 10, dayCount: 'business', responsible: 'buyer', reminderDaysBefore: 2 },
      { key: 'appraisal', kind: 'appraisal', offsetDays: 17, dayCount: 'calendar', responsible: 'lender', reminderDaysBefore: 3 },
      { key: 'closing', kind: 'closing', offsetDays: 30, dayCount: 'calendar', reminderDaysBefore: 5 },
    ],
  };
}

export async function putTemplates(by: TestClient, templates: unknown[]) {
  return call<{ templates: unknown[]; parsed: { id: string; reviewed: boolean }[]; invalid: { index: number; error: string }[] }>(by, 'PUT', '/transactions/milestone-templates', { templates });
}

/** The transaction_updates content, with the recipients' roles of the step (default: the built-in client roles). */
export function updatesContent(o: { roles?: string[]; template?: string; subject?: string } = {}): Record<string, unknown> {
  return {
    kind: 'triggers',
    digestWindowMinutes: 0,
    triggers: [
      {
        trigger: 'deal_date_upcoming',
        stepKey: 'deal_date_upcoming',
        channel: 'email',
        offsetSeconds: 0,
        purpose: 'informational',
        category: 'reminder',
        intent: 'deadline_reminder',
        subject: o.subject ?? 'A date on your transaction is coming up',
        template: o.template ?? 'Hi {{first_name}},\n\nA quick heads-up: {{document_name}} is coming up on {{due_date}}. Reply here with any questions.',
        slots: ['first_name', 'document_name', 'due_date'],
        maxLength: 2000,
        roles: o.roles ?? ['buyer', 'seller', 'co_buyer', 'co_seller'],
      },
    ],
  };
}

/** The Owner approves the team Milestone updates playbook (from the built-in template, optionally edited). */
export async function approveUpdates(owner: TestClient, o: { roles?: string[]; template?: string } = {}) {
  return approvedPlaybook(owner, { templateKey: 'transaction_updates', ...(o.roles || o.template ? { steps: updatesContent(o) } : {}) });
}

/** One milestones.reconcile pass as the worker runs it (system actor), at `at` or now. */
export async function reconcile(h: ApiHarness, tenantId: string, at?: Instant) {
  const deps = depsFromPlatform(h.app.platform);
  return withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => milestonesReconcileInTx(tx, deps, at ?? now), { db: h.database });
}

export async function dateChanged(h: ApiHarness, tenantId: string, dealDateId: string) {
  return withTenantTx(systemActor(tenantId, 'worker'), (tx) => dateChangedInTx(tx, dealDateId), { db: h.database });
}

/** Runs the pending jobs of the lane and what they enqueue (date-changed, trigger.step, comms.dispatch), `rounds` times. */
export async function drain(h: ApiHarness, tenantId: string, rounds = 2): Promise<void> {
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps), ...makeNurtureHandlers(() => deps), ...makeTransactionHandlers(() => deps)]);
  for (let i = 0; i < rounds; i++) {
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND kind IN ('milestones.date_changed','trigger.step','comms.dispatch','triggers.reconcile')`, [tenantId]);
    await createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 1, worker: `txn-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger }).drain(30);
  }
}

export interface DateRowView {
  id: string;
  status: string;
  source: string;
  due_on: string;
  due_at: Date | null;
  reminder_at: Date | null;
  completed_at: Date | null;
  due_version: number;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
  responsible: string | null;
  basis: Record<string, unknown>;
  label: string | null;
}

/**
 * A legacy Phase 1 row as it exists on the base (status confirmed by default, no confirmer, no instants). Rows like
 * this were written before 0018's guard existed, so the fixture writes it with triggers off (superuser session).
 */
export async function legacyDate(h: ApiHarness, tenantId: string, dealId: string, kind: string, dueOn: string, o: { completed?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, completed_at) VALUES ($1,$2,$3,$4,$5::date, ${o.completed ? 'now()' : 'NULL'})`, [tenantId, id, dealId, kind, dueOn]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return id;
}

export async function dateRow(h: ApiHarness, id: string): Promise<DateRowView> {
  return (await h.su.query<DateRowView>('SELECT id, status, source, due_on::text AS due_on, due_at, reminder_at, completed_at, due_version, confirmed_by_user_id, confirmed_at, responsible, basis, label FROM deal_dates WHERE id = $1', [id])).rows[0]!;
}

export async function runsOfDate(h: ApiHarness, dateId: string) {
  return (
    await h.su.query<{ id: string; contact_id: string; status: string; trigger_key: string; scheduled_for: Date; trigger_ref: Record<string, unknown>; message_id: string | null; assistant_action_id: string | null }>(
      "SELECT id, contact_id, status, trigger_key, scheduled_for, trigger_ref, message_id, assistant_action_id FROM playbook_step_runs WHERE enrollment_id IS NULL AND trigger_ref->'ref'->>'dealDateId' = $1 ORDER BY trigger_key",
      [dateId],
    )
  ).rows;
}

/** Emails the fake provider accepted for this address. */
export function mailTo(h: ApiHarness, email: string) {
  return h.providers.email.sent.filter((m: { to: string }) => m.to === email);
}

/** Confirms a date with a reminder whose time already passed (reminder_at = now), so one reconcile pass fires it. */
export async function confirmDueSoon(by: TestClient, dateId: string, zone: string, o: { daysAhead?: number; reminderDaysBefore?: number } = {}) {
  return call(by, 'POST', `/deal-dates/${dateId}/confirm`, { dueOn: localDay(zone, o.daysAhead ?? 2), reminderDaysBefore: o.reminderDaysBefore ?? 5 });
}

/** A date entered on the deal screen (Phase 1 route; confirmed by the person who typed it). */
export async function enterDate(by: TestClient, dealId: string, kind: string, dueOn: string, label?: string) {
  return call<{ date: { id: string } }>(by, 'POST', `/deals/${dealId}/dates`, { kind, dueOn, ...(label ? { label } : {}) });
}

export async function milestones(by: TestClient, dealId: string) {
  return call<{
    dates: { id: string; status: string; dueOn: string; dueVersion: number; risk: { state: string; text: string } | null; basis: Record<string, unknown>; updates: { contactId: string; status: string; text: string }[] }[];
    riskItems: { dealDateId: string | null }[];
    templates: { id: string; reviewed: boolean }[];
    updates: { approved: boolean; roles: string[] };
    acceptanceDate: string | null;
  }>(by, 'GET', `/deals/${dealId}/milestones`);
}
