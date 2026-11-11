// Mapping between the ownership tables and core/ownership types.
import type { ContactStage, LedgerActorKind, OwnershipErrorCode, OwnershipEvent, OwnershipEventPayload, OwnershipEventType, OwnershipProjection, OwnershipState, RejectionSpec } from '@realty/core/ownership';
import type { ContactId, Instant, OwnershipRejectionId, PondId, RuleId, UserId } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { sql } from 'kysely';
import type { Tx } from '../tenantTx.js';

const ts = (d: Date | null): Instant | null => (d ? instantFromDate(d) : null);
const iso = (t: Instant | null): string | null => (t === null ? null : toIso(t));
const num = (s: string | number | null): number | null => (s === null ? null : Number(s));

/** Every column of `contacts` the ownership path reads (guarded projection + the inputs core needs). */
export interface ContactOwnershipRow {
  id: string;
  ownership_state: OwnershipState;
  owner_user_id: string | null;
  pond_id: string | null;
  offer_id: string | null;
  offered_to_user_id: string | null;
  offer_expires_at: Date | null;
  offer_round: number;
  routing_rule_id: string | null;
  owned_at: Date | null;
  first_touch_due_at: Date | null;
  first_touch_at: Date | null;
  first_touch_breached_at: Date | null;
  release_due_at: Date | null;
  ownership_period_seq: string | null;
  route_due_at: Date | null;
  closed_reason: OwnershipProjection['closedReason'];
  ownership_seq: string;
  ownership_command_id: string;
  ownership_actor_user_id: string | null;
  stage: ContactStage;
  timezone: string | null;
  last_human_touch_at: Date | null;
  inactivity_warn_at: Date | null;
  inactivity_release_at: Date | null;
  deleted_at: Date | null;
  merged_into_contact_id: string | null;
}

export const CONTACT_OWNERSHIP_COLUMNS = sql.raw(`id, ownership_state, owner_user_id, pond_id, offer_id, offered_to_user_id,
  offer_expires_at, offer_round, routing_rule_id, owned_at, first_touch_due_at, first_touch_at, first_touch_breached_at,
  release_due_at, ownership_period_seq, route_due_at, closed_reason, ownership_seq, ownership_command_id,
  ownership_actor_user_id, stage, timezone, last_human_touch_at, inactivity_warn_at, inactivity_release_at, deleted_at,
  merged_into_contact_id`);

export function projectionOf(r: ContactOwnershipRow): OwnershipProjection {
  return {
    state: r.ownership_state,
    ownerUserId: r.owner_user_id as UserId | null,
    pondId: r.pond_id as PondId | null,
    offerId: r.offer_id,
    offeredToUserId: r.offered_to_user_id as UserId | null,
    offerExpiresAt: ts(r.offer_expires_at),
    offerRound: r.offer_round,
    routingRuleId: r.routing_rule_id as RuleId | null,
    ownedAt: ts(r.owned_at),
    firstTouchDueAt: ts(r.first_touch_due_at),
    firstTouchAt: ts(r.first_touch_at),
    firstTouchBreachedAt: ts(r.first_touch_breached_at),
    releaseDueAt: ts(r.release_due_at),
    periodSeq: num(r.ownership_period_seq),
    routeDueAt: ts(r.route_due_at),
    closedReason: r.closed_reason,
    seq: Number(r.ownership_seq),
    commandId: r.ownership_command_id,
    actorUserId: r.ownership_actor_user_id as UserId | null,
  };
}

