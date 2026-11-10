// Generated tenant-isolation test (BUILD_PLAN module 7). Every table with a tenant_id column is
// discovered from the catalog (new tables are covered automatically). Tenant B is seeded through the
// real definer and system paths first; any table those paths do not reach yet gets one generated
// row (isolationFixture.ts). Then, for three tenant-A contexts (the tenant-wide Owner, an agent, the
// system actor), every table must give: 0 rows on SELECT, 0 rows on UPDATE (or no privilege at all),
// and an error on INSERT of a tenant-B row. R-TEN-1 R-TEN-2 R-TEN-4 R-TEN-10 are proven by the smoke
// port; this test is the exhaustive per-table sweep of the same Layer-1 guarantee.
import { createHash } from 'node:crypto';
import type { Actor, ContactId, Instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsentEvent } from '../src/consent.js';
import { enqueue } from '../src/jobs.js';
import { withTenantTx } from '../src/tenantTx.js';
import { insertFixtureRow } from './isolationFixture.js';
import { BUY, cmd, createHarness, createWorld, drainFollowups, type Harness, intakeLead, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
let tables: string[] = [];
const generated: string[] = [];

beforeAll(async () => {
  h = await createHarness(8);
  a = await createWorld(h.app, { agents: 2, rule: 'round_robin' });
  b = await createWorld(h.app, { agents: 2, teamLead: true, rule: 'round_robin' });
  // --- tenant B through application paths ---
  const { contactId: offered } = await intakeLead(h.app, b, BUY); // contacts, ledger, offer timer, notification, feed, cursor
  const { contactId: pond } = await intakeLead(h.app, b);
  await cmd(h.app, b.agents[0]!.actor, pond, { kind: 'claim', pondId: b.pondId });
  await cmd(h.app, b.agents[1]!.actor, pond, { kind: 'claim', pondId: b.pondId }); // rejection log
  const own = await selfCreated(h.app, b, b.agents[1]!); // audit mirror
  const off = await suRows<{ offer_id: string; offered_to_user_id: string }>(h.su, 'SELECT offer_id, offered_to_user_id FROM contacts WHERE id = $1', [offered]);
  const offeree = [...b.agents, b.tl!].find((m) => m.id === off[0]!.offered_to_user_id)!;
  await cmd(h.app, offeree.actor, offered, { kind: 'decline', offerId: off[0]!.offer_id }); // follow-up job
  await drainFollowups(h, b);
  await withTenantTx(b.agents[1]!.actor, async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
              VALUES (${b.tenantId}, ${uuid()}, ${own}, 'phone', '+15555550142', ${createHash('sha256').update('b-142').digest()})`.execute(tx);
    await sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (${b.tenantId}, ${uuid()}, ${own}, ${b.agents[1]!.id}, 'Called')`.execute(tx);
  }, { db: h.app });
  await withTenantTx(b.system('provider'), async (tx) => {
    await recordConsentEvent(tx, {
      id: uuid(), addressKind: 'phone', addressHmac: createHash('sha256').update('b-142').digest('hex'), addressHint: '•••-0142',
      channel: 'sms', purpose: 'informational', eventType: 'grant', level: 'express', source: 'inbound_first_contact',
      occurredAt: Date.now() as Instant, contactId: own as ContactId, actor: { kind: 'system' }, disclosureId: null, evidenceObjectId: null,
      evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {}, imported: false, importRecordId: null,
      originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
    });
    await enqueue(tx, { queue: 'default', kind: 'test.isolation', payload: {} });
  }, { db: h.app });
  // --- every table with a tenant_id column ---
  tables = (await suRows<{ t: string }>(h.su, `
    SELECT c.table_name AS t FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`)).map((r) => r.t);
  for (const t of tables) {
    const [n] = await suRows<{ n: string }>(h.su, `SELECT count(*) AS n FROM public."${t}" WHERE tenant_id = $1`, [b.tenantId]);
    if (Number(n!.n) === 0) {
      await insertFixtureRow(h.su, t, b.tenantId);
      generated.push(t);
    }
  }
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const DENIED = /row-level security|permission denied/;
const GLOBAL_LOGS = new Set(['auth_events', 'webhook_events']);

async function attempt<T>(actor: Actor, fn: (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0]) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await withTenantTx(actor, fn, { db: h.app }) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

describe('generated tenant isolation sweep', () => {
  it('discovers every tenant table and every one holds tenant B rows (real paths first, generated rows for the rest)', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(87); // 94 tables; 87 carry tenant_id (0001 §22 lists the global ones)
    for (const t of tables) {
      const [n] = await suRows<{ n: string }>(h.su, `SELECT count(*) AS n FROM public."${t}" WHERE tenant_id = $1`, [b.tenantId]);
      expect(Number(n!.n), t).toBeGreaterThan(0);
    }
    // the real paths covered the core ownership / consent / job / notification tables
    for (const t of ['contacts', 'lead_ownership_events', 'ownership_command_rejections', 'consent_events', 'consent_state', 'jobs', 'notifications', 'audit_log', 'routing_rotation_state']) {
      expect(generated, t).not.toContain(t);
    }
  });

  for (const who of ['owner', 'agent', 'system'] as const) {
    it(`R-TEN-1: a tenant A ${who} context reads 0 rows, updates 0 rows and cannot insert a tenant B row in ANY tenant table (100% coverage)`, async () => {
      const actor: Actor = who === 'owner' ? a.owner.actor : who === 'agent' ? a.agents[0]!.actor : a.system();
      const failures: string[] = [];
      for (const t of tables) {
        const sel = await attempt(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)} WHERE tenant_id = ${b.tenantId}`.execute(tx)).rows[0]!.n));
        if (sel.ok ? sel.value !== 0 : !DENIED.test(sel.error)) failures.push(`${t} SELECT: ${JSON.stringify(sel)}`);
        const upd = await attempt(actor, async (tx) => Number((await sql`UPDATE ${sql.table(t)} SET tenant_id = tenant_id WHERE tenant_id = ${b.tenantId}`.execute(tx)).numAffectedRows ?? 0));
        if (upd.ok ? upd.value !== 0 : !DENIED.test(upd.error)) failures.push(`${t} UPDATE: ${JSON.stringify(upd)}`);
        const [row] = await suRows<{ j: Record<string, unknown> }>(h.su, `SELECT row_to_json(x) AS j FROM public."${t}" x WHERE tenant_id = $1 LIMIT 1`, [b.tenantId]);
        const cols = (await suRows<{ c: string }>(h.su, `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
                                                          AND is_generated = 'NEVER' AND (identity_generation IS NULL OR identity_generation <> 'ALWAYS') ORDER BY ordinal_position`, [t])).map((r) => `"${r.c}"`);
        const ins = await attempt(actor, async (tx) => {
          const list = sql.raw(cols.join(', '));
          await sql`INSERT INTO ${sql.table(t)} (${list}) SELECT ${list} FROM json_populate_record(NULL::${sql.table(t)}, ${JSON.stringify(row!.j)}::json)`.execute(tx);
        });
        // auth_events / webhook_events are global by design (0001 §22 self-check excludes them): failed logins
        // have no tenant, and app_user may only INSERT auth events (never read them back).
        if (GLOBAL_LOGS.has(t)) continue;
        if (ins.ok || !DENIED.test(ins.error)) failures.push(`${t} INSERT: ${JSON.stringify(ins)}`);
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }

  it('R-TEN-2: with no tenant context at all, every tenant table reads empty', async () => {
    const c = await h.app.pool.connect();
    try {
      const bad: string[] = [];
      for (const t of tables) {
        try {
          const r = await c.query(`SELECT count(*) AS n FROM public."${t}"`);
          if (Number(r.rows[0].n) !== 0) bad.push(t);
        } catch (e) {
          if (!DENIED.test((e as Error).message)) bad.push(`${t}: ${(e as Error).message}`);
        }
      }
      expect(bad).toEqual([]);
    } finally {
      c.release();
    }
  });
});
