// Test helpers for the api/assistant integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server or this module's public functions as
// app_user (RLS-bound). The superuser pool only reads state back, moves clocks, and inserts rows that
// have no application path yet in Phase 1 (deals, appointments, listings: api/workspace; recorded calls
// and transcripts: api/comms' provider webhooks), exactly as the comms and leads tests do.
import { randomUUID } from 'node:crypto';
import type { Instant, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, decisionsFor, grantConsent, inboundSms, messageRow, ownedContact, pointId, randomEmail, randomPhone } from '../comms/testing.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import type { WorldOptions } from '../leads/testing.js';
import { type Worker, createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { enqueueStep } from './enrollments.js';
import { makeAssistantHandlers } from './handlers.js';
import type { AssistantDeps } from './types.js';

export { call, decisionsFor, grantConsent, inboundSms, messageRow, ownedContact, pointId, randomEmail, randomPhone };

export type AssistantWorld = CommsWorld;

export async function assistantWorld(h: ApiHarness, o: WorldOptions = {}): Promise<AssistantWorld> {
  return commsWorld(h, o);
}

export function depsOf(h: ApiHarness): AssistantDeps {
  return depsFromPlatform(h.app.platform);
}

/** A worker over the assistant + comms handlers on the harness database and fakes. */
export function assistantWorker(h: ApiHarness, queues: ('realtime' | 'default')[] = ['realtime', 'default']): Worker {
  const deps = depsOf(h);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps)]);
  return createWorker({ db: h.database, registry, providers: h.providers, queues, concurrency: 2, worker: `assistant-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/**
 * Makes pending jobs of these kinds due now and drains the queues (jobs they enqueue that are due run
 * too). `queues: ['default']` runs playbook steps without the realtime comms.dispatch jobs they queue.
 */
export async function runJobs(h: ApiHarness, tenantId: string, kinds: string[], rounds = 3, queues: ('realtime' | 'default')[] = ['realtime', 'default']): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = ANY ($2) AND status = 'pending'`, [tenantId, kinds]);
    await assistantWorker(h, queues).drain(20);
  }
}

/** Moves an enrollment's next step into the past (a clock fixture) and runs the step + dispatch jobs. */
export async function stepNow(h: ApiHarness, tenantId: string, enrollmentId: string): Promise<void> {
  await h.su.query(`UPDATE playbook_enrollments SET next_step_due_at = now() - interval '1 second' WHERE id = $1 AND state = 'active'`, [enrollmentId]);
  await withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => enqueueStep(tx, enrollmentId, (now - 1000) as Instant), { db: h.database });
}

export interface ApprovedPlaybook {
  playbookId: string;
  versionId: string;
  sha: string;
}

/** Creates a playbook through the API (template or steps) and approves its first version. */
export async function approvedPlaybook(approver: TestClient, body: Record<string, unknown>): Promise<ApprovedPlaybook> {
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string; issues: unknown[] }[] } }>(approver, 'POST', '/playbooks', body);
  if (c.status !== 201) throw new Error(`create playbook: ${c.status} ${JSON.stringify(c.body)}`);
  const v = c.body.playbook.versions[0]!;
  const a = await call(approver, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 });
  if (a.status !== 200) throw new Error(`approve: ${a.status} ${JSON.stringify(a.body)}`);
  return { playbookId: c.body.playbook.id, versionId: v.id, sha: v.contentSha256 };
}

export function smsStep(o: { key?: string; category: string; intent: string; purpose: 'marketing' | 'informational'; template: string; slots?: string[]; anchor?: 'enrollment' | 'previous_step' | 'event'; offsetSeconds?: number; stopIf?: string[] }): Record<string, unknown> {
  return {
    stepKey: o.key ?? 'step_one',
    channel: 'sms',
    delay: { anchor: o.anchor ?? 'enrollment', offsetSeconds: o.offsetSeconds ?? 0 },
    purpose: o.purpose,
    category: o.category,
    intent: o.intent,
    template: o.template,
    personalization: 'none',
    slots: o.slots ?? [],
    maxLength: 640,
    stopIf: o.stopIf ?? [],
  };
}

/** An appointment row (api/workspace owns appointments; no application path yet in Phase 1). */
export async function appointment(h: ApiHarness, w: AssistantWorld, contactId: string, userId: string, o: { startsInMs?: number; location?: string } = {}): Promise<string> {
  const id = randomUUID();
  const start = new Date(Date.now() + (o.startsInMs ?? 3 * 86_400_000));
  await h.su.query(
    `INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, location, status, created_by_kind)
     VALUES ($1,$2,$3,$4,$4,'buyer_consult',$5,$6,$7,'scheduled','user')`,
    [w.tenantId, id, contactId, userId, start, new Date(start.getTime() + 3_600_000), o.location ?? 'Our office'],
  );
  return id;
}

