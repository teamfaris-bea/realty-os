// api/predict read route, mounted under /api (module 55 for module 50; PHASE2_3_PLAN §5.4 #55, owner question 1).
//
//   GET /likely   the caller's own open likely-to-move cards as a list, grouped by model        self (RLS)
//
// A read of the feed's own cards and nothing else (R-PRED-4): one tenant transaction, SELECT only. The rows are the
// caller's open likely_to_move feed rows under exactly the feed's filters (workspace/feed.ts shownCards: a deleted
// contact, a person-level do-not-contact contact (R-PRED-6) and a card whose own model is no longer approved or no
// longer flags the contact (R-PRED-5) are not shown). The lines come from the card row (pass.ts), never from the
// prediction's stored reasons, which carry points (R-PRED-3, R-STAFF-7). The order is the band, then the name: there
// is no order by points. "No model" is said as such, never as "nobody is likely to move" (E677).
import type { UserActor } from '@realty/core/foundation';
import { backtestText } from '@realty/core/predict';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { actorOf } from '../admin/common.js';
import type { RouteModule } from '../routes.js';
import { BAND_WORDS } from './settings.js';

export const LIKELY_LIMIT = 200;
export const NO_MODEL_SENTENCE = 'No likely-to-move model is approved on this deployment. A model is used only after counsel has reviewed it and it carries a platform back-test.';
const READY_SENTENCE = 'People you own whom an approved model flags as likely to move. Each line says why. Open a contact to decide what to do.';

const Band = z.enum(['likely_90d', 'watch']);
export const LikelyResponse = z.object({
  state: z.enum(['no_model', 'ready']),
  sentence: z.string(),
  models: z.array(z.object({ version: z.string(), backtest: z.object({ flagged: z.number().int(), transacted: z.number().int(), windowDays: z.number().int() }), sentence: z.string() }).strict()),
  items: z.array(
    z.object({ contactId: z.uuid(), contactName: z.string(), modelVersion: z.string(), band: Band, bandWords: z.string(), reasons: z.array(z.string()) }).strict(),
  ),
  more: z.boolean(),
}).strict();
export type LikelyView = z.infer<typeof LikelyResponse>;

/** The card's own lines without its band line and its back-test line (the page shows those once). */
const SKIP_CODES = new Set(['LIKELY_BAND_90D', 'LIKELY_BAND_WATCH', 'LIKELY_BACKTEST']);

export async function likelyList(actor: UserActor): Promise<LikelyView> {
  return withTenantTx(actor, async (tx) => {
    const models = (
      await sql<{ version: string; backtest_flagged: number; backtest_transacted: number; backtest_window_days: number; backtest_dataset: string }>`
        SELECT version, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset FROM prediction_models
         WHERE status = 'approved' AND backtest_flagged IS NOT NULL ORDER BY version`.execute(tx)
    ).rows;
    if (models.length === 0) return { state: 'no_model', sentence: NO_MODEL_SENTENCE, models: [], items: [], more: false };
    // the feed's own filters (workspace/feed.ts shownCards), for the likely_to_move rows of the caller only
    const rows = (
      await sql<{ contact_id: string; name: string; model_version: string; band: 'likely_90d' | 'watch'; reasons: { code?: unknown; label?: unknown }[] | null }>`
        SELECT f.contact_id, coalesce(c.display_name, '') AS name, split_part(f.dedupe_key, ':', 3) AS model_version,
               p.band, f.reasons
          FROM priority_feed_items f
          JOIN contacts c ON c.tenant_id = f.tenant_id AND c.id = f.contact_id AND c.deleted_at IS NULL
          JOIN contact_predictions p ON p.tenant_id = f.tenant_id AND p.contact_id = f.contact_id AND p.model_version = split_part(f.dedupe_key, ':', 3)
          JOIN prediction_models m ON m.version = p.model_version AND m.status = 'approved'
         WHERE f.tenant_id = app.tenant_id() AND f.user_id = ${actor.userId} AND f.state = 'open'
           AND f.item_type = 'likely_to_move' AND f.dedupe_key LIKE 'likely:%'
           AND c.do_not_contact_at IS NULL
           AND p.band IN ('likely_90d','watch')
         ORDER BY CASE p.band WHEN 'likely_90d' THEN 0 ELSE 1 END, lower(coalesce(c.display_name, '')), f.contact_id
         LIMIT ${LIKELY_LIMIT + 1}`.execute(tx)
    ).rows;
    const items = rows.slice(0, LIKELY_LIMIT).map((r) => ({
      contactId: r.contact_id,
      contactName: r.name === '' ? 'Unnamed contact' : r.name,
      modelVersion: r.model_version,
      band: r.band,
      bandWords: BAND_WORDS[r.band],
      reasons: (Array.isArray(r.reasons) ? r.reasons : []).filter((x) => typeof x?.label === 'string' && !SKIP_CODES.has(String(x.code))).map((x) => x.label as string),
    }));
    return {
      state: 'ready',
      sentence: READY_SENTENCE,
      models: models.map((m) => {
        const backtest = { flagged: m.backtest_flagged, transacted: m.backtest_transacted, windowDays: m.backtest_window_days };
        return { version: m.version, backtest, sentence: `${backtestText({ ...backtest, dataset: m.backtest_dataset })}.` };
      }),
      items,
      more: rows.length > LIKELY_LIMIT,
    };
  });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/likely', { config: { auth: 'self' }, schema: { response: { 200: LikelyResponse } } }, async (req) => likelyList(actorOf(req)));
}

export const likelyRoutes: RouteModule = { name: 'likely', register };
