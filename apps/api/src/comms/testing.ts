// Test helpers for the api/comms integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server or the module's public functions as
// app_user. The superuser pool only reads state back, moves clocks (stored instants) and inserts rows
// that have no application path in this module (assistant actions, playbooks, enrollments: api/assistant
// builds those later).
import { randomUUID } from 'node:crypto';
import { contentSha256 } from '@realty/core/assistant';
import type { LightMyRequestResponse } from 'fastify';
import { type ApiHarness, type TestClient } from '../auth/testHarness.js';
import { call, freshReauth } from '../admin/testing.js';
import { type LeadsWorld, type WorldOptions, leadsWorld, randomPhone } from '../leads/testing.js';
import { signedHeader, telephonySignature } from '../providers/webhooks.js';
import { type Worker, createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import type { JobHandler } from '../worker/types.js';
import { makeCommsHandlers } from './handlers.js';
import { depsFromPlatform } from './runtime.js';
import type { CommsDeps } from './types.js';

export { call, freshReauth, randomPhone };

export interface CommsWorld extends LeadsWorld {
  others: TestClient[];
  deps: CommsDeps;
  mainNumberId: string;
  mainNumber: string;
  registrationId: string;
  identityId: string;
}

/** A tenant with an approved 10DLC registration, a team main number and a team email identity. */
export async function commsWorld(h: ApiHarness, o: WorldOptions = {}): Promise<CommsWorld> {
  const w = await leadsWorld(h, { agents: 2, ...o });
  await freshReauth(h, w.owner);
  const num = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'team_main', areaCode: '415' });
  if (num.status !== 201) throw new Error(`number: ${num.status} ${JSON.stringify(num.body)}`);
  const reg = await call<{ registration: { id: string } }>(w.owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'customer care', sampleMessages: ['Hi, this is your agent following up.'], optInDescription: 'Leads opt in on our website form.' });
  if (reg.status !== 201) throw new Error(`registration: ${reg.status} ${JSON.stringify(reg.body)}`);
  const refreshed = await call<{ registration: { status: string } }>(w.owner, 'POST', `/sender-registrations/${reg.body.registration.id}/refresh`);
  if (refreshed.body.registration?.status !== 'approved') throw new Error(`registration not approved: ${refreshed.status} ${JSON.stringify(refreshed.body)}`);
  const att = await call(w.owner, 'PATCH', `/numbers/${num.body.number.id}/registration`, { registrationId: reg.body.registration.id });
  if (att.status !== 200) throw new Error(`attach: ${att.status} ${JSON.stringify(att.body)}`);
  const ident = await call<{ identity: { id: string } }>(w.owner, 'POST', '/email-identities', { fromAddress: `team-${randomUUID().slice(0, 6)}@send.example.test`, displayName: 'Team A' });
  if (ident.status !== 201) throw new Error(`identity: ${ident.status} ${JSON.stringify(ident.body)}`);
  return { ...w, deps: depsFromPlatform(h.app.platform), mainNumberId: num.body.number.id, mainNumber: num.body.number.e164, registrationId: reg.body.registration.id, identityId: ident.body.identity.id };
}

let emailSeq = 0;
export function randomEmail(): string {
  emailSeq += 1;
  return `client-${Date.now().toString(36)}-${emailSeq}@example.test`;
}

export interface TestContact {
  id: string;
  phone: string;
  email: string;
}

