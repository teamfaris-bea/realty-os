// Priority Feed inputs (core.scoreFeed FeedInputs) read under the CALLER's RLS (BUILD_PLAN module 14).
//
// Every query runs in the user's own transaction, so only rows the user may see exist (R-PERM-4); core
// additionally keeps only rows that belong to `userId`, so after a reassignment the previous owner gets no
// card for the lead (the contact is invisible to them, and its owner is no longer them).
//
// R-AST-12: nothing here reads contact_attributes; no protected-proxy value can reach scoring (the core
// input types have no field for one).
//
// `blockedChannels` is a display hint built from contact points, suppressions and consent revocations;
// every send is re-checked by canContact at send time (R-GATE-1), so the hint can only demote a card.
//
// Pond leads (R-OWN-16, R-PERM-6): a lead that entered, within the last 24 h, a pond the member may claim from
// (app.my_pond_ids(): an eligible role, the pond open to all or naming them, not archived, and claims allowed at
// all), unless the member is in claim cooldown on it. app.my_pond_leads reads the entry event and the member's
// own cooldown for them (a pond card's viewer cannot read the lead's ledger). A lead an import put in a pond is
// not new and gets no card. The member's running totals (claims today, uncontacted leads) are applied when the
// feed is read (feed.ts readFeed), never stored, because they change with the member's other leads and the day.
import type { EnvelopeService } from '../../crypto/envelope.js';
import type {
  ApptFacts,
  ChannelBlock,
  DealDateFacts,
  DraftFacts,
  FeedInputs,
  GateSummary,
  HandbackFacts,
  InactivityFacts,
  InboundFacts,
  OfferFacts,
  PondLeadFacts,
  ReinquiryFacts,
  SearchProposalFacts,
  SlaFacts,
  TaskEvidence,
  TaskFacts,
  TouchFacts,
} from '@realty/core/priority';
import type { PhoneEmailChannel as Channel } from '@realty/core/compliance'; // the feed's blocked-channel hint covers Phase 1 channels
import { type ContactId, type Instant, type UserActor, type UserId, localDateOf, localTime, resolveLocal } from '@realty/core/foundation';
import { POND_NEW_WINDOW_MS, appointmentGroup, contactGroup, dealDateGroup, nextFeedChange, splitFeedInputs, taskGroup } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { evidenceForClaims } from './evidence.js';

const ms = (d: Date | string): Instant => new Date(d).getTime() as Instant;
const HOUR = 3_600_000;
const MIDNIGHT = localTime('00:00');
const DAY = 86_400_000;
const msOrNull = (d: Date | string | null): Instant | null => (d === null ? null : ms(d));

/** How far back unanswered client messages are looked for (older ones live in the thread, not the feed). */
export const INBOUND_WINDOW_DAYS = 14;
/** Unanswered messages / missed calls read per contact (a conversation's newest ones; one card per contact). */
const PER_CONTACT_CAP = 300;
/** Tasks enter the inputs this long before they are due (core shows them from 24 h). */
export const TASK_INPUT_WINDOW_MS = 50 * HOUR;
/** Appointments without an outcome stay in the inputs this long after they end. */
export const APPT_INPUT_WINDOW_DAYS = 30;
/** Contract dates enter the inputs this many local days ahead. */
export const DEAL_DATE_INPUT_DAYS = 3;

/**
 * Which part of a book to read (the incremental feed, lane perf-misses): the inputs of these groups only
 * (core/priority incremental.ts: a contact, or a task / appointment without a contact, or a deal date).
 * Omitted: the whole book.
 */
export interface FeedScope {
  contactIds: readonly string[];
  taskIds: readonly string[];
  appointmentIds: readonly string[];
  dealDateIds: readonly string[];
}

export interface LoadedFeedInputs {
  /** the inputs core.scoreFeed scores at `now` */
  inputs: FeedInputs;
  /**
   * Per group: instants after which the inputs read here can differ only because time passed (a row leaves
   * a look-back window, or a future row enters a look-ahead one), plus everything core.nextFeedChange
   * names for the group's facts, including future facts not yet in `inputs`. Only instants > now.
   */
  nextChange: Map<string, number>;
}

interface PondLeadRow {
  contact_id: string;
  pond_id: string;
  entered_seq: string;
  entered_at: Date;
  entered_by_import: boolean;
  cooldown_until: Date | null;
}

/**
 * The time windows of the inputs (the old SQL predicates on `now`, applied in one place so the stored feed
 * can say when they move): an inactivity warning from its warn instant, a dated task from 50 h before it is
 * due, an appointment once it ended, a contract date from 3 local days before its day. Rows that left a
 * look-back window are never read (SQL), rows ahead of a look-ahead window are read and held back here.
 */
