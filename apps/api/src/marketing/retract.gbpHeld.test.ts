// Module 53, R-GBP-3 (batch 12 review gbp-1): while platform:gbp is uncleared, a person's own retraction of a live GBP
// post never reaches Google, not even through the paths that finish a retraction as the system: a claim left behind
// by a crash or a failed TX2 (the reconcile pass takes stale claims over "whatever the listing"), and the re-entry of
// an 'unknown' row confirmed between TX1 and TX2. Real Postgres, FakeGbp. The repo's locked read is wrapped so the
// test can act between TX1 and TX2 (the second locked read of the publication is TX2's).
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileMarketing } from './handlers.js';
import { publishDepsOf } from './routes.js';
import type * as Repo from './repo.js';
import { type MarketingWorld, type PieceBody, approve, call, clearFairHousing, generateAll, getPiece, marketingWorld, teamListing } from './testing.js';

const hook = vi.hoisted(() => ({ onLocked: null as null | ((n: number) => Promise<void>), n: 0 }));
vi.mock('./repo.js', async (importOriginal) => {
  const orig = await importOriginal<typeof Repo>();
  return {
    ...orig,
    publicationById: async (...a: Parameters<typeof orig.publicationById>) => {
      if (a[2]?.forUpdate && hook.onLocked) {
        hook.n += 1;
        await hook.onLocked(hook.n);
      }
      return orig.publicationById(...a);
    },
  };
});

