// Dispatch for AI ISA messages (R-ISA-8, -9, -10, -11, -25; docs/AI_ISA.md §5.4, §5.5). dispatchOutbound's TX1 calls
// aiIsaGateFacts so core canContact's checks 0, 8 and 12 decide first (D1's checks 5, 6 and 9 still run first and
// unchanged); the zones it resolves are written onto the turn BEFORE the dispatching UPDATE; Node's and Postgres's UTC
// offsets must agree. The DB guard then re-derives every check. Each terminal status emits one send_result through
// the `ai_isa.send_result` job, which maps the reason class (deferrable, replan, terminal, end care).
import type { AiIsaGateFacts } from '@realty/core/compliance';
import type { Instant } from '@realty/core/foundation';
import { type IanaZone, instantFromDate } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { aiIsaSendWindow, fromDisplayName, holidaysAround, icuOffsetMinutes, ISA_DEFAULT_CAPS, isaReasonClass, refusalClass } from './coreSeam.js';
import { chainEnvOf, contextFor, type IsaDeps } from './effects.js';
import { assignmentById, evaluateChain, exclusivity, stopSignalSince } from './repo.js';

export const AI_ISA_CATEGORIES = new Set(['ai_isa_message', 'ai_isa_confirmation', 'ai_isa_holding_line']);
export const isAiIsaMessage = (category: string | null | undefined): boolean => category !== null && category !== undefined && AI_ISA_CATEGORIES.has(category);

/**
 * ISA_GUARD_REASONS (beside GUARD_DENY_REASONS): the guard's AI ISA codes dispatch maps to a recorded refusal instead of
 * an error (unmapped guard codes would make the job retry ten times and die with the message still queued).
 */
export const ISA_GUARD_REASONS = [
  'ISA_NOT_AUTHORIZED', 'ISA_PURPOSE_MISMATCH', 'ISA_CHANNEL_NOT_ALLOWED', 'ISA_BODY_CHANGED', 'ISA_UNBOUND_RECIPIENT', 'ISA_STOPPED', 'ISA_PAUSED', 'ISA_STALE_EPOCH',
  'ISA_STALE_REPLY', 'ISA_HANDOFF_CLOSED', 'ISA_SHARED_ADDRESS', 'ISA_ACTIVE_CLIENT', 'ISA_UNREAD_PART', 'ISA_SELLER_DATA_NOT_CLEARED', 'ISA_CONSENT_EVIDENCE_MISSING',
  'ISA_REPLY_WINDOW_CLOSED', 'ISA_DNC_UNVERIFIED', 'ISA_ZONE_UNRESOLVED', 'ISA_QUIET_HOURS', 'ISA_MIN_GAP', 'ISA_CAP_REACHED', 'ASSISTANT_ACTION_WITHDRAWN',
] as const;
export type IsaGuardReason = (typeof ISA_GUARD_REASONS)[number];

/** The guard's AI ISA refusal code, or null for anything else (only for an AI ISA message). */
export function isaGuardRefusal(err: unknown): IsaGuardReason | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== '23514' || typeof message !== 'string') return null;
  return ISA_GUARD_REASONS.find((r) => message.startsWith(`${r}:`)) ?? null;
}

/** Codes whose message is a HOLD (§5.5): no pause, no per-lead card, the turn waits for the switch or the cap. */
export const HOLD_CODES = new Set(['AI_ISA_LIVE_OFF', 'TELEPHONY_LIVE_OFF', 'DAILY_SEND_CAP_REACHED']);

export interface IsaMessageRef {
  id: string;
  contactId: string;
  conversationId: string;
  channel: string;
  assistantActionId: string | null;
}

