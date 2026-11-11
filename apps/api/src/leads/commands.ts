// POST /leads/:contactId/{accept,decline,claim,release,reassign,handoff,close,reopen,merge,delete}
// body: { commandId, expectedSeq?, ... }   (BUILD_PLAN module 11; R-OWN-5…8, R-OWN-16…18, R-OWN-24, R-OWN-26)
//
// Authorization (DATA_MODEL §3, core.can on facts read under the caller's RLS):
//   accept / decline  lead.accept / lead.decline   own offer
//   claim             lead.claim                   pond card (TL/agent/ISA; Owner/Admin assign instead)
//   release           lead.release                 own lead
//   reassign          lead.reassign                Owner/Admin anywhere; TL within team (target in team)
//   handoff           lead.reassign                ISA: own lead → agent / TL, note required
//   close, reopen, delete (soft), merge            contact.view_detail: §3 has no row for these, so
//                     the route requires sight of the contact's detail and the ownership engine
//                     applies its own role rules (core decide: close/delete own, TL team/pond,
//                     Owner/Admin all; reopen TL/Owner/Admin; merge never on card-only contacts)
// A contact the caller can no longer see is still commanded when the caller had legitimate sight
// of it (app.ownership_head: they raced for the pond card, or a ledger event names them), so the
// engine records the precise rejection (E1: LEAD_ALREADY_CLAIMED; R-OWN-5). Any other invisible id
// is 404 (R-PERM-5, E52).
import type { Action, ContactId, PondId, ResourceFacts, Role, UserId } from '@realty/core/foundation';
import type { OwnershipCommand } from '@realty/core/ownership';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Tx, dbNow } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import { recordPersonDoNotContactInTx } from '../channels/personOptOut.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { NIL_UUID, actorOf, leadsTx, mapLeadsDbError, platformOf } from './common.js';
import { factsOf } from './contacts.js';
import { rejectionError, runOwnershipCommand } from './ownership.js';
import * as repo from './repos/contacts.js';
import { commandContact, narrowFactsOf } from './repos/ownership.js';
import { type CommandVerb, CommandBodies, OwnershipResultResponse } from './schemas.js';

const ACTION: Record<CommandVerb, Action> = {
  accept: 'lead.accept',
  decline: 'lead.decline',
  claim: 'lead.claim',
  release: 'lead.release',
  reassign: 'lead.reassign',
  handoff: 'lead.reassign',
  close: 'contact.view_detail',
  reopen: 'contact.view_detail',
  merge: 'contact.view_detail',
  delete: 'contact.view_detail',
};

/** The relation a verb is about (used when the row itself is no longer visible to the caller). */
const VERB_RELATION: Record<CommandVerb, ResourceFacts> = {
  accept: { offer: true },
  decline: { offer: true },
  claim: { pond: true },
  release: { own: true },
  reassign: { own: true },
  handoff: { own: true },
  close: {},
  reopen: {},
  merge: {},
  delete: {},
};

/** What the facts read saw (the handler reuses it to fill defaults such as the claimed pond). */
type SeenRow = Pick<repo.ContactRow, 'pond_id' | 'ownership_state'>;
const seen = new WeakMap<FastifyRequest, SeenRow | null>();

/**
 * Verbs authorized by the offer / pond / own scopes only (core MATRIX: lead.accept, lead.decline OFFER;
 * lead.claim POND; lead.release OWN). Their facts come from the narrow read (repos/ownership.ts): the same
 * row visibility and the same relation expressions as getContact, without evaluating the relations and the
 * detail visibility no rule of theirs reads (lane perf-misses: ~20 ms of Postgres CPU per tap at 250k).
 */
const NARROW: ReadonlySet<CommandVerb> = new Set(['accept', 'decline', 'claim', 'release']);

type Body = { commandId: string; expectedSeq?: number; toUserId?: string; loserId?: string };

async function commandFacts(req: FastifyRequest, verb: CommandVerb): Promise<ResourceFacts | null> {
  const id = (req.params as { contactId: string }).contactId;
  const body = req.body as Body;
  return leadsTx(req, async (tx) => {
    const narrow = NARROW.has(verb);
    const row = narrow ? await commandContact(tx, id) : await repo.getContact(tx, id);
    seen.set(req, row);
    const factsOfRow = (r: NonNullable<typeof row>): ResourceFacts => (narrow ? narrowFactsOf(r as NonNullable<Awaited<ReturnType<typeof commandContact>>>) : factsOf(r as repo.ContactRow));
    const target = async (): Promise<ResourceFacts> => {
      if (verb !== 'reassign' && verb !== 'handoff') return {};
      const t = body.toUserId ? await repo.memberTarget(tx, body.toUserId) : null;
      // no such member: can()'s target check answers TARGET_NOT_ELIGIBLE
      return t ? { target: { role: t.role as Role, inMyTeam: t.in_my_team } } : {};
    };
    // R-OWN-7: the caller already issued this very command: the engine returns the stored outcome,
    // whatever the contact looks like now (an accepted offer is no longer an offer, a decline hid it).
    // A command id the caller used on ANOTHER contact is not a replay: refused, never answered with
    // that other command's stored outcome as if this one had succeeded.
    const record = await repo.commandRecord(tx, body.commandId);
    if (!repo.isNewCommand(record)) {
      if (!repo.commandContacts(record).has(id)) throw new AppError('COMMAND_ID_REUSED');
      return { ...(row ? factsOfRow(row) : {}), ...VERB_RELATION[verb], ...(await target()) };
    }
    if (!row) {
      // E1 / R-OWN-5: the command still reaches the engine when the caller had legitimate sight
      if (!(await repo.ownershipHead(tx, id))) return null;
      return verb === 'claim' || verb === 'accept' || verb === 'decline' || verb === 'release' ? { ...VERB_RELATION[verb] } : null;
    }
    const facts = factsOfRow(row);
    // R-OWN-7: a second accept by the current owner is answered ALREADY_OWNER by the engine
    if (verb === 'accept' && row.rel_own) return { ...facts, offer: true };
    if (verb === 'reassign' || verb === 'handoff') return { ...facts, ...(await target()) };
    if (verb === 'close' || verb === 'reopen' || verb === 'merge' || verb === 'delete') {
      if (!(row as repo.ContactRow).detail_visible) return null;
      if (verb === 'merge') {
        const loser = body.loserId ? await repo.getContact(tx, body.loserId) : null;
        if (!loser || !loser.detail_visible) return null;
      }
    }
    return facts;
  });
}

