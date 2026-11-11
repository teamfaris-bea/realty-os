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
  ReinquiryFacts,
  SearchProposalFacts,
  SlaFacts,
  TaskEvidence,
  TaskFacts,
  TouchFacts,
} from '@realty/core/priority';
import type { Channel } from '@realty/core/compliance';
import type { ContactId, Instant, UserActor, UserId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { evidenceForClaims } from './evidence.js';

const ms = (d: Date | string): Instant => new Date(d).getTime() as Instant;
const msOrNull = (d: Date | string | null): Instant | null => (d === null ? null : ms(d));

/** How far back unanswered client messages are looked for (older ones live in the thread, not the feed). */
export const INBOUND_WINDOW_DAYS = 14;
/** Row caps per input (the feed shows the top 50; the caps keep one request bounded). */
const CAP = 300;

export async function loadFeedInputs(tx: Tx, actor: UserActor, envelope: EnvelopeService, now: Instant): Promise<FeedInputs> {
  const userId = actor.userId as UserId;
  const nowIso = new Date(now).toISOString();

  const [offers, slas, inactivity, reinquiries, inbound, missed, handbacks, drafts, tasks, dealDates, appts, searches] = await Promise.all([
    sql<{ id: string; offer_id: string; offered_to_user_id: string; offer_expires_at: Date; updated_at: Date; source: string | null }>`
      SELECT c.id, c.offer_id, c.offered_to_user_id, c.offer_expires_at, c.updated_at, ls.name AS source
        FROM contacts c LEFT JOIN lead_sources ls ON ls.tenant_id = c.tenant_id AND ls.id = c.original_lead_source_id
       WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'offered' AND c.offered_to_user_id = ${userId}
         AND c.deleted_at IS NULL AND c.offer_expires_at > ${nowIso}::timestamptz
       ORDER BY c.offer_expires_at LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; owner_user_id: string; ownership_period_seq: string; owned_at: Date; first_touch_due_at: Date; release_due_at: Date | null }>`
      SELECT id, owner_user_id, ownership_period_seq, owned_at, first_touch_due_at, release_due_at FROM contacts
       WHERE tenant_id = app.tenant_id() AND ownership_state = 'owned' AND owner_user_id = ${userId} AND deleted_at IS NULL
         AND first_touch_due_at IS NOT NULL AND first_touch_at IS NULL
       ORDER BY first_touch_due_at LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; ownership_period_seq: string; inactivity_warn_at: Date; inactivity_release_at: Date }>`
      SELECT id, ownership_period_seq, inactivity_warn_at, inactivity_release_at FROM contacts
       WHERE tenant_id = app.tenant_id() AND ownership_state = 'owned' AND owner_user_id = ${userId} AND deleted_at IS NULL
         AND inactivity_warn_at <= ${nowIso}::timestamptz AND inactivity_release_at > ${nowIso}::timestamptz
       ORDER BY inactivity_release_at LIMIT ${CAP}`.execute(tx),
    sql<{ contact_id: string; inquiry_id: string; occurred_at: Date; deadline_at: Date | null; touched: boolean }>`
      SELECT e.contact_id, e.payload->>'inquiryId' AS inquiry_id, e.occurred_at, e.deadline_at,
             (c.last_human_touch_at IS NOT NULL AND c.last_human_touch_at > e.occurred_at) AS touched
        FROM contacts c JOIN lead_ownership_events e ON e.tenant_id = c.tenant_id AND e.contact_id = c.id
       WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
         AND e.type = 'reinquiry' AND e.seq >= c.ownership_period_seq AND e.payload ? 'inquiryId'
         AND e.occurred_at > ${nowIso}::timestamptz - interval '14 days'
       ORDER BY e.occurred_at DESC LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; channel: 'sms' | 'mms' | 'email'; contact_id: string; occurred_at: Date; is_auto_reply: boolean; opt_out_keyword: string | null }>`
      WITH mine AS MATERIALIZED (
        -- the agent's owned contacts with the instant after which a client message is still unanswered
        SELECT c.tenant_id, c.id, GREATEST(${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS}), COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)) AS since
          FROM contacts c
         WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL)
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
           ORDER BY m.occurred_at DESC LIMIT ${CAP}) m
       ORDER BY m.occurred_at DESC LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string; started_at: Date }>`
      WITH mine AS MATERIALIZED (
        SELECT c.tenant_id, c.id, GREATEST(${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS}), COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)) AS since
          FROM contacts c
         WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL)
      SELECT k.id, k.contact_id, k.started_at
        FROM mine c
        -- per-contact index range scan, as for messages above
        CROSS JOIN LATERAL (
          SELECT k.id, k.contact_id, k.started_at FROM calls k
           WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND k.started_at > c.since
             AND k.direction = 'inbound' AND NOT k.imported AND k.answered_at IS NULL
             AND k.status IN ('no_answer','busy','voicemail','canceled','failed','completed')
           ORDER BY k.started_at DESC LIMIT ${CAP}) k
       ORDER BY k.started_at DESC LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string; created_at: Date; payload: Record<string, unknown>; m_channel: 'sms' | 'mms' | 'email' | null; m_at: Date | null }>`
      SELECT a.id, a.contact_id, a.created_at, a.payload, m.channel AS m_channel, m.occurred_at AS m_at
        FROM assistant_actions a
        LEFT JOIN messages m ON m.tenant_id = a.tenant_id AND m.id = CASE WHEN a.payload->>'inboundMessageId' ~ '^[0-9a-f-]{36}$' THEN (a.payload->>'inboundMessageId')::uuid END
       WHERE a.tenant_id = app.tenant_id() AND a.kind = 'handback' AND a.status = 'proposed' AND a.owner_user_id = ${userId} AND a.contact_id IS NOT NULL
       ORDER BY a.created_at DESC LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string; channel: string | null; action_category: string; explanation: string; created_at: Date; needs_review: boolean }>`
      SELECT a.id, a.contact_id, a.payload->>'channel' AS channel, a.action_category, a.explanation, a.created_at,
             EXISTS (SELECT 1 FROM assistant_claims cl WHERE cl.tenant_id = a.tenant_id AND cl.action_id = a.id
                       AND cl.needs_review AND cl.review_status = 'unreviewed') AS needs_review
        FROM assistant_actions a
       WHERE a.tenant_id = app.tenant_id() AND a.kind = 'message_draft' AND a.status = 'proposed' AND a.owner_user_id = ${userId} AND a.contact_id IS NOT NULL
       ORDER BY a.created_at DESC LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string | null; deal_id: string | null; kind: TaskFacts['kind']; due_at: Date | null; due_all_day: boolean; due_tz: string | null; needs_review: boolean; created_by_kind: TaskFacts['createdByKind']; created_at: Date; source_claim_id: string | null }>`
      SELECT id, contact_id, deal_id, kind, due_at, due_all_day, due_tz, needs_review, created_by_kind, created_at, source_claim_id FROM tasks
       WHERE tenant_id = app.tenant_id() AND assignee_user_id = ${userId} AND status = 'open'
         AND ((due_at IS NOT NULL AND due_at <= ${nowIso}::timestamptz + interval '50 hours')
              OR (kind = 'promise' AND needs_review AND due_at IS NULL))
       ORDER BY due_at NULLS LAST LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; deal_id: string; kind: DealDateFacts['kind']; label: string | null; due_on: string; completed_at: Date | null; created_at: Date; owner_user_id: string; members: string[]; zone: string }>`
      SELECT dd.id, dd.deal_id, dd.kind, dd.label, dd.due_on::text AS due_on, dd.completed_at, dd.created_at, d.owner_user_id,
             COALESCE((SELECT array_agg(dm.user_id::text) FROM deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id), '{}') AS members,
             s.default_timezone AS zone
        FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
        JOIN tenant_settings s ON s.tenant_id = d.tenant_id
       WHERE dd.tenant_id = app.tenant_id() AND dd.completed_at IS NULL AND d.stage NOT IN ('closed','lost')
         AND dd.due_on <= (${nowIso}::timestamptz AT TIME ZONE s.default_timezone)::date + 3
         AND (d.owner_user_id = ${userId} OR EXISTS (SELECT 1 FROM deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id AND dm.user_id = ${userId}))
       ORDER BY dd.due_on LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string | null; kind: ApptFacts['kind']; starts_at: Date; ends_at: Date; status: ApptFacts['status']; created_by_kind: ApptFacts['createdByKind'] }>`
      SELECT id, contact_id, kind, starts_at, ends_at, status, created_by_kind FROM appointments
       WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status IN ('scheduled','held') AND outcome_logged_at IS NULL
         AND created_by_kind <> 'import' AND ends_at <= ${nowIso}::timestamptz AND ends_at > ${nowIso}::timestamptz - interval '30 days'
       ORDER BY ends_at LIMIT ${CAP}`.execute(tx),
    sql<{ id: string; contact_id: string; created_at: Date; unchecked: number }>`
      SELECT s.id, s.contact_id, s.created_at,
             (SELECT count(*)::int FROM jsonb_each_text(s.criterion_evidence) ce
                JOIN assistant_claims cl ON cl.tenant_id = s.tenant_id AND ce.value ~ '^[0-9a-f-]{36}$' AND cl.id = ce.value::uuid
               WHERE cl.needs_review AND cl.review_status = 'unreviewed') AS unchecked
        FROM saved_searches s JOIN contacts c ON c.tenant_id = s.tenant_id AND c.id = s.contact_id
       WHERE s.tenant_id = app.tenant_id() AND s.status = 'proposed' AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
       ORDER BY s.created_at DESC LIMIT ${CAP}`.execute(tx),
  ]);

  // -- touches after the waiting messages (answered by a person?) -----------------------------------------
  const waitingContacts = [...new Set([...inbound.rows.map((m) => m.contact_id), ...missed.rows.map((c) => c.contact_id)])];
  const touches = new Map<string, TouchFacts[]>();
  if (waitingContacts.length > 0) {
    const t = await sql<{ contact_id: string; kind: 'message' | 'call'; direction: 'outbound' | 'inbound_answered'; initiator: TouchFacts['initiator']; imported: boolean; gate_allowed: boolean; at: Date; by_user: string | null }>`
      SELECT m.contact_id, 'message' AS kind, 'outbound' AS direction,
             CASE WHEN m.initiator IN ('human','assistant','system','import') THEN m.initiator ELSE 'system' END AS initiator,
             m.imported, m.status NOT IN ('scheduled','queued','blocked','canceled') AS gate_allowed,
             COALESCE(m.dispatched_at, m.occurred_at) AS at, m.initiated_by_user_id AS by_user
        FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ANY (${waitingContacts}::uuid[]) AND m.direction = 'outbound'
         AND m.occurred_at > ${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS})
      UNION ALL
      SELECT k.contact_id, 'call', CASE WHEN k.direction = 'outbound' THEN 'outbound' ELSE 'inbound_answered' END,
             CASE WHEN k.initiator = 'client' THEN 'human' ELSE k.initiator END,
             k.imported, (k.direction = 'inbound' OR NOT k.imported), COALESCE(k.answered_at, k.started_at), k.agent_user_id
        FROM calls k
       WHERE k.tenant_id = app.tenant_id() AND k.contact_id = ANY (${waitingContacts}::uuid[])
         AND (k.direction = 'outbound' OR (k.answered_at IS NOT NULL AND k.handled_by = 'human'))
         AND k.started_at > ${nowIso}::timestamptz - make_interval(days => ${INBOUND_WINDOW_DAYS})`.execute(tx);
    for (const x of t.rows) {
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

  return {
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
    pondLeads: [],
    searchProposals: searchesOut,
  };
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
     WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ANY (${[...contactIds]}::uuid[]) AND p.removed_at IS NULL AND p.status = 'active'`.execute(tx);
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
  // A STOP on any of the contact's phones blocks texting all of them (the gate's SMS opt-out rule).
  for (const p of r.rows) {
    const acc = per.get(p.contact_id);
    if (p.kind === 'phone' && p.rev_sms && acc) {
      acc.sms.usable = false;
      acc.sms.why.add('Opted out of texts');
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
