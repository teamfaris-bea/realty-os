// Test helpers of api/stage-automation (imported by *.test.ts only). Everything the application does goes
// through the real server (or this module's functions) as app_user; the superuser pool only reads back.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call, randomPhone } from '../comms/testing.js';
import { smsStep } from '../assistant/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileWith } from './reconcile.js';
import { pendingStageEvents } from './repos.js';

export interface StageResponse {
  stage: { stage: string };
  previousStage: string;
  rowVersion: number;
  automation: { started: string } | { skipped: string; plan: string } | null;
}

export const nurtureStep = (key = 'check_in') => smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your home search.', slots: ['first_name'] });

/** A playbook through the API (draft first version); `approve` approves it as `by`. */
export async function playbook(by: TestClient, o: { scope: 'team' | 'agent'; name: string; approve?: boolean; kind?: string }): Promise<{ id: string; versionId: string }> {
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(by, 'POST', '/playbooks', { kind: o.kind ?? 'nurture', scope: o.scope, name: o.name, steps: [nurtureStep()] });
  if (c.status !== 201) throw new Error(`create playbook: ${c.status} ${JSON.stringify(c.body)}`);
  const v = c.body.playbook.versions[0]!;
  if (o.approve !== false) {
    const a = await call(by, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 });
    if (a.status !== 200) throw new Error(`approve: ${a.status} ${JSON.stringify(a.body)}`);
  }
  return { id: c.body.playbook.id, versionId: v.id };
}

export function setStage(by: TestClient, playbookId: string, stage: string | null) {
  return call<{ playbook: { id: string; autoEnrollStage: string | null } }>(by, 'PUT', `/playbooks/${playbookId}/auto-enroll-stage`, { stage });
}

export function changeStage(by: TestClient, contactId: string, stage: string) {
  return call<StageResponse>(by, 'POST', `/contacts/${contactId}/stage`, { stage });
}

/** A stage change by `by` without the request path (as PATCH or a bulk stage action writes it). */
export async function rawStageChange(h: ApiHarness, by: TestClient, contactId: string, stage: string): Promise<string> {
  return withTenantTx(by.actor(), async (tx) => {
    await sql`UPDATE contacts SET stage = ${stage} WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
    const r = await sql<{ id: string }>`SELECT id FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx);
    return r.rows[0]!.id;
  }, { db: h.database });
}

/** What the worker does for one event (the stage_automation.reconcile job body). */
export async function reconcileAsJob(h: ApiHarness, tenantId: string, eventId: string) {
  const actor = systemActor(tenantId, 'assistant');
  return reconcileWith({ db: h.database }, actor, (fn) => withTenantTx(actor, fn, { db: h.database }), eventId);
}

export async function scanPending(h: ApiHarness, tenantId: string, sinceMs = 3_600_000): Promise<string[]> {
  return withTenantTx(systemActor(tenantId, 'assistant'), (tx, now) => pendingStageEvents(tx, (now - sinceMs) as never, 500), { db: h.database });
}

export async function enrollmentsOf(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ id: string; playbook_id: string; playbook_version_id: string; enrolled_by: string; enrolled_by_user_id: string | null; state: string }>(
    'SELECT id, playbook_id, playbook_version_id, enrolled_by, enrolled_by_user_id, state FROM playbook_enrollments WHERE contact_id = $1 ORDER BY created_at', [contactId])).rows;
}

export async function decisionsOf(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ stage_event_id: string; outcome: string; reason: string | null; playbook_id: string | null; enrollment_id: string | null }>(
    'SELECT stage_event_id, outcome, reason, playbook_id, enrollment_id FROM stage_automation_decisions WHERE contact_id = $1 ORDER BY decided_at', [contactId])).rows;
}

export async function newContact(by: TestClient, o: { phones?: string[]; emails?: string[]; firstName?: string } = {}): Promise<string> {
  const r = await call<{ contact: { id: string } }>(by, 'POST', '/contacts', { commandId: randomUUID(), firstName: o.firstName ?? 'Jane', lastName: 'Doe', phones: o.phones ?? [randomPhone()], emails: o.emails ?? [] });
  if (r.status !== 201) throw new Error(`contact: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}
