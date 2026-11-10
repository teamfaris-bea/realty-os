// Maintenance against real Postgres: drift verifiers (R-OWN-4, R-CONSENT-6), retention (R-DATA-3,
// E49), the media job, audit seq gaps (R-AUDIT-8), periodic per-tenant scheduling, sweeper lateness.
import { randomBytes } from 'node:crypto';
import type { ConsentEventSpec } from '@realty/core/compliance';
import type { ContactId, Instant } from '@realty/core/foundation';
import { createDatabase, recordConsentEvent, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../audit.js';
import { createFakeProviders } from '../providers/index.js';
import { blobDeleteHandler } from './handlers/blobDelete.js';
import { consentDriftHandler, ownershipDriftHandler } from './handlers/drift.js';
import { createWorker, workerName } from './loop.js';
import { createMaintenance, nextBoundary, periodicDedupeKey } from './maintenance.js';
import { MemoryMetrics, memoryAlerts, memoryLogger } from './observability.js';
import { createSweeper } from './sweeper.js';
import { type Harness, type World, cmd, contactRow, createHarness, createWorld, intakeLead, jobsFor, makeJobsDue, registryWith, selfCreated, suFixture, suRows, uuid } from './testing/world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const quiet = () => memoryLogger();

describe('drift verifiers', () => {
  it('R-OWN-4: the nightly drift job detects a projection corrupted by a superuser, alerts P1, audits, and corrects nothing', async () => {
    const t = await createWorld(h.app, { agents: 2 });
    const { contactId: clean } = await intakeLead(h.app, t);
    const { contactId: bad } = await intakeLead(h.app, t);
    const c0 = await contactRow(h.su, bad);
    const agent = t.agents.find((a) => a.id === c0.offered_to_user_id)!;
    expect((await cmd(h.app, agent.actor, bad as ContactId, { kind: 'accept', offerId: c0.offer_id as string })).outcome.ok).toBe(true);
    const owned = await contactRow(h.su, bad);
    // the corruption: a projection column changed outside applyOwnershipCommand (guards bypassed)
    await suFixture(h.su, `UPDATE contacts SET offer_round = offer_round + 3 WHERE id = $1`, [bad]);
    const corrupted = await contactRow(h.su, bad);

    const alerts = memoryAlerts();
    const reg = registryWith(ownershipDriftHandler());
    const m = createMaintenance({ db: h.app, registry: reg, log: quiet(), alerts, periodicEveryMs: 0 });
    await m.runOnce();
    const [job] = await jobsFor(h.su, t.tenantId, 'ownership.drift_check');
    expect(job!.dedupe_key).toBe(periodicDedupeKey('ownership.drift_check'));
    expect(job!.queue).toBe('maintenance');
    expect(job!.run_at.getTime()).toBe(nextBoundary(Date.now() as Instant, 86_400_000, 8 * 3_600_000));
    await makeJobsDue(h.su, t.tenantId);
    await createWorker({ queues: ['maintenance'], concurrency: 4, worker: workerName('t'), db: h.app, registry: reg, log: quiet(), alerts }).drain();

    const drift = alerts.alerts.filter((a) => a.code === 'OWNERSHIP_DRIFT' && a.tenantId === t.tenantId);
    expect(drift.map((a) => [a.severity, a.details.contactId, a.details.fields])).toEqual([['P1', bad, 'offerRound']]);
    expect(drift.some((a) => a.details.contactId === clean)).toBe(false);
    const rows = await suRows<{ actor_kind: string; actor_via: string; action: string; entity_id: string; changes: unknown; reason: string }>(
      h.su,
      `SELECT actor_kind, actor_via, action, entity_id::text, changes, reason FROM audit_log WHERE tenant_id = $1 AND action = 'ownership.drift_detected'`,
      [t.tenantId],
    );
    expect(rows).toEqual([
      { actor_kind: 'system', actor_via: 'worker', action: 'ownership.drift_detected', entity_id: bad, changes: { offerRound: { from: owned.offer_round, to: corrupted.offer_round } }, reason: 'PROJECTION_DRIFT' },
    ]);
    expect(await contactRow(h.su, bad)).toEqual(corrupted); // not auto-corrected
  });

  it('R-CONSENT-6: the consent verifier re-projects consent_state from the ledger and alarms on a corrupted row only', async () => {
    const t = await createWorld(h.app, { agents: 1 });
    const spec = (addressHmac: string): ConsentEventSpec => ({
      id: uuid(),
      addressHmac,
      addressKind: 'phone',
      addressHint: '•••-•••-0101',
      channel: 'sms',
      purpose: 'informational',
      eventType: 'grant',
      level: 'express',
      source: 'inbound_first_contact',
      occurredAt: Date.now() as Instant,
      contactId: null,
      actor: { kind: 'system' },
      disclosureId: null,
      evidenceObjectId: null,
      evidenceMessageId: null,
      evidenceCallId: null,
      evidenceCallOffsetMs: null,
      evidence: {},
      imported: false,
      importRecordId: null,
      originalProvenance: null,
      revertsEventId: null,
      expiresAt: null,
      needsReview: false,
    });
    const good = randomBytes(32).toString('hex');
    const bad = randomBytes(32).toString('hex');
    await withTenantTx(t.system('provider'), async (tx) => {
      await recordConsentEvent(tx, spec(good));
      await recordConsentEvent(tx, spec(bad));
    }, { db: h.app });
    // corruption that the write-time guard cannot see (count unchanged, level inflated)
    await suFixture(h.su, `UPDATE consent_state SET consent_level = 'express_written' WHERE address_hmac = decode($1, 'hex')`, [bad]);

    const alerts = memoryAlerts();
    const reg = registryWith(consentDriftHandler());
    await createMaintenance({ db: h.app, registry: reg, log: quiet(), alerts, periodicEveryMs: 0 }).runOnce();
    await makeJobsDue(h.su, t.tenantId);
    await createWorker({ queues: ['maintenance'], concurrency: 2, worker: workerName('t'), db: h.app, registry: reg, log: quiet(), alerts }).drain();
    const drift = alerts.alerts.filter((a) => a.code === 'CONSENT_DRIFT' && a.tenantId === t.tenantId);
    expect(drift.map((a) => [a.severity, a.details.channel, a.details.purpose, a.details.fields])).toEqual([['P1', 'sms', 'informational', 'consent_level']]);
    expect(JSON.stringify(drift)).not.toContain(bad); // no address material in the alert
    const [row] = await suRows<{ consent_level: string }>(h.su, `SELECT consent_level FROM consent_state WHERE address_hmac = decode($1, 'hex')`, [bad]);
    expect(row!.consent_level).toBe('express_written'); // alarm only, never auto-corrected
  });
});

describe('periodic per-tenant jobs', () => {
  it('R-TEN-6: one live job per tenant per periodic kind, enqueued in each tenant’s own transaction; repeated passes are no-ops', async () => {
    const periodic = (kind: 'test.periodic_a' | 'test.periodic_b') => ({ ...blobDeleteHandler(), kind, run: async () => {} });
    const reg = registryWith(periodic('test.periodic_a'), periodic('test.periodic_b'));
    const m = createMaintenance({ db: h.app, registry: reg, log: quiet(), alerts: memoryAlerts(), periodicEveryMs: 0 });
    const first = await m.runOnce();
    const again = await m.runOnce();
    expect(again.periodicEnqueued).toBe(0);
    const rows = await suRows<{ tenant_id: string; kind: string; n: string; tx: string }>(
      h.su,
      `SELECT tenant_id::text, kind, count(*)::text AS n, min(created_at)::text AS tx FROM jobs
        WHERE kind IN ('test.periodic_a', 'test.periodic_b') AND status = 'pending' GROUP BY tenant_id, kind`,
    );
    const tenants = await suRows<{ id: string }>(h.su, `SELECT id::text FROM tenants`);
    expect(first.periodicEnqueued).toBe(2 * tenants.length);
    expect(rows.filter((r) => r.kind === 'test.periodic_a').map((r) => r.tenant_id).sort()).toEqual(tenants.map((t) => t.id).sort());
    expect(rows.every((r) => r.n === '1')).toBe(true);
    // jobs.created_at is the inserting transaction's start: a tenant's two jobs share one transaction,
    // and no two tenants ever share one
    const byTenant = new Map<string, Set<string>>();
    for (const r of rows) byTenant.set(r.tenant_id, (byTenant.get(r.tenant_id) ?? new Set()).add(r.tx));
    const txs = [...byTenant.values()].map((x) => [...x]);
    expect(txs.every((x) => x.length === 1)).toBe(true);
    expect(new Set(txs.flat()).size).toBe(byTenant.size);
  });
});

describe('retention and the media job', () => {
  it('R-DATA-3 E49: retention_sweep applies the defaults; a shredded recording leaves its claim in place with the evidence marked unavailable', async () => {
    const t = await createWorld(h.app, { agents: 1 });
    const T = t.tenantId;
    const agent = t.agents[0]!.id;
    const contactId = await selfCreated(h.app, t.agents[0]!);
    const ago = (d: number) => `now() - interval '${d} days'`;
    const ids = { callId: uuid(), recId: uuid(), objId: uuid(), trId: uuid(), actionId: uuid(), claimId: uuid(), evId: uuid() };
    const key = `tenants/${T}/recordings/${ids.objId}`;
    await suFixture(
      h.su,
      `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, status, started_at, recording_mode, recording_decision)
         VALUES ($1, $2, $3, $4, 'inbound', '+15550000003', 'client', 'completed', ${ago(800)}, 'announced_all_parties', '{}')`,
      [T, ids.callId, uuid(), contactId],
    );
    await suFixture(
      h.su,
      `INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version)
         VALUES ($1, $2, 'recording', $3, 'audio/mpeg', 3, decode(repeat('00', 32), 'hex'), '\\x01', 1)`,
      [T, ids.objId, key],
    );
    await suFixture(
      h.su,
      `INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, object_id, source, consent_basis, status, retain_until)
         VALUES ($1, $2, $3, $4, $5, $6, 'provider', 'announced_all_parties', 'stored', ${ago(70)})`,
      [T, ids.recId, ids.callId, contactId, agent, ids.objId],
    );
    await suFixture(h.su, `INSERT INTO transcripts (tenant_id, id, recording_id, contact_id, status, segments_enc, key_version, provider) VALUES ($1, $2, $3, $4, 'ready', '\\x02', 1, 'fake')`, [T, ids.trId, ids.recId, contactId]);
    await suFixture(
      h.su,
      `INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review) VALUES ($1, $2, $3, 0, 'preference', 'Wants a fenced yard', false)`,
      [T, ids.claimId, ids.actionId],
    );
    await suFixture(
      h.su,
      `INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet_enc, verbatim_verified)
         VALUES ($1, $2, $3, 'call', $4, '{"kind":"transcript","start_ms":1000}', '\\x03', true)`,
      [T, ids.evId, ids.claimId, ids.callId],
    );
    // jobs, notifications, webhook payloads and audit rows on both sides of their limits
    for (const [status, days] of [['succeeded', 15], ['succeeded', 13], ['dead', 91], ['dead', 89]] as const) {
      await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at, status, finished_at, created_at) VALUES ($1, 'bulk', 'test.retention', $2::jsonb, now(), $3, ${ago(days)}, ${ago(days)})`, [
        T,
        JSON.stringify({ days }),
        status,
      ]);
    }
    for (const days of [91, 89]) {
      await h.su.query(`INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, dedupe_key, created_at) VALUES ($1, $2, $3, 'system', 'low', 'x', $4, ${ago(days)})`, [T, uuid(), agent, `ret-${days}`]);
    }
    const wh = { old: uuid(), fresh: uuid() };
    for (const [id, days] of [[wh.old, 31], [wh.fresh, 29]] as const) {
      await h.su.query(`INSERT INTO webhook_events (id, provider, provider_event_id, tenant_id, received_at, signature_valid, status, payload_enc) VALUES ($1::uuid, 'telephony', $1::text, $2, ${ago(days)}, true, 'processed', '\\x04')`, [id, T]);
    }
    const oldAudit = uuid();
    await suFixture(
      h.su,
      `INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, action, entity_type, entity_id) VALUES ($1, $2, now() - interval '7 years 1 day', 'system', 'worker', 'settings.changed', 'tenant', $1)`,
      [T, oldAudit],
    );
    // a soft-deleted contact past purge_after (the ownership ledger outlives it, no PII)
    const purged = await selfCreated(h.app, t.agents[0]!);
    expect((await cmd(h.app, t.agents[0]!.actor, purged, { kind: 'soft_delete' })).outcome.ok).toBe(true);
    await suFixture(h.su, `UPDATE contacts SET deleted_at = ${ago(31)}, purge_after = ${ago(1)} WHERE id = $1`, [purged]);

    const m = createMaintenance({ db: h.app, registry: registryWith(), log: quiet(), alerts: memoryAlerts(), metrics: new MemoryMetrics() });
    const r = await m.runOnce();
    expect(r.failedSteps).toEqual([]);
    expect(r.retention).toMatchObject({ recordings_shredded: 1, contacts_purged: 1 });

    const one = async <T extends Record<string, unknown>>(q: string, v: unknown[]) => (await suRows<T>(h.su, q, v))[0];
    expect(await one(`SELECT status, shredded_at IS NOT NULL AS s FROM recordings WHERE id = $1`, [ids.recId])).toEqual({ status: 'shredded', s: true });
    expect(await one(`SELECT dek_wrapped, deleted_at IS NOT NULL AS d FROM stored_objects WHERE id = $1`, [ids.objId])).toEqual({ dek_wrapped: null, d: true });
    expect(await one(`SELECT status, segments_enc FROM transcripts WHERE id = $1`, [ids.trId])).toEqual({ status: 'shredded', segments_enc: null });
    // E49: the claim stays; its evidence says the source was removed under the retention policy
    expect(await one(`SELECT text FROM assistant_claims WHERE id = $1`, [ids.claimId])).toEqual({ text: 'Wants a fenced yard' });
    expect(await one(`SELECT snippet, snippet_enc, source_available FROM evidence_refs WHERE id = $1`, [ids.evId])).toEqual({ snippet: null, snippet_enc: null, source_available: false });

    const kept = await suRows<{ status: string; days: number }>(h.su, `SELECT status, (payload->>'days')::int AS days FROM jobs WHERE tenant_id = $1 AND kind = 'test.retention' ORDER BY 2`, [T]);
    expect(kept).toEqual([{ status: 'succeeded', days: 13 }, { status: 'dead', days: 89 }]);
    expect((await suRows<{ dedupe_key: string }>(h.su, `SELECT dedupe_key FROM notifications WHERE tenant_id = $1 AND dedupe_key LIKE 'ret-%'`, [T])).map((x) => x.dedupe_key)).toEqual(['ret-89']);
    expect(await one(`SELECT payload_enc FROM webhook_events WHERE id = $1`, [wh.old])).toEqual({ payload_enc: null });
    expect((await one<{ payload_enc: Buffer }>(`SELECT payload_enc FROM webhook_events WHERE id = $1`, [wh.fresh]))!.payload_enc).not.toBeNull();
    expect(await suRows(h.su, `SELECT 1 FROM audit_log WHERE id = $1`, [oldAudit])).toEqual([]);
    expect(await suRows(h.su, `SELECT 1 FROM contacts WHERE id = $1`, [purged])).toEqual([]);
    expect((await suRows(h.su, `SELECT 1 FROM lead_ownership_events WHERE contact_id = $1`, [purged])).length).toBeGreaterThan(0);

    // the media job then deletes the shredded recording's blob and stamps it
    const providers = createFakeProviders();
    await providers.storage.put(key, new Uint8Array([1, 2, 3]), { contentType: 'audio/mpeg' });
    const reg = registryWith(blobDeleteHandler());
    await createMaintenance({ db: h.app, registry: reg, log: quiet(), periodicEveryMs: 0 }).runOnce();
    await makeJobsDue(h.su, T);
    await createWorker({ queues: ['maintenance'], concurrency: 2, worker: workerName('t'), db: h.app, registry: reg, providers, log: quiet() }).drain();
    expect(await providers.storage.exists(key)).toBe(false);
    expect(await one(`SELECT blob_deleted_at IS NOT NULL AS b FROM stored_objects WHERE id = $1`, [ids.objId])).toEqual({ b: true });
  });
});

describe('audit seq gap check', () => {
  it('R-AUDIT-8: gaps in the global audit_log.seq (rolled-back transactions) are counted and tracked', async () => {
    const metrics = new MemoryMetrics();
    const log = memoryLogger();
    const m = createMaintenance({ db: h.app, registry: registryWith(), log, alerts: memoryAlerts(), metrics, auditCheckEveryMs: 0 });
    const before = (await m.runOnce()).audit!;
    expect(metrics.gaugeValue('audit_seq_missing')).toBe(before.missing);
    const write = (fail: boolean) =>
      withTenantTx(w.system(), async (tx) => {
        await audit(tx, w.system(), { action: 'settings.changed', entity: { type: 'tenant', id: w.tenantId }, reason: 'TEST' });
        if (fail) throw new Error('roll back');
      }, { db: h.app });
    await write(false);
    await expect(write(true)).rejects.toThrow('roll back');
    await write(false);
    const after = (await m.runOnce()).audit!;
    expect(after.rows - before.rows).toBe(2);
    expect(after.missing - before.missing).toBe(1);
    expect(metrics.gaugeValue('audit_seq_missing')).toBe(after.missing);
    expect(log.lines.some((l) => l.msg === 'audit_log seq gaps grew')).toBe(true);
  });

  it('the cross-tenant maintenance definers answer only without tenant context (migrations 0004, 0005)', async () => {
    const rows = await withTenantTx(w.system(), async (tx) => {
      const { sql } = await import('kysely');
      const a = await sql`SELECT * FROM app.worker_tenant_ids()`.execute(tx);
      const b = await sql`SELECT * FROM app.audit_seq_stats()`.execute(tx);
      const c = await sql`SELECT * FROM app.dead_jobs_after(now() - interval '1 year', 0, 10)`.execute(tx);
      const d = await sql<{ ok: boolean }>`SELECT app.extend_job_lease(1, 'any-worker', interval '1 minute') AS ok`.execute(tx);
      return [a.rows.length, (b.rows[0] as { row_count: string }).row_count, c.rows.length, d.rows[0]!.ok];
    }, { db: h.app });
    expect(rows).toEqual([0, '0', 0, false]);
  });
});

describe('sweeper lateness', () => {
  it('a sweeper that cannot complete a pass raises SWEEPER_LATE once', async () => {
    const broken = createDatabase({ url: h.db.appUserUrl.replace(/\/[^/]+$/, '/realty_no_such_db'), max: 1 });
    const alerts = memoryAlerts();
    const ac = new AbortController();
    const loop = createSweeper({ db: broken, registry: registryWith(), log: quiet(), alerts, lateAlertMs: 300 }).run({ everyMs: 100, signal: ac.signal }).catch(() => undefined);
    const until = Date.now() + 10_000;
    while (alerts.alerts.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 400));
    ac.abort(new Error('stop'));
    await loop;
    await broken.close();
    expect(alerts.alerts.map((a) => [a.severity, a.code])).toEqual([['P1', 'SWEEPER_LATE']]);
  });
});
