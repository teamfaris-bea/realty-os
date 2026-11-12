// Contacts (BUILD_PLAN module 11; R-OWN-19, R-OWN-25, R-PERM-4…7, R-PERM-12).
//
//   POST /contacts            self-created, owned by the creator, no SLA (R-OWN-19)       contact.create
//   GET  /contacts/:id        the card, or the full record when the caller sees detail    contact.view
//
// Visibility is RLS's (the central contact rule); can() checks the §3 matrix on facts read from the
// RLS-visible row. An invisible id is 404 (R-PERM-5). The card (R-PERM-6) carries name, intent,
// source, age and the pond summary; phones, emails, inquiries and history appear only when the
// caller sees the contact's detail (contact.view_detail and app.contact_detail_visible agree).
//
// Manual create dedups like intake (R-OWN-25): app.lock_address per identifier, then
// app.find_contacts_by_address. An exact match is refused with DUPLICATE_CONTACT, which names the
// matching contact only when the caller can see it, and otherwise only its owner's display name
// (R-PERM-12: "Ask {owner} to share"). `confirmDistinct` (spouses sharing a phone) creates the
// contact anyway and records a duplicate candidate.
import type { ContactId, ResourceFacts } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import { addressLockOrder } from '@realty/core/ownership';
import { applyOwnershipCommandInTx, lockAddresses, type Tx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { visibleSurvivorOf } from '../comms/repos/contacts.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { actorOf, leadsTx, platformOf } from './common.js';
import { identifiersOf } from './intake.js';
import * as repo from './repos/contacts.js';
import { ContactCreatedResponse, ContactResponse, CreateContactBody } from './schemas.js';
import { cardOf, fullOf } from './views.js';

/** The caller's §3 relation to a visible contact row. */
export function factsOf(row: repo.ContactRow): ResourceFacts {
  return { own: row.rel_own, collaborator: row.rel_collab, team: row.rel_team, pond: row.rel_pond, offer: row.rel_offer, deal: row.rel_deal };
}

/** Full record when both the matrix (contact.view_detail) and RLS (contact_detail_visible) allow it. */
export function seesDetail(req: FastifyRequest, row: repo.ContactRow): boolean {
  const actor = actorOf(req);
  const state = req.authState!;
  return row.detail_visible && can(actor, 'contact.view_detail', { ...factsOf(row), reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } }).ok;
}

export async function contactView(tx: Tx, req: FastifyRequest, row: repo.ContactRow) {
  if (!seesDetail(req, row)) return cardOf(row, { masked: row.ownership_state === 'in_pond' });
  const full = fullOf(row, await repo.contactPoints(tx, row.id), await repo.contactInquiries(tx, row.id), await repo.chatClaims(tx, row.id));
  // a merged-away record names the record the person lives on now only to whoever may open it (R-PERM-5, review R2),
  // the same record a CONTACT_MERGED refusal names (comms/merged.ts)
  return full.merged ? { ...full, mergedIntoContactId: await visibleSurvivorOf(tx, row.id) } : full;
}

