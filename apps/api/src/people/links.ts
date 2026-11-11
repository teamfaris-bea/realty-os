// Addresses, collaborators and relationships (PARITY_PLAN module 57; R-PAR-21, R-PAR-22, R-PAR-2 Share).
//
//   POST   /contacts/:id/addresses                    add               contact.edit
//   PATCH  /contacts/:id/addresses/:addressId         edit              contact.edit
//   DELETE /contacts/:id/addresses/:addressId         delete (audited)  contact.edit
//          (the DB's contact_addresses_delete policy, migration 0037: detail visible + an editing role as itself);
//          answers a restore token: the deleted row, sealed for that user's Undo (addressRestore.ts)
//   POST   /contacts/:id/addresses/:addressId/restore { restoreToken }
//                                                     the Undo: puts the deleted row back verbatim (same id,
//                                                     jurisdiction, import batch), within 10 min (audited)  contact.edit
//   GET    /contacts/:id/collaborators                list              contact.view_detail
//   POST   /contacts/:id/collaborators                add (audited)     collaborator.manage (existing RLS)
//   DELETE /contacts/:id/collaborators/:userId        remove (audited)  collaborator.manage
//   GET    /contacts/:id/relationships                both people visible only (RLS)   contact.view_detail
//   POST   /contacts/:id/relationships                link a person the caller sees    contact.edit
//   DELETE /contacts/:id/relationships/:relationshipId                                 contact.edit
//
// A relationship grants no access, merges nothing and moves no opt-out (R-PAR-22): it is a row that
// exists for a viewer only when they see both people's detail, and nobody links someone they cannot see.
// A collaborator does grant access: it is the existing collaborator mechanism, audited, and only the
// roles the existing RLS allows (tenant-wide, Team Leads, the contact owner) may add one.
import type { ResourceFacts } from '@realty/core/foundation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { factsOf } from '../leads/contacts.js';
import * as leads from '../leads/repos/contacts.js';
import { authorize } from '../rbac.js';
import { openAddressRestore, sealAddressRestore } from './addressRestore.js';
import { detailFacts, idOf, peopleTx, platformOf } from './common.js';
import * as repo from './repos/people.js';
import * as S from './schemas.js';
import { addressView, collaboratorView, relationshipView } from './views.js';

const editAuth = (req: FastifyRequest) => detailFacts(req);

function addressInput(b: { kind: string; line1?: string | null | undefined; line2?: string | null | undefined; city?: string | null | undefined; region?: string | null | undefined; postalCode?: string | null | undefined; country: string }): repo.AddressInput {
  return { kind: b.kind, line1: b.line1 ?? null, line2: b.line2 ?? null, city: b.city ?? null, region: b.region ?? null, postalCode: b.postalCode ?? null, country: b.country };
}

/** collaborator.manage: the existing RLS (tenant-wide, Team Leads, the contact owner) on a visible contact. */
function collabFacts(req: FastifyRequest): Promise<ResourceFacts | null> {
  return peopleTx(req, async (tx) => {
    const row = await leads.getContact(tx, idOf(req));
    return row && row.detail_visible ? factsOf(row) : null;
  });
}

const ROLE_FOR: Record<string, 'isa' | 'tc' | 'co_agent'> = { isa: 'isa', tc: 'tc' };

