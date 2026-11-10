// The Team Lead live exception queue (BUILD_PLAN module 15; A5; R-ACC-1, R-ACC-2, R-ACC-3, R-OWN-13,
// R-OWN-18, R-AUDIT-5, R-IMPORT-6, R-AST-15).
//
//   GET  /team/exceptions?type=&owner=&state=          the queue (TL: team; agent/ISA: own; Owner/Admin: all)
//   GET  /team/exceptions/:dedupeKey                    one item with its full event history
//   POST /team/exceptions/:dedupeKey/resolve  { note, commandId? }             agent (own), TL (team), Owner/Admin
//   POST /team/exceptions/:dedupeKey/verify   { note?, commandId? }            TL (team), Owner/Admin only
//   POST /team/exceptions/:dedupeKey/reopen   { note?, commandId? }            whoever may resolve it
//   POST /team/exceptions/:dedupeKey/reassign { toUserId, note?, commandId }   TL (team), Owner/Admin only
//
// Derivation (R-ACC-1): recomputeExceptions() runs core.deriveExceptions over the tenant's facts as the
// system actor and upserts exception_items by per-occurrence dedupe key. It never deletes a row and never
// touches exception_events, so a recompute keeps every human action. A condition that stops holding sets
// condition_cleared_at; the item stays in the LIVE queue until its latest human event is `resolved` or
// `verified` ("fixed late"). Nobody hand-enters an exception: there is no create route.
//
// Human actions (R-ACC-3) are append-only exception_events, inserted as the caller with their TRUE role
// (RLS exception_events_insert). The DB enforces: resolve needs a note; verify and reassign only by
// TL/Admin/Owner; a reassigned event must cite a ledger reassignment of the item's contact by the same user
// after detection (F7 trigger). Reassign runs the ownership engine (applyOwnershipCommandInTx) in the SAME
// transaction as its event, so the event can never exist without the ledger command (R-OWN-18).
//
// Evidence: each item stores ≥ 1 PII-free evidence ref (source + id + explanation + instant). Quotes are
// never stored on the item (its owner keeps seeing it after the lead moves on, R-PERM-7); for promise
// items they are added at read time from the task's source claim under the VIEWER's rights, so a
// transcript quote appears only to someone allowed to read that transcript (R-PERM-8). No confidence
// anywhere (R-AST-13).
import { type Action, type ContactId, DAY_MS, type IdGenerator, type Instant, type ResourceFacts, type Role, type UserActor, type UserId, can } from '@realty/core/foundation';
import type { OwnershipCommand } from '@realty/core/ownership';
import {
  DEFAULT_EXCEPTION_SETTINGS,
  type ExceptionEvidence,
  type ExceptionType,
  apptKey,
  deriveExceptions,
  promiseKey,
  sendKey,
  untouchedKey,
} from '@realty/core/priority';
import { type Tx, applyOwnershipCommandInTx, derivedCommandId, setOwnershipCommand } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError, isErrorCode } from '../errors.js';
import { factsOf } from '../leads/contacts.js';
import { getContact, memberTarget } from '../leads/repos/contacts.js';
import { maskLastName } from '../leads/views.js';
import { evidenceForClaims } from '../workspace/repos/evidence.js';
import { iso, isoOrNull, ms } from './common.js';
import * as repo from './repos/exceptions.js';

// ---- derivation -----------------------------------------------------------------------------------------

/** Conditions that started holding longer ago than this are re-read only while their item is open. */
export const RECOMPUTE_WINDOW_MS = 30 * DAY_MS;

export type RecomputeScope = 'tenant' | { contactId: string };

export interface RecomputeResult {
  upserted: number;
  cleared: number;
  inputs: { periods: number; promises: number; outbound: number; appointments: number };
}