const Params = z.object({ id: z.uuid() });

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/contacts/:id',
    {
      config: { auth: 'contact.view' },
      preHandler: authorize('contact.view', (req) =>
        leadsTx(req, async (tx) => {
          const row = await repo.getContact(tx, (req.params as { id: string }).id);
          return row ? factsOf(row) : null;
        }),
      ),
      schema: { params: Params, response: { 200: ContactResponse } },
    },
    async (req) =>
      leadsTx(req, async (tx) => {
        const row = await repo.getContact(tx, req.params.id);
        if (!row) throw new AppError('NOT_FOUND');
        return { contact: await contactView(tx, req, row) };
      }),
  );

  r.post(
    '/contacts',
    { config: { auth: 'contact.create' }, preHandler: authorize('contact.create', () => ({})), schema: { body: CreateContactBody, response: { 201: ContactCreatedResponse, 200: ContactCreatedResponse } } },
    async (req, reply) => {
      const p = platformOf(req);
      const b = req.body;
      const result = await leadsTx(req, async (tx, _now, actor) => {
        // R-OWN-7: a replayed create returns the contact it made (before dedup, which would match it),
        // serialized as the caller sees it NOW (R-PERM-6: a contact the creator since released is a
        // masked pond card). A command id of the caller's that names any other command is refused.
        const record = await repo.commandRecord(tx, b.commandId);
        if (record.events.length > 0) {
          const contacts = repo.commandContacts(record);
          if (contacts.size !== 1 || record.events[0]!.type !== 'created') throw new AppError('COMMAND_ID_REUSED');
          const row = await repo.getContact(tx, record.events[0]!.contact_id);
          if (!row) throw new AppError('NOT_FOUND');
          return { contact: await contactView(tx, req, row), replayed: true };
        }
        if (record.rejection && record.rejection.command_kind !== 'create') throw new AppError('COMMAND_ID_REUSED');
        const idents = await identifiersOf(tx, p.envelope, actor.tenantId, b.phones ?? [], b.emails ?? []);
        // a person typing a contact in gets told which entry is wrong (intake drops bad ones instead)
        if (idents.invalidPhones > 0) throw new AppError('PHONE_INVALID');
        if (idents.invalidEmails > 0) throw new AppError('EMAIL_INVALID');
        const first = b.firstName ?? null;
        const last = b.lastName ?? null;
        const displayName = b.displayName ?? ([first, last].filter(Boolean).join(' ') || null);
        if (!displayName) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/displayName', code: 'required' }] });
        const person = { phoneHmacs: idents.phones.map((x) => x.hmac), emailHmacs: idents.emails.map((x) => x.hmac) };
        await lockAddresses(tx, addressLockOrder(person));
        const matches = await repo.findByAddress(tx, [...person.phoneHmacs, ...person.emailHmacs]);
        const matchIds = [...new Set(matches.map((m) => m.contact_id))];
        if (matchIds.length > 0 && b.confirmDistinct !== true) {
          const visible = await repo.visibleIds(tx, matchIds);
          const seen = new Set<string>();
          const list = [];
          for (const m of matches) {
            if (seen.has(m.contact_id)) continue;
            seen.add(m.contact_id);
            // R-PERM-12: an invisible match reveals only that it exists and its owner's display name
            list.push(visible.has(m.contact_id) ? { contactId: m.contact_id, ownerDisplayName: m.owner_display_name } : { contactId: null, ownerDisplayName: m.owner_display_name });
          }
          throw new AppError('DUPLICATE_CONTACT', { matches: list });
        }
        const contactId = p.ids.next<'ContactId'>();
        const res = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'create', via: 'self' }, {
          commandId: b.commandId,
          ids: p.ids,
          newContact: { displayName, firstName: first, lastName: last, intent: b.intent ?? null, contactType: b.contactType ?? 'lead', ...(b.stage ? { stage: b.stage } : {}), ...(b.leadSourceId ? { originalLeadSourceId: b.leadSourceId } : {}) },
        });
        if (!res.outcome.ok) throw new AppError(res.outcome.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_FAILED');
        for (const ph of idents.phones) await repo.addPoint(tx, { id: p.ids.next(), contactId, kind: 'phone', address: ph.e164, hmacHex: ph.hmac, label: b.phoneLabel ?? 'mobile' });
        for (const em of idents.emails) await repo.addPoint(tx, { id: p.ids.next(), contactId, kind: 'email', address: em.email, hmacHex: em.hmac, ...(b.emailLabel ? { label: b.emailLabel } : {}) });
        if (b.address) await repo.addAddress(tx, p.ids.next(), contactId, b.address);
        for (const id of matchIds) await repo.addDuplicateCandidate(tx, p.ids.next(), contactId, id, matches.find((m) => m.contact_id === id && person.phoneHmacs.includes(m.hmac)) ? 'shared_phone' : 'shared_email');
        const row = await repo.getContact(tx, contactId);
        if (!row) throw new AppError('INTERNAL_ERROR');
        return { contact: fullOf(row, await repo.contactPoints(tx, contactId), []), replayed: false };
      });
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );
}

export type { ContactId };