export function windowFeedInputs(i: FeedInputs): FeedInputs {
  const now = i.now;
  return {
    ...i,
    inactivityWarnings: (i.inactivityWarnings ?? []).filter((w) => w.warnAt <= now && w.releaseAt > now),
    tasks: i.tasks.filter((t) => (t.dueAt !== null ? t.dueAt <= now + TASK_INPUT_WINDOW_MS : t.kind === 'promise' && t.needsReview)),
    appointments: i.appointments.filter((a) => a.endsAt <= now),
    dealDates: i.dealDates.filter((d) => d.dueOn <= addDays(localDateOf(now, d.zone), DEAL_DATE_INPUT_DAYS)),
  };
}

function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export async function loadFeedInputs(tx: Tx, actor: UserActor, envelope: EnvelopeService, now: Instant): Promise<FeedInputs> {
  return (await loadFeedInputsScoped(tx, actor, envelope, now)).inputs;
}

/** loadFeedInputs for a part of the book (or all of it), with the instants its inputs can change by time. */
export async function loadFeedInputsScoped(tx: Tx, actor: UserActor, envelope: EnvelopeService, now: Instant, scope?: FeedScope): Promise<LoadedFeedInputs> {
  const userId = actor.userId as UserId;
  const nowIso = new Date(now).toISOString();
  const C = scope ? [...scope.contactIds] : [];
  const byContact = (col: string) => (scope ? sql`AND ${sql.ref(col)} = ANY (${C}::uuid[])` : sql``);
  const tasksIn = scope ? sql`AND (contact_id = ANY (${C}::uuid[]) OR id = ANY (${[...scope.taskIds]}::uuid[]))` : sql``;
  const apptsIn = scope ? sql`AND (contact_id = ANY (${C}::uuid[]) OR id = ANY (${[...scope.appointmentIds]}::uuid[]))` : sql``;
  const datesIn = scope ? sql`AND dd.id = ANY (${[...scope.dealDateIds]}::uuid[])` : sql``;
  const windows = new Map<string, number[]>();
  const win = (group: string, t: number) => {
    if (!(t > now)) return;
    const l = windows.get(group);
    if (l) l.push(t);
    else windows.set(group, [t]);
  };

  const [offers, slas, inactivity, reinquiries, inbound, missed, handbacks, drafts, tasks, dealDates, appts, searches] = await Promise.all([
    sql<{ id: string; offer_id: string; offered_to_user_id: string; offer_expires_at: Date; updated_at: Date; source: string | null }>`
      SELECT c.id, c.offer_id, c.offered_to_user_id, c.offer_expires_at, c.updated_at, ls.name AS source
        FROM contacts c LEFT JOIN lead_sources ls ON ls.tenant_id = c.tenant_id AND ls.id = c.original_lead_source_id
       WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'offered' AND c.offered_to_user_id = ${userId}
         AND c.deleted_at IS NULL AND c.offer_expires_at > ${nowIso}::timestamptz ${byContact('c.id')}
       ORDER BY c.offer_expires_at`.execute(tx),
    sql<{ id: string; owner_user_id: string; ownership_period_seq: string; owned_at: Date; first_touch_due_at: Date; release_due_at: Date | null }>`
      SELECT id, owner_user_id, ownership_period_seq, owned_at, first_touch_due_at, release_due_at FROM contacts
       WHERE tenant_id = app.tenant_id() AND ownership_state = 'owned' AND owner_user_id = ${userId} AND deleted_at IS NULL
         AND first_touch_due_at IS NOT NULL AND first_touch_at IS NULL ${byContact('id')}
       ORDER BY first_touch_due_at`.execute(tx),
    sql<{ id: string; ownership_period_seq: string; inactivity_warn_at: Date; inactivity_release_at: Date }>`
      SELECT id, ownership_period_seq, inactivity_warn_at, inactivity_release_at FROM contacts
       WHERE tenant_id = app.tenant_id() AND ownership_state = 'owned' AND owner_user_id = ${userId} AND deleted_at IS NULL
         -- warn_at <= now is applied by windowFeedInputs (a warning ahead of its instant is read and held back)
         AND inactivity_warn_at IS NOT NULL AND inactivity_release_at > ${nowIso}::timestamptz ${byContact('id')}
       ORDER BY inactivity_release_at`.execute(tx),
    sql<{ contact_id: string; inquiry_id: string; occurred_at: Date; deadline_at: Date | null; touched: boolean }>`
      SELECT e.contact_id, e.payload->>'inquiryId' AS inquiry_id, e.occurred_at, e.deadline_at,
             (c.last_human_touch_at IS NOT NULL AND c.last_human_touch_at > e.occurred_at) AS touched
        FROM contacts c JOIN lead_ownership_events e ON e.tenant_id = c.tenant_id AND e.contact_id = c.id
       WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
         AND e.type = 'reinquiry' AND e.seq >= c.ownership_period_seq AND e.payload ? 'inquiryId'
         AND e.occurred_at > ${nowIso}::timestamptz - interval '14 days' ${byContact('c.id')}
       ORDER BY e.occurred_at DESC`.execute(tx),
    sql<{ id: string; channel: 'sms' | 'mms' | 'email' | 'web_chat'; contact_id: string; occurred_at: Date; is_auto_reply: boolean; opt_out_keyword: string | null }>`
      WITH mine AS MATERIALIZED (
        -- the agent's owned contacts with the instant after which a client message is still unanswered
        SELECT c.tenant_id, c.id, GREATEST(${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS}), COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)) AS since
          FROM contacts c
         WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL ${byContact('c.id')})
      SELECT m.id, m.channel, m.contact_id, m.occurred_at, m.is_auto_reply, m.opt_out_keyword
        FROM mine c
        -- Per-contact index range scan (scale-250k): (contact_id, occurred_at > since) is the index condition,
        -- so only this agent's messages after the last touch reach the messages RLS check. A tenant-wide scan
        -- of the window ran the per-row visibility check on every other agent's message too (about 1.5 ms each
        -- for a contact the caller cannot see). \`since\` is a plain column here: the planner keeps an
        -- expression over GREATEST/COALESCE out of an index condition under RLS (not leakproof).
        CROSS JOIN LATERAL (
          SELECT m.id, m.channel, m.contact_id, m.occurred_at, m.is_auto_reply, m.opt_out_keyword FROM messages m
           WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND m.occurred_at > c.since
             AND m.direction = 'inbound' AND NOT m.imported
           ORDER BY m.occurred_at DESC LIMIT ${PER_CONTACT_CAP}) m
       ORDER BY m.occurred_at DESC`.execute(tx),
    sql<{ id: string; contact_id: string; started_at: Date }>`
      WITH mine AS MATERIALIZED (
        SELECT c.tenant_id, c.id, GREATEST(${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS}), COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)) AS since
          FROM contacts c
         WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL ${byContact('c.id')})
      SELECT k.id, k.contact_id, k.started_at
        FROM mine c
        -- per-contact index range scan, as for messages above
        CROSS JOIN LATERAL (
          SELECT k.id, k.contact_id, k.started_at FROM calls k
           WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND k.started_at > c.since
             AND k.direction = 'inbound' AND NOT k.imported AND k.answered_at IS NULL
             AND k.status IN ('no_answer','busy','voicemail','canceled','failed','completed')
           ORDER BY k.started_at DESC LIMIT ${PER_CONTACT_CAP}) k
       ORDER BY k.started_at DESC`.execute(tx),
    sql<{ id: string; contact_id: string; created_at: Date; payload: Record<string, unknown>; m_channel: 'sms' | 'mms' | 'email' | null; m_at: Date | null }>`
      SELECT a.id, a.contact_id, a.created_at, a.payload, m.channel AS m_channel, m.occurred_at AS m_at
        FROM assistant_actions a
        LEFT JOIN messages m ON m.tenant_id = a.tenant_id AND m.id = CASE WHEN a.payload->>'inboundMessageId' ~ '^[0-9a-f-]{36}$' THEN (a.payload->>'inboundMessageId')::uuid END
       WHERE a.tenant_id = app.tenant_id() AND a.kind = 'handback' AND a.status = 'proposed' AND a.owner_user_id = ${userId} AND a.contact_id IS NOT NULL ${byContact('a.contact_id')}
       ORDER BY a.created_at DESC`.execute(tx),
    sql<{ id: string; contact_id: string; channel: string | null; action_category: string; explanation: string; created_at: Date; needs_review: boolean }>`
      SELECT a.id, a.contact_id, a.payload->>'channel' AS channel, a.action_category, a.explanation, a.created_at,
             EXISTS (SELECT 1 FROM assistant_claims cl WHERE cl.tenant_id = a.tenant_id AND cl.action_id = a.id
                       AND cl.needs_review AND cl.review_status = 'unreviewed') AS needs_review
        FROM assistant_actions a
       WHERE a.tenant_id = app.tenant_id() AND a.kind = 'message_draft' AND a.status = 'proposed' AND a.owner_user_id = ${userId} AND a.contact_id IS NOT NULL ${byContact('a.contact_id')}
       ORDER BY a.created_at DESC`.execute(tx),
    sql<{ id: string; contact_id: string | null; deal_id: string | null; kind: TaskFacts['kind']; due_at: Date | null; due_all_day: boolean; due_tz: string | null; needs_review: boolean; created_by_kind: TaskFacts['createdByKind']; created_at: Date; source_claim_id: string | null }>`
      SELECT id, contact_id, deal_id, kind, due_at, due_all_day, due_tz, needs_review, created_by_kind, created_at, source_claim_id FROM tasks
       -- due_at <= now + 50 h is applied by windowFeedInputs
       WHERE tenant_id = app.tenant_id() AND assignee_user_id = ${userId} AND status = 'open'
         AND (due_at IS NOT NULL OR (kind = 'promise' AND needs_review AND due_at IS NULL)) ${tasksIn}
       ORDER BY due_at NULLS LAST`.execute(tx),
    sql<{ id: string; deal_id: string; kind: DealDateFacts['kind']; label: string | null; due_on: string; completed_at: Date | null; created_at: Date; owner_user_id: string; members: string[]; zone: string }>`
      SELECT dd.id, dd.deal_id, dd.kind, dd.label, dd.due_on::text AS due_on, dd.completed_at, dd.created_at, d.owner_user_id,
             COALESCE((SELECT array_agg(dm.user_id::text) FROM deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id), '{}') AS members,
             s.default_timezone AS zone
        FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
        JOIN tenant_settings s ON s.tenant_id = d.tenant_id
       -- R-TXN-2 / E158: a proposed or waived date reminds nobody until a person confirms it
       -- due_on <= local today + 3 is applied by windowFeedInputs
       WHERE dd.tenant_id = app.tenant_id() AND dd.completed_at IS NULL AND dd.status = 'confirmed' AND d.stage NOT IN ('closed','lost') ${datesIn}
         AND (d.owner_user_id = ${userId} OR EXISTS (SELECT 1 FROM deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id AND dm.user_id = ${userId}))
       ORDER BY dd.due_on`.execute(tx),
    sql<{ id: string; contact_id: string | null; kind: ApptFacts['kind']; starts_at: Date; ends_at: Date; status: ApptFacts['status']; created_by_kind: ApptFacts['createdByKind'] }>`
      SELECT id, contact_id, kind, starts_at, ends_at, status, created_by_kind FROM appointments
       WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status IN ('scheduled','held') AND outcome_logged_at IS NULL
         -- ends_at <= now is applied by windowFeedInputs
         AND created_by_kind <> 'import' AND ends_at > ${nowIso}::timestamptz - make_interval(days => ${APPT_INPUT_WINDOW_DAYS}) ${apptsIn}
       ORDER BY ends_at`.execute(tx),
    sql<{ id: string; contact_id: string; created_at: Date; unchecked: number }>`
      SELECT s.id, s.contact_id, s.created_at,
             (SELECT count(*)::int FROM jsonb_each_text(s.criterion_evidence) ce
                JOIN assistant_claims cl ON cl.tenant_id = s.tenant_id AND ce.value ~ '^[0-9a-f-]{36}$' AND cl.id = ce.value::uuid
               WHERE cl.needs_review AND cl.review_status = 'unreviewed') AS unchecked
        FROM saved_searches s JOIN contacts c ON c.tenant_id = s.tenant_id AND c.id = s.contact_id
       WHERE s.tenant_id = app.tenant_id() AND s.status = 'proposed' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL ${byContact('s.contact_id')}
       ORDER BY s.created_at DESC`.execute(tx),
  ]);

  // -- pond leads the member may claim (R-OWN-16): entered a claimable pond within the card's window -----
  // The same window bounds the full and the scoped read (an entry older than the window can give no card).
  const pondSince = new Date(now - POND_NEW_WINDOW_MS).toISOString();
  const pond = scope && C.length === 0
    ? { rows: [] as PondLeadRow[] }
    : await sql<PondLeadRow>`
        SELECT contact_id, pond_id, entered_seq::text AS entered_seq, entered_at, entered_by_import, cooldown_until
          FROM app.my_pond_leads(${pondSince}::timestamptz, ${scope ? C : null}::uuid[])
         ORDER BY entered_at DESC, contact_id`.execute(tx);
  const pondOut: PondLeadFacts[] = [];
  for (const p of pond.rows) {
    // imported into a pond: not new, no card (the Pond page lists it)
    if (p.entered_by_import) continue;
    if (p.cooldown_until !== null && ms(p.cooldown_until) >= now) {
      // R-OWN-16: no card while the member's own claim cooldown on the lead runs; it may appear when it ends
      win(contactGroup(p.contact_id), ms(p.cooldown_until) + 1);
      continue;
    }
    pondOut.push({ contactId: p.contact_id as ContactId, pondId: p.pond_id as never, enteredSeq: Number(p.entered_seq), enteredAt: ms(p.entered_at), userIds: [userId] });
  }

  // -- touches after the waiting messages (answered by a person?) -----------------------------------------
  // R-PAR-37: a bulk email or batch text is marketing, never a touch and never a reply, so it never answers a
  // waiting client (the exclusion the exception queue's outbound reads and the scoreboard counts make too).
  const waitingContacts = [...new Set([...inbound.rows.map((m) => m.contact_id), ...missed.rows.map((c) => c.contact_id)])];
  const touches = new Map<string, TouchFacts[]>();
  if (waitingContacts.length > 0) {
    const t = await sql<{ contact_id: string; kind: 'message' | 'call'; direction: 'outbound' | 'inbound_answered'; initiator: TouchFacts['initiator']; imported: boolean; gate_allowed: boolean; at: Date; by_user: string | null; win_at: Date }>`
      SELECT m.contact_id, 'message' AS kind, 'outbound' AS direction,
             CASE WHEN m.initiator IN ('human','assistant','system','import') THEN m.initiator ELSE 'system' END AS initiator,
             m.imported, m.status NOT IN ('scheduled','queued','blocked','canceled') AS gate_allowed,
             COALESCE(m.dispatched_at, m.occurred_at) AS at, m.initiated_by_user_id AS by_user, m.occurred_at AS win_at
        FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ANY (${waitingContacts}::uuid[]) AND m.direction = 'outbound'
         AND m.bulk_action_id IS NULL
         AND m.occurred_at > ${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS})
      UNION ALL
      SELECT k.contact_id, 'call', CASE WHEN k.direction = 'outbound' THEN 'outbound' ELSE 'inbound_answered' END,
             CASE WHEN k.initiator = 'client' THEN 'human' ELSE k.initiator END,
             k.imported, (k.direction = 'inbound' OR NOT k.imported), COALESCE(k.answered_at, k.started_at), k.agent_user_id, k.started_at
        FROM calls k
       WHERE k.tenant_id = app.tenant_id() AND k.contact_id = ANY (${waitingContacts}::uuid[])
         AND (k.direction = 'outbound' OR (k.answered_at IS NOT NULL AND k.handled_by = 'human'))
         AND k.started_at > ${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS})`.execute(tx);
    for (const x of t.rows) {
      win(contactGroup(x.contact_id), ms(x.win_at) + INBOUND_WINDOW_DAYS * DAY);
      win(contactGroup(x.contact_id), ms(x.win_at) + INBOUND_WINDOW_DAYS * DAY + 1);
      const list = touches.get(x.contact_id) ?? [];
      list.push({ kind: x.kind, direction: x.direction, initiator: x.initiator, imported: x.imported, gateAllowed: x.gate_allowed, at: ms(x.at), byUserId: x.by_user as UserId | null });
      touches.set(x.contact_id, list);
    }
  }

  // -- promise evidence (verified quotes from the source the promise was made in) -------------------------
  const claimIds = tasks.rows.filter((t) => t.kind === 'promise' && t.source_claim_id !== null).map((t) => t.source_claim_id as string);
  const evidence = await evidenceForClaims(tx, actor, envelope, claimIds);

  const contactIds = new Set<string>();
  const offersOut: OfferFacts[] = offers.rows.map((o) => {
    contactIds.add(o.id);
    return { contactId: o.id as ContactId, offerId: o.offer_id, offeredToUserId: o.offered_to_user_id as UserId, offeredAt: ms(o.updated_at), expiresAt: ms(o.offer_expires_at), sourceName: o.source };
  });
  const slasOut: SlaFacts[] = slas.rows.map((s) => {
    contactIds.add(s.id);
    return { contactId: s.id as ContactId, ownerUserId: s.owner_user_id as UserId, periodSeq: Number(s.ownership_period_seq), ownedAt: ms(s.owned_at), firstTouchDueAt: ms(s.first_touch_due_at), firstTouchAt: null, periodEndedAt: null, releaseDueAt: msOrNull(s.release_due_at) };
  });
  const inactivityOut: InactivityFacts[] = inactivity.rows.map((w) => {
    contactIds.add(w.id);
    return { contactId: w.id as ContactId, ownerUserId: userId, periodSeq: Number(w.ownership_period_seq), warnAt: ms(w.inactivity_warn_at), releaseAt: ms(w.inactivity_release_at) };
  });
  const reinquiriesOut: ReinquiryFacts[] = reinquiries.rows.map((r) => {
    contactIds.add(r.contact_id);
    return { contactId: r.contact_id as ContactId, ownerUserId: userId, inquiryId: r.inquiry_id as never, at: ms(r.occurred_at), dueAt: msOrNull(r.deadline_at), touchedSince: r.touched };
  });
  const inboundOut: InboundFacts[] = [
    ...inbound.rows.map((m) => ({
      id: m.id as never,
      kind: 'message' as const,
      channel: m.channel,
      contactId: m.contact_id as ContactId,
      ownerUserId: userId,
      at: ms(m.occurred_at),
      imported: false,
      isAutoReply: m.is_auto_reply,
      isKeyword: m.opt_out_keyword !== null,
      laterTouches: touches.get(m.contact_id) ?? [],
    })),
    ...missed.rows.map((c) => ({
      id: c.id as never,
      kind: 'missed_call' as const,
      channel: 'voice' as const,
      contactId: c.contact_id as ContactId,
      ownerUserId: userId,
      at: ms(c.started_at),
      imported: false,
      laterTouches: touches.get(c.contact_id) ?? [],
    })),
  ];
  for (const m of inboundOut) contactIds.add(m.contactId);
  const handbacksOut: HandbackFacts[] = handbacks.rows.map((h) => {
    contactIds.add(h.contact_id);
    const draft = h.payload.draft as { body?: unknown } | undefined;
    const viaCall = typeof h.payload.inboundCallId === 'string' && h.payload.inboundCallId.length > 0 && h.m_channel === null;
    return {
      actionId: h.id as never,
      ownerUserId: userId,
      contactId: h.contact_id as ContactId,
      inboundMessageId: (typeof h.payload.inboundMessageId === 'string' ? h.payload.inboundMessageId : null) as never,
      inboundChannel: h.m_channel ?? (viaCall ? 'voice' : null),
      receivedAt: ms(h.m_at ?? h.created_at),
      // the handback carries its own reply draft: approving the handback sends it (one tap, A1)
      replyDraftActionId: draft && typeof draft.body === 'string' && draft.body.trim() !== '' ? (h.id as never) : null,
      createdAt: ms(h.created_at),
    };
  });
  const draftsOut: DraftFacts[] = drafts.rows.map((d) => {
    contactIds.add(d.contact_id);
    return {
      actionId: d.id as never,
      ownerUserId: userId,
      contactId: d.contact_id as ContactId,
      channel: d.channel === 'email' ? 'email' : 'sms',
      category: d.action_category as DraftFacts['category'],
      explanation: d.explanation,
      needsReview: d.needs_review,
      createdAt: ms(d.created_at),
    };
  });
  const tasksOut: TaskFacts[] = tasks.rows.map((t) => {
    if (t.contact_id) contactIds.add(t.contact_id);
    const ev: TaskEvidence[] = (t.source_claim_id ? (evidence.get(t.source_claim_id) ?? []) : [])
      .filter((e) => e.snippet !== null && e.sourceAvailable && e.verified)
      .map((e) => ({ sourceType: e.sourceType as TaskEvidence['sourceType'], sourceId: e.sourceId, locator: e.locator as TaskEvidence['locator'], snippet: e.snippet as string }));
    return {
      taskId: t.id as never,
      assigneeUserId: userId,
      contactId: t.contact_id as ContactId | null,
      dealId: t.deal_id as never,
      kind: t.kind,
      dueAt: msOrNull(t.due_at),
      dueAllDay: t.due_all_day,
      dueTz: t.due_tz as never,
      status: 'open',
      completedAt: null,
      needsReview: t.needs_review,
      createdByKind: t.created_by_kind,
      createdAt: ms(t.created_at),
      ...(ev.length > 0 ? { evidence: ev } : {}),
    };
  });
  const dealDatesOut: DealDateFacts[] = dealDates.rows.map((d) => ({
    dealDateId: d.id as never,
    dealId: d.deal_id as never,
    userIds: [...new Set([d.owner_user_id, ...d.members])] as UserId[],
    kind: d.kind,
    label: d.label,
    dueOn: d.due_on as never,
    zone: d.zone as never,
    completedAt: msOrNull(d.completed_at),
    createdAt: ms(d.created_at),
  }));
  const apptsOut: ApptFacts[] = appts.rows.map((a) => ({
    appointmentId: a.id as never,
    contactId: a.contact_id as ContactId | null,
    userId,
    kind: a.kind,
    startsAt: ms(a.starts_at),
    endsAt: ms(a.ends_at),
    status: a.status,
    outcomeLoggedAt: null,
    createdByKind: a.created_by_kind,
  }));
  const searchesOut: SearchProposalFacts[] = searches.rows.map((s) => ({ savedSearchId: s.id as never, ownerUserId: userId, contactId: s.contact_id as ContactId, uncheckedCount: s.unchecked, createdAt: ms(s.created_at) }));

  // -- when time alone changes what was read (the windows above; core's own instants are added below) ---
  const lookBack = (group: string, t: number, days: number) => {
    // a row at instant t leaves `> now - days` once now >= t + days; +1 ms covers sub-millisecond DB instants
    win(group, t + days * DAY);
    win(group, t + days * DAY + 1);
  };
  for (const m of inboundOut) lookBack(contactGroup(m.contactId), m.at, INBOUND_WINDOW_DAYS);
  for (const r of reinquiriesOut) lookBack(contactGroup(r.contactId), r.at, INBOUND_WINDOW_DAYS);
  for (const a of apptsOut) lookBack(a.contactId !== null ? contactGroup(a.contactId) : appointmentGroup(a.appointmentId), a.endsAt, APPT_INPUT_WINDOW_DAYS);
  for (const w of inactivityOut) win(contactGroup(w.contactId), w.warnAt);
  for (const t of tasksOut) if (t.dueAt !== null) win(t.contactId !== null ? contactGroup(t.contactId) : taskGroup(t.taskId), t.dueAt - TASK_INPUT_WINDOW_MS);
  for (const d of dealDatesOut) {
    // the first instant whose local date is due_on - 3 (an hour earlier too: a DST gap at local midnight)
    const start = resolveLocal(addDays(d.dueOn, -DEAL_DATE_INPUT_DAYS) as never, MIDNIGHT, d.zone, 'earlier');
    win(dealDateGroup(d.dealDateId), start - HOUR);
    win(dealDateGroup(d.dealDateId), start);
  }

  const raw: FeedInputs = {
    now,
    userId,
    offers: offersOut,
    slas: slasOut,
    unansweredInbound: inboundOut,
    handbacks: handbacksOut,
    drafts: draftsOut,
    tasks: tasksOut,
    dealDates: dealDatesOut,
    appointments: apptsOut,
    blockedChannels: await gateSummaries(tx, [...contactIds]),
    reinquiries: reinquiriesOut,
    inactivityWarnings: inactivityOut,
    pondLeads: pondOut,
    searchProposals: searchesOut,
  };
  const nextChange = new Map<string, number>();
  const note = (g: string, t: number | null) => {
    if (t === null || !(t > now)) return;
    const prev = nextChange.get(g);
    if (prev === undefined || t < prev) nextChange.set(g, t);
  };
  for (const [g, list] of windows) for (const t of list) note(g, t);
  // core's instants over every fact read, including future ones still held back by the windows
  for (const [g, gi] of splitFeedInputs(raw)) note(g, nextFeedChange(gi));
  return { inputs: windowFeedInputs(raw), nextChange };
}

