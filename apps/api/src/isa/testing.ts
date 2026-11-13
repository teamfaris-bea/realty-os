// Test fixtures for module 75 (fakes only: FakeIsaAi / HostileIsaAi, the fake telephony and email adapters, the fake
// DNC provider; no real model, send, call or vendor). Every application step goes through the API routes or the
// worker; the superuser pool only clears the counsel pack, seeds the approved ai_isa policy (the policy editor is the
// web lane's) and moves stored instants (there is no fake clock).
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import type { AiProvider } from '../providers/types.js';
import { call } from '../admin/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import type { ApiHarness } from '../auth/testHarness.js';
import { makeAssistantHandlers } from '../assistant/handlers.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { commsWorld, type CommsWorld, freshReauth, ownedContact, type TestContact } from '../comms/testing.js';
import { FakeIsaAi } from '../providers/fake/isaAi.js';
import { silentLogger } from '../worker/observability.js';
import { createWorker } from '../worker/loop.js';
import { HandlerRegistry } from '../worker/registry.js';
import { DEFAULT_AI_ISA_CONTENT } from './coreSeam.js';
import { makeIsaHandlers } from './handlers.js';
import { ownershipFollowupHandler } from '../worker/handlers/followup.js';

export { call, freshReauth };

// b12 recheck R25: every name is its own canonical name (core ianaZone). 'Etc/GMT' is 'UTC' canonically: the contact
// stored 'Etc/GMT' while the turn stored 'UTC', so the DB guard refused every AI send ISA_ZONE_UNRESOLVED in the hour
// (10:00-10:59 UTC) this fixture picked it. testing.test.ts holds every pick to that.
const ETC = Array.from({ length: 25 }, (_, i) => i - 12).map((n) => (n === 0 ? 'UTC' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`));
function localOf(zone: string, at: Date): { hour: number; isoDow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), isoDow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1 };
}
/** A fixed-offset zone where it is now (or at `at`) 10:00–17:59, Monday to Saturday. */
export const openZone = (at = new Date()) => ETC.find((z) => { const l = localOf(z, at); return l.hour >= 10 && l.hour < 18 && l.isoDow <= 6; })!;
/** A fixed-offset zone where it is now (or at `at`) 01:00–04:59. */
export const closedZone = (at = new Date()) => ETC.find((z) => { const l = localOf(z, at); return l.hour >= 1 && l.hour < 5; })!;

export interface IsaWorld extends CommsWorld {
  versionId: string;
  versionSha: string;
  ai: FakeIsaAi;
}

/** A tenant with the AI ISA fully authorized on fakes: pack cleared, switch on, an approved policy, agent 0 opted in. */
export async function isaWorld(h: ApiHarness, o: { optIn?: boolean; clear?: boolean } = {}): Promise<IsaWorld> {
  const w = await commsWorld(h, { agents: 2, teamLead: true });
  const pb = randomUUID();
  const versionId = randomUUID();
  const versionSha = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const content = { ...DEFAULT_AI_ISA_CONTENT };
  await h.su.query(`SET session_replication_role = replica`);
  try {
    await h.su.query(`INSERT INTO playbooks (tenant_id, id, kind, scope, name, status) VALUES ($1, $2, 'ai_isa', 'team', 'AI assistant', 'active')`, [w.tenantId, pb]);
    await h.su.query(`INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
      VALUES ($1, $2, $3, 1, $4::jsonb, '{}'::jsonb, $5, 'approved', $6)`, [w.tenantId, versionId, pb, JSON.stringify(content), versionSha, w.owner.userId]);
    await h.su.query(`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
      VALUES ($1, gen_random_uuid(), $2, 'approve', $3, 'owner', $4, 'approved', now())`, [w.tenantId, versionId, w.owner.userId, versionSha]);
  } finally {
    await h.su.query(`SET session_replication_role = origin`);
  }
  if (o.clear ?? true) await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'`);
  await h.su.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1`, [w.tenantId]);
  await freshReauth(h, w.owner);
  const on = await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 100, attestation: 'I turn on the AI assistant for my team and accept the engineering defaults.' });
  if (on.status !== 200) throw new Error(`switch: ${on.status} ${JSON.stringify(on.body)}`);
  if (o.optIn ?? true) await optInAgent(h, w.agents[0]!, versionId);
  const ai = new FakeIsaAi();
  (h.providers as { ai: AiProvider }).ai = ai;
  return { ...w, versionId, versionSha, ai };
}

export async function optInAgent(h: ApiHarness, agent: TestClient, versionId: string, capabilities: string[] = ['converse']): Promise<void> {
  await freshReauth(h, agent);
  const r = await call(agent, 'PUT', '/me/ai-isa/opt-in', { versionId, capabilities, channels: ['sms', 'email'], timezone: 'America/New_York', availability: [], bookingKinds: [] });
  if (r.status !== 200) throw new Error(`opt-in: ${r.status} ${JSON.stringify(r.body)}`);
}

export interface IsaLead extends TestContact {
  zone: string;
}

/** An agent-owned contact (a phone and an email) with an explicit time zone. */
export async function isaLead(h: ApiHarness, agent: TestClient, o: { zone?: string } = {}): Promise<IsaLead> {
  const c = await ownedContact(agent, { consent: false });
  const zone = o.zone ?? openZone();
  await h.su.query(`UPDATE contacts SET timezone = $2, timezone_source = 'explicit' WHERE id = $1`, [c.id, zone]);
  return { ...c, zone };
}

export async function startCare(agent: TestClient, contactId: string, body: Record<string, unknown> = { side: 'buyer' }) {
  return call<{ assignmentId: string; sentence: string }>(agent, 'POST', `/contacts/${contactId}/ai-isa/start`, body);
}

/** A worker over the comms, assistant and AI ISA handlers on the harness database and fakes. A `hold` kind's job is put
 *  back, a day out, without running (a worker that is behind). */
export function isaWorker(h: ApiHarness, o: { hold?: readonly string[] } = {}) {
  const deps = depsFromPlatform(h.app.platform);
  const all = [...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps), ...makeIsaHandlers(() => deps), ownershipFollowupHandler({ ids: deps.ids }) as never];
  const handlers = all.map((x) => (o.hold?.includes(x.kind) ? { ...x, run: async (ctx: { now: Instant }) => ({ retryAt: (ctx.now + 86_400_000) as Instant }) } : x)) as typeof all;
  const registry = new HandlerRegistry().registerAll(handlers);
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 1, worker: `isa-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/** Makes every pending AI ISA and dispatch job due and drains, `rounds` times. Jobs of a `hold` kind stay pending. */
export async function runIsa(h: ApiHarness, tenantId: string, rounds = 4, o: { hold?: readonly string[] } = {}): Promise<void> {
  const notDue = ['ai_isa.sweep', 'ai_isa.sla', ...(o.hold ?? [])];
  for (let i = 0; i < rounds; i += 1) {
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND (kind LIKE 'ai_isa.%' OR kind IN ('comms.dispatch','ownership.followup')) AND kind <> ALL ($2::text[])`, [tenantId, notDue]);
    // the debounce reads conversations.last_inbound_at: age it so a due turn runs now
    await h.su.query(`UPDATE conversations SET last_inbound_at = last_inbound_at - interval '1 minute' WHERE tenant_id = $1 AND last_inbound_at > now() - interval '1 minute'`, [tenantId]);
    await h.su.query(`UPDATE messages SET created_at = created_at - interval '3 minutes' WHERE tenant_id = $1 AND direction = 'inbound' AND created_at > now() - interval '3 minutes'`, [tenantId]);
    await isaWorker(h, o).drain(30);
  }
}

export async function assignmentOf(h: ApiHarness, contactId: string) {
  const r = await h.su.query<{ id: string; state: string; paused_at: Date | null; pause_reason: string | null; ended_at: Date | null; end_reason: string | null; epoch: number }>(
    `SELECT id, state, paused_at, pause_reason, ended_at, end_reason, epoch FROM ai_isa_assignments WHERE contact_id = $1 ORDER BY started_at DESC LIMIT 1`, [contactId]);
  return r.rows[0] ?? null;
}

export async function aiMessages(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ id: string; status: string; status_reason: string | null; body: string; to_address: string; channel: string; action_category: string; purpose: string }>(
    `SELECT id, status, status_reason, body, to_address, channel, action_category, purpose FROM messages WHERE contact_id = $1 AND initiator = 'assistant'
       AND action_category LIKE 'ai_isa%' ORDER BY created_at`, [contactId])).rows;
}

export async function feedItems(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ item_type: string; band: string; state: string; dedupe_key: string }>(`SELECT item_type, band, state, dedupe_key FROM priority_feed_items WHERE contact_id = $1 ORDER BY created_at`, [contactId])).rows;
}

export async function handbacksOf(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ id: string; status: string; dedupe_key: string }>(`SELECT id, status, dedupe_key FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback' ORDER BY created_at`, [contactId])).rows;
}

export async function handoffOf(h: ApiHarness, contactId: string) {
  return (await h.su.query<{ id: string; reason: string; sla_class: string; package: Record<string, unknown>; pending_message_id: string | null; confirmation_status: string }>(
    `SELECT id, reason, sla_class, package, pending_message_id, confirmation_status FROM ai_isa_handoffs WHERE contact_id = $1`, [contactId])).rows;
}