/** A recorded, transcribed call (api/comms writes these from provider webhooks). The transcript is encrypted as comms does. */
export async function transcribedCall(h: ApiHarness, w: AssistantWorld, contactId: string, agentUserId: string, segments: { startMs: number; endMs: number; speaker: string; text: string }[], o: { startedAt?: Date } = {}): Promise<string> {
  const callId = randomUUID();
  const recId = randomUUID();
  const started = o.startedAt ?? new Date(Date.now() - 600_000);
  const conv = await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [contactId]);
  let convId = conv.rows[0]?.id;
  if (!convId) {
    convId = randomUUID();
    await h.su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3)', [w.tenantId, convId, contactId]);
  }
  await h.su.query(
    `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, answered_at, ended_at,
       duration_s, recording_mode, recording_announced_at, recording_decision)
     VALUES ($1,$2,$3,$4,'inbound',$5,'+14155550123','client','completed',$6,$6,$7,600,'announced_all_parties',$6,'{}')`,
    [w.tenantId, callId, convId, contactId, agentUserId, started, new Date(started.getTime() + 600_000)],
  );
  await h.su.query(
    `INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, source, consent_basis, status, retain_until)
     VALUES ($1,$2,$3,$4,$5,'provider','announced_all_parties','pending_copy', now() + interval '700 days')`,
    [w.tenantId, recId, callId, contactId, agentUserId],
  );
  const deps = depsOf(h);
  const tid = randomUUID();
  await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
    const enc = await deps.envelope.inTx(tx, w.tenantId as TenantId).encrypt(w.tenantId as TenantId, { table: 'transcripts', column: 'segments_enc', rowId: tid }, Buffer.from(JSON.stringify(segments)));
    await sql`INSERT INTO transcripts (tenant_id, id, recording_id, contact_id, status, language, segments_enc, key_version, provider)
              VALUES (app.tenant_id(), ${tid}, ${recId}, ${contactId}, 'ready', 'en', ${Buffer.from(enc)}, 1, 'fake')`.execute(tx);
  }, { db: h.database });
  return callId;
}

/** A team listing (api/workspace writes listings; no application path yet in Phase 1). */
export async function listing(h: ApiHarness, w: AssistantWorld, agentUserId: string, o: { postalCode?: string; city?: string; priceCents?: number; beds?: number; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft, property_type, listing_agent_user_id, list_date)
     VALUES ($1,$2,'team',$3,$4,$5,'CA',$6,$7,$8,20,1500,'single_family',$9, now()::date)`,
    [w.tenantId, id, o.status ?? 'active', `${Math.floor(Math.random() * 900) + 100} Oak St`, o.city ?? 'Oakland', o.postalCode ?? '94110', o.priceCents ?? 80_000_000, o.beds ?? 3, agentUserId],
  );
  return id;
}

export async function actionsOf(h: ApiHarness, contactId: string): Promise<{ id: string; kind: string; action_category: string; autonomy: string; status: string; owner_user_id: string | null; explanation: string; payload: Record<string, unknown> }[]> {
  return (await h.su.query('SELECT id, kind, action_category, autonomy, status, owner_user_id, explanation, payload FROM assistant_actions WHERE contact_id = $1 ORDER BY created_at, id', [contactId])).rows;
}

export async function messagesOf(h: ApiHarness, contactId: string): Promise<{ id: string; status: string; status_reason: string | null; initiator: string; channel: string; body: string; action_category: string; playbook_step_run_id: string | null; scheduled_for: Date | null }[]> {
  return (await h.su.query("SELECT id, status, status_reason, initiator, channel, body, action_category, playbook_step_run_id, scheduled_for FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at, id", [contactId])).rows;
}

export async function enrollmentRow(h: ApiHarness, id: string): Promise<{ state: string; pause_reason: string | null; stop_reason: string | null; current_step: number; playbook_version_id: string; next_step_due_at: Date | null }> {
  return (await h.su.query('SELECT state, pause_reason, stop_reason, current_step, playbook_version_id, next_step_due_at FROM playbook_enrollments WHERE id = $1', [id])).rows[0];
}

export async function auditRows(h: ApiHarness, tenantId: string, action: string): Promise<{ action: string; entity_id: string | null; actor_user_id: string | null; changes: Record<string, unknown> | null; reason: string | null }[]> {
  return (await h.su.query('SELECT action, entity_id, actor_user_id, changes, reason FROM audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;
}

/** Sets the tenant's AI switch (api/admin owns the settings route; this is the stored value). */
export async function setAiEnabled(h: ApiHarness, tenantId: string, on: boolean): Promise<void> {
  await h.su.query('UPDATE tenant_settings SET ai_enabled = $2 WHERE tenant_id = $1', [tenantId, on]);
}