let h: ApiHarness;
let w: MarketingWorld;
let loc: { connectionId: string; accountId: string };
const gbp = () => h.providers.gbp;
const packs = (keys: string[], on: boolean) => h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${on ? 'now()' : 'NULL'} WHERE key = ANY($1::text[]) AND status = 'published'`, [keys]);
const replica = (sqlText: string) => h.su.query(`SET session_replication_role = replica; ${sqlText}; SET session_replication_role = origin;`);
const rowOf = async (id: string) => (await h.su.query('SELECT status, external_post_id, retract_claim_id FROM marketing_publications WHERE id = $1', [id])).rows[0] as { status: string; external_post_id: string | null; retract_claim_id: string | null };
const removeCards = async (pieceId: string, publicationId: string): Promise<number> =>
  (await h.su.query("SELECT count(*)::int AS n FROM priority_feed_items f, jsonb_array_elements(f.reasons) x WHERE f.dedupe_key = $1 AND x->>'code' = $2", [`marketing:${pieceId}`, `REMOVE_POST_YOURSELF:${publicationId}`])).rows[0].n as number;

function jobCtx(): StandaloneJobContext {
  const actor = systemActor(w.tenantId, 'provider');
  return {
    actor,
    now: Date.now() as never,
    providers: h.providers,
    job: { id: 1n, kind: 'marketing.reconcile', attempt: 1 } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    alerts: { raise: async () => undefined } as never,
    withTx: (fn) => withTenantTx(actor, fn, { db: h.database }),
  };
}

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  await clearFairHousing(h);
  const accountId = `loc-${Math.random().toString(36).slice(2, 10)}`;
  const { connectFlow } = await import('../integrations/testing.js');
  const f = await connectFlow(h, w.owner, 'gbp_location', { externalAccountId: accountId, displayName: 'Example Realty Team location' }, [{ id: accountId }]);
  if (f.cb.result !== 'CONNECTED') throw new Error(`connect gbp: ${f.cb.result}`);
  loc = { connectionId: f.connectionId, accountId };
}, 180_000);
afterAll(async () => {
  await packs(['platform:gbp'], false);
  await h?.close();
});
beforeEach(() => {
  hook.onLocked = null;
  hook.n = 0;
  gbp().nextPublish = 'published';
  gbp().deletion = 'supported';
});

/** A GBP post published while platform:gbp was cleared, then platform:gbp uncleared again. */
async function liveGbpPostThenUncleared(): Promise<{ pieceId: string; publicationId: string }> {
  await packs(['platform:gbp'], true);
  const l = await teamListing(w.agent, {});
  const p = (await generateAll(w.agent, l, { kinds: ['gbp_post'] })).gbp_post!;
  const a = await approve(w.agent, p);
  if (a.status !== 200) throw new Error(`approve gbp: ${JSON.stringify(a.body)}`);
  const piece: PieceBody = a.body.piece;
  const r = await call(w.agent, 'POST', `/marketing-pieces/${piece.id}/publish`, { connectionId: loc.connectionId });
  if (r.status !== 200) throw new Error(`publish gbp: ${r.status}`);
  const pub = (await getPiece(w.agent, piece.id)).publications[0]!;
  expect((await rowOf(pub.id)).status).toBe('published');
  await packs(['platform:gbp'], false);
  return { pieceId: piece.id, publicationId: pub.id };
}

describe('R-GBP-3 gbp-1: a person\'s held GBP retraction never reaches Google through the system\'s paths', () => {
  it('R-GBP-3: a person\'s retraction whose TX2 fails leaves no claim, so the reconcile pass (after the claim window) calls nothing at Google', async () => {
    const { pieceId, publicationId } = await liveGbpPostThenUncleared();
    const before = gbp().deletions.length;
    hook.onLocked = async (n) => {
      if (n >= 2) throw new Error('INJECTED_TX2_FAILURE');
    };
    const r = await call(w.agent, 'POST', `/marketing-pieces/${pieceId}/retract`, { publicationId });
    hook.onLocked = null;
    expect(r.status).toBe(500);
    // whatever TX1 left is made older than app.marketing_retract_claim_window(), as if the process had died long ago
    await replica(`UPDATE marketing_publications SET retract_claimed_at = now() - interval '10 minutes' WHERE id = '${publicationId}' AND retract_claim_id IS NOT NULL`);
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(gbp().deletions.length).toBe(before);
    expect(await rowOf(publicationId)).toMatchObject({ status: 'published', retract_claim_id: null });
    // the person's next request is held as before: the card, no provider call
    const again = await call(w.agent, 'POST', `/marketing-pieces/${pieceId}/retract`, { publicationId });
    expect(again.status).toBe(200);
    expect(gbp().deletions.length).toBe(before);
    expect(await removeCards(pieceId, publicationId)).toBeGreaterThanOrEqual(1);
  });

  it('R-GBP-3: an \'unknown\' GBP row confirmed between a person\'s TX1 and TX2 re-enters for that person: still held, the card, no call at Google', async () => {
    const { pieceId, publicationId } = await liveGbpPostThenUncleared();
    const ref = (await rowOf(publicationId)).external_post_id!;
    // the provider's answer was lost: 'unknown' (a fixture; the guards are bypassed for it only)
    await replica(`UPDATE marketing_publications SET status = 'unknown', external_post_id = NULL, published_at = NULL WHERE id = '${publicationId}'`);
    const before = gbp().deletions.length;
    // the provider's late answer lands after TX1 (the first locked read) and before TX2 (the second)
    hook.onLocked = async (n) => {
      if (n === 2) await replica(`UPDATE marketing_publications SET status = 'published', external_post_id = '${ref}', published_at = now() WHERE id = '${publicationId}'`);
    };
    const r = await call(w.agent, 'POST', `/marketing-pieces/${pieceId}/retract`, { publicationId });
    hook.onLocked = null;
    expect(r.status).toBe(200);
    expect(gbp().deletions.length).toBe(before);
    expect(await rowOf(publicationId)).toMatchObject({ status: 'published', retract_claim_id: null });
    expect(await removeCards(pieceId, publicationId)).toBeGreaterThanOrEqual(1);
  });

  it('R-GBP-3: the system\'s retraction of that post still goes to Google (the listing must come down)', async () => {
    const { publicationId } = await liveGbpPostThenUncleared();
    const before = gbp().deletions.length;
    const { retractPublication } = await import('./publish.js');
    expect(await retractPublication(publishDepsOf(h.app.platform), w.tenantId, publicationId, null)).toEqual({ outcome: 'retracted' });
    expect(gbp().deletions.length).toBe(before + 1);
  });
});
