// GET /ponds/:id/cards (BUILD_PLAN module 11; R-PERM-6, R-OWN-16): the leads waiting in a pond, as
// MASKED cards only (first name + last initial, intent, source, age, the PII-free pond summary). No
// contact point, inquiry text or history is ever serialized here, whoever asks (a Team Lead who sees
// pond detail opens the contact itself). Authorized as contact.view with the pond relation: an agent
// or ISA must be able to claim from the pond (app.my_pond_ids()); Team Leads see every pond; Owner /
// Admin all. A pond the caller may not use is 404. In a pond the caller may claim from, a lead they are in
// claim cooldown on (they released or lost it within the pond's cooldown) is left out: they may not claim it.
//
// GET /me/ponds (journey bug: agents never saw a pond lead): the ponds the caller may claim from (eligible role,
// open to all or a member, not archived, claims allowed at all), each with what blocks a claim there now: the
// caller's claims today against the pond's daily limit, or their leads still waiting for a first touch against
// the capacity cap (R-OWN-16, leads/claimable.ts). The Pond page lists exactly these ponds.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { claimStatus } from './claimable.js';
import { leadsTx } from './common.js';
import * as repo from './repos/contacts.js';
import { MyPondsResponse, PondCardsResponse } from './schemas.js';
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
      return leadsTx(req, async (tx, now) => {
        const pond = await repo.pondAccess(tx, req.params.id);
        if (!pond) throw new AppError('NOT_FOUND');
        const rows = await repo.pondContacts(tx, pond.id, limit + 1, after ? { createdAt: after.at, id: after.id } : null);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        // R-OWN-16: in a pond the caller may claim from, a lead they are in claim cooldown on is not theirs to claim
        const cooldown = pond.claimable ? await repo.myPondLeadCooldowns(tx, page.map((c) => c.id)) : new Map<string, Date | null>();
        const coolingDown = (id: string) => {
          const until = cooldown.get(id);
          return until !== undefined && until !== null && until.getTime() >= now;
        };
        return {
          pond: { id: pond.id, name: pond.name, claimable: pond.claimable },
          cards: page.filter((c) => !coolingDown(c.id)).map((c) => cardOf(c, { masked: true })),
          nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_text, last.id) : null,
        };
      });
    },
  );

  r.get('/me/ponds', { config: { auth: 'self' }, schema: { response: { 200: MyPondsResponse } } }, async (req) =>
    leadsTx(req, async (tx, now, actor) => {
      const s = await claimStatus(tx, actor, now);
      return {
        ponds: s.ponds.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, claimsPerDay: p.claimsPerDay, blockedBy: p.blockedBy })),
        claimsToday: s.claimsToday,
        uncontactedOwned: s.uncontactedOwned,
        capacityCap: s.capacityCap,
      };
    }),
  );
}
