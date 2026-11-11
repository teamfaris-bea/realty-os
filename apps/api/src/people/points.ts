// Phones and emails (PARITY_PLAN module 57; R-PAR-11, R-PAR-12, R-PAR-44).
//
//   GET  /contacts/:id/points                         live + removed (tail only)        contact.view_detail
//   POST /contacts/:id/points                         add (dedup as intake: warning + candidate)   contact.edit
//   POST /contacts/:id/points/:pointId/replace        replace = remove (replaced) + add  contact.edit
//   POST /contacts/:id/points/:pointId/remove         reason old | wrong_number (ledger-proven)   contact.edit
//   POST /contacts/:id/points/:pointId/primary        make primary                       contact.edit
//   PATCH /contacts/:id/points/:pointId               label                              contact.edit
//
// An address never changes (DB trigger contact_points_immutable). Consent, suppressions and opt-outs stay
// keyed by HMAC, so a removed number keeps its STOP, and the opt-out guards keep reading removed points for
// the person's other phones unless the point was removed as a confirmed wrong number (R-PAR-12).
import type { TenantId } from '@realty/core/foundation';
import { addressLockOrder } from '@realty/core/ownership';
import { normalizePointAddress, planReplacePoint, removalReason, restorable } from '@realty/core/parity/people';
import { type Tx, lockAddresses } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { identifiersOf } from '../leads/intake.js';
import * as leads from '../leads/repos/contacts.js';
import { authorize } from '../rbac.js';
import { detailFacts, peopleTx, platformOf } from './common.js';
import * as repo from './repos/people.js';
import * as S from './schemas.js';
import { pointView, removedPointView } from './views.js';

type Kind = 'phone' | 'email';

async function hmacOf(req: FastifyRequest, tx: Tx, tenantId: string, kind: Kind, address: string): Promise<string> {
  const ids = await identifiersOf(tx, platformOf(req).envelope, tenantId as TenantId, kind === 'phone' ? [address] : [], kind === 'email' ? [address] : []);
  const h = kind === 'phone' ? ids.phones[0]?.hmac : ids.emails[0]?.hmac;
  if (!h) throw new AppError(kind === 'phone' ? 'PHONE_INVALID' : 'EMAIL_INVALID');
  return h;
}

/**
 * Adds `address` to the contact (dedup exactly as intake: the address lock, then find_contacts_by_address).
 * A match on another contact is a warning plus a duplicate candidate, never a refusal (R-PAR-44); an
 * invisible match reveals only its owner's display name (R-PERM-12). Re-adding a number this contact
 * once had restores that row (its HMAC history is the same), except a confirmed wrong number.
 */
async function addAddress(req: FastifyRequest, tx: Tx, tenantId: string, contactId: string, kind: Kind, address: string, label: string, primary: boolean | null) {
  const p = platformOf(req);
  const hmac = await hmacOf(req, tx, tenantId, kind, address);
  await lockAddresses(tx, addressLockOrder({ phoneHmacs: kind === 'phone' ? [hmac] : [], emailHmacs: kind === 'email' ? [hmac] : [] }));
  const mine = await repo.allPoints(tx, contactId);
  const same = mine.find((x) => x.kind === kind && x.address === address);
  const makePrimary = primary ?? !mine.some((x) => x.kind === kind && x.is_primary && x.removed_at === null);
  let pointId: string;
  if (same && same.removed_at === null) throw new AppError('POINT_EXISTS');
  if (same) {
    if (!restorable({ removed: true, removedReason: same.removed_reason })) throw new AppError('WRONG_NUMBER_FINAL');
    if (makePrimary) await clearPrimary(tx, contactId, kind);
    await repo.restorePoint(tx, same.id, label, makePrimary);
    pointId = same.id;
  } else {
    if (makePrimary) await clearPrimary(tx, contactId, kind);
    pointId = p.ids.next();
    await repo.insertPoint(tx, { id: pointId, contactId, kind, address, hmacHex: hmac, label, primary: makePrimary });
  }
  const matches = (await leads.findByAddress(tx, [hmac])).filter((m) => m.contact_id !== contactId);
  const visible = await leads.visibleIds(tx, matches.map((m) => m.contact_id));
  const duplicates = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m.contact_id)) continue;
    seen.add(m.contact_id);
    duplicates.push(visible.has(m.contact_id) ? { contactId: m.contact_id, ownerDisplayName: m.owner_display_name } : { contactId: null, ownerDisplayName: m.owner_display_name });
    await leads.addDuplicateCandidate(tx, p.ids.next(), contactId, m.contact_id, kind === 'phone' ? 'shared_phone' : 'shared_email');
  }
  const point = (await repo.allPoints(tx, contactId)).find((x) => x.id === pointId)!;
  return { point, duplicates };
}

async function clearPrimary(tx: Tx, contactId: string, kind: Kind): Promise<void> {
  for (const x of await repo.allPoints(tx, contactId)) if (x.kind === kind && x.is_primary && x.removed_at === null) await repo.setPrimaryOff(tx, x.id);
}

