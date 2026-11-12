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
// `verified` ("fixed late"). A stored untouched_lead item the current definitions make no item at all (its
// window ended before the deadline under a later rule) is withdrawn instead (withdrawn_at, core
// withdrawnUntouched): never live, never "fixed late", nothing to act on (batch 6 review F2, F5). Nobody
// hand-enters an exception: there is no create route.
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
//
// R-PAR-32: an untouched-lead card also shows, as context, the activities people logged in that ownership
// period (R-PAR-30 notes: "Logged by <name>", at the time it happened), read at read time under the viewer's
// rights. They are never inputs of the derivation: a logged call never satisfies, delays or clears the first
// touch. A period ends when the lead leaves its owner or a re-inquiry starts the owner's next period (R-OWN-20 /
// E68), so a newer period's activity never shows on an earlier card. The view also says whether the item's period
// is still the lead's current one (`period.current`) and whether the lead has left that owner since
// (`period.movedOn`), so a card labels its facts as the owner's earlier period and says why it ended.
//
// Module 18a (Phase 2): milestone_at_risk (R-ACC-6, R-TXN-3) is the fifth definition: a confirmed deal date
// overdue, or due within 48 h with nobody responsible, keyed milestone:{deal_date}:{due_version} and owned by
// the deal owner (no contact; its evidence links to the deal). Open-house invite rows never raise
// failed_send (R-MKT-8). Both run on the 60-second tenant scan.
import { type Action, type ContactId, DAY_MS, type IdGenerator, type Instant, type ResourceFacts, type Role, type UserActor, type UserId, can } from '@realty/core/foundation';
import type { OwnershipCommand } from '@realty/core/ownership';
import {
  DEFAULT_EXCEPTION_SETTINGS,
  EXCEPTION_RULE_VERSION,
  type ExceptionEvidence,
  type ExceptionType,
  apptKey,
  deriveExceptions,
  milestoneKey,
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
  inputs: { periods: number; promises: number; outbound: number; appointments: number; milestones: number };
}

const KEY_RE = /^(?:untouched:([0-9a-f-]{36}):(\d+)|promise:([0-9a-f-]{36})|send:([0-9a-f-]{36})|appt:([0-9a-f-]{36})|milestone:([0-9a-f-]{36}):\d+)$/;
/** The dedupe keys core derives (R-ACC-1, per occurrence). Anything else is not an exception key. */
export const DEDUPE_KEY_PATTERN = '^(untouched:[0-9a-f-]{36}:[0-9]{1,18}|promise:[0-9a-f-]{36}|send:[0-9a-f-]{36}|appt:[0-9a-f-]{36}|milestone:[0-9a-f-]{36}:[0-9]{1,9})$';

