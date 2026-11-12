// Test helpers for api/nurture (imported by *.test.ts only). Fakes only: the deterministic MLS record feed
// (mls/testing.ts pagedFeed), the fake telephony and email providers; no real provider, lead or network call.
// The application acts through the real server and the module's public functions as app_user; the superuser
// pool only reads state back, moves stored instants (clock fixtures) and inserts rows that have no application
// path yet (deals, listing interest on MLS rows).
import { randomUUID } from 'node:crypto';
import type { Instant, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { approvedPlaybook } from '../assistant/testing.js';
import { makeAssistantHandlers } from '../assistant/handlers.js';
import { type CommsWorld, call, commsWorld } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { makeDue, mlsConnection, mlsDeps, pagedFeed, reso } from '../mls/testing.js';
import { syncConnection } from '../mls/sync.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { makeNurtureHandlers } from './handlers.js';
import { anniversaryScanInTx } from './detect.js';
import { reconcileTriggersInTx } from './reconcile.js';

export interface NurtureWorld extends CommsWorld {
  mls: string;
}

export async function nurtureWorld(h: ApiHarness, o: { others?: ('admin' | 'isa' | 'tc')[] } = {}): Promise<NurtureWorld> {
  const w = await commsWorld(h, { agents: 2, teamLead: true, others: o.others ?? ['admin'] });
  // marketing email carries the brokerage postal address (CAN-SPAM; the gate refuses it otherwise)
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield, ST 00000' WHERE tenant_id = $1", values: [w.tenantId] }]);
  // marketing email goes from a verified sending domain (the gate refuses it otherwise): the fake provider verifies it
  const domain = `mail-${randomUUID().slice(0, 6)}.nurture.test`;
  h.providers.email.verifiedDomains.add(domain);
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  for (const a of w.agents) await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@${domain}`, displayName: 'Agent', userId: a.userId, domainId: dom.body.domain.id });
  // the assistant sends from the team identity: the world's first one moves onto the verified domain (fixture)
  await h.su.query("UPDATE email_identities SET domain_id = $2, from_address = 'team@' || $3 WHERE tenant_id = $1 AND user_id IS NULL", [w.tenantId, dom.body.domain.id, domain]);
  const mls = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
  return { ...w, mls };
}

/** The agent approves a built-in template once (create from the template, approve its draft). */
export async function approveTemplate(by: TestClient, templateKey: string): Promise<{ playbookId: string; versionId: string; sha: string }> {
  return approvedPlaybook(by, { templateKey });
}

let modSeq = 0;
/** One sync of one synthetic MLS record (each call is a newer modification). Returns the listing id. */
export async function mlsRecord(h: ApiHarness, w: NurtureWorld, n: number, o: Record<string, unknown> = {}, tenantId = w.tenantId, connectionId = w.mls): Promise<string> {
  modSeq += 1;
  const ts = new Date(Date.UTC(2026, 10, 10, 10, 0, 0) + modSeq * 60_000).toISOString();
  await makeDue(h, connectionId);
  const r = await syncConnection(mlsDeps(h, { [connectionId]: pagedFeed([[reso(n, { ModificationTimestamp: ts, ...o })]]) }), tenantId as TenantId, connectionId);
  if (r.outcome !== 'synced') throw new Error(`mls sync: ${JSON.stringify(r)}`);
  await drainKinds(h, tenantId, ['nurture.listing_changed']); // detection runs as its own system job (module 26)
  const row = await h.su.query<{ id: string }>("SELECT id FROM listings WHERE tenant_id = $1 AND source = 'mls' AND mls_number = $2", [tenantId, `M${n}`]);
  return row.rows[0]!.id;
}

/** The client follows a home (a client's interest; listing_contacts has no application path for MLS rows). */
export async function follow(h: ApiHarness, tenantId: string, listingId: string, contactId: string): Promise<void> {
  await h.su.query("INSERT INTO listing_contacts (tenant_id, listing_id, contact_id, role) VALUES ($1,$2,$3,'interested') ON CONFLICT DO NOTHING", [tenantId, listingId, contactId]);
}

export interface RunRowView {
  id: string;
  status: string;
  step_key: string;
  trigger_key: string;
  scheduled_for: Date;
  trigger_ref: Record<string, unknown>;
  message_id: string | null;
  assistant_action_id: string | null;
  playbook_version_id: string;
}

export async function triggerRuns(h: ApiHarness, contactId: string): Promise<RunRowView[]> {
  return (await h.su.query<RunRowView>('SELECT id, status, step_key, trigger_key, scheduled_for, trigger_ref, message_id, assistant_action_id, playbook_version_id FROM playbook_step_runs WHERE contact_id = $1 AND enrollment_id IS NULL ORDER BY scheduled_for, trigger_key', [contactId])).rows;
}

/** A clock fixture: the contact's open firings are due now (their stored instant moved into the past). */
export async function firingsDue(h: ApiHarness, contactId: string): Promise<void> {
  await h.su.query("UPDATE playbook_step_runs SET scheduled_for = now() - interval '1 second' WHERE contact_id = $1 AND enrollment_id IS NULL AND status = 'scheduled' AND message_id IS NULL", [contactId]);
}

/** Runs the pending jobs of these kinds now (and what they enqueue). */
export async function drainKinds(h: ApiHarness, tenantId: string, kinds: string[]): Promise<void> {
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps), ...makeNurtureHandlers(() => deps)]);
  await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND kind = ANY ($2)`, [tenantId, kinds]);
  await createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `nurture-drain-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger }).drain(30);
}

/** One reconcile pass as the worker would run it, then drains the jobs it and they enqueue (trigger.step, comms.dispatch). */
export async function reconcileAndRun(h: ApiHarness, tenantId: string, rounds = 2): Promise<void> {
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeCommsHandlers(() => deps), ...makeAssistantHandlers(() => deps), ...makeNurtureHandlers(() => deps)]);
  for (let i = 0; i < rounds; i++) {
    await withTenantTx(systemActor(tenantId, 'assistant'), (tx, now) => reconcileTriggersInTx(tx, now), { db: h.database });
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND kind IN ('trigger.step','comms.dispatch','nurture.listing_changed')`, [tenantId]);
    await createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 1, worker: `nurture-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger }).drain(30);
  }
}

export async function anniversaryScan(h: ApiHarness, tenantId: string, at?: Instant): Promise<number> {
  const deps = depsFromPlatform(h.app.platform);
  return withTenantTx(systemActor(tenantId, 'assistant'), (tx, now) => anniversaryScanInTx(tx, deps, at ?? now), { db: h.database });
}

/** A closed deal (api/workspace has no deal-close path in these tests). */
export async function closedDeal(h: ApiHarness, tenantId: string, contactId: string, ownerUserId: string, closedAt: Date): Promise<string> {
  const id = randomUUID();
  await h.su.query(`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, closed_at) VALUES ($1,$2,'12 Birch Ln purchase','buy','closed',$5,$3,$4,$5)`, [tenantId, id, contactId, ownerUserId, closedAt]);
  return id;
}

export const ATTEST = 'I reviewed these alerts and approve them.';