const KEY_RE = /^(?:untouched:([0-9a-f-]{36}):(\d+)|promise:([0-9a-f-]{36})|send:([0-9a-f-]{36})|appt:([0-9a-f-]{36}))$/;
/** The dedupe keys core derives (R-ACC-1, per occurrence). Anything else is not an exception key. */
export const DEDUPE_KEY_PATTERN = '^(untouched:[0-9a-f-]{36}:[0-9]{1,18}|promise:[0-9a-f-]{36}|send:[0-9a-f-]{36}|appt:[0-9a-f-]{36})$';

function extraOf(rows: readonly repo.StoredItemRow[]): repo.InputScope['extra'] {
  const extra: repo.InputScope['extra'] = { periods: [], taskIds: [], messageIds: [], appointmentIds: [] };
  for (const r of rows) {
    const m = KEY_RE.exec(r.dedupe_key);
    if (!m) continue;
    if (m[1] && m[2]) extra.periods.push({ contactId: m[1], seq: Number(m[2]) });
    else if (m[3]) extra.taskIds.push(m[3]);
    else if (m[4]) extra.messageIds.push(m[4]);
    else if (m[5]) extra.appointmentIds.push(m[5]);
  }
  return extra;
}

/**
 * Recomputes the exception queue for one scope in the caller's transaction. The caller must be the
 * system actor (exception_items is written only by tenant-wide actors). Idempotent: a second run with no
 * change in the facts writes nothing (core diffs against the stored rows).
 */
export async function recomputeExceptions(tx: Tx, scope: RecomputeScope, now: Instant, ids: IdGenerator): Promise<RecomputeResult> {
  await repo.lockRecompute(tx);
  const contactId = scope === 'tenant' ? null : scope.contactId;
  const stored = await repo.storedRowsForScope(tx, contactId);
  const input: repo.InputScope = { contactId, now, windowStart: (now - RECOMPUTE_WINDOW_MS) as Instant, extra: extraOf(stored.filter((r) => r.condition_cleared_at === null)) };
  const settings = DEFAULT_EXCEPTION_SETTINGS;
  const [periods, promises, outbound, appointments] = await Promise.all([
    repo.slaFacts(tx, input),
    repo.promiseFacts(tx, input),
    repo.outboundFacts(tx, input),
    repo.appointmentFacts(tx, input, settings.missingOutcomeHours),
  ]);
  const keys = [
    ...periods.map((p) => untouchedKey(p.contactId, p.periodSeq)),
    ...promises.map((t) => promiseKey(t.taskId)),
    ...outbound.map((m) => sendKey(m.messageId)),
    ...appointments.map((a) => apptKey(a.appointmentId)),
  ];
  const byKey = new Map<string, repo.StoredItemRow>();
  for (const r of stored) byKey.set(r.dedupe_key, r);
  const missing = keys.filter((k) => !byKey.has(k));
  for (const r of await repo.storedRowsByKeys(tx, missing)) byKey.set(r.dedupe_key, r);

  const d = deriveExceptions({
    now,
    ownedWithSla: periods,
    promiseTasks: promises,
    outbound,
    appointments,
    settings,
    existing: [...byKey.values()].map(repo.specOf),
  });
  await repo.upsertItems(tx, d.upserts, ids, now);
  const cleared = await repo.clearItems(tx, d.cleared, now);
  return { upserted: d.upserts.length, cleared, inputs: { periods: periods.length, promises: promises.length, outbound: outbound.length, appointments: appointments.length } };
}

// ---- the queue view --------------------------------------------------------------------------------------

export type ExceptionAction = 'resolved' | 'reassigned' | 'verified' | 'reopened';
export type Verb = 'resolve' | 'reassign' | 'verify' | 'reopen';

export interface EvidenceLink {
  kind: 'contact' | 'message' | 'call' | 'task' | 'appointment';
  id: string;
  contactId: string | null;
  /** where to start the call player ("at 2:14 in the call") */
  offsetMs: number | null;
}

export interface EvidenceItemView {
  sourceType: string;
  sourceId: string;
  /** short, PII-free line for the stored refs; the readable quote line for read-time claim evidence */
  explanation: string;
  at: string | null;
  locator: Record<string, unknown> | null;
  snippet: string | null;
  /** an assistant-extracted quote that was not found verbatim in its source: check it */
  needsReview: boolean;
  link: EvidenceLink | null;
}

