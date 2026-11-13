// Test fixtures for module 75 (fakes only: FakeIsaAi / HostileIsaAi, the fake telephony and email adapters, the fake
// DNC provider; no real model, send, call or vendor). Every application step goes through the API routes or the
// worker; the superuser pool only clears the counsel pack, seeds the approved ai_isa policy (the policy editor is the
// web lane's) and moves stored instants (there is no fake clock).
import { randomUUID } from 'node:crypto';
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
import { dispatchStaleHandler } from '../worker/handlers/dispatchStale.js';

export { call, freshReauth };

const ETC = Array.from({ length: 25 }, (_, i) => i - 12).map((n) => (n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`));
function localOf(zone: string): { hour: number; isoDow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), isoDow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1 };
}
/** A fixed-offset zone where it is now 10:00–17:59, Monday to Saturday. */
export const openZone = () => ETC.find((z) => { const l = localOf(z); return l.hour >= 10 && l.hour < 18 && l.isoDow <= 6; })!;
/** A fixed-offset zone where it is now 01:00–04:59. */
export const closedZone = () => ETC.find((z) => { const l = localOf(z); return l.hour >= 1 && l.hour < 5; })!;

export interface IsaWorld extends CommsWorld {
  versionId: string;
  versionSha: string;
  ai: FakeIsaAi;
}

/** A tenant with the AI ISA fully authorized on fakes: pack cleared, switch on, an approved policy, agent 0 opted in. */
export async function isaWorld(h: ApiHarness, o: { optIn?: boolean; clear?: boolean; capabilities?: string[] } = {}): Promise<IsaWorld> {
  const w = await commsWorld(h, { agents: 2, teamLead: true });
  const pb = randomUUID();
  const versionId = randomUUID();
  const versionSha = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const content = { ...DEFAULT_AI_ISA_CONTENT, ...(o.capabilities ? { capabilities: o.capabilities } : {}) };
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

export async function optInAgent(h: ApiHarness, agent: TestClient, versionId: string, capabilities: string[] = ['converse'],
  o: { timezone?: string; availability?: { weekday: number; start: string; end: string }[]; bookingKinds?: string[] } = {}): Promise<void> {
  await freshReauth(h, agent);
  const r = await call(agent, 'PUT', '/me/ai-isa/opt-in', { versionId, capabilities, channels: ['sms', 'email'], timezone: o.timezone ?? 'America/New_York', availability: o.availability ?? [], bookingKinds: o.bookingKinds ?? [] });
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

/** A worker over the comms, assistant and AI ISA handlers on the harness database and fakes. */
export function isaWorker(h: ApiHarness) {
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps), ...makeIsaHandlers(() => deps), ownershipFollowupHandler({ ids: deps.ids }) as never, dispatchStaleHandler() as never]);
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 1, worker: `isa-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/** Makes every pending AI ISA and dispatch job due and drains, `rounds` times. */
export async function runIsa(h: ApiHarness, tenantId: string, rounds = 4, o: { beforeTick?: () => Promise<void> } = {}): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND (kind LIKE 'ai_isa.%' OR kind IN ('comms.dispatch','ownership.followup')) AND kind NOT IN ('ai_isa.sweep','ai_isa.sla')`, [tenantId]);
    // the debounce reads conversations.last_inbound_at: age it so a due turn runs now
    await h.su.query(`UPDATE conversations SET last_inbound_at = last_inbound_at - interval '1 minute' WHERE tenant_id = $1 AND last_inbound_at > now() - interval '1 minute'`, [tenantId]);
    await h.su.query(`UPDATE messages SET created_at = created_at - interval '3 minutes' WHERE tenant_id = $1 AND direction = 'inbound' AND created_at > now() - interval '3 minutes'`, [tenantId]);
    if (o.beforeTick) {
      const wk = isaWorker(h);
      for (let k = 0; k < 30; k += 1) {
        await o.beforeTick();
        if ((await wk.drain(1)) === 0) break;
      }
    } else await isaWorker(h).drain(30);
  }
}

/** The conversation's reply address (what an email from the team carries as Reply-To), minted like dispatch does. */
export async function replyAddressOf(h: ApiHarness, tenantId: string, contactId: string): Promise<string> {
  const { replyAddress, replyToken, replyTokenHash } = await import('../comms/render.js');
  const deps = depsFromPlatform(h.app.platform) as unknown as { linkSecret: Uint8Array; publicBaseUrl: string };
  const c = await h.su.query<{ id: string }>(`SELECT id FROM conversations WHERE contact_id = $1`, [contactId]);
  const token = replyToken(deps.linkSecret, tenantId, c.rows[0]!.id);
  await h.su.query(`UPDATE conversations SET reply_token_hash = $2 WHERE id = $1 AND reply_token_hash IS NULL`, [c.rows[0]!.id, replyTokenHash(token)]);
  return replyAddress(deps.publicBaseUrl, token);
}

/** Runs the AI ISA sweep once now (the periodic job's body), then drains what it enqueued. */
export async function sweepNow(h: ApiHarness, tenantId: string, rounds = 3): Promise<void> {
  const { withTenantTx } = await import('@realty/db');
  const { systemActor } = await import('../worker/systemActor.js');
  const { sweepInTx } = await import('./handlers.js');
  const deps = depsFromPlatform(h.app.platform);
  await withTenantTx(systemActor(tenantId as never, 'assistant'), (tx, now) => sweepInTx(tx, deps, systemActor(tenantId as never, 'assistant'), now), { db: h.database });
  await runIsa(h, tenantId, rounds);
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

// ---- buyer fixtures (ISA-2b items 10–12; synthetic data only, VERIFY fixtures) -----------------------------------

/** The person's own-form express_written grant (scope stated, naming the brokerage) and a fake "not listed" DNC result. */
export async function grantInitiated(h: ApiHarness, tenantId: string, lead: IsaLead): Promise<void> {
  const { createHash } = await import('node:crypto');
  const hmacHex = async (addr: string) => {
    const deps = depsFromPlatform(h.app.platform);
    const { withTenantTx } = await import('@realty/db');
    const { systemActor } = await import('../worker/systemActor.js');
    return withTenantTx(systemActor(tenantId as never, 'worker'), async (tx) => Buffer.from(await deps.envelope.inTx(tx, tenantId as never).hmacAddress(tenantId as never, addr)).toString('hex'), { db: h.database });
  };
  await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || jsonb_build_object('d12_effective_at', (now() - interval '30 days')::text) WHERE key = 'platform:ai_isa'`);
  const ts = (await h.su.query<{ b: string }>(`SELECT brokerage_legal_name AS b FROM tenant_settings WHERE tenant_id = $1`, [tenantId])).rows[0]!;
  const disc = randomUUID();
  const src = randomUUID();
  const body = `By submitting you agree that ${ts.b} may text and email you about homes (${disc}).`;
  await h.su.query(`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, $3, 'website')`, [tenantId, src, `Own form (test) ${src.slice(0, 8)}`]);
  await h.su.query(`INSERT INTO consent_disclosures (tenant_id, id, channel_scope, purpose_scope, body, body_sha256, names_seller, source_kind, scope_stated)
    VALUES ($1, $2, ARRAY['sms','email'], ARRAY['marketing','informational'], $3, $4, $5, 'own_form', true)`, [tenantId, disc, body, createHash('sha256').update(body).digest('hex'), ts.b]);
  await h.su.query(`INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome, consent_disclosure_id)
    VALUES ($1, gen_random_uuid(), $2, $3, now(), 'buy', 'fp-' || gen_random_uuid(), 'new_contact', $4)`, [tenantId, lead.id, src, disc]);
  for (const [kind, ch, addr] of [['phone', 'sms', lead.phone], ['email', 'email', lead.email]] as const) {
    await h.su.query(`INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level, source,
        occurred_at, recorded_at, contact_id, actor_kind, disclosure_id, evidence, imported)
      VALUES ($1, gen_random_uuid(), $2, decode($3, 'hex'), '•••', $4, 'marketing', 'grant', 'express_written', 'web_form', now(), now(), $5, 'system', $6, '{}'::jsonb, false)`,
      [tenantId, kind, await hmacHex(addr), ch, lead.id, disc]);
  }
  await h.su.query(`INSERT INTO dnc_checks (tenant_id, id, phone_hmac, registry, listed, checked_at, valid_until, provider)
    VALUES ($1, gen_random_uuid(), decode($2, 'hex'), 'us_national', false, now(), now() + interval '31 days', 'fake')`, [tenantId, await hmacHex(lead.phone)]);
}

