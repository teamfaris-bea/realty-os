// Module 45 portal.sync (R-PORTAL-15; E410, E696, E698; findings F10, F13). Runs the job's transaction as the worker
// does: one withTenantTx as the system of the tenant.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { handlers } from '../worker/handlers/index.js';
import { systemActor } from '../worker/systemActor.js';
import { RETRACTED_NOT_SELLER_SIDE } from './shared/copy.js';
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
    // b14 review B14-OWN-5: each stored expiry is audited once, as the system, with why (a lost deal ends access at once)
    const audits = await h.su.query<{ entity_id: string; reason: string; actor_kind: string }>(
      `SELECT entity_id, reason, actor_kind FROM audit_log WHERE action = 'portal.grant_expiry_stored' AND entity_id = ANY ($1::uuid[]) ORDER BY reason, entity_id`,
      [[closed.g, late.g, lost.g]],
    );
    expect(audits.rows).toEqual(
      [
        { entity_id: closed.g, reason: 'deal_closed', actor_kind: 'system' },
        { entity_id: late.g, reason: 'deal_closed', actor_kind: 'system' },
        { entity_id: lost.g, reason: 'deal_lost', actor_kind: 'system' },
      ].sort((a, b) => a.reason.localeCompare(b.reason) || a.entity_id.localeCompare(b.entity_id)),
    );
  });

  it('E698 (b14 review B14-OWN-5): a listing grant\'s expiry, stored when the listing is sold, is audited listing_ended once', async () => {
    const c = await client(agent());
    const l = (await call<{ listing: { id: string } }>(agent(), 'POST', '/listings', { status: 'active', addressLine1: '9 Elm Court', city: 'Exampleville', region: 'CA', postalCode: '94000' })).body.listing.id;
    expect((await call(agent(), 'POST', `/listings/${l}/contacts`, { contactId: c.id, role: 'seller' })).status).toBe(200);
    const inv = await invite(agent(), l, c.id, {}, 'listings');
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    const g = inv.body.grant.id;
    await h.su.query(`ALTER TABLE listings DISABLE TRIGGER USER; UPDATE listings SET status = 'sold' WHERE id = '${l}'; ALTER TABLE listings ENABLE TRIGGER USER`);
    await sync();
    await sync();
    const audits = await h.su.query<{ reason: string; actor_kind: string }>(`SELECT reason, actor_kind FROM audit_log WHERE action = 'portal.grant_expiry_stored' AND entity_id = $1`, [g]);
    expect(audits.rows).toEqual([{ reason: 'listing_ended', actor_kind: 'system' }]);
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

describe('R-PORTAL-19 after a role correction (b14 review R3)', () => {
  it('R-PORTAL-19 (b14 review R3): a party corrected from seller to co_buyer loses the listing\'s feedback and seller update at the next sync; their own showing stays; the staff view says why', async () => {
    await setPortalCleared(h, true);
    try {
      const l = (await call<{ listing: { id: string } }>(agent(), 'POST', '/listings', { status: 'active', addressLine1: '12 Birch Lane', city: 'Exampleville', region: 'CA', postalCode: '94000' })).body.listing.id;
      const buyer = await client(agent(), { firstName: 'Bix' });
      const d = await deal(agent(), buyer.id, { side: 'buy', listingId: l });
      const spouse = await client(agent(), { firstName: 'Sam' });
      // entered by mistake as a seller of the deal
      expect((await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: spouse.id, role: 'seller' })).status).toBe(200);
      const g = (await invite(agent(), d, spouse.id)).body.grant.id;
      const sh = await call<{ showing: { id: string } }>(agent(), 'POST', `/listings/${l}/showings`, { startsAt: '2030-01-05T15:00:00Z' });
      await call(agent(), 'POST', `/showings/${sh.body.showing.id}/feedback`, { rating: 2, comments: 'Overpriced; the sellers will drop.' });
      const fb = (await h.su.query<{ id: string }>('SELECT id FROM showing_feedback WHERE showing_id = $1', [sh.body.showing.id])).rows[0]!.id;
      const su = randomUUID();
      await h.su.query(
        `INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, owner_user_id, decided_by_user_id, decided_at, explanation, payload, edited_payload, trigger_ref)
         VALUES ($1, $2, 'seller_update_draft', 'seller_update', 'requires_approval', 'approved', $3, $3, now(), 'Weekly update', $4, $4, $5)`,
        [w.tenantId, su, agent().userId, JSON.stringify({ body: 'Seller will accept 20k under list.', recommendation: 'Hold the price two more weeks.' }), JSON.stringify({ listing_id: l })],
      );
      // the spouse's own showing (as the buyer contact) reaches the grant directly, whatever the role
      const own = await call<{ showing: { id: string } }>(agent(), 'POST', `/listings/${l}/showings`, { startsAt: '2030-01-06T15:00:00Z', buyerContactId: spouse.id });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      for (const [kind, id] of [['feedback', fb], ['seller_update', su], ['showing', own.body.showing.id]] as const) {
        expect((await publish(agent(), kind, id, [g])).body.results[0]!.result).toBe('published');
      }
      await sync();
      expect((await items(g)).filter((i) => i.retracted)).toEqual([]);
      // the role is corrected: the spouse is a co-buyer
      expect((await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: spouse.id, role: 'co_buyer' })).status).toBe(200);
      expect((await sync()).retracted).toBe(2);
      const after = await items(g);
      expect(after.map((i) => [i.kind, i.retracted, i.retracted_by])).toEqual([
        ['feedback', true, null],
        ['seller_update', true, null],
        ['showing', false, null],
      ]);
      const audits = await h.su.query<{ reason: string }>(`SELECT reason FROM audit_log WHERE action = 'portal.item_retracted' AND entity_id = ANY ($1::uuid[])`, [after.slice(0, 2).map((i) => i.id)]);
      expect(audits.rows.map((a) => a.reason)).toEqual(['NOT_SELLER_SIDE', 'NOT_SELLER_SIDE']);
      const view = await call<{ items: { id: string; retractedBy: string | null; note: string | null }[] }>(agent(), 'GET', `/deals/${d}/portal`);
      expect(view.status).toBe(200);
      const notes = view.body.items.filter((i) => after.slice(0, 2).some((a) => a.id === i.id)).map((i) => [i.retractedBy, i.note]);
      expect(notes).toEqual([
        ['Automatic', RETRACTED_NOT_SELLER_SIDE],
        ['Automatic', RETRACTED_NOT_SELLER_SIDE],
      ]);
      // and once the role is seller again, a person may publish again (nothing is put back by itself)
      expect((await sync()).retracted).toBe(0);
    } finally {
      await setPortalCleared(h, false);
    }
  });

  it('R-PORTAL-19 (b15, b14 low c): a seller merged into another record keeps the listing\'s items: the merge moved the deal role to the survivor, so the sync skips the account (Q-PORTAL-20) and never says "no longer a seller"', async () => {
    await setPortalCleared(h, true);
    try {
      const l = (await call<{ listing: { id: string } }>(agent(), 'POST', '/listings', { status: 'active', addressLine1: '14 Birch Lane', city: 'Exampleville', region: 'CA', postalCode: '94000' })).body.listing.id;
      const buyer = await client(agent(), { firstName: 'Ida' });
      const d = await deal(agent(), buyer.id, { side: 'buy', listingId: l });
      const seller = await client(agent(), { firstName: 'Ola' });
      expect((await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: seller.id, role: 'seller' })).status).toBe(200);
      const g = (await invite(agent(), d, seller.id)).body.grant.id;
      const sh = await call<{ showing: { id: string } }>(agent(), 'POST', `/listings/${l}/showings`, { startsAt: '2030-01-07T15:00:00Z' });
      await call(agent(), 'POST', `/showings/${sh.body.showing.id}/feedback`, { rating: 4, comments: 'Bright kitchen.' });
      const fb = (await h.su.query<{ id: string }>('SELECT id FROM showing_feedback WHERE showing_id = $1', [sh.body.showing.id])).rows[0]!.id;
      expect((await publish(agent(), 'feedback', fb, [g])).body.results[0]!.result).toBe('published');
      await sync();
      // the seller's record is merged into another one (a duplicate): the deal role moves to the survivor
      const survivor = await client(agent(), { firstName: 'Ola' });
      const m = await call(agent(), 'POST', `/leads/${survivor.id}/merge`, { loserId: seller.id, commandId: randomUUID() });
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      expect((await h.su.query<{ merged: string | null }>('SELECT merged_into_contact_id AS merged FROM contacts WHERE id = $1', [seller.id])).rows[0]!.merged).toBe(survivor.id);
      expect((await sync()).retracted).toBe(0);
      expect((await items(g)).map((i) => [i.kind, i.retracted])).toEqual([['feedback', false]]);
      const view = await call<{ items: { note: string | null }[] }>(agent(), 'GET', `/deals/${d}/portal`);
      expect(view.body.items.map((i) => i.note)).not.toContain(RETRACTED_NOT_SELLER_SIDE);
    } finally {
      await setPortalCleared(h, false);
    }
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