export interface ExceptionEventView {
  action: ExceptionAction;
  note: string | null;
  actor: { userId: string; name: string | null };
  at: string;
}

export interface ExceptionView {
  id: string;
  dedupeKey: string;
  itemType: ExceptionType;
  subjectType: string;
  subjectId: string;
  /** null when the viewer can no longer see the contact (e.g. the lead moved on after the miss) */
  contact: { id: string; name: string } | null;
  owner: { userId: string; name: string | null } | null;
  detectedAt: string;
  dueAt: string | null;
  /** seconds since the condition started holding */
  ageSeconds: number;
  /** null while the condition still holds; set when it was fixed (late) */
  conditionClearedAt: string | null;
  /** in the live queue: the latest human event is neither resolved nor verified */
  live: boolean;
  evidence: EvidenceItemView[];
  latestEvent: ExceptionEventView | null;
  /** what the viewer may do now (one tap each) */
  actions: { resolve: boolean; reassign: boolean; verify: boolean; reopen: boolean };
}

const LINKABLE = new Set(['message', 'call', 'task', 'appointment']);

function linkOf(sourceType: string, sourceId: string, locator: Record<string, unknown> | undefined, row: repo.QueueRow): EvidenceLink | null {
  const contactId = row.contact_visible ? row.contact_id : null;
  if (sourceType === 'ownership_period') return contactId ? { kind: 'contact', id: contactId, contactId, offsetMs: null } : null;
  if (!LINKABLE.has(sourceType)) return null;
  // communications open inside the contact's timeline: only for a viewer who sees the contact's detail
  if ((sourceType === 'message' || sourceType === 'call') && !row.contact_detail_visible) return null;
  const offset = locator && locator.kind === 'transcript_offset' && typeof locator.startMs === 'number' ? locator.startMs : null;
  return { kind: sourceType as EvidenceLink['kind'], id: sourceId, contactId, offsetMs: offset };
}

function itemFacts(actor: UserActor, row: Pick<repo.QueueRow, 'owner_user_id' | 'owner_in_my_team'>): ResourceFacts {
  return { own: row.owner_user_id === actor.userId, team: row.owner_in_my_team === true };
}

const HANDLED = new Set<string>(['resolved', 'verified']);
const isLive = (row: Pick<repo.QueueRow, 'last_action'>) => row.last_action === null || !HANDLED.has(row.last_action);

function allowed(actor: UserActor, action: Action, row: repo.QueueRow): boolean {
  return can(actor, action, itemFacts(actor, row)).ok;
}

function contactName(row: repo.QueueRow): string | null {
  if (!row.contact_visible || row.contact_display_name === null) return null;
  if (row.contact_detail_visible) return row.contact_display_name;
  return maskLastName({ first_name: row.contact_first_name, last_name: row.contact_last_name, display_name: row.contact_display_name });
}

function viewOf(row: repo.QueueRow, actor: UserActor, now: Instant, claimEvidence: EvidenceItemView[]): ExceptionView {
  const live = isLive(row);
  const evidence: EvidenceItemView[] = (row.evidence as ExceptionEvidence[]).map((e) => ({
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    explanation: e.explanation,
    at: e.at === undefined ? null : iso(e.at),
    locator: (e.locator as Record<string, unknown> | undefined) ?? null,
    snippet: null,
    needsReview: false,
    link: linkOf(e.sourceType, e.sourceId, e.locator as Record<string, unknown> | undefined, row),
  }));
  evidence.push(...claimEvidence);
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    itemType: row.item_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    contact: row.contact_id !== null && row.contact_visible ? { id: row.contact_id, name: contactName(row) ?? '' } : null,
    owner: row.owner_user_id === null ? null : { userId: row.owner_user_id, name: row.owner_name },
    detectedAt: iso(row.detected_at),
    dueAt: isoOrNull(row.due_at),
    ageSeconds: Math.max(0, Math.floor((now - ms(row.detected_at)) / 1000)),
    conditionClearedAt: isoOrNull(row.condition_cleared_at),
    live,
    evidence,
    latestEvent:
      row.last_action === null
        ? null
        : { action: row.last_action, note: row.last_note, actor: { userId: row.last_actor_user_id as string, name: row.last_actor_name }, at: iso(row.last_at as Date) },
    actions: {
      resolve: live && allowed(actor, 'exception.resolve', row),
      verify: row.last_action !== 'verified' && allowed(actor, 'exception.verify', row),
      reassign: live && row.contact_id !== null && row.contact_visible && allowed(actor, 'exception.reassign', row),
      reopen: !live && allowed(actor, 'exception.resolve', row),
    },
  };
}

