// Privacy erasure (R-DATA-4, E59; VERIFY WITH COUNSEL: when erasure applies and what a transaction
// record must keep).
//
//   GET  /contacts/:id/erasure                          what erasing would need: the deals the person is on,     contact.erase (Owner/Admin 🔒)
//                                                      and how many merged records go with them
//   POST /contacts/:id/erase          { reason }       app.erase_contact; refused CONTACT_ON_DEAL (409) while    contact.erase (Owner/Admin 🔒)
//                                                      the person is on any deal, details = the deal ids/stages
//   POST /contacts/:id/deals/:dealId/remove { reason }
//                                                      the Owner removes the person from a deal so erasure can   contact.erase + Owner only
//                                                      proceed: the party link is deleted; as the primary contact
//                                                      the link is cleared only on a closed or lost deal (an open
//                                                      deal gets another primary contact first: DEAL_STILL_OPEN).
//                                                      The deal (the transaction record) stays. Audited.
//
// "The person" is the contact and every record merged into it, along merge chains (migration 0037): erasing
// the person erases those merged duplicates too, so each step above covers all of them. The most
// privacy-protective reading of what erasure means for merged records; an owner/counsel question (VERIFY
// WITH COUNSEL). The database enforces the same rules (0037 app.erase_contact over app.contact_merge_tree,
// 0016 deals_primary_contact_guard), so a race or a missed check still fails closed.
//
// A do-not-contact outlives the erasure (D1): the person-level flag is a column of the rows being erased, so
// the same transaction first puts it on each of the person's addresses in the HMAC-keyed consent ledger
// (optOutCarry.ts, recorded by the Owner/Admin). The database refuses the erasure while one is missing
// (PERSON_DO_NOT_CONTACT_UNCARRIED, 409), and a refused erasure rolls the carried revokes back with it.
// Before the carry the person is LOCKED (repos/erasure.ts lockPerson: their addresses, then their records FOR
// UPDATE; batch 5 review F1-ERASE-DNC-TOCTOU, migration 0041): a transaction still adding a phone to the person (a
// lead-email intake or accept, POST /contacts/:id/points, an import) is waited for, so its phone is carried too.
// Before, the carry and the database's check both read a snapshot without that phone, the delete then waited for
// the writer and cascade-deleted the phone with no revoke, and the number was texted afterwards.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { adminTx, platformOf } from './common.js';
import { carryPersonOptOut } from './optOutCarry.js';
import * as repo from './repos/erasure.js';

/** A reason code, never free text (audit `reason` holds no PII, CONVENTIONS §8). */
const ReasonCode = z.enum(['PRIVACY_REQUEST', 'DUPLICATE_RECORD', 'ENTERED_IN_ERROR', 'OTHER']);

const DealLink = z.object({ id: z.uuid(), name: z.string(), stage: z.string(), link: z.enum(['primary', 'party', 'primary_and_party']), closed: z.boolean() });
/** mergedRecords: the duplicate records merged into the person, erased with them (0 for most people). */
const ErasurePreview = z.object({ contactId: z.uuid(), erasable: z.boolean(), deals: z.array(DealLink), mergedRecords: z.number().int().min(0) });

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
      const records = await repo.mergeTree(tx, req.params.id);
      const deals = (await repo.dealLinks(tx, records)).map((d) => ({ id: d.id, name: d.name, stage: d.stage, link: linkOf(d), closed: CLOSED.has(d.stage) }));
      return { contactId: req.params.id, erasable: deals.length === 0, deals, mergedRecords: records.length - 1 };
    }),
  );

  r.post(
    '/contacts/:id/erase',
    { ...auth, schema: { params: z.object({ id: z.uuid() }), body: z.object({ reason: ReasonCode }).strict(), response: { 200: z.object({ erased: z.literal(true) }) } } },
    async (req) => {
      const p = platformOf(req);
      // The refusal names the deals (ids and stages only, no PII in error details) so the Owner can act.
      const blocking = await adminTx(req, async (tx, now, actor) => {
        if (!(await repo.contactExists(tx, req.params.id))) throw new AppError('NOT_FOUND');
        const records = await repo.mergeTree(tx, req.params.id);
        const deals = await repo.dealLinks(tx, records);
        if (deals.length > 0) return deals;
        // in-flight writers of the person's points finish first, so the carry below sees what they added
        await repo.lockPerson(tx, records);
        // an address the carry cannot take (an out-of-scope Meta identity): nothing is erased (the revokes roll back)
        if ((await carryPersonOptOut(tx, req.params.id, actor, now, p.ids)).uncarriable > 0) throw new AppError('PERSON_DO_NOT_CONTACT_UNCARRIED');
        try {
          await repo.eraseContact(tx, req.params.id, p.ids.next<'AuditId'>(), req.body.reason);
        } catch (e) {
          if (pgMessage(e).startsWith('CONTACT_ON_DEAL')) throw new AppError('CONTACT_ON_DEAL'); // a deal appeared meanwhile (the tx is aborted)
          if (pgMessage(e).startsWith('NOT_FOUND')) throw new AppError('NOT_FOUND');
          // the database's own check (a point the locks above missed): nothing is erased
          if (pgMessage(e).startsWith('PERSON_DO_NOT_CONTACT_UNCARRIED')) throw new AppError('PERSON_DO_NOT_CONTACT_UNCARRIED');
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
        // the person's records: a duplicate merged into them may be the one on the deal
        const records = await repo.mergeTree(tx, contactId);
        const isPrimary = deal.primary_contact_id !== null && records.includes(deal.primary_contact_id);
        if (isPrimary && !CLOSED.has(deal.stage)) throw new AppError('DEAL_STILL_OPEN');
        if (isPrimary) {
          try {
            await repo.clearPrimary(tx, dealId);
          } catch (e) {
            if (pgMessage(e).startsWith('DEAL_PRIMARY_CONTACT_REQUIRED')) throw new AppError('DEAL_STILL_OPEN');
            throw e;
          }
        }
        const parties = await repo.removeParty(tx, dealId, records);
        if (!isPrimary && parties.length === 0) throw new AppError('NOT_FOUND');
        // ids only: which merged records (if any) were taken off the deal with the person
        const merged = [...new Set([...(isPrimary ? [deal.primary_contact_id!] : []), ...parties])].filter((x) => x !== contactId).sort();
        const extra = merged.length > 0 ? { before: { merged_contact_ids: merged }, after: { merged_contact_ids: [] } } : { before: {}, after: {} };
        await audit(tx, actor, {
          action: 'deal.contact_removed',
          entity: { type: 'deal', id: dealId },
          changes: redactDiff({ contact_id: contactId, primary_contact: isPrimary, ...extra.before }, { contact_id: null, primary_contact: false, ...extra.after }, { entity: 'deal' }),
          reason: req.body.reason,
        });
        return { removed: true as const };
      }),
  );
}

export async function registerErasureRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
