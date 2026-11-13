// Module 45 portal.sync (R-PORTAL-15; E410, E696, E698; findings F10, F13). Runs the job's transaction as the worker
// does: one withTenantTx as the system of the tenant.
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { handlers } from '../worker/handlers/index.js';
import { systemActor } from '../worker/systemActor.js';
import { PORTAL_SYNC_EVERY_MS } from './sync/jobs.js';
import { portalSyncInTx } from './sync/sync.js';
import { call, client, deal, invite, milestone, portalWorld, publish, setPortalCleared, sharedDocument, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let wb: PortalWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  wb = await portalWorld(h);
}, 240_000);
afterAll(async () => {
  await setPortalCleared(h, false).catch(() => undefined);
  await h?.close();
});

const sync = (tenantId = w.tenantId) =>
  withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => portalSyncInTx(tx, systemActor(tenantId, 'worker'), { linkSecret: h.config.sessionSecret, publicBaseUrl: h.config.publicBaseUrl }, now), { db: h.database });
const agent = () => w.agents[0]!;
const items = (grantId: string) =>
  h.su.query<{ id: string; kind: string; source_id: string; source_version: number; retracted: boolean; by_kind: string; retracted_by: string | null; occurs_on: string | null }>(
    `SELECT id, kind, source_id, source_version, retracted_at IS NOT NULL AS retracted, published_by_kind AS by_kind, retracted_by_user_id AS retracted_by, occurs_on::text AS occurs_on
       FROM portal_items WHERE grant_id = $1 ORDER BY published_at, id`, [grantId]).then((r) => r.rows);

async function granted() {
  const c = await client(agent());
  const d = await deal(agent(), c.id);
  const g = (await invite(agent(), d, c.id)).body.grant.id;
  return { c, d, g };
}

