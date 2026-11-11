// Privacy erasure (R-DATA-4, E59; VERIFY WITH COUNSEL: when erasure applies and what a transaction
// record must keep).
//
//   GET  /contacts/:id/erasure                          what erasing would need: the deals the person is on      contact.erase (Owner/Admin 🔒)
//   POST /contacts/:id/erase          { reason }       app.erase_contact; refused CONTACT_ON_DEAL (409) while    contact.erase (Owner/Admin 🔒)
//                                                      the person is on any deal, details = the deal ids/stages
//   POST /contacts/:id/deals/:dealId/remove { reason }
//                                                      the Owner removes the person from a deal so erasure can   contact.erase + Owner only
//                                                      proceed: the party link is deleted; as the primary contact
//                                                      the link is cleared only on a closed or lost deal (an open
//                                                      deal gets another primary contact first: DEAL_STILL_OPEN).
//                                                      The deal (the transaction record) stays. Audited.
//
// The database enforces the same rules (0001 app.erase_contact, 0016 deals_primary_contact_guard), so
// a race or a missed check still fails closed.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { adminTx, platformOf } from './common.js';
import * as repo from './repos/erasure.js';

/** A reason code, never free text (audit `reason` holds no PII, CONVENTIONS §8). */
const ReasonCode = z.enum(['PRIVACY_REQUEST', 'DUPLICATE_RECORD', 'ENTERED_IN_ERROR', 'OTHER']);

const DealLink = z.object({ id: z.uuid(), name: z.string(), stage: z.string(), link: z.enum(['primary', 'party', 'primary_and_party']), closed: z.boolean() });
const ErasurePreview = z.object({ contactId: z.uuid(), erasable: z.boolean(), deals: z.array(DealLink) });

const CLOSED = new Set(['closed', 'lost']);

function linkOf(r: repo.DealLinkRow): z.infer<typeof DealLink>['link'] {
  if (r.is_primary && r.is_party) return 'primary_and_party';
  return r.is_primary ? 'primary' : 'party';
}

function pgMessage(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { config: { auth: 'contact.erase' as const }, preHandler: authorize('contact.erase', () => ({})) };

  r.get('/contacts/:id/erasure', { ...auth, schema: { params: z.object({ id: z.uuid() }), response: { 200: ErasurePreview } } }, async (req) =>
    adminTx(req, async (tx) => {
      if (!(await repo.contactExists(tx, req.params.id))) throw new AppError('NOT_FOUND');
      const deals = (await repo.dealLinks(tx, req.params.id)).map((d) => ({ id: d.id, name: d.name, stage: d.stage, link: linkOf(d), closed: CLOSED.has(d.stage) }));
      return { contactId: req.params.id, erasable: deals.length === 0, deals };
    }),
  );

  r.post(
    '/contacts/:id/erase',
    { ...auth, schema: { params: z.object({ id: z.uuid() }), body: z.object({ reason: ReasonCode }).strict(), response: { 200: z.object({ erased: z.literal(true) }) } } },
    async (req) => {
      const p = platformOf(req);
      // The refusal names the deals (ids and stages only, no PII in error details) so the Owner can act.
      const blocking = await adminTx(req, async (tx) => {
        if (!(await repo.contactExists(tx, req.params.id))) throw new AppError('NOT_FOUND');
        const deals = await repo.dealLinks(tx, req.params.id);
        if (deals.length > 0) return deals;
        try {
          await repo.eraseContact(tx, req.params.id, p.ids.next<'AuditId'>(), req.body.reason);
        } catch (e) {
          if (pgMessage(e).startsWith('CONTACT_ON_DEAL')) throw new AppError('CONTACT_ON_DEAL'); // a deal appeared meanwhile (the tx is aborted)
          if (pgMessage(e).startsWith('NOT_FOUND')) throw new AppError('NOT_FOUND');
          throw e;
        }
        return [];
      });
      if (blocking.length > 0) throw new AppError('CONTACT_ON_DEAL', { deals: blocking.map((d) => ({ id: d.id, stage: d.stage })) });
      return { erased: true as const };
    },
  );

  r.post(
    '/contacts/:id/deals/:dealId/remove',
    { ...auth, schema: { params: z.object({ id: z.uuid(), dealId: z.uuid() }), body: z.object({ reason: ReasonCode }).strict(), response: { 200: z.object({ removed: z.literal(true) }) } } },
    async (req) =>
      adminTx(req, async (tx, _now, actor) => {
        // E59: the Owner removes the deal link (an Admin may erase, but not edit transaction records)
        if (actor.role !== 'owner') throw new AppError('OWNER_REQUIRED');
        const { dealId, id: contactId } = req.params;
        const deal = await repo.lockDeal(tx, dealId);
        if (!deal) throw new AppError('NOT_FOUND');
        const isPrimary = deal.primary_contact_id === contactId;
        if (isPrimary && !CLOSED.has(deal.stage)) throw new AppError('DEAL_STILL_OPEN');
        if (isPrimary) {
          try {
            await repo.clearPrimary(tx, dealId);
          } catch (e) {
            if (pgMessage(e).startsWith('DEAL_PRIMARY_CONTACT_REQUIRED')) throw new AppError('DEAL_STILL_OPEN');
            throw e;
          }
        }
        const parties = await repo.removeParty(tx, dealId, contactId);
        if (!isPrimary && parties === 0) throw new AppError('NOT_FOUND');
        await audit(tx, actor, {
          action: 'deal.contact_removed',
          entity: { type: 'deal', id: dealId },
          changes: redactDiff({ contact_id: contactId, primary_contact: isPrimary }, { contact_id: null, primary_contact: false }, { entity: 'deal' }),
          reason: req.body.reason,
        });
        return { removed: true as const };
      }),
  );
}

export async function registerErasureRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