export interface FakeListing {
  id: string;
}

/** An MLS (or team) listing row written as the sync would (fixtures bypass the system-only triggers). */
export async function buyerListing(h: ApiHarness, tenantId: string, o: { connectionId?: string | null; source?: 'mls' | 'team'; status?: string; price?: number; city?: string;
  beds?: number; lease?: boolean; version?: number; seenHoursAgo?: number; offMarket?: boolean; teamListingId?: string | null; description?: string; agentUserId?: string; displayAllowed?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const src = o.source ?? 'mls';
  await h.su.query(`SET session_replication_role = replica`);
  try {
    await h.su.query(`INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft, property_type,
        description, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, team_listing_id, last_seen_in_feed_at, off_market_at, is_lease, mls_normalize_version, listing_agent_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'CA', '94110', $8, $9, 20, 1400, 'single_family', $10, $11, now(), $12, $13, $14, $15, $16, $17, $18, $19)`,
      [tenantId, id, src, src === 'mls' ? `M${id.slice(0, 8)}` : null, o.status ?? 'active', `${10 + Math.floor(Math.random() * 900)} Sample Ave`, o.city ?? 'Oakland', (o.price ?? 500000) * 100,
        o.beds ?? 3, o.description ?? 'Bright home near the park.', src === 'mls' ? (o.connectionId ?? null) : null, src === 'mls' ? 'Other Brokerage (test)' : null, o.displayAllowed ?? true,
        o.teamListingId ?? null, src === 'mls' ? new Date(Date.now() - (o.seenHoursAgo ?? 1) * 3_600_000) : null, o.offMarket ? new Date() : null, o.lease ?? false, o.version ?? 2,
        src === 'team' ? (o.agentUserId ?? null) : null]);
  } finally {
    await h.su.query(`SET session_replication_role = origin`);
  }
  return id;
}

/** Seeds usable qualification claims onto the machine (the bundle tests; J1 qualifies through the fake model). */
export async function seedClaims(h: ApiHarness, contactId: string, claims: { field: string; value: unknown; quote: string }[]): Promise<void> {
  const m = (await h.su.query<{ id: string }>(`SELECT id FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0]!;
  const rows = claims.map((c, k) => ({ claimId: randomUUID(), field: c.field, value: c.value, quote: c.quote, messageId: m.id, saidAt: Date.now() - 60_000 + k }));
  await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{claims}', $2::jsonb) WHERE contact_id = $1 AND ended_at IS NULL`, [contactId, JSON.stringify(rows)]);
}
