// The share's sweep cancel against real Postgres (R-CMA-7, R-CMA-9, R-MLS-3; E612; VERIFY 6, 7), through module 24's
// mls.compliance_sweep (mls/sweep.ts) as the system actor. Fakes only: nothing is sent; no real MLS.
import { systemActor } from '../worker/systemActor.js';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform, dispatchOutbound } from '../comms/index.js';
import { complianceSweepInTx } from '../mls/sweep.js';
import * as gates from './gates.js';
import { QUEUED_READ, SHARED_READ } from './sweep.js';
import { randomUUID } from 'node:crypto';
import { type CmaBody, type ShareWorld, call, cmaPack, emailSeller, feedLastSyncedAt, localSales, mlsSale, oneTap, shareFrom, sharePreview, shareQueued, shareWorld, withPlatformCmaCleared } from './testing.js';

vi.mock('./gates.js', async (orig) => {
  const m = await orig<typeof gates>();
  return { ...m, readinessConnections: vi.fn(m.readinessConnections) };
});

let h: ApiHarness;
let w: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await shareWorld(h);
  await localSales(w, 10);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const sweep = () => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => complianceSweepInTx(tx, systemActor(w.tenantId, 'worker'), now), { db: h.app.platform.db });
const msg = async (id: string) => (await h.su.query('SELECT status, status_reason, dispatched_at FROM messages WHERE id = $1', [id])).rows[0] as { status: string; status_reason: string | null; dispatched_at: Date | null };
const setPack = (pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [w.mls, JSON.stringify(pack)]);
/** A successful sync recovers a degraded feed (mls/sweep.ts): one far-away record, never a comp of these homes. */
const freshFeed = async () => {
  await mlsSale(w, { status: 'withdrawn', closePriceCents: null, closeDate: null, city: 'Faraway', postalCode: '96999', latE6: 21_000_000, lonE6: -157_000_000, subdivision: null });
  expect((await h.su.query('SELECT status FROM integration_connections WHERE id = $1', [w.mls])).rows[0].status).toBe('connected');
};

/** A shared CMA whose email is still queued (dispatch:false), shared while platform:cma is cleared in this database. */
async function queuedShare(o: { line1?: string } = {}) {
  const s = await emailSeller(w, agent(), o);
  const tap = await oneTap(agent(), s.c);
  expect(tap.status).toBe(201);
  const r = await withPlatformCmaCleared(h, async () => {
    const p = await sharePreview(agent(), tap.body.cma.id);
    expect(p.body.preview.canShare, JSON.stringify(p.body.preview.blockers)).toBe(true);
    return shareQueued(h, agent(), p.body.preview);
  });
  expect(r.message.status).toBe('queued');
  return { ...s, cmaId: tap.body.cma.id, messageId: r.message.id };
}

type ShareView = CmaBody['cma'] & { share: { message: { status: string; sentence: string } | null } | null };
const view = async (id: string) => (await call<{ cma: ShareView }>(agent(), 'GET', `/cma/${id}`)).body.cma;