describe('R-PORTAL-15 portal.sync', () => {
  it('R-PORTAL-15: it is a per-tenant job every 5 minutes, registered with the worker', () => {
    const sync = handlers.find((x) => x.kind === 'portal.sync')!;
    expect(sync.every?.ms).toBe(PORTAL_SYNC_EVERY_MS);
    expect(PORTAL_SYNC_EVERY_MS).toBe(300_000);
    expect(handlers.some((x) => x.kind === 'portal.link_expire')).toBe(true);
  });

  it('R-PORTAL-15: publishes confirmed milestones only, once (idempotent), as the system', async () => {
    const { d, g } = await granted();
    const confirmed = await milestone(agent(), d, '2031-04-01');
    const proposed = await milestone(agent(), d, '2031-04-02', 'appraisal');
    await h.su.query(`UPDATE deal_dates SET status = 'proposed', source = 'template' WHERE id = $1`, [proposed]);
    await sync();
    await sync();
    const rows = await items(g);
    expect(rows.map((r) => [r.source_id, r.by_kind, r.retracted])).toEqual([[confirmed, 'system', false]]);
  });

  it('E696: a moved milestone is retracted by the sync and its new version published; a waived or back-to-proposed one is retracted', async () => {
    const { d, g } = await granted();
    const a = await milestone(agent(), d, '2031-05-01');
    const b = await milestone(agent(), d, '2031-05-02', 'appraisal');
    const c = await milestone(agent(), d, '2031-05-03', 'financing');
    await sync();
    expect((await call(agent(), 'PATCH', `/deal-dates/${a}`, { dueOn: '2031-05-20' })).status).toBe(200);
    await h.su.query(`UPDATE deal_dates SET status = 'waived' WHERE id = $1`, [b]);
    await h.su.query(`UPDATE deal_dates SET status = 'proposed', source = 'template' WHERE id = $1`, [c]);
    await sync();
    const rows = await items(g);
    const live = rows.filter((r) => !r.retracted);
    expect(live.map((r) => [r.source_id, r.source_version, r.occurs_on])).toEqual([[a, 2, '2031-05-20']]);
    expect(rows.filter((r) => r.retracted).every((r) => r.retracted_by === null)).toBe(true);
    expect(rows.filter((r) => r.retracted)).toHaveLength(3);
  });

  it('E696: a milestone a person retracted (at any version) is never published again by the sync', async () => {
    const { d, g } = await granted();
    const a = await milestone(agent(), d, '2031-06-01');
    await sync();
    const first = (await items(g))[0]!;
    expect((await call(agent(), 'POST', `/portal-items/${first.id}/retract`)).status).toBe(200);
    await sync();
    expect((await items(g)).filter((r) => !r.retracted)).toEqual([]);
    expect((await call(agent(), 'PATCH', `/deal-dates/${a}`, { dueOn: '2031-06-15' })).status).toBe(200);
    await sync();
    expect((await items(g)).filter((r) => !r.retracted)).toEqual([]);
    // a person may still publish it (E697)
    expect((await publish(agent(), 'milestone', a, [g])).body.results[0]!.result).toBe('published');
  });

  it('E410 R-DOC-9: a document no longer shared, or whose object is gone, is retracted by the sync', async () => {
    const { d, g } = await granted();
    const doc = await sharedDocument(h, w, agent(), d);
    const doc2 = await sharedDocument(h, w, agent(), d, 'Disclosure.pdf');
    await publish(agent(), 'document', doc.id, [g]);
    await publish(agent(), 'document', doc2.id, [g]);
    await call(agent(), 'POST', `/documents/${doc.id}/share`, { shared: false });
    await h.su.query(`UPDATE stored_objects SET deleted_at = now() WHERE id = (SELECT object_id FROM documents WHERE id = $1)`, [doc2.id]);
    const before = (await call<{ items: { note: string | null }[] }>(agent(), 'GET', `/deals/${d}/portal`)).body.items;
    expect(before.some((i) => i.note?.startsWith('Still listed but the file is no longer shared'))).toBe(true);
    await sync();
    expect((await items(g)).filter((r) => !r.retracted)).toEqual([]);
    const after = (await call<{ items: { retractedBy: string | null; note: string | null }[] }>(agent(), 'GET', `/deals/${d}/portal`)).body.items;
    expect(after.every((i) => i.retractedBy === 'Automatic' && /Removed automatically/.test(i.note ?? ''))).toBe(true);
  });

  it('R-PORTAL-15: a next step whose task is done or canceled is retracted (b14 F10: both, each through the task route)', async () => {
    const { d, g } = await granted();
    const done = await call<{ task: { id: string } }>(agent(), 'POST', '/tasks', { title: 'Book the inspector', dealId: d });
    const dropped = await call<{ task: { id: string } }>(agent(), 'POST', '/tasks', { title: 'Order the survey', dealId: d });
    const open = await call<{ task: { id: string } }>(agent(), 'POST', '/tasks', { title: 'Confirm the appraisal', dealId: d });
    for (const t of [done, dropped, open]) expect((await publish(agent(), 'next_step', t.body.task.id, [g])).body.results[0]!.result).toBe('published');
    await sync();
    const live = async () => (await items(g)).filter((r) => !r.retracted).length;
    expect(await live()).toBe(3);
    expect((await call(agent(), 'PATCH', `/tasks/${done.body.task.id}`, { status: 'done' })).status).toBe(200);
    await sync();
    expect(await live()).toBe(2);
    expect((await call(agent(), 'PATCH', `/tasks/${dropped.body.task.id}`, { status: 'canceled' })).status).toBe(200);
    await sync();
    expect(await live()).toBe(1); // the open task's next step stays
  });

  it('E698 F10: expiry is stored once: 90 days after the later of closing and the grant (a grant made 100 days after closing too); at once when lost', async () => {
    const closed = await granted();
    await h.su.query(`ALTER TABLE deals DISABLE TRIGGER USER; UPDATE deals SET stage = 'closed', closed_at = now() - interval '100 days' WHERE id = '${closed.d}'; ALTER TABLE deals ENABLE TRIGGER USER`);
    const late = await granted();
    await h.su.query(`ALTER TABLE deals DISABLE TRIGGER USER; UPDATE deals SET stage = 'closed', closed_at = now() - interval '200 days' WHERE id = '${late.d}'; ALTER TABLE deals ENABLE TRIGGER USER`);
    const lost = await granted();
    await h.su.query(`ALTER TABLE deals DISABLE TRIGGER USER; UPDATE deals SET stage = 'lost', closed_at = NULL, lost_reason = 'went with another agent' WHERE id = '${lost.d}'; ALTER TABLE deals ENABLE TRIGGER USER`);
    await sync();
    const exp = async (g: string) => (await h.su.query<{ e: Date; g: Date }>('SELECT expires_at AS e, granted_at AS g FROM portal_grants WHERE id = $1', [g])).rows[0]!;
    const c = await exp(closed.g);
    expect(Math.abs(c.e.getTime() - (c.g.getTime() + 90 * 86_400_000))).toBeLessThan(5_000); // granted after closing: 90 days after the grant
    const l = await exp(late.g);
    expect(l.e.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    const x = await exp(lost.g);
    expect(x.e.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(x.e.getTime()).toBeGreaterThan(x.g.getTime());
    const again = await exp(closed.g);
    await sync();
    expect((await exp(closed.g)).e.getTime()).toBe(again.e.getTime()); // stored once
  });

  it('R-PORTAL-15: tenant A\'s sync never touches tenant B; it never publishes documents, showings, feedback, seller updates or next steps', async () => {
    const bc = await client(wb.agents[0]!);
    const bd = await deal(wb.agents[0]!, bc.id);
    const bg = (await invite(wb.agents[0]!, bd, bc.id)).body.grant.id;
    await milestone(wb.agents[0]!, bd, '2031-08-08');
    await sharedDocument(h, wb, wb.agents[0]!, bd);
    await sync(w.tenantId);
    expect(await items(bg)).toEqual([]);
    await sync(wb.tenantId);
    expect((await items(bg)).map((r) => r.kind)).toEqual(['milestone']);
  });

  it('R-PORTAL-18: the contact card follows a change of deal owner (audited)', async () => {
    const { d, g } = await granted();
    const before = (await h.su.query<{ display: { agentName?: string } }>('SELECT display FROM portal_grants WHERE id = $1', [g])).rows[0]!.display;
    expect(before.agentName).toBeTruthy();
    await h.su.query(`UPDATE users SET display_name = 'Riley Second' WHERE id = $1`, [w.agents[1]!.userId]);
    await h.su.query(`ALTER TABLE deals DISABLE TRIGGER USER; UPDATE deals SET owner_user_id = $2 WHERE id = $1; ALTER TABLE deals ENABLE TRIGGER USER`.replace('$1', `'${d}'`).replace('$2', `'${w.agents[1]!.userId}'`));
    const s = await sync();
    expect(s.cards).toBeGreaterThanOrEqual(1);
    const after = (await h.su.query<{ display: { agentName?: string } }>('SELECT display FROM portal_grants WHERE id = $1', [g])).rows[0]!.display;
    expect(after.agentName).not.toBe(before.agentName);
    const a = await h.su.query(`SELECT 1 FROM audit_log WHERE action = 'portal.display_updated' AND entity_id = $1`, [g]);
    expect(a.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe('R-PORTAL-15 batches', () => {
  it('E698: a tenant with more open grants than one batch still stores the expiry of every ended deal', async () => {
    const open = await granted();
    const closed = await granted();
    await h.su.query(`ALTER TABLE deals DISABLE TRIGGER USER; UPDATE deals SET stage = 'closed', closed_at = now() WHERE id = '${closed.d}'; ALTER TABLE deals ENABLE TRIGGER USER`);
    // a batch of one: the open grant is older, and must not take the only slot
    await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => portalSyncInTx(tx, systemActor(w.tenantId, 'worker'), { linkSecret: h.config.sessionSecret, publicBaseUrl: h.config.publicBaseUrl }, now, 1), { db: h.database });
    const r = await h.su.query<{ id: string; e: Date | null }>('SELECT id, expires_at AS e FROM portal_grants WHERE id = ANY($1::uuid[])', [[open.g, closed.g]]);
    expect(r.rows.find((x) => x.id === closed.g)!.e).not.toBeNull();
    expect(r.rows.find((x) => x.id === open.g)!.e).toBeNull();
  });
});