/** When every refusal reason is deferrable, the instant to retry at (the next window start, the gap, or an hour). */
export async function deferralFor(tx: Tx, m: IsaMessageRef, reasons: readonly string[], now: Instant): Promise<Instant | null> {
  if (reasons.length === 0 || refusalClass(reasons) !== 'deferrable') return null;
  if (reasons.every((r) => r === 'ISA_MIN_GAP')) return (now + ISA_DEFAULT_CAPS.minGapSeconds * 1000) as Instant;
  if (reasons.includes('ISA_QUIET_HOURS') || reasons.includes('ISA_ZONE_UNRESOLVED')) {
    const t = await sql<{ zones: string[] | null; ws: string | null; we: string | null; kind: string | null }>`SELECT t.zones, t.window_start::text AS ws, t.window_end::text AS we, t.message_kind AS kind
      FROM ai_isa_turns t WHERE t.tenant_id = app.tenant_id() AND t.message_id = ${m.id}`.execute(tx);
    const r = t.rows[0];
    if (r?.zones && r.ws && r.we) {
      const sec = (s: string) => { const [h, mi] = s.split(':').map(Number); return h! * 3600 + mi! * 60; };
      const next = aiIsaSendWindow({ at: (now + 60_000) as Instant, zones: r.zones as IanaZone[], startSec: sec(r.ws), endSec: sec(r.we), initiated: r.kind === 'initiated', initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true });
      if (next !== null) return next;
    }
  }
  return (now + 3_600_000) as Instant;
}

/** Set an AI ISA message back to `scheduled` (a deferrable refusal: quiet hours, the cap, the gap, the offsets). */
export async function deferMessageInTx(tx: Tx, messageId: string, until: Instant, reason: string): Promise<void> {
  await sql`UPDATE messages SET status = 'scheduled', scheduled_for = ${new Date(until)}, status_reason = ${reason}
    WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND status IN ('queued','scheduled')`.execute(tx);
  await sql`UPDATE ai_isa_turns SET not_before = ${new Date(until)}, status = 'deferred' WHERE tenant_id = app.tenant_id() AND message_id = ${messageId}`.execute(tx);
}

/** Every terminal status of an AI ISA message emits one send_result (the job is idempotent on the message). */
export async function emitSendResultInTx(tx: Tx, messageId: string, status: string): Promise<void> {
  await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.send_result', payload: { messageId, status }, dedupeKey: `ai_isa.send_result:${messageId}:${status}` });
}

/** The email From display name of an AI ISA message: "{Agent}'s AI assistant ({Team})" (§7.3). */
export async function isaFromName(tx: Tx, m: IsaMessageRef): Promise<string | null> {
  const r = await sql<{ first: string | null; team: string | null; brokerage: string }>`SELECT split_part(COALESCE(u.display_name, ''), ' ', 1) AS first, s.team_name AS team,
      s.brokerage_legal_name AS brokerage
    FROM assistant_actions aa JOIN tenant_settings s ON s.tenant_id = aa.tenant_id LEFT JOIN users u ON u.id = aa.owner_user_id
    WHERE aa.tenant_id = app.tenant_id() AND aa.id = ${m.assistantActionId}`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return fromDisplayName({ agentFirstName: x.first && x.first.trim() !== '' ? x.first : 'your agent', teamName: x.team ?? x.brokerage, brokerageName: x.brokerage }).slice(0, 120);
}

export interface IsaTx1Facts {
  facts: AiIsaGateFacts;
  /** API-level reasons (offset disagreement), deferrable */
  extra: string[];
}