/** Reads one contact's ownership row under the caller's RLS, locking it FOR UPDATE (null if invisible/absent). */
export async function selectContactForUpdate(tx: Tx, id: ContactId): Promise<ContactOwnershipRow | null> {
  const r = await sql<ContactOwnershipRow>`
    SELECT ${CONTACT_OWNERSHIP_COLUMNS} FROM contacts
     WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

/** Reads one contact's ownership row under the caller's RLS without locking. */
export async function selectContact(tx: Tx, id: ContactId): Promise<ContactOwnershipRow | null> {
  const r = await sql<ContactOwnershipRow>`
    SELECT ${CONTACT_OWNERSHIP_COLUMNS} FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

/** State + ledger head of a contact the caller may not see (app.ownership_head, migration 0002). */
export async function ownershipHead(tx: Tx, id: ContactId): Promise<{ state: OwnershipState; seq: number } | null> {
  const r = await sql<{ ownership_state: OwnershipState; ownership_seq: string }>`
    SELECT * FROM app.ownership_head(${id}::uuid)`.execute(tx);
  const row = r.rows[0];
  return row ? { state: row.ownership_state, seq: Number(row.ownership_seq) } : null;
}

// ---- ledger -----------------------------------------------------------------------------------

export interface LedgerRow {
  contact_id: string;
  seq: string;
  event_id: string;
  type: OwnershipEventType;
  from_state: OwnershipState | null;
  to_state: OwnershipState;
  owner_user_id: string | null;
  prev_owner_user_id: string | null;
  pond_id: string | null;
  offer_id: string | null;
  offered_to_user_id: string | null;
  routing_rule_id: string | null;
  deadline_at: Date | null;
  actor_kind: LedgerActorKind;
  actor_user_id: string | null;
  reason_code: string;
  note: string | null;
  command_id: string;
  payload: OwnershipEventPayload;
  occurred_at: Date;
}

export function eventOf(r: LedgerRow): OwnershipEvent {
  return {
    eventId: r.event_id,
    contactId: r.contact_id as ContactId,
    seq: Number(r.seq),
    type: r.type,
    fromState: r.from_state,
    toState: r.to_state,
    ownerUserId: r.owner_user_id as UserId | null,
    prevOwnerUserId: r.prev_owner_user_id as UserId | null,
    pondId: r.pond_id as PondId | null,
    offerId: r.offer_id,
    offeredToUserId: r.offered_to_user_id as UserId | null,
    routingRuleId: r.routing_rule_id as RuleId | null,
    deadlineAt: ts(r.deadline_at),
    actorKind: r.actor_kind,
    actorUserId: r.actor_user_id as UserId | null,
    reasonCode: r.reason_code,
    note: r.note,
    commandId: r.command_id,
    payload: r.payload,
    occurredAt: instantFromDate(r.occurred_at),
  };
}

/** The contact's whole ledger, in seq order (visible to the caller). */
export async function selectLedger(tx: Tx, contactId: ContactId): Promise<OwnershipEvent[]> {
  const r = await sql<LedgerRow>`
    SELECT * FROM lead_ownership_events WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} ORDER BY seq`.execute(tx);
  return r.rows.map(eventOf);
}

export async function insertEvents(tx: Tx, events: readonly OwnershipEvent[]): Promise<void> {
  for (const e of events) {
    await sql`
      INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
        prev_owner_user_id, pond_id, offer_id, offered_to_user_id, routing_rule_id, deadline_at, actor_kind, actor_user_id,
        reason_code, note, command_id, payload, occurred_at)
      VALUES (app.tenant_id(), ${e.contactId}, ${e.seq}, ${e.eventId}, ${e.type}, ${e.fromState}, ${e.toState},
        ${e.ownerUserId}, ${e.prevOwnerUserId}, ${e.pondId}, ${e.offerId}, ${e.offeredToUserId}, ${e.routingRuleId},
        ${iso(e.deadlineAt)}::timestamptz, ${e.actorKind}, ${e.actorUserId}, ${e.reasonCode}, ${e.note}, ${e.commandId},
        ${JSON.stringify(e.payload)}::jsonb, ${toIso(e.occurredAt)}::timestamptz)`.execute(tx);
  }
}

// ---- rejections ---------------------------------------------------------------------------------

interface RejectionRow {
  id: string;
  contact_id: string | null;
  command_id: string;
  command_kind: string;
  code: string;
  observed_seq: string | null;
  actor_kind: LedgerActorKind;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export async function insertRejection(tx: Tx, r: RejectionSpec): Promise<void> {
  await sql`
    INSERT INTO ownership_command_rejections (tenant_id, id, contact_id, command_id, command_kind, code, observed_seq,
      actor_kind, actor_user_id, payload, occurred_at)
    VALUES (app.tenant_id(), ${r.id}, ${r.contactId}, ${r.commandId}, ${r.commandKind}, ${r.code}, ${r.observedSeq},
      ${r.actorKind}, ${r.actorUserId}, ${JSON.stringify(r.payload)}::jsonb, ${toIso(r.occurredAt)}::timestamptz)`.execute(tx);
}

export async function selectRejection(tx: Tx, commandId: string): Promise<RejectionSpec | null> {
  const r = await sql<RejectionRow>`
    SELECT id, contact_id, command_id, command_kind, code, observed_seq, actor_kind, actor_user_id, payload, occurred_at
      FROM ownership_command_rejections WHERE tenant_id = app.tenant_id() AND command_id = ${commandId}`.execute(tx);
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id as OwnershipRejectionId,
    contactId: row.contact_id as ContactId | null,
    commandId: row.command_id,
    commandKind: row.command_kind as RejectionSpec['commandKind'],
    code: row.code as OwnershipErrorCode,
    observedSeq: num(row.observed_seq),
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id as UserId | null,
    payload: row.payload,
    occurredAt: instantFromDate(row.occurred_at),
  };
}

/** Ledger rows of one command the caller issued (or any, tenant-wide): app.ownership_command_events. */
export async function selectCommandEvents(tx: Tx, commandId: string): Promise<OwnershipEvent[]> {
  const r = await sql<LedgerRow>`SELECT * FROM app.ownership_command_events(${commandId}::uuid)`.execute(tx);
  return r.rows.map(eventOf);
}

// ---- projection writes ---------------------------------------------------------------------------

/** Non-guarded contact columns that ride along with the projection write (Effect kinds). */
export interface ContactColumnEffects {
  inactivity?: { warnAt: Instant | null; releaseAt: Instant | null };
  lastHumanTouchAt?: Instant;
  markDeleted?: { purgeAfter: Instant; deletedBy: UserId | null; at: Instant };
  clearDeleted?: true;
  mergedInto?: ContactId;
}

function projectionValues(p: OwnershipProjection) {
  return {
    ownership_state: p.state,
    owner_user_id: p.ownerUserId,
    pond_id: p.pondId,
    offer_id: p.offerId,
    offered_to_user_id: p.offeredToUserId,
    offer_expires_at: iso(p.offerExpiresAt),
    offer_round: p.offerRound,
    routing_rule_id: p.routingRuleId,
    owned_at: iso(p.ownedAt),
    first_touch_due_at: iso(p.firstTouchDueAt),
    first_touch_at: iso(p.firstTouchAt),
    first_touch_breached_at: iso(p.firstTouchBreachedAt),
    release_due_at: iso(p.releaseDueAt),
    ownership_period_seq: p.periodSeq,
    route_due_at: iso(p.routeDueAt),
    closed_reason: p.closedReason,
    ownership_seq: p.seq,
    ownership_command_id: p.commandId,
    ownership_actor_user_id: p.actorUserId,
  };
}

/**
 * UPDATE contacts SET <projection + ride-along columns> WHERE ownership_seq = expected (R-OWN-5:
 * belt and braces on top of the row lock). Returns the number of rows written (0 = lost the race).
 * Inactivity deadlines are forced to NULL outside `owned` (CHECK contacts_owned_period).
 */
export async function updateProjection(tx: Tx, id: ContactId, expectedSeq: number, p: OwnershipProjection, fx: ContactColumnEffects): Promise<number> {
  const v = projectionValues(p);
  const owned = p.state === 'owned';
  const warnSet = fx.inactivity !== undefined || !owned;
  const warnAt = owned && fx.inactivity ? iso(fx.inactivity.warnAt) : null;
  const releaseAt = owned && fx.inactivity ? iso(fx.inactivity.releaseAt) : null;
  const r = await sql`
    UPDATE contacts SET
      ownership_state = ${v.ownership_state}, owner_user_id = ${v.owner_user_id}, pond_id = ${v.pond_id},
      offer_id = ${v.offer_id}, offered_to_user_id = ${v.offered_to_user_id}, offer_expires_at = ${v.offer_expires_at}::timestamptz,
      offer_round = ${v.offer_round}, routing_rule_id = ${v.routing_rule_id}, owned_at = ${v.owned_at}::timestamptz,
      first_touch_due_at = ${v.first_touch_due_at}::timestamptz, first_touch_at = ${v.first_touch_at}::timestamptz,
      first_touch_breached_at = ${v.first_touch_breached_at}::timestamptz, release_due_at = ${v.release_due_at}::timestamptz,
      ownership_period_seq = ${v.ownership_period_seq}, route_due_at = ${v.route_due_at}::timestamptz,
      closed_reason = ${v.closed_reason}, ownership_seq = ${v.ownership_seq}, ownership_command_id = ${v.ownership_command_id},
      ownership_actor_user_id = ${v.ownership_actor_user_id},
      inactivity_warn_at = CASE WHEN ${warnSet} THEN ${warnAt}::timestamptz ELSE inactivity_warn_at END,
      inactivity_release_at = CASE WHEN ${warnSet} THEN ${releaseAt}::timestamptz ELSE inactivity_release_at END,
      last_human_touch_at = COALESCE(${iso(fx.lastHumanTouchAt ?? null)}::timestamptz, last_human_touch_at),
      deleted_at = CASE WHEN ${fx.markDeleted !== undefined} THEN ${iso(fx.markDeleted?.at ?? null)}::timestamptz
                        WHEN ${fx.clearDeleted === true} THEN NULL ELSE deleted_at END,
      deleted_by_user_id = CASE WHEN ${fx.markDeleted !== undefined} THEN ${fx.markDeleted?.deletedBy ?? null}::uuid
                        WHEN ${fx.clearDeleted === true} THEN NULL ELSE deleted_by_user_id END,
      purge_after = CASE WHEN ${fx.markDeleted !== undefined} THEN ${iso(fx.markDeleted?.purgeAfter ?? null)}::timestamptz
                        WHEN ${fx.clearDeleted === true} THEN NULL ELSE purge_after END,
      merged_into_contact_id = COALESCE(${fx.mergedInto ?? null}::uuid, merged_into_contact_id),
      row_version = row_version + 1
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND ownership_seq = ${expectedSeq}`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** Fields of a contact created by an ownership command (create / import_assign). */
export interface NewContactFields {
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  contactType?: 'lead' | 'sphere' | 'past_client' | 'vendor' | 'other';
  intent?: 'buyer' | 'seller' | 'buyer_seller' | 'renter' | 'landlord' | 'investor' | null;
  stage?: ContactStage;
  timezone?: string | null;
  timezoneSource?: 'explicit' | 'address' | 'area_code' | 'tenant_default' | null;
  pondSummary?: string | null;
  originalLeadSourceId?: string | null;
  originalCampaignRef?: string | null;
  originalAdRef?: string | null;
  originalSourceDetail?: Record<string, string | number | boolean | null>;
  importBatchId?: string | null;
}

export async function insertContact(tx: Tx, id: ContactId, c: NewContactFields, p: OwnershipProjection, fx: ContactColumnEffects, createdBy: UserId | null): Promise<void> {
  const v = projectionValues(p);
  const owned = p.state === 'owned';
  await sql`
    INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, contact_type, intent, stage, timezone,
      timezone_source, pond_summary, original_lead_source_id, original_campaign_ref, original_ad_ref, original_source_detail,
      import_batch_id, created_by_user_id,
      ownership_state, owner_user_id, pond_id, offer_id, offered_to_user_id, offer_expires_at, offer_round, routing_rule_id,
      owned_at, first_touch_due_at, first_touch_at, first_touch_breached_at, release_due_at, ownership_period_seq,
      route_due_at, closed_reason, ownership_seq, ownership_command_id, ownership_actor_user_id,
      inactivity_warn_at, inactivity_release_at)
    VALUES (app.tenant_id(), ${id}, ${c.firstName ?? null}, ${c.lastName ?? null}, ${c.displayName}, ${c.contactType ?? 'lead'},
      ${c.intent ?? null}, ${c.stage ?? 'new'}, ${c.timezone ?? null}, ${c.timezoneSource ?? null}, ${c.pondSummary ?? null},
      ${c.originalLeadSourceId ?? null}, ${c.originalCampaignRef ?? null}, ${c.originalAdRef ?? null},
      ${JSON.stringify(c.originalSourceDetail ?? {})}::jsonb, ${c.importBatchId ?? null}, ${createdBy},
      ${v.ownership_state}, ${v.owner_user_id}, ${v.pond_id}, ${v.offer_id}, ${v.offered_to_user_id},
      ${v.offer_expires_at}::timestamptz, ${v.offer_round}, ${v.routing_rule_id}, ${v.owned_at}::timestamptz,
      ${v.first_touch_due_at}::timestamptz, ${v.first_touch_at}::timestamptz, ${v.first_touch_breached_at}::timestamptz,
      ${v.release_due_at}::timestamptz, ${v.ownership_period_seq}, ${v.route_due_at}::timestamptz, ${v.closed_reason},
      ${v.ownership_seq}, ${v.ownership_command_id}, ${v.ownership_actor_user_id},
      ${owned && fx.inactivity ? iso(fx.inactivity.warnAt) : null}::timestamptz,
      ${owned && fx.inactivity ? iso(fx.inactivity.releaseAt) : null}::timestamptz)`.execute(tx);
}
