// Narrow contact reads for the ownership command routes (lane perf-misses, claim contention).
//
// repos/contacts.getContact (CONTACT_SELECT) serves every contact view: besides the columns it evaluates
// all six relation facts and app.contact_detail_visible for the row (the caller's collaborations, team
// members, ponds, deal contacts). At 250k contacts that is ~20 ms of Postgres CPU per call
// (auto_explain on realty_load), and a tap called it twice (authorization facts, response projection).
// Accept / decline / claim / release are authorized by the offer / pond / own scopes only (core MATRIX),
// and the response needs only the projection columns, so these reads select just that.
//
// Visibility is the same: one row of `contacts` filtered only by tenant + id under the caller's RLS (no
// join), so the row is returned exactly when getContact returns it. The relation expressions are copied
// verbatim from CONTACT_SELECT. apps/api/src/leads/commands.test.ts proves the facts equal factsOf(getContact)
// for every relation the narrow verbs use; ownership.test.ts proves the projection equals a fresh read.
import type { ResourceFacts } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { ProjectionView } from '../schemas.js';
import type { ContactRow } from './contacts.js';

type ProjectionColumns =
  | 'id' | 'ownership_state' | 'owner_user_id' | 'pond_id' | 'offer_id' | 'offered_to_user_id' | 'offer_expires_at'
  | 'offer_round' | 'owned_at' | 'first_touch_due_at' | 'first_touch_at' | 'first_touch_breached_at' | 'release_due_at'
  | 'closed_reason' | 'ownership_seq';
export type ProjectionRow = Pick<ContactRow, ProjectionColumns>;
export type CommandContactRow = ProjectionRow & Pick<ContactRow, 'rel_own' | 'rel_offer' | 'rel_pond'>;

const PROJECTION_COLUMNS = sql`c.id, c.ownership_state, c.owner_user_id, c.pond_id, c.offer_id, c.offered_to_user_id,
         c.offer_expires_at, c.offer_round, c.owned_at, c.first_touch_due_at, c.first_touch_at, c.first_touch_breached_at,
         c.release_due_at, c.closed_reason, c.ownership_seq`;

/** The contact's projection and the offer / pond / own relations, as the caller sees it (null: invisible). */
export async function commandContact(tx: Tx, id: string): Promise<CommandContactRow | null> {
  const r = await sql<CommandContactRow>`
    SELECT ${PROJECTION_COLUMNS},
           COALESCE(c.owner_user_id = app.user_id(), false) AS rel_own,
           COALESCE(c.offered_to_user_id = app.user_id(), false) AS rel_offer,
           COALESCE(c.ownership_state = 'in_pond' AND (c.pond_id = ANY (app.my_pond_ids()) OR app.my_role() = 'team_lead'), false) AS rel_pond
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** The projection columns only (the response read-back). */
export async function projectionRow(tx: Tx, id: string): Promise<ProjectionRow | null> {
  const r = await sql<ProjectionRow>`
    SELECT ${PROJECTION_COLUMNS} FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** The relation facts of the narrow verbs (offer / pond / own scopes). */
export function narrowFactsOf(r: CommandContactRow): ResourceFacts {
  return { own: r.rel_own, pond: r.rel_pond, offer: r.rel_offer };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Same mapping as views.projectionFromRow. */
export function projectionOfRow(r: ProjectionRow): z.infer<typeof ProjectionView> {
  return {
    state: r.ownership_state,
    ownerUserId: r.owner_user_id,
    pondId: r.pond_id,
    offerId: r.offer_id,
    offeredToUserId: r.offered_to_user_id,
    offerExpiresAt: iso(r.offer_expires_at),
    offerRound: r.offer_round,
    ownedAt: iso(r.owned_at),
    firstTouchDueAt: iso(r.first_touch_due_at),
    firstTouchAt: iso(r.first_touch_at),
    firstTouchBreachedAt: iso(r.first_touch_breached_at),
    releaseDueAt: iso(r.release_due_at),
    closedReason: r.closed_reason,
    seq: Number(r.ownership_seq),
  };
}
