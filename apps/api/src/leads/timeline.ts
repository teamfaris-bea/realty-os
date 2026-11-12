// GET /contacts/:id/timeline (BUILD_PLAN module 11): messages, calls, notes, ownership changes (with
// their reason code and note), appointments and behavior events, newest first, cursor-paginated.
// Authorized as contact.view_detail (§3 "View phones, emails, timeline, history"); the view is
// security_invoker, so a pond/offer-card viewer gets nothing from it even if the matrix were wrong
// (RLS: ledger rows need contact detail, R-PERM-6).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { messageStatusExtras } from '../comms/reachability.js';
import { reactionExtras } from '../comms/reactions.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { leadsTx } from './common.js';
import { factsOf } from './contacts.js';
import * as contacts from './repos/contacts.js';
import * as repo from './repos/timeline.js';
import { TimelineResponse } from './schemas.js';
import { decodeCursor, encodeCursor } from './views.js';

export async function registerTimelineRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/contacts/:id/timeline',
    {
      config: { auth: 'contact.view_detail' },
      preHandler: authorize('contact.view_detail', (req) =>
        leadsTx(req, async (tx) => {
          const row = await contacts.getContact(tx, (req.params as { id: string }).id);
          // card-only sight (pond / offer) is not detail, whatever the relation flags say
          return row && row.detail_visible ? factsOf(row) : null;
        }),
      ),
      schema: {
        params: z.object({ id: z.uuid() }),
        querystring: z.strictObject({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        response: { 200: TimelineResponse },
      },
    },
    async (req) => {
      const before = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && before === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/cursor', code: 'invalid' }] });
      const limit = req.query.limit;
      const { rows, extras, rx } = await leadsTx(req, async (tx) => {
        const rows = await repo.timeline(tx, req.params.id, limit + 1, before);
        // one batch per page: why a message was blocked, failed or is held (lane optout-visibility)
        const messageIds = rows.slice(0, limit).filter((t) => t.item_type === 'message').map((t) => t.item_id);
        const extras = await messageStatusExtras(tx, messageIds);
        // D5b: the reactions on the page and the reaction in force on each text (R-REACT-6)
        const rx = await reactionExtras(tx, messageIds);
        return { rows, extras, rx };
      });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((t) => ({
          id: t.item_id,
          type: t.item_type,
          occurredAt: t.occurred_at.toISOString(),
          actor: t.actor_user_id ? { userId: t.actor_user_id, displayName: t.actor_name } : null,
          detail: t.detail,
          preview: t.preview,
          note: t.note,
          provenance: t.provenance,
          status: t.status,
          statusReason: extras.get(t.item_id)?.statusReason ?? null,
          providerErrorCode: extras.get(t.item_id)?.providerErrorCode ?? null,
          blockedBy: extras.get(t.item_id)?.blockedBy ?? null,
          reaction: rx.reaction.get(t.item_id) ?? null,
          reactedWith: rx.reactedWith.get(t.item_id) ?? null,
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.at_text, last.item_id) : null,
      };
    },
  );
}