/** Claim evidence (quotes) of promise items, read under the viewer's rights. */
async function claimEvidenceFor(tx: Tx, actor: UserActor, envelope: EnvelopeService, rows: readonly repo.QueueRow[]): Promise<Map<string, EvidenceItemView[]>> {
  const out = new Map<string, EvidenceItemView[]>();
  const promiseRows = rows.filter((r) => r.item_type === 'overdue_promise');
  if (promiseRows.length === 0) return out;
  const claims = await repo.taskClaims(tx, promiseRows.map((r) => r.subject_id));
  if (claims.size === 0) return out;
  const ev = await evidenceForClaims(tx, actor, envelope, [...new Set(claims.values())]);
  for (const r of promiseRows) {
    const claimId = claims.get(r.subject_id);
    const list = claimId ? (ev.get(claimId) ?? []) : [];
    out.set(
      r.dedupe_key,
      list.map((e) => ({
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        explanation: e.label,
        at: null,
        locator: e.locator,
        snippet: e.sourceAvailable ? e.snippet : null,
        needsReview: !e.verified,
        link: e.sourceAvailable ? linkOf(e.sourceType, e.sourceId, e.locator, r) : null,
      })),
    );
  }
  return out;
}

export interface ListFilter {
  type?: ExceptionType | undefined;
  owner?: string | undefined;
  state?: repo.QueueState | undefined;
  limit?: number | undefined;
}

export const QUEUE_LIMIT = 200;

export interface QueueView {
  items: ExceptionView[];
  /** live items by type, for the viewer (independent of the type filter): every number has its scope */
  counts: { live: number; byType: Record<ExceptionType, number> };
  generatedAt: string;
}

export async function listExceptions(tx: Tx, actor: UserActor, envelope: EnvelopeService, f: ListFilter, now: Instant): Promise<QueueView> {
  const ownerUserId = f.owner === 'me' ? actor.userId : f.owner;
  const rows = await repo.queueRows(tx, { type: f.type, ownerUserId, state: f.state ?? 'live', limit: Math.min(f.limit ?? QUEUE_LIMIT, QUEUE_LIMIT) });
  const claimEv = await claimEvidenceFor(tx, actor, envelope, rows);
  const byType: Record<ExceptionType, number> = { untouched_lead: 0, overdue_promise: 0, failed_send: 0, missing_outcome: 0 };
  const all = f.type === undefined && (f.state ?? 'live') === 'live' && rows.length < QUEUE_LIMIT ? rows : await repo.queueRows(tx, { ownerUserId, state: 'live', limit: 10_000 });
  for (const r of all) byType[r.item_type] += 1;
  return {
    items: rows.map((r) => viewOf(r, actor, now, claimEv.get(r.dedupe_key) ?? [])),
    counts: { live: all.length, byType },
    generatedAt: iso(now),
  };
}

