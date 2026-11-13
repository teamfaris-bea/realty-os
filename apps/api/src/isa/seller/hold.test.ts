// Smaller brief deviations (batch 13 audit F10): a rebuilt area sentence the engine did not give refuses the email
// (scope 6: each asserted to be among result.area.sentences), a held pricing topic newer than the last resume suspends
// comps again (E502), and the hourly sweep reaches every live seller assignment, page by page. Real Postgres through the
// API harness; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { call } from '../testing.js';
import type { StoredResult } from './cmaSeam.js';
import { areaSentences } from './comps.js';
import { sellerBundleInTx } from './index.js';
import { type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, sellerLead, sellerWorld } from './testing.js';
import { sellerWatchSweepInTx } from './watch.js';

let h: ApiHarness;
let w: SellerWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
});
afterAll(async () => {
  await h?.close();
});

describe('scope 6 (ISA-3 audit F10 b): the area sentences', () => {
  const result = (sentences: string[], tiersSkipped: string[] = []) => ({ area: { tier: 'within_1mi', lookbackMonths: 12, tiersSkipped, sentences } }) as unknown as StoredResult;

  it('R-ISA-18: every rebuilt sentence must be among the engine\'s, else no email (null: the caller refuses COMPS_CEILING), never a silently shorter set', () => {
    const engine = areaSentences(result([]), 1960);
    expect(engine).toBeNull();
    const reached = result(['placeholder']);
    expect(areaSentences(reached, 1960)).toBeNull();
  });

  it('R-ISA-18: the engine\'s own sentences come back, in order', async () => {
    const { tierReachedSentence, CMA_DEFAULTS } = await import('./cmaSeam.js');
    const s = tierReachedSentence('within_1mi' as never, true, 12, CMA_DEFAULTS);
    expect(areaSentences(result([s]), 1960)).toEqual([s]);
  });
});

describe('E502 (ISA-3 audit F10 c): a held pricing topic after the last resume suspends again', () => {
  const watch = async (l: SellerLead) => (await h.su.query<{ s: Date | null; r: Date | null }>(`SELECT comps_suspended_at AS s, comps_resumed_at AS r FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId])).rows[0]!;
  const hold = (l: SellerLead, since: number) => h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{held}', jsonb_build_array(jsonb_build_object('class', 'pricing_negotiation', 'since', $2::bigint))) WHERE id = $1`, [l.assignmentId, since]);
  const bundle = (l: SellerLead) => asSystem(h, w, l, (tx, a, actor) => sellerBundleInTx(tx, actor, a, nowInstant()));

  it('E502: a hold held since before the owner\'s resume does not suspend again; a hold that starts after it does', async () => {
    const l = await sellerLead(h, w);
    expect((await confirm(w, l)).status).toBe(200);
    await hold(l, Date.now() - 60_000);
    await bundle(l);
    const first = await watch(l);
    expect(first.s).not.toBeNull();
    // the owner lets the assistant keep sharing; the same hold (older than the resume) suspends nothing
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/seller/resume-comps`, {})).status).toBe(200);
    await bundle(l);
    const resumed = await watch(l);
    expect(resumed.s!.getTime()).toBe(first.s!.getTime());
    expect(resumed.r!.getTime()).toBeGreaterThanOrEqual(first.s!.getTime());
    // a pricing question after the resume (a new hold, here a secondary class with no escalate action of its own)
    await hold(l, Date.now() + 1_000);
    await bundle(l);
    const again = await watch(l);
    expect(again.s!.getTime()).toBeGreaterThan(resumed.r!.getTime());
  });
});

describe('scope 7 (ISA-3 audit F10 e): the hourly sweep pages', () => {
  it('R-ISA-18: every live seller assignment is enqueued, page after page, each once', async () => {
    const leads = [await sellerLead(h, w), await sellerLead(h, w), await sellerLead(h, w)];
    const seen: string[] = [];
    const n = await asSystem(h, w, leads[0]!, (tx) => sellerWatchSweepInTx(tx, async (id) => void seen.push(id), nowInstant(), 2));
    const live = (await h.su.query<{ id: string }>(`SELECT id FROM ai_isa_assignments WHERE tenant_id = $1 AND ended_at IS NULL AND side IN ('seller','both') ORDER BY id`, [w.tenantId])).rows.map((x) => x.id);
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(n).toBe(live.length);
    expect(seen).toEqual(live);
  });
});