export async function registerLinkRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- addresses ----
  r.post('/contacts/:id/addresses', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.IdParams, body: S.AddressBody, response: { 201: S.AddressResponse } } }, async (req, reply) => {
    const out = await peopleTx(req, async (tx, _now, actor) => {
      const id = platformOf(req).ids.next();
      await repo.insertAddress(tx, id, req.params.id, addressInput(req.body));
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ address_action: 'add' }, { entity: 'contact_address' }) });
      return { address: addressView((await repo.addresses(tx, req.params.id)).find((a) => a.id === id)!) };
    });
    reply.status(201);
    return out;
  });
  r.patch('/contacts/:id/addresses/:addressId', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.AddressParams, body: S.AddressBody, response: { 200: S.AddressResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      if (!(await repo.updateAddress(tx, req.params.id, req.params.addressId, addressInput(req.body)))) throw new AppError('NOT_FOUND');
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ address_action: 'edit' }, { entity: 'contact_address' }) });
      return { address: addressView((await repo.addresses(tx, req.params.id)).find((a) => a.id === req.params.addressId)!) };
    }),
  );
  r.delete('/contacts/:id/addresses/:addressId', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.AddressParams, response: { 200: S.AddressDeleteResponse } } }, async (req) =>
    peopleTx(req, async (tx, now, actor) => {
      // an address of another person, or one RLS does not let this caller delete, is simply not found (R-PERM-5)
      const gone = await repo.deleteAddress(tx, req.params.id, req.params.addressId);
      if (!gone) throw new AppError('NOT_FOUND');
      // the diff reads as a removal: the address id and kind go to null (ids and codes only, never the address text)
      await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactDiff({ address_id: gone.id, kind: gone.kind }, { address_action: 'delete', address_id: null, kind: null }, { entity: 'contact_address' }) });
      return { ok: true as const, restoreToken: await sealAddressRestore(platformOf(req).envelope, tx, actor, req.params.id, gone, now) };
    }),
  );
  // the Undo of a delete: the row the token seals goes back exactly as it was (never fields the client sends)
  r.post('/contacts/:id/addresses/:addressId/restore', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.AddressParams, body: S.RestoreAddressBody, response: { 201: S.AddressResponse } } }, async (req, reply) => {
    const out = await peopleTx(req, async (tx, now, actor) => {
      const row = await openAddressRestore(platformOf(req).envelope, tx, actor, req.params.id, req.params.addressId, req.body.restoreToken, now);
      const restored = await repo.restoreAddress(tx, req.params.id, row);
      const view = (await repo.addresses(tx, req.params.id)).find((a) => a.id === row.id);
      if (!view) throw new AppError('NOT_FOUND');
      // an Undo sent twice puts nothing back twice: the second answers the address as it is
      if (restored) await audit(tx, actor, { action: 'contact.update', entity: { type: 'contact', id: req.params.id }, changes: redactDiff({ address_id: null, kind: null }, { address_action: 'restore', address_id: row.id, kind: row.kind }, { entity: 'contact_address' }) });
      return { address: addressView(view) };
    });
    reply.status(201);
    return out;
  });
  // ---- collaborators ----
  r.get('/contacts/:id/collaborators', { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', editAuth), schema: { params: S.IdParams, response: { 200: S.CollaboratorsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => ({ collaborators: (await repo.collaborators(tx, req.params.id)).map(collaboratorView) })),
  );
  r.post('/contacts/:id/collaborators', { config: { auth: 'collaborator.manage' }, preHandler: authorize('collaborator.manage', collabFacts), schema: { params: S.IdParams, body: S.CollaboratorBody, response: { 200: S.CollaboratorsResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      const contact = await leads.getContact(tx, req.params.id);
      if (!contact) throw new AppError('NOT_FOUND');
      const member = (await repo.activeMembers(tx)).find((m) => m.user_id === req.body.userId);
      if (!member || member.user_id === contact.owner_user_id) throw new AppError('COLLABORATOR_NOT_ELIGIBLE');
      const role = req.body.role ?? ROLE_FOR[member.role] ?? 'co_agent';
      if (!(await repo.upsertCollaborator(tx, req.params.id, member.user_id, role, actor.userId))) throw new AppError('NOT_FOUND');
      await audit(tx, actor, { action: 'collaborator.added', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ collaborator_user_id: member.user_id, role }, { entity: 'contact_collaborator' }) });
      return { collaborators: (await repo.collaborators(tx, req.params.id)).map(collaboratorView) };
    }),
  );
  r.delete('/contacts/:id/collaborators/:userId', { config: { auth: 'collaborator.manage' }, preHandler: authorize('collaborator.manage', collabFacts), schema: { params: S.CollaboratorParams, response: { 200: S.CollaboratorsResponse } } }, async (req) =>
    peopleTx(req, async (tx, _now, actor) => {
      if (!(await repo.removeCollaborator(tx, req.params.id, req.params.userId))) throw new AppError('NOT_FOUND');
      await audit(tx, actor, { action: 'collaborator.removed', entity: { type: 'contact', id: req.params.id }, changes: redactSnapshot({ collaborator_user_id: req.params.userId }, { entity: 'contact_collaborator' }) });
      return { collaborators: (await repo.collaborators(tx, req.params.id)).map(collaboratorView) };
    }),
  );

  // ---- relationships ----
  r.get('/contacts/:id/relationships', { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', editAuth), schema: { params: S.IdParams, response: { 200: S.RelationshipsResponse } } }, async (req) =>
    peopleTx(req, async (tx) => ({ relationships: (await repo.relationships(tx, req.params.id)).map((x) => relationshipView(x, req.params.id)) })),
  );
  r.post('/contacts/:id/relationships', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.IdParams, body: S.RelationshipBody, response: { 201: S.RelationshipResponse } } }, async (req, reply) => {
    const out = await peopleTx(req, async (tx, _now, actor) => {
      if (req.body.relatedContactId === req.params.id) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/relatedContactId', code: 'self' }] });
      // R-PAR-21: nobody links a person whose detail they cannot see (and RLS refuses it anyway)
      const other = await leads.getContact(tx, req.body.relatedContactId);
      if (!other || !other.detail_visible) throw new AppError('NOT_FOUND');
      const id = platformOf(req).ids.next();
      await repo.insertRelationship(tx, { id, contactId: req.params.id, relatedId: other.id, kind: req.body.kind, label: req.body.kind === 'other' ? (req.body.label ?? null) : null, userId: actor.userId });
      return { relationship: relationshipView((await repo.relationships(tx, req.params.id)).find((x) => x.id === id)!, req.params.id) };
    });
    reply.status(201);
    return out;
  });
  r.delete('/contacts/:id/relationships/:relationshipId', { config: { auth: 'contact.edit' }, preHandler: authorize('contact.edit', editAuth), schema: { params: S.RelationshipParams, response: { 200: S.OkResponse } } }, async (req) =>
    peopleTx(req, async (tx) => {
      if (!(await repo.deleteRelationship(tx, req.params.id, req.params.relationshipId))) throw new AppError('NOT_FOUND');
      return { ok: true as const };
    }),
  );
}
