// GET /ponds/:id/cards (BUILD_PLAN module 11; R-PERM-6, R-OWN-16): the leads waiting in a pond, as
// MASKED cards only (first name + last initial, intent, source, age, the PII-free pond summary). No
// contact point, inquiry text or history is ever serialized here, whoever asks (a Team Lead who sees
// pond detail opens the contact itself). Authorized as contact.view with the pond relation: an agent
// or ISA must be able to claim from the pond (app.my_pond_ids()); Team Leads see every pond; Owner /
// Admin all. A pond the caller may not use is 404.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { leadsTx } from './common.js';
import * as repo from './repos/contacts.js';
import { PondCardsResponse } from './schemas.js';
import { cardOf, decodeCursor, encodeCursor } from './views.js';

export async function registerPondRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/ponds/:id/cards',
    {
      config: { auth: 'contact.view' },
      preHandler: authorize('contact.view', (req) =>
        leadsTx(req, async (tx) => {
          const p = await repo.pondAccess(tx, (req.params as { id: string }).id);
          if (!p) return null;
          return p.tenant_wide || p.claimable || p.team_lead ? { pond: true } : null;
        }),
      ),
      schema: {
        params: z.object({ id: z.uuid() }),
        querystring: z.strictObject({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        response: { 200: PondCardsResponse },
      },
    },
    async (req) => {
      const after = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && after === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/cursor', code: 'invalid' }] });
      const limit = req.query.limit;
      return leadsTx(req, async (tx) => {
        const pond = await repo.pondAccess(tx, req.params.id);
        if (!pond) throw new AppError('NOT_FOUND');
        const rows = await repo.pondContacts(tx, pond.id, limit + 1, after ? { createdAt: after.at, id: after.id } : null);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          pond: { id: pond.id, name: pond.name, claimable: pond.claimable },
          cards: page.map((c) => cardOf(c, { masked: true })),
          nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_text, last.id) : null,
        };
      });
    },
  );
}