describe('R-CMA-7 E612: the sweep cancels a queued share whose readiness fails', () => {
  it('E612 (a) R-MLS-3: the feed goes stale: canceled CMA_FEED_STALE; the CMA stays shared and the view says to prepare a new one; a second sweep changes nothing', async () => {
    const q = await queuedShare();
    await withPlatformCmaCleared(h, async () => {
      await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
      const r = await sweep();
      expect(r.canceledCmaShares).toBe(1);
      expect(await msg(q.messageId)).toMatchObject({ status: 'canceled', status_reason: 'CMA_FEED_STALE', dispatched_at: null });
      expect((await sweep()).canceledCmaShares).toBe(0);
    });
    await freshFeed();
    const v = await view(q.cmaId);
    expect(v.status).toBe('shared');
    expect(v.share!.message).toMatchObject({ status: 'canceled', sentence: 'The email was canceled before sending: the MLS feed went out of date. Prepare a new CMA to share again.' });
    expect((await h.su.query('SELECT status FROM cma_reports WHERE id = $1', [q.cmaId])).rows[0].status).toBe('shared');
  });

  it('E612 (b): client_cma is withdrawn: canceled CMA_CLIENT_USE_NOT_ALLOWED', async () => {
    const q = await queuedShare();
    await setPack(cmaPack({ valuation: { client_cma: false } }));
    try {
      await withPlatformCmaCleared(h, async () => expect((await sweep()).canceledCmaShares).toBe(1));
    } finally {
      await setPack(cmaPack());
    }
    expect(await msg(q.messageId)).toMatchObject({ status: 'canceled', status_reason: 'CMA_CLIENT_USE_NOT_ALLOWED' });
  });

  it('E612 (c) D9: platform:cma\'s review is cleared again: canceled CMA_PLATFORM_NOT_CLEARED', async () => {
    const q = await queuedShare();
    expect((await sweep()).canceledCmaShares).toBe(1); // platform:cma is back to its shipped, unreviewed state
    expect(await msg(q.messageId)).toMatchObject({ status: 'canceled', status_reason: 'CMA_PLATFORM_NOT_CLEARED' });
  });

  it('E612 (d) R-AVM-1: a live listing of the home that withholds automated valuations appears: canceled CMA_SELLER_WITHHELD', async () => {
    const q = await queuedShare();
    await mlsSale(w, { line1: q.line1, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    await withPlatformCmaCleared(h, async () => expect((await sweep()).canceledCmaShares).toBe(1));
    expect(await msg(q.messageId)).toMatchObject({ status: 'canceled', status_reason: 'CMA_SELLER_WITHHELD' });
  });

  it('E612 (e) E27: a share held for a re-tap after a client reply is still queued: when the feed then goes stale it is canceled too', async () => {
    const q = await queuedShare();
    await h.su.query('UPDATE conversations SET inbound_seq = inbound_seq + 1, last_inbound_at = now() WHERE contact_id = $1', [q.c]);
    const d = await dispatchOutbound(q.messageId, depsFromPlatform(h.app.platform), { tenantId: w.tenantId, actor: agent().actor() });
    expect(d.kind).toBe('needs_retap');
    expect(await msg(q.messageId)).toMatchObject({ status: 'queued', status_reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    expect((await view(q.cmaId)).share!.message!.sentence).toBe('They replied since; open the thread to send it.');
    await withPlatformCmaCleared(h, async () => {
      await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
      expect((await sweep()).canceledCmaShares).toBe(1);
    });
    await freshFeed();
    expect(await msg(q.messageId)).toMatchObject({ status: 'canceled', status_reason: 'CMA_FEED_STALE' });
  });

  it('E612 R-GATE-14: a dispatched share is never touched; a ready queued share is left queued; the connections are read once per pass', async () => {
    const s = await emailSeller(w, agent());
    const tap = await oneTap(agent(), s.c);
    const sentShare = await withPlatformCmaCleared(h, async () => shareFrom(agent(), (await sharePreview(agent(), tap.body.cma.id)).body.preview));
    expect(sentShare.body.message.result).toBe('sent');
    const ready = await queuedShare();
    const ready2 = await queuedShare();
    const spy = vi.mocked(gates.readinessConnections);
    await withPlatformCmaCleared(h, async () => {
      spy.mockClear();
      expect((await sweep()).canceledCmaShares).toBe(0); // readiness holds: both stay queued
      expect(spy).toHaveBeenCalledTimes(1);
      await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
      spy.mockClear();
      expect((await sweep()).canceledCmaShares).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
    });
    await freshFeed();
    expect((await msg(sentShare.body.message.id)).status).toBe('sent');
    for (const q of [ready, ready2]) expect((await msg(q.messageId)).status_reason).toBe('CMA_FEED_STALE');
  });
});

describe('VERIFY 6 VERIFY 7', () => {
  it('VERIFY 7: the system\'s UPDATE of a human message to canceled passes every messages trigger (shown by the cancels above); a direct one does too', async () => {
    const q = await queuedShare();
    const r = await withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => (await sql<{ id: string }>`UPDATE messages SET status = 'canceled', status_reason = 'CMA_TEST' WHERE tenant_id = app.tenant_id() AND id = ${q.messageId}::uuid AND status IN ('queued','scheduled') RETURNING id`.execute(tx)).rows, { db: h.app.platform.db });
    expect(r).toEqual([{ id: q.messageId }]);
  });

  it('VERIFY 6: under FORCE RLS the sweep reads the shared CMAs through cma_reports_share_message and their messages by the messages primary key, never a scan of the tenant\'s messages', async () => {
    // the planner's choice on a few fixture rows says nothing; with fresh statistics it is the one the shape allows
    await h.su.query('ANALYZE messages; ANALYZE cma_reports');
    const plans = await withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(tx);
      const explain = async (q: ReturnType<typeof sql>) => (await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${q}`.execute(tx)).rows.map((x) => x['QUERY PLAN']).join('\n');
      return [await explain(SHARED_READ), await explain(QUEUED_READ([randomUUID(), randomUUID()], 500))];
    }, { db: h.app.platform.db });
    if (process.env['CMA_PRINT_PLAN']) console.log(plans.join('\n----\n'));
    expect(plans[0]).toMatch(/Index Scan (using|on) cma_reports_share_message/);
    expect(plans[1]).toMatch(/Index Scan (using|on) messages_pkey[^\n]*\s+Index Cond: \(\(tenant_id = [^\n]*\) AND \(id = ANY/);
    for (const p of plans) expect(p).not.toMatch(/Seq Scan on (messages|cma_reports)|using messages_contact_idx/);
  });
});