function extraOf(rows: readonly repo.StoredItemRow[]): repo.InputScope['extra'] {
  const extra: repo.InputScope['extra'] = { periods: [], taskIds: [], messageIds: [], appointmentIds: [], dealDateIds: [] };
  for (const r of rows) {
    const m = KEY_RE.exec(r.dedupe_key);
    if (!m) continue;
    if (m[1] && m[2]) extra.periods.push({ contactId: m[1], seq: Number(m[2]) });
    else if (m[3]) extra.taskIds.push(m[3]);
    else if (m[4]) extra.messageIds.push(m[4]);
    else if (m[5]) extra.appointmentIds.push(m[5]);
    else if (m[6]) extra.dealDateIds.push(m[6]);
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
  // review R6: at tenant scope, also the untouched_lead rows an earlier rule stored (open or cleared, not withdrawn):
  // their periods are re-read once, so one the current rules make no item is withdrawn even when its deadline is older
  // than the window and it was already cleared ("fixed late"); a contact scope reads every row of the contact anyway
  const earlier = contactId === null ? await repo.untouchedRowsOfEarlierRules(tx, EXCEPTION_RULE_VERSION) : [];
  const input: repo.InputScope = {
    contactId,
    now,
    windowStart: (now - RECOMPUTE_WINDOW_MS) as Instant,
    extra: extraOf([...stored.filter((r) => r.condition_cleared_at === null), ...earlier.filter((r) => r.condition_cleared_at !== null)]),
  };
  const settings = DEFAULT_EXCEPTION_SETTINGS;
  const [periods, promises, outbound, appointments, milestoneDates] = await Promise.all([
    repo.slaFacts(tx, input),
    repo.promiseFacts(tx, input),
    repo.outboundFacts(tx, input),
    repo.appointmentFacts(tx, input, settings.missingOutcomeHours),
    repo.milestoneFacts(tx, input),
  ]);
  const keys = [
    ...periods.map((p) => untouchedKey(p.contactId, p.periodSeq)),
    ...promises.map((t) => promiseKey(t.taskId)),
    ...outbound.map((m) => sendKey(m.messageId)),
    ...appointments.map((a) => apptKey(a.appointmentId)),
    ...milestoneDates.map((d) => milestoneKey(d.dealDateId, d.dueVersion)),
  ];
  const byKey = new Map<string, repo.StoredItemRow>();
  for (const r of [...stored, ...earlier]) byKey.set(r.dedupe_key, r);
  const missing = keys.filter((k) => !byKey.has(k));
  for (const r of await repo.storedRowsByKeys(tx, missing)) byKey.set(r.dedupe_key, r);

  const d = deriveExceptions({
    now,
    ownedWithSla: periods,
    promiseTasks: promises,
    outbound,
    appointments,
    milestoneDates,
    settings,
    existing: [...byKey.values()].map(repo.specOf),
  });
  await repo.upsertItems(tx, d.upserts, ids, now);
  const cleared = await repo.clearItems(tx, d.cleared, now);
  return { upserted: d.upserts.length, cleared, inputs: { periods: periods.length, promises: promises.length, outbound: outbound.length, appointments: appointments.length, milestones: milestoneDates.length } };
}

// ---- the queue view --------------------------------------------------------------------------------------

export type ExceptionAction = 'resolved' | 'reassigned' | 'verified' | 'reopened';
export type Verb = 'resolve' | 'reassign' | 'verify' | 'reopen';

export interface EvidenceLink {
  kind: 'contact' | 'message' | 'call' | 'task' | 'appointment' | 'deal';
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
  /** in the live queue: not withdrawn, and the latest human event is neither resolved nor verified */
  live: boolean;
  /**
   * untouched_lead only (batch 6 review F2, F5): the current definitions make this period no item (its window ended
   * before the deadline: a re-inquiry superseded it, or the lead left its owner; or it was touched in time). Never
   * live and never "fixed late"; the evidence says why; nothing may be done with it.
   */
  withdrawn: boolean;
  evidence: EvidenceItemView[];
  /**
   * untouched_lead only (null for other types). `current`: the item's ownership period is still the lead's current
   * one (the same owner, the same period). `movedOn`: the lead left that owner since (reassigned, released, closed,
   * merged) or is gone from the viewer's sight. Not current and not moved on: the same owner has held the lead
   * throughout, and a re-inquiry started their next period (R-OWN-20 / E68).
   */
  period: { current: boolean; movedOn: boolean } | null;
  contactOwnershipSeq: number | null;
  latestEvent: ExceptionEventView | null;
  /** what the viewer may do now (one tap each) */
  actions: { resolve: boolean; reassign: boolean; verify: boolean; reopen: boolean };
}

const LINKABLE = new Set(['message', 'call', 'task', 'appointment', 'deal']);

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
const isLive = (row: Pick<repo.QueueRow, 'last_action' | 'withdrawn_at'>) => row.withdrawn_at === null && (row.last_action === null || !HANDLED.has(row.last_action));

function allowed(actor: UserActor, action: Action, row: repo.QueueRow): boolean {
  return can(actor, action, itemFacts(actor, row)).ok;
}

function contactName(row: repo.QueueRow): string | null {
  if (!row.contact_visible || row.contact_display_name === null) return null;
  if (row.contact_detail_visible) return row.contact_display_name;
  return maskLastName({ first_name: row.contact_first_name, last_name: row.contact_last_name, display_name: row.contact_display_name });
}

/**
 * ownership-2: the item is about its owner's period of the lead. Once someone else holds the lead (owns it
 * or has the offer), or the item's owner holds it in a later ownership period, a reassign from the item
 * would take the lead from whoever is working it now: the item no longer offers it and the endpoint refuses
 * it (LEAD_STATE_CHANGED). A lead nobody holds (pond, unassigned) can still be assigned from the item.
 */
function reassignStale(row: repo.QueueRow): boolean {
  if (row.contact_ownership_state === null || row.owner_user_id === null) return false;
  const holder = row.contact_ownership_state === 'owned' ? row.contact_owner_user_id : row.contact_ownership_state === 'offered' ? row.contact_offered_to_user_id : null;
  if (holder !== null && holder !== row.owner_user_id) return true;
  const period = KEY_RE.exec(row.dedupe_key)?.[2];
  return period !== undefined && holder !== null && row.contact_period_seq !== null && Number(period) !== Number(row.contact_period_seq);
}

/** The item's owner holds its lead now (as the viewer sees it). */
function heldByOwner(row: repo.QueueRow): boolean {
  return row.contact_visible && row.contact_ownership_state === 'owned' && row.contact_owner_user_id !== null && row.contact_owner_user_id === row.owner_user_id;
}

/** An untouched lead's period seq, from its key (null for other types). */
function periodSeqOf(row: repo.QueueRow): number | null {
  if (row.item_type !== 'untouched_lead') return null;
  const seq = KEY_RE.exec(row.dedupe_key)?.[2];
  return seq === undefined ? null : Number(seq);
}

/** The owner holds the lead in a later period: whether they kept it throughout is a ledger question (periodsKeptFor). */
function heldInLaterPeriod(row: repo.QueueRow): boolean {
  const seq = periodSeqOf(row);
  return seq !== null && heldByOwner(row) && row.contact_period_seq !== null && Number(row.contact_period_seq) !== seq;
}

/**
 * An untouched lead's period is still current while the same owner holds the lead in that same period. It has
 * moved on once the lead left them, unless `kept`: the ledger shows they held it throughout and only a re-inquiry
 * started their next period (repo.periodsKeptByOwner).
 */
function periodOf(row: repo.QueueRow, kept: boolean): { current: boolean; movedOn: boolean } | null {
  const seq = periodSeqOf(row);
  if (seq === null) return null;
  const held = heldByOwner(row);
  const current = held && row.contact_period_seq !== null && Number(row.contact_period_seq) === seq;
  return { current, movedOn: !held || (!current && !kept) };
}

/** The untouched-lead rows whose owner kept the lead while a re-inquiry started their next period (the viewer's ledger). */
async function periodsKeptFor(tx: Tx, rows: readonly repo.QueueRow[]): Promise<Set<string>> {
  const periods = rows.filter(heldInLaterPeriod).flatMap((r) => {
    const m = KEY_RE.exec(r.dedupe_key);
    return m?.[1] && m[2] ? [{ key: r.dedupe_key, contactId: m[1], seq: Number(m[2]) }] : [];
  });
  return repo.periodsKeptByOwner(tx, periods);
}

function viewOf(row: repo.QueueRow, actor: UserActor, now: Instant, claimEvidence: EvidenceItemView[], kept: boolean): ExceptionView {
  const live = isLive(row);
  const withdrawn = row.withdrawn_at !== null;
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
    withdrawn,
    evidence,
    period: periodOf(row, kept),
    contactOwnershipSeq: row.contact_visible && row.contact_ownership_seq !== null ? Number(row.contact_ownership_seq) : null,
    latestEvent:
      row.last_action === null
        ? null
        : { action: row.last_action, note: row.last_note, actor: { userId: row.last_actor_user_id as string, name: row.last_actor_name }, at: iso(row.last_at as Date) },
    actions: {
      resolve: live && allowed(actor, 'exception.resolve', row),
      verify: !withdrawn && row.last_action !== 'verified' && allowed(actor, 'exception.verify', row),
      reassign: live && row.contact_id !== null && row.contact_visible && !reassignStale(row) && allowed(actor, 'exception.reassign', row),
      reopen: !withdrawn && !live && allowed(actor, 'exception.resolve', row),
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

const ACTIVITY_KIND: Record<repo.LoggedActivityRow['kind'], string> = { call: 'call', text: 'text', email: 'email' };
const ACTIVITY_DIRECTION: Record<string, string> = { outbound: 'outgoing', inbound: 'incoming' };
const ACTIVITY_OUTCOME: Record<string, string> = { connected: 'talked', left_voicemail: 'left a voicemail', no_answer: 'no answer', wrong_number: 'wrong number', other: 'other outcome' };

/** "Logged by Ava Agent: outgoing call, talked (context only; not a first contact)" (R-PAR-30 / R-PAR-32). */
export function loggedActivityLine(a: Pick<repo.LoggedActivityRow, 'kind' | 'direction' | 'outcome' | 'author_name'>): string {
  const what = [a.direction ? ACTIVITY_DIRECTION[a.direction] : null, ACTIVITY_KIND[a.kind]].filter(Boolean).join(' ');
  const outcome = a.outcome ? `, ${ACTIVITY_OUTCOME[a.outcome] ?? 'other outcome'}` : '';
  return `Logged by ${a.author_name ?? 'a former member'}: ${what}${outcome} (context only; not a first contact)`;
}

/**
 * R-PAR-32: the logged activities of each untouched lead's period, as context, read under the viewer's rights
 * (a viewer who no longer sees the lead or its notes gets none). Never an input of the derivation.
 */
async function loggedActivityContextFor(tx: Tx, rows: readonly repo.QueueRow[]): Promise<Map<string, EvidenceItemView[]>> {
  const out = new Map<string, EvidenceItemView[]>();
  const periods = rows.flatMap((r) => {
    if (r.item_type !== 'untouched_lead' || r.contact_id === null || !r.contact_detail_visible) return [];
    const m = KEY_RE.exec(r.dedupe_key);
    return m?.[1] && m[2] ? [{ key: r.dedupe_key, contactId: m[1], seq: Number(m[2]) }] : [];
  });
  if (periods.length === 0) return out;
  const byKey = new Map(rows.map((r) => [r.dedupe_key, r] as const));
  for (const a of await repo.loggedActivitiesInPeriods(tx, periods)) {
    const row = byKey.get(a.dedupe_key)!;
    const list = out.get(a.dedupe_key) ?? [];
    list.push({
      sourceType: 'note',
      sourceId: a.id,
      explanation: loggedActivityLine(a),
      at: iso(a.at),
      locator: null,
      snippet: null,
      needsReview: false,
      link: row.contact_id ? { kind: 'contact', id: row.contact_id, contactId: row.contact_id, offsetMs: null } : null,
    });
    out.set(a.dedupe_key, list);
  }
  return out;
}

/** Read-time evidence of the rows: promise quotes and logged-activity context, each under the viewer's rights. */
async function readTimeEvidenceFor(tx: Tx, actor: UserActor, envelope: EnvelopeService, rows: readonly repo.QueueRow[]): Promise<Map<string, EvidenceItemView[]>> {
  const [claims, activities] = await Promise.all([claimEvidenceFor(tx, actor, envelope, rows), loggedActivityContextFor(tx, rows)]);
  const out = new Map<string, EvidenceItemView[]>();
  for (const m of [claims, activities]) for (const [k, list] of m) out.set(k, [...(out.get(k) ?? []), ...list]);
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
  const claimEv = await readTimeEvidenceFor(tx, actor, envelope, rows);
  const kept = await periodsKeptFor(tx, rows);
  const byType: Record<ExceptionType, number> = { untouched_lead: 0, overdue_promise: 0, failed_send: 0, missing_outcome: 0, milestone_at_risk: 0 };
  let live: number;
  if (f.type === undefined && (f.state ?? 'live') === 'live' && rows.length < QUEUE_LIMIT) {
    for (const r of rows) byType[r.item_type] += 1;
    live = rows.length;
  } else {
    // counted, not loaded (scale-250k). The 10,000-row read this replaces also capped the counts at
    // 10,000 items; a count now always covers every live item the viewer can see.
    for (const c of await repo.liveCounts(tx, ownerUserId)) byType[c.item_type] = c.n;
    live = Object.values(byType).reduce((a, b) => a + b, 0);
  }
  return {
    items: rows.map((r) => viewOf(r, actor, now, claimEv.get(r.dedupe_key) ?? [], kept.has(r.dedupe_key))),
    counts: { live, byType },
    generatedAt: iso(now),
  };
}

export async function getException(tx: Tx, actor: UserActor, envelope: EnvelopeService, dedupeKey: string, now: Instant): Promise<{ item: ExceptionView; events: ExceptionEventView[] }> {
  const row = (await repo.queueRows(tx, { dedupeKey, state: 'all', limit: 1 }))[0];
  if (!row) throw new AppError('NOT_FOUND');
  const claimEv = await readTimeEvidenceFor(tx, actor, envelope, [row]);
  const kept = await periodsKeptFor(tx, [row]);
  const events = (await repo.eventsOf(tx, dedupeKey)).map((e) => ({ action: e.action, note: e.note, actor: { userId: e.actor_user_id, name: e.actor_name }, at: iso(e.occurred_at) }));
  return { item: viewOf(row, actor, now, claimEv.get(dedupeKey) ?? [], kept.has(dedupeKey)), events };
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

function stateAllows(verb: Verb, last: repo.QueueRow['last_action'], withdrawn: boolean): boolean {
  // a withdrawn item is no item under the current definitions (batch 6 review F2, F5): nothing to resolve, verify,
  // reopen or reassign from
  if (withdrawn) return false;
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
  if (!stateAllows(verb, row.last_action, row.withdrawn_at !== null)) throw new AppError('EXCEPTION_STATE_CONFLICT', { latestAction: row.last_action, withdrawn: row.withdrawn_at !== null });
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
export async function reassignException(tx: Tx, actor: UserActor, ids: IdGenerator, dedupeKey: string, body: ActBody & { toUserId: string; commandId: string; expectedSeq?: number | undefined }): Promise<ReassignOutcome> {
  const row = await lockedRow(tx, actor, dedupeKey, 'reassign');
  const eventId = eventIdFor('reassign', body.commandId);
  if (await replayed(tx, 'reassign', dedupeKey, eventId)) return { ok: true };
  if (!stateAllows('reassign', row.last_action, row.withdrawn_at !== null)) throw new AppError('EXCEPTION_STATE_CONFLICT', { latestAction: row.last_action, withdrawn: row.withdrawn_at !== null });
  if (row.contact_id === null) throw new AppError('EXCEPTION_NOT_REASSIGNABLE');
  const contact = await getContact(tx, row.contact_id);
  if (!contact) throw new AppError('NOT_FOUND');
  // ownership-2: never take the lead from whoever holds it now on the strength of an older item
  if (reassignStale(row)) throw new AppError('LEAD_STATE_CHANGED', { observedSeq: Number(row.contact_ownership_seq) });
  // the same authorization as POST /leads/:id/reassign (DATA_MODEL §3: Owner/Admin anywhere, TL within team)
  const target = await memberTarget(tx, body.toUserId);
  const facts: ResourceFacts = { ...factsOf(contact), ...(target ? { target: { role: target.role as Role, inMyTeam: target.in_my_team } } : {}) };
  const ok = can(actor, 'lead.reassign', facts);
  if (!ok.ok) throw new AppError(isErrorCode(ok.code) ? ok.code : 'NOT_FOUND');

  const kind = contact.ownership_state === 'owned' ? 'reassign' : 'assign';
  const cmd: OwnershipCommand = { kind, toUserId: body.toUserId as UserId, reason: 'EXCEPTION_REASSIGN' };
  // the stale-UI fence: the ledger head the queue showed (LEAD_STATE_CHANGED when the lead moved since)
  const r = await applyOwnershipCommandInTx(tx, actor, row.contact_id as ContactId, cmd, { commandId: body.commandId, ids, ...(body.expectedSeq !== undefined ? { expectedSeq: body.expectedSeq } : {}) });
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