/** TX1: the AI ISA facts of one message (under lock_contact), and the zone write onto its turn. */
export async function aiIsaGateFacts(tx: Tx, deps: IsaDeps, m: IsaMessageRef, recipientHmac: string, now: Instant): Promise<IsaTx1Facts> {
  const row = await sql<{ turn_id: string | null; assignment_id: string | null; status: string; epoch: number | null; pinned: string | null; zones: string[] | null;
    ws: string | null; we: string | null; kind: string | null; conv_seq: string | null; conv_reason: string | null; media: boolean; sold: boolean }>`
    SELECT t.id AS turn_id, t.assignment_id, aa.status, aa.epoch, aa.pinned_inbound_seq AS pinned, t.zones, t.window_start::text AS ws, t.window_end::text AS we,
           t.message_kind AS kind, cv.inbound_seq AS conv_seq, cv.automation_pause_reason AS conv_reason,
           EXISTS (SELECT 1 FROM message_media mm WHERE mm.tenant_id = aa.tenant_id AND mm.message_id = ${m.id}) AS media,
           EXISTS (SELECT 1 FROM ai_isa_shared_facts f WHERE f.tenant_id = aa.tenant_id AND f.message_id = ${m.id} AND f.fact_kind IN ('sold_comp_set','nearby_sale')) AS sold
      FROM assistant_actions aa LEFT JOIN ai_isa_turns t ON t.tenant_id = aa.tenant_id AND t.id = aa.ai_isa_turn_id
      LEFT JOIN conversations cv ON cv.tenant_id = aa.tenant_id AND cv.id = ${m.conversationId}
     WHERE aa.tenant_id = app.tenant_id() AND aa.id = ${m.assistantActionId}`.execute(tx);
  const r = row.rows[0];
  const a = r?.assignment_id ? await assignmentById(tx, r.assignment_id) : null;
  const sec = (s: string | null, d: number) => { if (!s) return d; const [h, mi] = s.split(':').map(Number); return h! * 3600 + mi! * 60; };
  const empty: AiIsaGateFacts = {
    chainFailures: ['NO_ASSIGNMENT'], paused: true, pinnedSeqCurrent: false, epochCurrent: false, conversationPauseReason: r?.conv_reason ?? null, boundRecipientHmac: null,
    allowedChannels: [], hasMedia: r?.media ?? false, consentMissing: ['evidence'], zones: [], windowStartSec: 9 * 3600, windowEndSec: 20 * 3600, initiated: true,
    initiatedDays: [1, 2, 3, 4, 5, 6], holidays: [], counts: { ai24h: 0, automated24h: 0, initiated24h: 0, initiated7d: 0, lastAiOutboundAt: null },
    caps: { ...ISA_DEFAULT_CAPS }, sharedAddress: false, activeClient: false, soldDerivedFact: r?.sold ?? false, sellerPacksCleared: false,
  };
  if (!r || !a) return { facts: empty, extra: [] };
  const ctx = await contextFor(tx, a, now);
  const ch = m.channel === 'email' ? 'email' : 'sms';
  const live = a.endedAt === null;
  const handoffPending = !live ? (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}
      AND pending_message_id = ${m.id}) AS ok`.execute(tx)).rows[0]!.ok : false;
  const chain = await evaluateChain(tx, a, chainEnvOf(deps));
  const failures = live ? chain.links.filter((l) => l.effect === 'pause' || l.effect === 'end').map((l) => l.code ?? `LINK_${l.link}`) : chain.links.filter((l) => l.link <= 3 && (l.effect === 'pause' || l.effect === 'end')).map((l) => l.code ?? `LINK_${l.link}`);
  const stopped = (await stopSignalSince(tx, a)) !== null;
  // zones: the turn's set widened by the zones resolved now (written before the dispatching UPDATE, §5.4)
  const zones = [...new Set([...(r.zones ?? []), ...ctx.zones])].sort();
  if (r.turn_id) await sql`UPDATE ai_isa_turns SET zones = ${zones}::text[] WHERE tenant_id = app.tenant_id() AND id = ${r.turn_id}`.execute(tx);
  // the offset agreement check (E514): core's ICU offset at now against Postgres's tzdata
  const pg = await sql<{ z: string; off: number }>`SELECT z, (EXTRACT(EPOCH FROM ((now() AT TIME ZONE z) - (now() AT TIME ZONE 'UTC'))) / 60)::int AS off FROM unnest(${zones}::text[]) z`.execute(tx);
  const extra = pg.rows.some((x) => icuOffsetMinutes(x.z as IanaZone, now) !== x.off) ? ['ISA_OFFSET_MISMATCH'] : [];
  const consent = await consentFacts(tx, a, m, ch, r.sold || (await sql<{ f: boolean }>`SELECT EXISTS (SELECT 1 FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id() AND message_id = ${m.id}) AS f`.execute(tx)).rows[0]!.f);
  const counts = await countFacts(tx, a.contactId, m.id);
  const ex = await exclusivity(tx, a.contactId);
  const sellerOk = (await sql<{ ok: boolean }>`SELECT app.platform_cleared('platform:cma') AND app.platform_cleared('platform:ai_isa_seller_data') AS ok`.execute(tx)).rows[0]!.ok;
  const initiated = r.kind === 'initiated' || consent.tier === 'initiated';
  return {
    extra,
    facts: {
      chainFailures: failures,
      paused: stopped || (live ? a.pausedAt !== null : !handoffPending),
      pinnedSeqCurrent: !live || Number(r.pinned) === Number(r.conv_seq),
      epochCurrent: !live || Number(r.epoch) === a.epoch,
      conversationPauseReason: r.conv_reason,
      boundRecipientHmac: a.boundPoints[ch]?.hmac ?? null,
      allowedChannels: ctx.channels,
      hasMedia: r.media,
      consentMissing: consent.missing,
      zones,
      windowStartSec: Math.max(sec(r.ws, ctx.content.window.startSec), 8 * 3600),
      windowEndSec: Math.min(sec(r.we, ctx.content.window.endSec), 20 * 3600),
      initiated,
      initiatedDays: ctx.content.initiatedDays,
      holidays: ctx.content.noInitiatedOnHolidays ? holidaysAround(now) : [],
      counts,
      caps: ctx.content.caps,
      sharedAddress: ex.shared,
      activeClient: ex.activeClient,
      soldDerivedFact: r.sold,
      sellerPacksCleared: sellerOk,
    },
  };
  void recipientHmac;
}

async function consentFacts(tx: Tx, a: NonNullable<Awaited<ReturnType<typeof assignmentById>>>, m: IsaMessageRef, ch: 'sms' | 'email', hasFacts: boolean): Promise<{ tier: 'reply' | 'initiated'; missing: ('evidence' | 'reply_window' | 'dnc')[] }> {
  const bound = a.boundPoints[ch];
  const r = await sql<{ reply_ok: boolean; grant_ok: boolean; dnc_ok: boolean; revoked: boolean; kind: string | null }>`
    WITH pack AS (SELECT rules FROM jurisdiction_packs WHERE key = 'platform:ai_isa' AND status = 'published'),
         ts AS (SELECT team_name, brokerage_legal_name FROM tenant_settings WHERE tenant_id = app.tenant_id()),
         person AS (SELECT unnest(app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid)) AS id),
         last_ai AS (SELECT max(om.dispatched_at) AS at FROM messages om WHERE om.tenant_id = app.tenant_id() AND om.conversation_id = ${m.conversationId}
                      AND om.channel = ${ch} AND om.id <> ${m.id} AND om.initiator = 'assistant'
                      AND om.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
                      AND om.status IN ('dispatching','dispatch_unknown','sent','delivered','failed','undelivered'))
    SELECT
      EXISTS (SELECT 1 FROM messages im, contact_points bp WHERE im.tenant_id = app.tenant_id() AND im.conversation_id = ${m.conversationId} AND im.direction = 'inbound'
                AND im.channel = ${ch} AND NOT im.is_auto_reply AND bp.tenant_id = im.tenant_id AND bp.id = ${bound?.point_id ?? null}::uuid AND im.from_address = bp.address
                AND im.created_at >= now() - make_interval(hours => COALESCE(((SELECT rules FROM pack)->>'reply_window_hours')::int, 24))
                AND im.created_at > COALESCE((SELECT at FROM last_ai), '-infinity'::timestamptz)
                AND (${ch} <> 'email' OR im.email_dkim_aligned IS TRUE)) AS reply_ok,
      (NULLIF((SELECT rules FROM pack)->>'d12_effective_at', '') IS NOT NULL AND EXISTS (
        SELECT 1 FROM consent_events g LEFT JOIN consent_disclosures d ON d.tenant_id = g.tenant_id AND d.id = g.disclosure_id
         WHERE g.tenant_id = app.tenant_id() AND g.event_type = 'grant' AND g.channel = ${ch} AND g.purpose IN ('marketing','all')
           AND encode(g.address_hmac, 'hex') = ${bound?.hmac ?? ''} AND NOT g.imported AND g.source <> 'agent_entry' AND g.needs_review IS NOT TRUE
           AND (CASE WHEN ${ch} = 'sms' THEN g.consent_level = 'express_written' ELSE g.consent_level IN ('inquiry','express','express_written') END)
           AND (g.expires_at IS NULL OR g.expires_at > now())
           AND (g.occurred_at >= NULLIF((SELECT rules FROM pack)->>'d12_effective_at', '')::timestamptz OR g.source = 'signed_document')
           AND ((g.source = 'signed_document' AND g.evidence_object_id IS NOT NULL)
                OR (d.id IS NOT NULL AND d.scope_stated IS TRUE AND ${ch} = ANY (d.channel_scope) AND 'marketing' = ANY (d.purpose_scope)
                    AND EXISTS (SELECT 1 FROM lead_inquiries li WHERE li.tenant_id = d.tenant_id AND li.consent_disclosure_id = d.id AND li.contact_id IN (SELECT id FROM person))
                    AND NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.tenant_id = d.tenant_id AND ls.consent_disclosure_id = d.id)
                    AND ((length(btrim(COALESCE((SELECT team_name FROM ts), ''))) > 0 AND position(lower((SELECT team_name FROM ts)) IN lower(d.body)) > 0)
                         OR position(lower((SELECT brokerage_legal_name FROM ts)) IN lower(d.body)) > 0)))
           AND NOT EXISTS (SELECT 1 FROM consent_events rv WHERE rv.tenant_id = g.tenant_id AND rv.channel = ${ch} AND rv.event_type IN ('revoke','expire','import_revert')
                             AND rv.occurred_at > g.occurred_at AND rv.address_hmac IN (SELECT p.address_hmac FROM contact_points p WHERE p.tenant_id = app.tenant_id()
                               AND p.contact_id IN (SELECT id FROM person) AND p.kind = ${ch === 'sms' ? 'phone' : 'email'})))
      ) AS grant_ok,
      EXISTS (SELECT 1 FROM dnc_checks k WHERE k.tenant_id = app.tenant_id() AND encode(k.phone_hmac, 'hex') = ${a.boundPoints.sms?.hmac ?? ''} AND NOT k.listed
                AND k.registry = 'us_national' AND k.valid_until > now()
                AND k.checked_at >= now() - make_interval(days => COALESCE(((SELECT rules FROM pack)->>'dnc_freshness_days')::int, 31))) AS dnc_ok,
      EXISTS (SELECT 1 FROM consent_state cs JOIN contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac
               WHERE cs.tenant_id = app.tenant_id() AND cs.channel = ${ch} AND cs.status = 'revoked' AND p.contact_id IN (SELECT id FROM person)
                 AND p.kind = ${ch === 'sms' ? 'phone' : 'email'}) AS revoked,
      (SELECT t.message_kind FROM ai_isa_turns t WHERE t.tenant_id = app.tenant_id() AND t.message_id = ${m.id}) AS kind`.execute(tx);
  const x = r.rows[0]!;
  const tier: 'reply' | 'initiated' = x.reply_ok && !hasFacts ? 'reply' : 'initiated';
  const missing: ('evidence' | 'reply_window' | 'dnc')[] = [];
  if (x.revoked) missing.push('evidence');
  if (x.kind === 'reply' && tier === 'initiated' && !hasFacts) missing.push('reply_window');
  else if (tier === 'initiated') {
    if (!x.grant_ok) missing.push('evidence');
    if (ch === 'sms' && !x.dnc_ok) missing.push('dnc');
  }
  return { tier, missing };
}

async function countFacts(tx: Tx, contactId: string, exceptId: string): Promise<AiIsaGateFacts['counts']> {
  const r = await sql<{ ai: number; auto: number; i24: number; i7: number; last: Date | null }>`
    SELECT count(*) FILTER (WHERE m.initiator = 'assistant' AND m.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') AND m.dispatched_at >= now() - interval '24 hours')::int AS ai,
           count(*) FILTER (WHERE (m.initiator IN ('assistant','system') OR m.bulk_action_id IS NOT NULL OR m.marketing_piece_id IS NOT NULL) AND m.dispatched_at >= now() - interval '24 hours')::int AS auto,
           count(*) FILTER (WHERE t.message_kind = 'initiated' AND m.dispatched_at >= now() - interval '24 hours')::int AS i24,
           count(*) FILTER (WHERE t.message_kind = 'initiated')::int AS i7,
           max(m.dispatched_at) FILTER (WHERE m.initiator = 'assistant' AND m.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')) AS last
      FROM messages m LEFT JOIN ai_isa_turns t ON t.tenant_id = m.tenant_id AND t.message_id = m.id
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)) AND m.direction = 'outbound'
       AND m.id <> ${exceptId} AND m.status IN ('dispatching','dispatch_unknown','sent','delivered','failed','undelivered') AND m.dispatched_at >= now() - interval '7 days'`.execute(tx);
  const x = r.rows[0]!;
  return { ai24h: x.ai, automated24h: x.auto, initiated24h: x.i24, initiated7d: x.i7, lastAiOutboundAt: x.last ? instantFromDate(x.last) : null };
}

export { isaReasonClass };
