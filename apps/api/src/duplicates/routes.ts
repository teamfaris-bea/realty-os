// api/duplicates (PARITY_PLAN module 66; R-PAR-44, R-PAR-45, R-OWN-24, R-OWN-25). Mounted under /api.
//
//   GET  /duplicates                 open duplicate suggestions whose two people the caller sees in detail
//   GET  /duplicates/:id             one pair, side by side, with what a merge moves and who would own it
//   POST /duplicates/:id/dismiss     "Not the same person" (audited; Undo below)
//   POST /duplicates/:id/restore     Undo a dismiss
//
// Merging is NOT here: the page calls the existing POST /leads/:survivorId/merge, so every merge goes
// through the ownership engine (applyOwnershipCommand: locks, owner rules, ledger, audit) and the
// database's merge trigger moves tags, custom values, relationships, notes, stage history and every
// phone/email (so every opt-out keeps blocking the merged person: D1, R-PAR-12).
//
// Authorization: 'self' (a session in a tenant). RLS decides which pairs exist for the caller (both
// people's detail visible), so a pair with a hidden side is 404 and never hinted at (R-PERM-5, R-PERM-12).
// Transaction coordinators never own or merge leads (R-PERM-15): every route is 404 for them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { actorOf, leadsTx } from '../leads/common.js';
import { decodeCursor, encodeCursor } from '../leads/views.js';
import type { RouteModule } from '../routes.js';
import * as repo from './repo.js';
import { type PairView, pairView } from './views.js';
import { DuplicateResponse, DuplicatesResponse, IdParams, ListQuery } from './schemas.js';

function refuseTc(req: FastifyRequest): void {
  if (actorOf(req).role === 'tc') throw new AppError('NOT_FOUND');
}

async function loadPairs(req: FastifyRequest, rows: repo.CandidateRow[]): Promise<PairView[]> {
  if (rows.length === 0) return [];
  return leadsTx(req, async (tx) => {
    const ids = [...new Set(rows.flatMap((r) => [r.contact_a_id, r.contact_b_id]))];
    const [sides, pts] = await Promise.all([repo.sides(tx, ids), repo.points(tx, ids)]);
    return rows.flatMap((r) => {
      const a = sides.get(r.contact_a_id);
      const b = sides.get(r.contact_b_id);
      return a && b ? [pairView(r, a, b, pts, actorOf(req).role)] : [];
    });
  });
}

export const duplicatesRoutes: RouteModule = {
  name: 'duplicates',
  async register(app: FastifyInstance) {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get('/duplicates', { config: { auth: 'self' }, schema: { querystring: ListQuery, response: { 200: DuplicatesResponse } } }, async (req) => {
      refuseTc(req);
      const before = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && before === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/cursor', code: 'invalid' }] });
      const limit = req.query.limit;
      const rows = await leadsTx(req, (tx) => repo.listOpen(tx, limit + 1, before));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { duplicates: await loadPairs(req, page), nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_text, last.id) : null };
    });

    r.get('/duplicates/:id', { config: { auth: 'self' }, schema: { params: IdParams, response: { 200: DuplicateResponse } } }, async (req) => {
      refuseTc(req);
      const row = await leadsTx(req, (tx) => repo.getCandidate(tx, req.params.id));
      if (!row) throw new AppError('NOT_FOUND');
      const [pair] = await loadPairs(req, [row]);
      if (!pair) throw new AppError('NOT_FOUND');
      return { duplicate: pair };
    });

    for (const verb of ['dismiss', 'restore'] as const) {
      r.post(`/duplicates/:id/${verb}`, { config: { auth: 'self' }, schema: { params: IdParams, body: z.strictObject({}).optional(), response: { 200: DuplicateResponse } } }, async (req) => {
        refuseTc(req);
        const actor = actorOf(req);
        await leadsTx(req, async (tx) => {
          const row = await repo.getCandidate(tx, req.params.id);
          if (!row) throw new AppError('NOT_FOUND');
          if (!(await repo.setDecision(tx, row.id, verb === 'dismiss' ? 'dismissed' : 'open'))) throw new AppError('DUPLICATE_ALREADY_DECIDED', { status: row.status });
          await audit(tx, actor, {
            action: verb === 'dismiss' ? 'duplicate.dismissed' : 'duplicate.restored',
            entity: { type: 'contact_duplicate_candidate', id: row.id },
            reason: row.match_reason,
          });
        });
        const row = await leadsTx(req, (tx) => repo.getCandidate(tx, req.params.id));
        const [pair] = row ? await loadPairs(req, [row]) : [];
        if (!pair) throw new AppError('NOT_FOUND');
        return { duplicate: pair };
      });
    }
  },
};