const SUPPRESSION_SENTENCE: Record<string, string> = {
  hard_bounce: 'Email address bounced',
  spam_complaint: 'Marked our email as spam',
  undeliverable: 'Messages to this address fail',
  landline_no_sms: 'Landline: cannot get texts',
  internal_dnc: 'On the team do-not-contact list',
  admin_block: 'Blocked by an admin',
  wrong_number: 'Wrong number',
  provider_opt_out: 'Opted out with the carrier',
  import_dnc: 'Marked do-not-contact in the import',
};

/**
 * Per-contact channel hint for the feed (core GateSummary). A channel is `unavailable` when the contact
 * has no working address for it, and `deny` when every working address is suppressed or opted out.
 * Contacts with no known block are absent from the map.
 */
export async function gateSummaries(tx: Tx, contactIds: readonly string[]): Promise<Map<ContactId, GateSummary>> {
  const out = new Map<ContactId, GateSummary>();
  if (contactIds.length === 0) return out;
  const r = await sql<{ contact_id: string; kind: 'phone' | 'email'; line_type: string; sup_sms: string | null; sup_voice: string | null; sup_email: string | null; rev_sms: boolean; rev_voice: boolean; rev_email: boolean }>`
    SELECT p.contact_id, p.kind, p.line_type,
           (SELECT s.reason FROM suppressions s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.lifted_at IS NULL AND s.channel IN ('sms','all') LIMIT 1) AS sup_sms,
           (SELECT s.reason FROM suppressions s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.lifted_at IS NULL AND s.channel IN ('voice','all') LIMIT 1) AS sup_voice,
           (SELECT s.reason FROM suppressions s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.lifted_at IS NULL AND s.channel IN ('email','all') LIMIT 1) AS sup_email,
           EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.address_hmac = p.address_hmac AND cs.channel = 'sms' AND cs.status = 'revoked') AS rev_sms,
           EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.address_hmac = p.address_hmac AND cs.channel = 'voice' AND cs.status = 'revoked') AS rev_voice,
           EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.address_hmac = p.address_hmac AND cs.channel = 'email' AND cs.status = 'revoked') AS rev_email
      FROM contact_points p
     WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ANY (${[...contactIds]}::uuid[]) AND p.removed_at IS NULL AND p.status = 'active'
       -- phones and emails only: a website-chat identity (kind web_chat, wc:<hex>) is no email address (finding UXA-3)
       AND p.kind IN ('phone','email')`.execute(tx);
  // The opt-out fan-out of the send gate (comms/repos/gate.ts optOutFanoutPhoneHmacs, the `others` set of the
  // 0021 dispatch guards): every phone of the contact, live or removed, except one removed as a confirmed
  // wrong number. A STOP (or "do not call me") on any of them blocks texting (calling) every phone of the
  // person (R-CONSENT-7, outbound-3, R-PAR-12), so the card never offers a channel the composer refuses.
  const fan = await sql<{ contact_id: string; rev_sms: boolean; rev_voice: boolean }>`
    SELECT p.contact_id,
           bool_or(EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.address_hmac = p.address_hmac AND cs.channel = 'sms' AND cs.status = 'revoked')) AS rev_sms,
           bool_or(EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.address_hmac = p.address_hmac AND cs.channel = 'voice' AND cs.status = 'revoked')) AS rev_voice
      FROM contact_points p
     WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ANY (${[...contactIds]}::uuid[]) AND p.kind = 'phone'
       AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')
     GROUP BY p.contact_id`.execute(tx);
  type Acc = { usable: boolean; why: Set<string> };
  const per = new Map<string, Record<Channel, Acc>>();
  const fresh = (): Record<Channel, Acc> => ({ sms: { usable: false, why: new Set() }, voice: { usable: false, why: new Set() }, email: { usable: false, why: new Set() } });
  const seen = new Map<string, Set<Channel>>();
  for (const p of r.rows) {
    const acc = per.get(p.contact_id) ?? fresh();
    per.set(p.contact_id, acc);
    const has = seen.get(p.contact_id) ?? new Set<Channel>();
    seen.set(p.contact_id, has);
    const judge = (ch: Channel, sup: string | null, revoked: boolean, extra?: string) => {
      has.add(ch);
      const why = extra ?? (sup ? (SUPPRESSION_SENTENCE[sup] ?? 'Blocked') : revoked ? (ch === 'sms' ? 'Opted out of texts' : ch === 'voice' ? 'Asked not to be called' : 'Unsubscribed from email') : null);
      if (why === null) acc[ch].usable = true;
      else acc[ch].why.add(why);
    };
    if (p.kind === 'phone') {
      judge('sms', p.sup_sms, p.rev_sms, p.line_type === 'landline' ? 'Landline: cannot get texts' : undefined);
      judge('voice', p.sup_voice, p.rev_voice);
    } else judge('email', p.sup_email, p.rev_email);
  }
  // A STOP on any phone of the fan-out blocks texting all of them, a "do not call me" calling all of them
  // (the gate's opt-out rule, removed phones included).
  for (const f of fan.rows) {
    const acc = per.get(f.contact_id);
    if (!acc) continue;
    if (f.rev_sms) {
      acc.sms.usable = false;
      acc.sms.why.add('Opted out of texts');
    }
    if (f.rev_voice) {
      acc.voice.usable = false;
      acc.voice.why.add('Asked not to be called');
    }
  }
  for (const id of contactIds) {
    const acc = per.get(id) ?? fresh();
    const has = seen.get(id) ?? new Set<Channel>();
    const g: GateSummary = {};
    for (const ch of ['sms', 'voice', 'email'] as const) {
      if (acc[ch].usable) continue;
      const block: ChannelBlock = has.has(ch)
        ? { outcome: 'deny', explanation: [...acc[ch].why].join(' · ') }
        : { outcome: 'unavailable', explanation: ch === 'email' ? 'No email address' : 'No working phone number' };
      g[ch] = block;
    }
    if (Object.keys(g).length > 0) out.set(id as ContactId, g);
  }
  return out;
}