/** A contact the agent creates (owned by the agent), optionally with staff-entered express consent. */
export async function ownedContact(agent: TestClient, o: { phone?: string; email?: string; consent?: boolean; firstName?: string; confirmDistinct?: boolean } = {}): Promise<TestContact> {
  const phone = o.phone ?? randomPhone();
  const email = o.email ?? randomEmail();
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: o.firstName ?? 'Jane', lastName: 'Doe', phones: [phone], emails: [email], ...(o.confirmDistinct ? { confirmDistinct: true } : {}) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`contact: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.contact.id;
  if (o.consent !== false) await grantConsent(agent, id, 'sms');
  return { id, phone, email };
}

export async function pointId(h: ApiHarness, contactId: string, kind: 'phone' | 'email'): Promise<string> {
  const r = await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND kind = $2 ORDER BY created_at LIMIT 1', [contactId, kind]);
  return r.rows[0]!.id;
}

/** Staff-entered express consent (agent_entry, R-CONSENT-4) for every purpose of a channel. */
export async function grantConsent(agent: TestClient, contactId: string, channel: 'sms' | 'email' | 'voice'): Promise<void> {
  const h = agent.h;
  const pid = await pointId(h, contactId, channel === 'email' ? 'email' : 'phone');
  const r = await call(agent, 'POST', `/contacts/${contactId}/consent`, { kind: 'record', pointId: pid, channel, purpose: 'all', level: 'express', evidence: { note: 'asked on the phone' } });
  if (r.status !== 200) throw new Error(`consent: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function sendText(agent: TestClient, contactId: string, body: string, extra: Record<string, unknown> = {}) {
  return call<{ message: { id: string; status: string; statusReason: string | null; body: string } | null; decision: { id: string | null; outcome: string; reasons: string[]; explanation: string; phase: string } | null; result: string }>(
    agent,
    'POST',
    `/contacts/${contactId}/messages`,
    { channel: 'sms', body, idempotencyKey: `k-${randomUUID()}`, ...extra },
  );
}

/** A signed Twilio-shaped form webhook. */
export async function telephonyWebhook(h: ApiHarness, path: string, params: Record<string, string>): Promise<LightMyRequestResponse> {
  const url = new URL(`/api${path}`, h.config.publicBaseUrl).toString();
  const sig = telephonySignature(h.config.webhookSecrets.telephony, url, params);
  return h.app.inject({ method: 'POST', url: `/api${path}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: new URLSearchParams(params).toString() });
}

let sidSeq = 0;
export function sid(prefix = 'SM'): string {
  sidSeq += 1;
  return `${prefix}${Date.now().toString(16)}${String(sidSeq).padStart(6, '0')}${Math.random().toString(16).slice(2, 10)}`;
}

export async function inboundSms(h: ApiHarness, from: string, to: string, body: string, messageSid = sid()): Promise<LightMyRequestResponse> {
  return telephonyWebhook(h, '/webhooks/telephony/sms', { MessageSid: messageSid, From: from, To: to, Body: body, NumMedia: '0' });
}

export async function emailWebhook(h: ApiHarness, path: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  const raw = JSON.stringify(body);
  return h.app.inject({ method: 'POST', url: `/api${path}`, headers: { 'content-type': 'application/json', 'x-realty-signature': signedHeader(h.config.webhookSecrets.email, Math.floor(Date.now() / 1000), raw) }, payload: raw });
}

export async function messageRow(h: ApiHarness, id: string): Promise<{ status: string; status_reason: string | null; gate_decision_id: string | null; dispatched_at: Date | null; scheduled_for: Date | null; body: string; provider_message_ref: string | null }> {
  return (await h.su.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
}

export async function decisionsFor(h: ApiHarness, where: { messageId?: string; contactId?: string; callId?: string }): Promise<{ id: string; phase: string; outcome: string; reason_codes: string[]; explanation: string; policy_version_id: string; core_rules_version: string; inputs: Record<string, unknown>; inputs_sha256: string; initiator: string; action_category: string; recipient_kind: string }[]> {
  if (where.messageId) return (await h.su.query('SELECT * FROM gate_decisions WHERE message_id = $1 ORDER BY evaluated_at, id', [where.messageId])).rows;
  if (where.callId) return (await h.su.query('SELECT * FROM gate_decisions WHERE call_id = $1 ORDER BY evaluated_at, id', [where.callId])).rows;
  return (await h.su.query('SELECT * FROM gate_decisions WHERE contact_id = $1 ORDER BY evaluated_at, id', [where.contactId])).rows;
}

/** A worker over api/comms' handlers on the harness database and fakes. */
export function commsWorker(h: ApiHarness, extra: JobHandler<unknown>[] = []): Worker {
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...extra]);
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 2, worker: `comms-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/** Runs due jobs of the given kinds once (makes their run_at due first). */
export async function runJobs(h: ApiHarness, tenantId: string, kinds: string[]): Promise<void> {
  await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = ANY ($2) AND status = 'pending'`, [tenantId, kinds]);
  await commsWorker(h).drain(10);
}

// ---- assistant fixtures (no application path in this module: api/assistant writes these) -------------

export interface PlaybookFixture {
  playbookId: string;
  versionId: string;
  enrollmentId: string;
  stepRunId: string;
  actionId: string;
}

/** A team or agent playbook version, approved with a matching approval row, and one live enrollment + step run. */
export async function playbookFixture(h: ApiHarness, tenantId: string, approver: TestClient, contactId: string, o: { scope: 'team' | 'agent'; ownerUserId?: string; step: Record<string, unknown>; extraSteps?: Record<string, unknown>[]; body: string; category: string; purpose: 'marketing' | 'informational' }): Promise<PlaybookFixture> {
  const playbookId = randomUUID();
  const versionId = randomUUID();
  const steps = [o.step, ...(o.extraSteps ?? [])];
  const tone = {};
  const sha = contentSha256(steps as never, tone as never);
  const kind = o.category === 'speed_to_lead_reply' ? 'new_lead_response' : 'nurture';
  await h.su.query('INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, playbookId, kind, o.scope, o.scope === 'agent' ? o.ownerUserId : null, 'Test playbook']);
  await h.su.query("INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id) VALUES ($1,$2,$3,1,$4,$5,$6,'draft',$7)", [tenantId, versionId, playbookId, JSON.stringify(steps), JSON.stringify(tone), sha, approver.userId]);
  // approval through the real path (RLS + playbook_approvals_guard), then the version transition
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at) VALUES ($1,$2,$3,'approve',$4,$5,$6,'I approve these messages',now())", [tenantId, randomUUID(), versionId, approver.userId, approver.role, sha]);
    await c.query("UPDATE playbook_versions SET status = 'approved' WHERE id = $1", [versionId]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const enrollmentId = randomUUID();
  await h.su.query("INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state) VALUES ($1,$2,$3,$4,$5,'new_lead','active')", [tenantId, enrollmentId, playbookId, versionId, contactId]);
  const stepRunId = randomUUID();
  await h.su.query("INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for) VALUES ($1,$2,$3,$4,$5,'scheduled',now())", [tenantId, stepRunId, enrollmentId, versionId, (o.step as { stepKey: string }).stepKey]);
  const actionId = randomUUID();
  const owner = (await h.su.query<{ owner_user_id: string | null; ownership_period_seq: string | null }>('SELECT owner_user_id, ownership_period_seq FROM contacts WHERE id = $1', [contactId])).rows[0]!;
  await h.su.query(
    "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id, explanation, payload, bound_ownership_seq) VALUES ($1,$2,$3,'autonomous_message',$4,'within_playbook',$5,'proposed',$6,'Playbook step',$7,$8)",
    [tenantId, actionId, contactId, o.category, versionId, owner.owner_user_id, JSON.stringify({ body: o.body }), owner.ownership_period_seq],
  );
  return { playbookId, versionId, enrollmentId, stepRunId, actionId };
}

export async function approvedDraft(h: ApiHarness, tenantId: string, contactId: string, approver: TestClient, category = 'novel_message'): Promise<string> {
  const id = randomUUID();
  const owner = (await h.su.query<{ owner_user_id: string | null; ownership_period_seq: string | null }>('SELECT owner_user_id, ownership_period_seq FROM contacts WHERE id = $1', [contactId])).rows[0]!;
  await h.su.query(
    "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq, decided_by_user_id, decided_at) VALUES ($1,$2,$3,'message_draft',$4,'requires_approval','approved',$5,'Draft',$6,$7,$8,now())",
    [tenantId, id, contactId, category, owner.owner_user_id, JSON.stringify({}), owner.ownership_period_seq, approver.userId],
  );
  return id;
}