export async function getException(tx: Tx, actor: UserActor, envelope: EnvelopeService, dedupeKey: string, now: Instant): Promise<{ item: ExceptionView; events: ExceptionEventView[] }> {
  const row = (await repo.queueRows(tx, { dedupeKey, state: 'all', limit: 1 }))[0];
  if (!row) throw new AppError('NOT_FOUND');
  const claimEv = await claimEvidenceFor(tx, actor, envelope, [row]);
  const events = (await repo.eventsOf(tx, dedupeKey)).map((e) => ({ action: e.action, note: e.note, actor: { userId: e.actor_user_id, name: e.actor_name }, at: iso(e.occurred_at) }));
  return { item: viewOf(row, actor, now, claimEv.get(dedupeKey) ?? []), events };
}

/** The facts authorize() needs for one item (null: invisible ⇒ 404, R-PERM-5). */
export async function exceptionFacts(tx: Tx, actor: UserActor, dedupeKey: string): Promise<ResourceFacts | null> {
  const row = (await repo.queueRows(tx, { dedupeKey, state: 'all', limit: 1 }))[0];
  return row ? itemFacts(actor, row) : null;
}

// ---- human actions (R-ACC-3) -----------------------------------------------------------------------------

const VERB_ACTION: Record<Verb, { action: ExceptionAction; authz: Action }> = {
  resolve: { action: 'resolved', authz: 'exception.resolve' },
  verify: { action: 'verified', authz: 'exception.verify' },
  reopen: { action: 'reopened', authz: 'exception.resolve' },
  reassign: { action: 'reassigned', authz: 'exception.reassign' },
};

export interface ActBody {
  note?: string | undefined;
  commandId?: string | undefined;
  toUserId?: string | undefined;
}

/** The event id for a command id: a retry of the same tap inserts nothing twice. */
export function eventIdFor(verb: Verb, commandId: string): string {
  return derivedCommandId('exception.event', verb, commandId);
}

function stateAllows(verb: Verb, last: repo.QueueRow['last_action']): boolean {
  switch (verb) {
    case 'resolve':
    case 'reassign':
      return last === null || !HANDLED.has(last);
    case 'verify':
      return last !== 'verified';
    case 'reopen':
      return last !== null && HANDLED.has(last);
  }
}

const AUDIT_OF = { resolved: 'exception.resolved', verified: 'exception.verified', reopened: 'exception.reopened', reassigned: 'exception.reassigned' } as const;

async function lockedRow(tx: Tx, actor: UserActor, dedupeKey: string, verb: Verb): Promise<repo.QueueRow> {
  await repo.lockItem(tx, dedupeKey);
  const row = (await repo.queueRows(tx, { dedupeKey, state: 'all', limit: 1 }))[0];
  // invisible, or visible but not the caller's to act on: 404 either way (R-PERM-5)
  if (!row || !can(actor, VERB_ACTION[verb].authz, itemFacts(actor, row)).ok) throw new AppError('NOT_FOUND');
  return row;
}

/** A replay of the same command returns the current item; a command id used elsewhere is refused. */
async function replayed(tx: Tx, verb: Verb, dedupeKey: string, eventId: string | null): Promise<boolean> {
  if (eventId === null) return false;
  const prior = await repo.eventById(tx, eventId);
  if (!prior) return false;
  if (prior.exception_dedupe_key !== dedupeKey || prior.action !== VERB_ACTION[verb].action) throw new AppError('COMMAND_ID_REUSED');
  return true;
}

async function record(tx: Tx, actor: UserActor, row: repo.QueueRow, verb: Verb, eventId: string, note: string | null, ownershipCommandId: string | null): Promise<void> {
  const action = VERB_ACTION[verb].action;
  await repo.insertEvent(tx, { id: eventId, dedupeKey: row.dedupe_key, action, note, actorUserId: actor.userId, actorRole: actor.role, ownershipCommandId });
  // R-AUDIT-5: resolve/verify are always audited; reassign and reopen too (the ledger mirrors the
  // ownership command itself). The note is free text: redacted to {changed: true} (R-AUDIT-4).
  await audit(tx, actor, {
    action: AUDIT_OF[action],
    entity: { type: 'exception_item', id: row.id },
    changes: redactSnapshot({ action, item_type: row.item_type, ...(note !== null ? { note } : {}), ...(ownershipCommandId ? { ownership_command_id: ownershipCommandId } : {}) }),
    reason: row.item_type.toUpperCase(),
  });
}

