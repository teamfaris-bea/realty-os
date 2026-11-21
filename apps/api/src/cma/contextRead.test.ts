// VERIFY E7 (ARCHITECTURE §21.49; R-CMA-10, R-CMA-5): the run's read of the active and pending listings near the
// subject ("market context", E360) is for the agent's CMA only. An automated value (the in-house note, the seller
// range: cma/pipeline.ts valueForSubjectInTx) never shows or stores it, so it does not make that read.
// Real Postgres (app_user, RLS); MLS rows are RESO fixtures stored through V1-A's sync; fakes only.
import { type Tx, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { valueForSubjectInTx } from './pipeline.js';
import { run } from './service.js';
import { type CmaWorld, address, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;
let home: { contactId: string; addressId: string };
let active: string[];

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  await localSales(w, 8);
  const contactId = await contact(w.agents[0]!);
  const addressId = await address(h, w.tenantId, contactId, { kind: 'home', line1: '905 Sample Avenue' });
  await mlsSale(w, { line1: '905 Sample Avenue', closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
  home = { contactId, addressId };
  // three homes for sale nearby: the market context of an agent's CMA
  active = [];
  for (const line1 of ['11 Context Way', '12 Context Way', '13 Context Way']) active.push(await mlsSale(w, { status: 'active', listPriceCents: 60_000_000, line1, closePriceCents: null, closeDate: null }));
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** The context read's own text: active and pending listings of the area, never a lease (service.ts contextListings). */
const isContextRead = (q: string) => q.includes('NOT l.is_lease') && q.includes('l.status = ANY');

/** Runs `fn` in a system transaction whose every query is recorded (the node as JSON) with the rows it returned. */
async function counted<T>(fn: (tx: Tx, now: Parameters<Parameters<typeof withTenantTx>[1]>[1]) => Promise<T>): Promise<{ out: T; queries: number; contextReads: number; contextRows: number }> {
  const seen = new Map<string, string>();
  let queries = 0;
  let contextReads = 0;
  let contextRows = 0;
  const out = await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx, now) => {
    const recording = tx.withPlugin({
      transformQuery(args) {
        queries += 1;
        seen.set(args.queryId.queryId, JSON.stringify(args.node));
        return args.node;
      },
      async transformResult(args) {
        if (isContextRead(seen.get(args.queryId.queryId) ?? '')) {
          contextReads += 1;
          contextRows += args.result.rows.length;
        }
        return args.result;
      },
    });
    return fn(recording, now);
  }, { db: h.database });
  return { out, queries, contextReads, contextRows };
}

const automated = () => counted((tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: home.addressId }, { contactId: home.contactId, use: 'automated_notes' }));

describe('VERIFY E7: the market-context read is the agent CMA\'s only', () => {
  it('R-CMA-10 R-CMA-5: an automated value run makes no context read (one query and three rows fewer than the same run with it), and its value, comps and inputs hash are unchanged', async () => {
    const a = await automated();
    if (!a.out.ok) throw new Error(`fixture: ${a.out.code}`);
    const v = a.out;
    expect(v.result.available).toBe(true);
    // the same run as an agent's CMA makes it (the default): exactly one context read, of the three homes for sale
    const full = await counted((tx) => run(tx, v.conns, v.resolved, v.valuationDate, [], []));
    expect({ reads: full.contextReads, rows: full.contextRows }).toEqual({ reads: 1, rows: 3 });
    expect(full.out.result.context.map((c) => c.listingId).sort()).toEqual([...active].sort());
    // the automated run: none
    expect({ reads: a.contextReads, rows: a.contextRows }).toEqual({ reads: 0, rows: 0 });
    expect(v.result.context).toEqual([]);
    expect(v.result.contextSentence).toBe('Active and pending listings nearby are not looked up for an automated value.');
    // run() alone, with and without the read: exactly one query apart
    const lean = await counted((tx) => run(tx, v.conns, v.resolved, v.valuationDate, [], [], { context: false }));
    expect(lean.contextReads).toBe(0);
    expect(full.queries - lean.queries).toBe(1);
    // nothing the value is made of changes
    const pick = (r: typeof full.out.result) => (r.available ? { value: r.valueCents, low: r.lowCents, high: r.highCents, comps: r.comps.map((c) => c.ref.identity), method: r.methodVersion } : null);
    expect(pick(lean.out.result)).toEqual(pick(full.out.result));
    expect(pick(v.result)).toEqual(pick(full.out.result));
    expect((await automated()).out).toMatchObject({ ok: true, inputsSha256: v.inputsSha256 });
  });

  it('E360 R-CMA-9: an agent-prepared CMA still gets its context listings, stored and shown with their sentence', async () => {
    const r = await oneTap(w.agents[0]!, home.contactId);
    expect(r.status).toBe(201);
    const cma = r.body.cma as unknown as { id: string; context: { listingId: string; status: string }[]; contextSentence: string };
    expect(cma.context.map((c) => c.listingId).sort()).toEqual([...active].sort());
    expect(cma.context.every((c) => c.status === 'active')).toBe(true);
    expect(cma.contextSentence).toBe('3 active or pending listings nearby, shown for the market only: they are not sales and are not used in the value.');
    const stored = (await h.su.query<{ n: number }>("SELECT jsonb_array_length(result->'context') AS n FROM cma_reports WHERE id = $1", [cma.id])).rows[0]!.n;
    expect(stored).toBe(3);
  });
});