/** After a removal: the oldest live point of the kind becomes primary when none is. */
async function promoteNext(tx: Tx, contactId: string, kind: Kind): Promise<void> {
  const live = (await repo.allPoints(tx, contactId)).filter((x) => x.kind === kind && x.removed_at === null);
  if (live.length > 0 && !live.some((x) => x.is_primary)) await repo.setPrimary(tx, contactId, live[0]!.id, kind);
}

async function livePoint(tx: Tx, contactId: string, pointId: string): Promise<repo.PointRow> {
  const pt = (await repo.allPoints(tx, contactId)).find((x) => x.id === pointId);
  if (!pt) throw new AppError('NOT_FOUND');
  if (pt.removed_at !== null) throw new AppError('POINT_REMOVED');
  return pt;
}

const editAuth = (req: FastifyRequest) => detailFacts(req);

export async function registerPointRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/contacts/:id/points', { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', editAuth), schema: { params: S.IdParams, response: { 200: S.PointsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => {
      const all = await repo.allPoints(tx, req.params.id);
      return { points: all.filter((p) => p.removed_at === null).map(pointView), removed: all.filter((p) => p.removed_at !== null).map(removedPointView) };
    }),
  );

  r.post('/contacts/:id/points', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.IdParams, body: S.AddPointBody, response: { 201: S.PointResponse } } }, async (req, reply) => {
    const n = normalizePointAddress(req.body.kind, req.body.address);
    if (!n.ok) throw new AppError(n.code);
    const out = await peopleTx(req, async (tx, _now, actor) => {
      const res = await addAddress(req, tx, actor.tenantId, req.params.id, req.body.kind, n.address, req.body.label ?? (req.body.kind === 'phone' ? 'mobile' : 'other'), null);
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ point_action: 'add', kind: req.body.kind }, { entity: 'contact_point' }) });
      return { point: pointView(res.point), removedPointId: null, duplicates: res.duplicates };
    });
    reply.status(201);
    return out;
  });

  r.post('/contacts/:id/points/:pointId/replace', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.PointParams, body: S.ReplacePointBody, response: { 201: S.PointResponse } } }, async (req, reply) => {
    const out = await peopleTx(req, async (tx, _now, actor) => {
      const old = await livePoint(tx, req.params.id, req.params.pointId);
      const plan = planReplacePoint({ id: old.id, kind: old.kind, address: old.address, label: old.label, removed: false, removedReason: null }, req.body.address, req.body.label);
      if (!plan.ok) throw new AppError(plan.code);
      // R-PAR-11: never an UPDATE of the address: remove (replaced), then add
      await repo.removePoint(tx, plan.plan.remove.id, plan.plan.remove.reason);
      const res = await addAddress(req, tx, actor.tenantId, req.params.id, plan.plan.add.kind, plan.plan.add.address, plan.plan.add.label, old.is_primary ? true : null);
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ point_action: 'replace', kind: old.kind }, { entity: 'contact_point' }) });
      return { point: pointView(res.point), removedPointId: old.id, duplicates: res.duplicates };
    });
    reply.status(201);
    return out;
  });

  r.post('/contacts/:id/points/:pointId/remove', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.PointParams, body: S.RemovePointBody, response: { 200: S.PointsResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      const pt = await livePoint(tx, req.params.id, req.params.pointId);
      const why = removalReason(req.body.reason, req.body.reason === 'wrong_number' ? await repo.hasWrongNumberRevoke(tx, pt.hmac) : false);
      if (!why.ok) throw new AppError(why.code);
      await repo.removePoint(tx, pt.id, why.reason);
      if (pt.is_primary) await promoteNext(tx, req.params.id, pt.kind);
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ point_action: 'remove', kind: pt.kind, removed_reason: why.reason }, { entity: 'contact_point' }) });
      const all = await repo.allPoints(tx, req.params.id);
      return { points: all.filter((p) => p.removed_at === null).map(pointView), removed: all.filter((p) => p.removed_at !== null).map(removedPointView) };
    }),
  );

  r.post('/contacts/:id/points/:pointId/primary', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.PointParams, response: { 200: S.PointsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => {
      const pt = await livePoint(tx, req.params.id, req.params.pointId);
      await repo.setPrimary(tx, req.params.id, pt.id, pt.kind);
      const all = await repo.allPoints(tx, req.params.id);
      return { points: all.filter((p) => p.removed_at === null).map(pointView), removed: all.filter((p) => p.removed_at !== null).map(removedPointView) };
    }),
  );

  r.patch('/contacts/:id/points/:pointId', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.PointParams, body: S.LabelPointBody, response: { 200: S.PointsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => {
      const pt = await livePoint(tx, req.params.id, req.params.pointId);
      await repo.setPointLabel(tx, pt.id, req.body.label);
      const all = await repo.allPoints(tx, req.params.id);
      return { points: all.filter((p) => p.removed_at === null).map(pointView), removed: all.filter((p) => p.removed_at !== null).map(removedPointView) };
    }),
  );
}