/** resolve / verify / reopen: one append-only event, under the item lock, as the caller's true role. */
export async function actOnException(tx: Tx, actor: UserActor, ids: IdGenerator, dedupeKey: string, verb: Exclude<Verb, 'reassign'>, body: ActBody): Promise<void> {
  const row = await lockedRow(tx, actor, dedupeKey, verb);
  const eventId = body.commandId ? eventIdFor(verb, body.commandId) : null;
  if (await replayed(tx, verb, dedupeKey, eventId)) return;
  if (!stateAllows(verb, row.last_action)) throw new AppError('EXCEPTION_STATE_CONFLICT', { latestAction: row.last_action });
  const note = body.note?.trim() ? body.note.trim() : null;
  if (verb === 'resolve' && note === null) throw new AppError('VALIDATION_FAILED', { reason: 'NOTE_REQUIRED' });
  await record(tx, actor, row, verb, eventId ?? ids.next(), note, null);
}

export type ReassignOutcome = { ok: true } | { ok: false; error: AppError };

const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'LEAD_OFFER_NOT_YOURS']);

/**
 * reassign: the ownership engine moves the item's contact (reassign an owned lead, assign one sitting in a
 * pond or unassigned) and the `reassigned` event cites that command, in ONE transaction. An engine
 * rejection is returned (not thrown) so the caller commits the rejection log before answering (R-OWN-5).
 * The transaction must carry `ownershipCommand: commandId` (withTenantTx option).
 */
export async function reassignException(tx: Tx, actor: UserActor, ids: IdGenerator, dedupeKey: string, body: ActBody & { toUserId: string; commandId: string }): Promise<ReassignOutcome> {
  const row = await lockedRow(tx, actor, dedupeKey, 'reassign');
  const eventId = eventIdFor('reassign', body.commandId);
  if (await replayed(tx, 'reassign', dedupeKey, eventId)) return { ok: true };
  if (!stateAllows('reassign', row.last_action)) throw new AppError('EXCEPTION_STATE_CONFLICT', { latestAction: row.last_action });
  if (row.contact_id === null) throw new AppError('EXCEPTION_NOT_REASSIGNABLE');
  const contact = await getContact(tx, row.contact_id);
  if (!contact) throw new AppError('NOT_FOUND');
  // the same authorization as POST /leads/:id/reassign (DATA_MODEL §3: Owner/Admin anywhere, TL within team)
  const target = await memberTarget(tx, body.toUserId);
  const facts: ResourceFacts = { ...factsOf(contact), ...(target ? { target: { role: target.role as Role, inMyTeam: target.in_my_team } } : {}) };
  const ok = can(actor, 'lead.reassign', facts);
  if (!ok.ok) throw new AppError(isErrorCode(ok.code) ? ok.code : 'NOT_FOUND');

  const kind = contact.ownership_state === 'owned' ? 'reassign' : 'assign';
  const cmd: OwnershipCommand = { kind, toUserId: body.toUserId as UserId, reason: 'EXCEPTION_REASSIGN' };
  const r = await applyOwnershipCommandInTx(tx, actor, row.contact_id as ContactId, cmd, { commandId: body.commandId, ids });
  await setOwnershipCommand(tx, null);
  if (!r.outcome.ok) {
    const code = r.outcome.code;
    if (NOT_FOUND_CODES.has(code)) return { ok: false, error: new AppError('NOT_FOUND') };
    return { ok: false, error: new AppError(isErrorCode(code) ? code : 'INTERNAL_ERROR', { observedSeq: r.outcome.rejection.observedSeq }) };
  }
  const note = body.note?.trim() ? body.note.trim() : null;
  await record(tx, actor, row, 'reassign', eventId, note, body.commandId);
  return { ok: true };
}

export { isLive };