function commandOf(verb: CommandVerb, contactId: string, b: Record<string, unknown>, row: SeenRow | null): OwnershipCommand {
  switch (verb) {
    case 'accept':
      return { kind: 'accept', offerId: b.offerId as string };
    case 'decline':
      return { kind: 'decline', offerId: b.offerId as string, ...(b.reason ? { reason: b.reason as 'busy' } : {}) };
    case 'claim':
      return { kind: 'claim', pondId: ((b.pondId as string | undefined) ?? row?.pond_id ?? NIL_UUID) as PondId };
    case 'release':
      return {
        kind: 'release',
        reason: b.reason as 'other',
        ...(b.note !== undefined ? { note: b.note as string } : {}),
        ...(b.toPondId !== undefined ? { toPondId: b.toPondId as PondId } : {}),
      };
    case 'reassign': {
      // an owned lead is reassigned; a pond / unassigned / offered lead is assigned (ledger + audit name it so)
      const kind = row?.ownership_state === 'owned' ? 'reassign' : 'assign';
      return { kind, toUserId: b.toUserId as UserId, reason: (b.reason as string | undefined) ?? (kind === 'assign' ? 'MANUAL_ASSIGN' : 'MANUAL_REASSIGN'), ...(b.note !== undefined ? { note: b.note as string } : {}) };
    }
    case 'handoff':
      return { kind: 'isa_handoff', toUserId: b.toUserId as UserId, note: b.note as string };
    case 'close':
      return { kind: 'close', reason: b.reason as 'spam' };
    case 'reopen':
      return { kind: 'reopen' };
    case 'merge':
      return { kind: 'merge', survivorId: contactId as ContactId, loserId: b.loserId as ContactId, ownerChoice: (b.ownerChoice as UserId | null | undefined) ?? null };
    case 'delete':
      return { kind: 'soft_delete' };
  }
}

export async function registerCommandRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  for (const verb of Object.keys(CommandBodies) as CommandVerb[]) {
    const action = ACTION[verb];
    r.post(
      `/leads/:contactId/${verb}`,
      {
        config: { auth: action },
        preHandler: authorize(action, (req) => commandFacts(req, verb)),
        schema: { params: z.object({ contactId: z.uuid() }), body: CommandBodies[verb], response: { 200: OwnershipResultResponse } },
      },
      async (req) => {
        const p = platformOf(req);
        const actor = actorOf(req);
        const b = req.body as Record<string, unknown> & Body;
        const cmd = commandOf(verb, req.params.contactId, b, seen.get(req) ?? null);
        let res: Awaited<ReturnType<typeof runOwnershipCommand>>;
        // F19 / R-CHAN-3 (module 22): closing a lead as do-not-contact records the person-level opt-out in the
        // close's own transaction (every channel of every point revoked, contacts.do_not_contact_at set)
        const afterApplied =
          cmd.kind === 'close' && cmd.reason === 'do_not_contact'
            ? async (tx: Tx) => {
                const now = await dbNow(tx);
                const out = await recordPersonDoNotContactInTx(tx, p.ids, actor, req.params.contactId, 'closed_as_do_not_contact', now);
                if (out.firstEventId !== null) {
                  await audit(tx, actor, { action: 'consent.recorded', entity: { type: 'contact', id: req.params.contactId }, changes: redactSnapshot({ kind: 'revoke', source: 'agent_revoke', scope: 'person' }, { entity: 'consent_event' }), reason: 'PERSON_DO_NOT_CONTACT' });
                }
              }
            : undefined;
        try {
          res = await runOwnershipCommand(actor, req.params.contactId as ContactId, cmd, b.commandId, b.expectedSeq, { db: p.db, ids: p.ids, ...(afterApplied ? { afterApplied } : {}) });
        } catch (e) {
          const mapped = mapLeadsDbError(e);
          if (mapped) throw mapped;
          throw e;
        }
        if (!res.ok) throw rejectionError(res);
        return { result: { contactId: res.contactId, replayed: res.replayed, events: res.events, projection: res.projection } };
      },
    );
  }
}

