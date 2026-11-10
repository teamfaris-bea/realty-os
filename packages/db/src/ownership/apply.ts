// applyOwnershipCommand: the single code path for every ownership change (ARCHITECTURE §5;
// R-OWN-2, R-OWN-3, R-OWN-5, R-OWN-6, R-OWN-7).
//
//   BEGIN; withTenantTx context; set_config('app.ownership_command', command_id, true)
//     0 idempotency: a rejection or ledger events with this command_id ⇒ return the stored outcome
//     1 app.lock_contact; SELECT … FROM contacts … FOR UPDATE (merges: both, ascending id)
//     2 system actor only: routing_rotation_state FOR UPDATE; candidate memberships (sorted)
//     3 now := clock_timestamp()   (read AFTER the locks)
//     4 decision := core.ownership.decide(projection, command, ctx)
//     5 accepted: INSERT lead_ownership_events (seq = head + 1 …)   rejected: INSERT ownership_command_rejections
//     6 UPDATE contacts SET … WHERE ownership_seq = expected        (the DB guard re-checks ledger/head)
//     7 effects: inline (rows the actor may write) + ONE ownership.followup job for cross-user effects
//   COMMIT  (serialization_failure / deadlock ⇒ retry ≤ 3 with the same command_id)
import { randomFillSync } from 'node:crypto';
import { sha256Hex } from '@realty/core/compliance';
import type { Actor, ContactId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { instant, instantFromDate, uuidv7Generator } from '@realty/core/foundation';
import {
  type DeactivationFacts,
  type Decision,
  type DecisionContext,
  type Effect,
  type InquiryFacts,
  type OwnershipCommand,
  type OwnershipErrorCode,
  type OwnershipEvent,
  type OwnershipProjection,
  type RejectionSpec,
  decide,
  decideMerge,
  ledgerActor,
  placeEffects,
} from '@realty/core/ownership';
import { sql } from 'kysely';
import type { Database } from '../client.js';
import { lockContact, lockContacts } from '../locks.js';
import { dbNow, setOwnershipCommand, type Tx, withTenantTx } from '../tenantTx.js';
import {
  type TenantFacts,
  loadClaimStats,
  loadDealOpen,
  loadInquiry,
  loadIsCollaborator,
  loadMember,
  loadPeople,
  loadPond,
  loadRoutingSnapshot,
  loadTenantFacts,
  lockMemberships,
  myTeamMemberIds,
  nextContactableFn,
} from './context.js';
import { type EffectContext, type FollowupPayload, applyEffects, enqueueFollowup } from './effects.js';
import {
  type ContactColumnEffects,
  type ContactOwnershipRow,
  type NewContactFields,
  insertContact,
  insertEvents,
  insertRejection,
  ownershipHead,
  projectionOf,
  selectCommandEvents,
  selectContact,
  selectContactForUpdate,
  selectLedger,
  selectRejection,
  updateProjection,
} from './rows.js';
import { mergeCommunication } from './merge.js';

export interface OwnershipCommandOptions {
  /** idempotency key (uuid); retries and replays reuse it */
  commandId: string;
  /** the ledger head the user's UI observed (stale UI ⇒ LEAD_STATE_CHANGED) */
  expectedSeq?: number;
  /** id generator for events, offers, rejections, notifications (default: UUIDv7 from the OS RNG) */
  ids?: IdGenerator;
  /** create / import_assign: the new contact's fields */
  newContact?: NewContactFields;
  /** create via intake: the inquiry facts routing matches on (the lead_inquiries row is written after the contact) */
  inquiry?: InquiryFacts;
  /** deactivate_owner: the staged deactivation's facts (R-OWN-22) */
  deactivation?: DeactivationFacts;
  db?: Database;
}

/** A replay returns what the first execution stored (R-OWN-7): the ledger events, or the rejection. */
export type StoredOutcome = { ok: true; events: OwnershipEvent[] } | { ok: false; code: OwnershipErrorCode; rejection: RejectionSpec };

export type OwnershipCommandResult =
  | { replayed: false; outcome: Decision; projection: OwnershipProjection | null }
  | { replayed: true; outcome: StoredOutcome; projection: OwnershipProjection | null };

export class OwnershipWriteConflict extends Error {
  override readonly name = 'OwnershipWriteConflict';
  /** retried like a serialization failure */
  readonly code = '40001';
}

export class MissingNewContactError extends TypeError {
  override readonly name = 'MissingNewContactError';
}

export function defaultIds(): IdGenerator {
  return uuidv7Generator({ now: () => instant(Date.now()) }, (n) => randomFillSync(new Uint8Array(n)));
}

/** Deterministic command id derived from another (name-based UUIDv8 over SHA-256, RFC 9562 §5.8). */
export function derivedCommandId(namespace: string, ...parts: string[]): string {
  const h = sha256Hex(`${namespace}:${parts.map((p) => p.toLowerCase()).join(':')}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ROUTING_COMMANDS = new Set<OwnershipCommand['kind']>(['create', 'route', 'timer', 'reinquiry', 'reopen', 'deactivate_owner']);

function contactEffects(effects: readonly Effect[], actor: Actor, now: Instant): ContactColumnEffects {
  const fx: ContactColumnEffects = {};
  for (const e of effects) {
    if (e.kind === 'setInactivityDeadlines') fx.inactivity = { warnAt: e.warnAt, releaseAt: e.releaseAt };
    else if (e.kind === 'recordHumanTouch') fx.lastHumanTouchAt = e.at;
    else if (e.kind === 'markDeleted') fx.markDeleted = { purgeAfter: e.purgeAfter, at: now, deletedBy: actor.kind === 'user' ? actor.userId : null };
    else if (e.kind === 'clearDeleted') fx.clearDeleted = true;
    else if (e.kind === 'markMergedInto') fx.mergedInto = e.survivorId;
  }
  return fx;
}

/** Non-guarded columns only (a decision with no events but contact effects, e.g. a repeat touch). */
async function updateContactColumns(tx: Tx, id: ContactId, fx: ContactColumnEffects): Promise<void> {
  if (fx.inactivity === undefined && fx.lastHumanTouchAt === undefined) return;
  const iso = (t: Instant | null | undefined) => (t === null || t === undefined ? null : new Date(t).toISOString());
  await sql`
    UPDATE contacts SET
      inactivity_warn_at = CASE WHEN ${fx.inactivity !== undefined} THEN ${iso(fx.inactivity?.warnAt)}::timestamptz ELSE inactivity_warn_at END,
      inactivity_release_at = CASE WHEN ${fx.inactivity !== undefined} THEN ${iso(fx.inactivity?.releaseAt)}::timestamptz ELSE inactivity_release_at END,
      last_human_touch_at = COALESCE(${iso(fx.lastHumanTouchAt)}::timestamptz, last_human_touch_at)
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND ownership_state = 'owned'`.execute(tx);
}

async function storedOutcome(tx: Tx, commandId: string): Promise<StoredOutcome | null> {
  const rej = await selectRejection(tx, commandId);
  if (rej) return { ok: false, code: rej.code, rejection: rej };
  const events = await selectCommandEvents(tx, commandId);
  return events.length > 0 ? { ok: true, events } : null;
}

async function currentProjection(tx: Tx, id: ContactId): Promise<OwnershipProjection | null> {
  const row = await selectContact(tx, id);
  return row ? projectionOf(row) : null;
}

/**
 * The command cannot be decided because the actor can no longer see the contact (it moved on in a
 * command that committed while this one waited for the lock: E1, a re-routed decline, …). The DB
 * still reports state + head (app.ownership_head), so the rejection is as precise as core's would be.
 */
function invisibleRejection(cmd: OwnershipCommand, ctxBase: { actor: Actor; ids: IdGenerator; commandId: string; contactId: ContactId; now: Instant }, head: { state: OwnershipProjection['state']; seq: number }): Decision {
  let code: OwnershipErrorCode = 'NOT_FOUND';
  if (cmd.kind === 'claim') code = head.state === 'owned' ? 'LEAD_ALREADY_CLAIMED' : 'LEAD_STATE_CHANGED';
  else if (cmd.kind === 'accept' || cmd.kind === 'decline') code = head.state === 'offered' ? 'LEAD_OFFER_SUPERSEDED' : 'LEAD_STATE_CHANGED';
  else if (cmd.kind === 'create') code = 'LEAD_STATE_CHANGED';
  const { actorKind, actorUserId } = ledgerActor(ctxBase.actor);
  const rejection: RejectionSpec = {
    id: ctxBase.ids.next<'OwnershipRejectionId'>(),
    contactId: ctxBase.contactId,
    commandId: ctxBase.commandId,
    commandKind: cmd.kind,
    code,
    observedSeq: head.seq,
    actorKind,
    actorUserId,
    payload: { invisible: true },
    occurredAt: ctxBase.now,
  };
  return { ok: false, code, rejection, next: null, effects: [] };
}

interface Loaded {
  facts: TenantFacts;
  ctx: DecisionContext;
}

async function buildContext(
  tx: Tx,
  actor: Actor,
  contactId: ContactId,
  cmd: OwnershipCommand,
  row: ContactOwnershipRow | null,
  state: OwnershipProjection | null,
  now: Instant,
  ids: IdGenerator,
  opts: OwnershipCommandOptions,
): Promise<Loaded> {
  const facts = await loadTenantFacts(tx);
  const u = actor.kind === 'user' ? actor : null;
  const nextContactableAt = await nextContactableFn(tx, facts, row ? contactId : null, row?.timezone ?? opts.newContact?.timezone ?? null);
  const ctx: DecisionContext = {
    now,
    ids,
    actor,
    commandId: opts.commandId,
    contactId,
    settings: facts.settings,
    calendar: facts.calendar,
    nextContactableAt,
    ...(opts.expectedSeq !== undefined ? { expectedSeq: opts.expectedSeq } : {}),
    contactStage: row?.stage ?? opts.newContact?.stage ?? 'new',
    dealOpen: row ? await loadDealOpen(tx, contactId) : false,
    lastHumanTouchAt: row?.last_human_touch_at ? instantFromDate(row.last_human_touch_at) : null,
    inactivity: {
      warnAt: row?.inactivity_warn_at ? instantFromDate(row.inactivity_warn_at) : null,
      releaseAt: row?.inactivity_release_at ? instantFromDate(row.inactivity_release_at) : null,
    },
    people: await loadPeople(tx),
  };
  const team = u?.role === 'team_lead' ? await myTeamMemberIds(tx) : undefined;
  const ownerOrOfferee = state?.state === 'owned' ? state.ownerUserId : state?.state === 'offered' ? state.offeredToUserId : null;
  if (team) ctx.ownerInActorTeam = ownerOrOfferee !== null && team.has(ownerOrOfferee);
  switch (cmd.kind) {
    case 'accept':
    case 'claim':
      if (u) {
        ctx.actorMember = await loadMember(tx, u.userId);
        if (cmd.kind === 'claim') {
          const pond = await loadPond(tx, cmd.pondId, u.userId);
          if (pond) {
            ctx.pond = pond;
            ctx.claimStats = await loadClaimStats(tx, u.userId, contactId, now, facts, pond.claimCooldownHours);
          }
        }
      }
      break;
    case 'decline':
      if (u) ctx.offereeMissedOffers = (await loadMember(tx, u.userId))?.missedOffers ?? 0;
      break;
    case 'release':
      if (cmd.toPondId) {
        const pond = await loadPond(tx, cmd.toPondId, u?.userId ?? null);
        if (pond) ctx.pond = pond;
      }
      break;
    case 'assign':
    case 'reassign':
    case 'isa_handoff': {
      const t = await loadMember(tx, cmd.toUserId, team);
      if (t) ctx.targetMember = t;
      break;
    }
    case 'import_assign':
      if (cmd.target !== 'unassigned' && 'userId' in cmd.target) {
        const t = await loadMember(tx, cmd.target.userId);
        if (t) ctx.targetMember = t;
      }
      break;
    case 'touch':
      if (u) ctx.actorIsCollaborator = await loadIsCollaborator(tx, contactId, u.userId, now);
      break;
    case 'reinquiry':
      if (state?.state === 'in_pond' && state.pondId) {
        const pond = await loadPond(tx, state.pondId, null);
        if (pond) ctx.pond = pond;
      }
      break;
    case 'deactivate_owner':
      if (opts.deactivation) ctx.deactivation = opts.deactivation;
      break;
    default:
      break;
  }
  // Offer expiry: the offeree's missed-offer counter (R-OWN-12) is written by this command.
  const writeUsers: string[] = [];
  if (cmd.kind === 'timer' && cmd.deadline === 'offer_expiry' && state?.state === 'offered' && state.offeredToUserId) {
    const m = await loadMember(tx, state.offeredToUserId);
    ctx.offereeMissedOffers = m?.missedOffers ?? 0;
    writeUsers.push(state.offeredToUserId);
  }
  // Step 2: routing inputs, system actor only (F1). Locks: rotation FOR UPDATE, memberships sorted.
  if (actor.kind === 'system' && actor.via !== 'assistant' && actor.via !== 'import' && ROUTING_COMMANDS.has(cmd.kind)) {
    const ledger = state ? await selectLedger(tx, contactId) : [];
    const inquiry = opts.inquiry ?? (state ? await loadInquiry(tx, contactId, cmd.kind === 'route' || cmd.kind === 'reinquiry' ? cmd.inquiryId : undefined) : { leadSourceId: null, inquiryType: null, postalCode: null, priceMinCents: null, priceMaxCents: null });
    ctx.routing = await loadRoutingSnapshot(tx, contactId, inquiry, ledger, now, facts, writeUsers);
  } else if (writeUsers.length > 0) {
    await lockMemberships(tx, [], writeUsers);
  }
  return { facts, ctx };
}

async function persistDecision(
  tx: Tx,
  actor: Actor,
  contactId: ContactId,
  cmd: OwnershipCommand,
  state: OwnershipProjection | null,
  decision: Decision,
  ctx: DecisionContext,
  opts: OwnershipCommandOptions,
): Promise<void> {
  if (!decision.ok) {
    await insertRejection(tx, decision.rejection);
    return;
  }
  const fx = contactEffects(decision.effects, actor, ctx.now);
  if (decision.events.length > 0) {
    await insertEvents(tx, decision.events);
    if (state === null) {
      if (!opts.newContact) throw new MissingNewContactError(`${cmd.kind} creates a contact: opts.newContact is required`);
      await insertContact(tx, contactId, opts.newContact, decision.next, fx, actor.kind === 'user' ? actor.userId : null);
    } else {
      const n = await updateProjection(tx, contactId, state.seq, decision.next, fx);
      if (n !== 1) throw new OwnershipWriteConflict(`contact ${contactId}: projection write affected ${n} rows`);
    }
  } else if (state !== null) {
    await updateContactColumns(tx, contactId, fx);
  }
  await runEffects(tx, actor, contactId, cmd, state, decision.next, decision.effects, ctx, opts.commandId);
}

async function runEffects(
  tx: Tx,
  actor: Actor,
  contactId: ContactId,
  cmd: OwnershipCommand,
  before: OwnershipProjection | null,
  after: OwnershipProjection | null,
  effects: readonly Effect[],
  ctx: DecisionContext,
  commandId: string,
  extraFollowup: FollowupPayload['effects'] = [],
): Promise<void> {
  const { inline, followup } = placeEffects(effects, actor);
  const ec: EffectContext = { actor, ids: ctx.ids, now: ctx.now, contactId, before, after, commandKind: cmd.kind, ...(ctx.people ? { people: ctx.people } : {}) };
  const fanout = await applyEffects(tx, ec, inline);
  if (followup.length > 0 || fanout.length > 0 || extraFollowup.length > 0) {
    // The follow-up runs later without the "before" projection: a re-home of open handbacks for a lead
    // that is no longer owned must still reach the PREVIOUS owner's Team Lead (ARCHITECTURE §10), so
    // the previous owner travels with the effect (an id only).
    const carried = followup.map((e) =>
      e.kind === 'rehomeHandbacks' ? { ...e, previousOwnerUserId: before?.state === 'owned' ? before.ownerUserId : null } : e,
    );
    await enqueueFollowup(tx, { commandId, contactId, effects: [...extraFollowup, ...(carried as unknown as FollowupPayload['effects'])], fanoutNotificationIds: fanout }, ctx.ids);
  }
}

/** Every step of an ownership command inside an existing transaction (dispatch TX1 touch, dial, merge, follow-up). */
export async function applyOwnershipCommandInTx(tx: Tx, actor: Actor, contactId: ContactId, cmd: OwnershipCommand, opts: OwnershipCommandOptions): Promise<OwnershipCommandResult> {
  const ids = opts.ids ?? defaultIds();
  await setOwnershipCommand(tx, opts.commandId);
  const stored = await storedOutcome(tx, opts.commandId);
  if (stored) return { replayed: true, outcome: stored, projection: await currentProjection(tx, cmd.kind === 'merge' ? cmd.survivorId : contactId) };
  if (cmd.kind === 'merge') return applyMerge(tx, actor, cmd, { ...opts, ids });

  await lockContact(tx, contactId);
  // a concurrent retry of the SAME command may have committed while this one waited for the lock
  const storedAfterLock = await storedOutcome(tx, opts.commandId);
  if (storedAfterLock) return { replayed: true, outcome: storedAfterLock, projection: await currentProjection(tx, contactId) };
  const row = await selectContactForUpdate(tx, contactId);
  if (!row) {
    const head = await ownershipHead(tx, contactId);
    if (head) {
      const now = await dbNow(tx);
      const d = invisibleRejection(cmd, { actor, ids, commandId: opts.commandId, contactId, now }, head);
      if (!d.ok) await insertRejection(tx, d.rejection);
      return { replayed: false, outcome: d, projection: null };
    }
  }
  const state = row ? projectionOf(row) : null;
  const now = await dbNow(tx); // R-OWN-6: after the contact lock (routing locks follow in buildContext)
  const { ctx } = await buildContext(tx, actor, contactId, cmd, row, state, now, ids, opts);
  // The routing locks may have waited: the decision uses the DB clock read after ALL locks.
  ctx.now = await dbNow(tx);
  const decision = decide(state, cmd, ctx);
  await persistDecision(tx, actor, contactId, cmd, state, decision, ctx, opts);
  const projection = decision.ok ? decision.next : row ? await currentProjection(tx, contactId) : null;
  return { replayed: false, outcome: decision, projection };
}

/** applyOwnershipCommand in its own transaction (retried ≤ 3 times on serialization failure / deadlock). */
export function applyOwnershipCommand(actor: Actor, contactId: ContactId | null, cmd: OwnershipCommand, opts: OwnershipCommandOptions): Promise<OwnershipCommandResult> {
  const id = contactId ?? (cmd.kind === 'merge' ? cmd.survivorId : null);
  if (id === null) throw new TypeError('contactId is required (merge: the survivor id)');
  const ids = opts.ids ?? defaultIds();
  return withTenantTx(actor, (tx) => applyOwnershipCommandInTx(tx, actor, id, cmd, { ...opts, ids }), {
    ownershipCommand: opts.commandId,
    retries: 3,
    ...(opts.db ? { db: opts.db } : {}),
  });
}

// ---- merge (R-OWN-24, E69) ---------------------------------------------------------------------------

async function applyMerge(tx: Tx, actor: Actor, cmd: Extract<OwnershipCommand, { kind: 'merge' }>, opts: OwnershipCommandOptions & { ids: IdGenerator }): Promise<OwnershipCommandResult> {
  const { survivorId, loserId } = cmd;
  await lockContacts(tx, [survivorId, loserId]);
  // A concurrent delivery of the SAME merge may have committed while this one waited for the locks:
  // return its stored outcome (R-OWN-7) instead of re-deciding and re-running the communication move.
  const storedAfterLock = await storedOutcome(tx, opts.commandId);
  if (storedAfterLock) return { replayed: true, outcome: storedAfterLock, projection: await currentProjection(tx, survivorId) };
  // contacts FOR UPDATE in ascending id order (global lock order step 3)
  const rows = new Map<string, ContactOwnershipRow | null>();
  for (const id of [survivorId, loserId].sort()) rows.set(id, await selectContactForUpdate(tx, id));
  const srow = rows.get(survivorId) ?? null;
  const lrow = rows.get(loserId) ?? null;
  const now = await dbNow(tx);
  if (!srow || !lrow) {
    const head = (await ownershipHead(tx, srow ? loserId : survivorId)) ?? { state: 'closed' as const, seq: 1 };
    const d = invisibleRejection(cmd, { actor, ids: opts.ids, commandId: opts.commandId, contactId: survivorId, now }, head);
    if (!d.ok) await insertRejection(tx, d.rejection);
    return { replayed: false, outcome: d, projection: srow ? projectionOf(srow) : null };
  }
  const survivor = projectionOf(srow);
  const loser = projectionOf(lrow);
  const { ctx } = await buildContext(tx, actor, survivorId, cmd, srow, survivor, now, opts.ids, opts);
  ctx.mergePeer = loser;
  ctx.mergePeerInactivity = {
    warnAt: lrow.inactivity_warn_at ? instantFromDate(lrow.inactivity_warn_at) : null,
    releaseAt: lrow.inactivity_release_at ? instantFromDate(lrow.inactivity_release_at) : null,
  };
  const d = decideMerge(survivor, loser, cmd, ctx);
  if (!d.ok) {
    await insertRejection(tx, d.rejection);
    return { replayed: false, outcome: d, projection: survivor };
  }
  await insertEvents(tx, d.loser.events);
  await insertEvents(tx, d.survivor.events);
  const lfx = contactEffects(d.loser.effects, actor, ctx.now);
  const sfx = contactEffects(d.survivor.effects, actor, ctx.now);
  if (d.loser.events.length > 0 && (await updateProjection(tx, loserId, loser.seq, d.loser.next, lfx)) !== 1) throw new OwnershipWriteConflict('merge loser write');
  if (d.survivor.events.length > 0 && (await updateProjection(tx, survivorId, survivor.seq, d.survivor.next, sfx)) !== 1) throw new OwnershipWriteConflict('merge survivor write');
  // Communication and automation move with the merge (R-OWN-24). A tenant-wide actor (system,
  // Owner/Admin) does it in this transaction; a Team Lead / agent cannot write other users'
  // messages, handbacks or enrollments, so the follow-up does it as the system actor, under both
  // contact locks again.
  // Asked of the DATABASE (current membership role), never of actor.role: a session that still says
  // 'admin' after a demotion would otherwise run the move under a Team Lead's RLS, where the UPDATEs
  // silently match zero rows and the loser's history is left behind with no follow-up to move it.
  const tenantWide = (await sql<{ ok: boolean }>`SELECT app.is_tenant_wide() AS ok`.execute(tx)).rows[0]?.ok === true;
  const owner = d.survivor.next.state === 'owned' ? d.survivor.next.ownerUserId : null;
  const mergeFx = { kind: 'mergeCommunication', survivorId, loserId, ownerUserId: owner, previousOwnerUserId: survivor.ownerUserId ?? loser.ownerUserId };
  if (tenantWide) await mergeCommunication(tx, ctx.now, ctx.ids, survivorId, loserId, owner ?? null, ctx.people, survivor.ownerUserId ?? loser.ownerUserId);
  // the communication move runs FIRST in the loser's follow-up (before its draft invalidation / re-homing)
  await runEffects(tx, actor, loserId, cmd, loser, d.loser.next, d.loser.effects, ctx, opts.commandId, tenantWide ? [] : [mergeFx]);
  await runEffects(tx, actor, survivorId, cmd, survivor, d.survivor.next, d.survivor.effects, { ...ctx }, derivedCommandId('merge.survivor', opts.commandId));
  const outcome: Decision = { ok: true, events: [...d.loser.events, ...d.survivor.events], next: d.survivor.next, effects: [...d.loser.effects, ...d.survivor.effects] };
  return { replayed: false, outcome, projection: d.survivor.next };
}

export type { UserId };
