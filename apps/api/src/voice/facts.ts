// What module 48 reads for one call (E150: read once, never re-read during the session).
//
//   loadAnswerFacts   at the takeover decision (inbound ring): the call, the team's voice_answering version, the
//                     tenant's voice settings, the active policy's voice switch and recording switch, the
//                     platform:voice pack (listPlatformPacks + its two rules values), the routing hours, ai_enabled
//   loadSessionFacts  in the takeover transaction: core's VoiceFacts (approved content, the contact's owner and
//                     routing hours, the hold, keywords, the fair-housing pack, the caller's opt-out facts)
// Everything runs as the system actor inside the caller's transaction (RLS-scoped to the tenant). Hot-rule storage
// does not exist (O2): deps.hotRuleFor answers null in production, so nobody is transferred live (R-VOICE-24).
import type { IdentityFacts } from '@realty/core/assistant';
import type { ReachabilityInput, ReachPoint, ReachSuppression } from '@realty/core/compliance';
import { type BusinessCalendar, type CallId, type ContactId, type Instant, type PlaybookVersionId, type UserId, instantFromDate } from '@realty/core/foundation';
import type { MemberFacts } from '@realty/core/ownership';
import { type CallFacts, type HotRule, type PlatformVoicePack, type VoiceFacts, type VoicePlaybookFacts, type VoiceSettings, DEFAULT_TRANSFER_HOLD_SECONDS, MAX_TRANSFER_HOLD_SECONDS, MIN_TRANSFER_HOLD_SECONDS, approvedVoiceContent } from '@realty/core/voice';
import { type Tx, loadTenantFacts } from '@realty/db';
import { sql } from 'kysely';
import { identityFacts } from '../assistant/repos/context.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import * as rr from '../comms/repos/reachability.js';
import { listPlatformPacks } from '../integrations/repos/connections.js';
import { fairHousingPack } from '../marketing/repo.js';

/** E119 / O7: the content names no language; English only until a covered-language list exists (product default). */
export const COVERED_LANGUAGES: readonly string[] = ['en'];

export interface AnswerCall {
  id: string;
  contactId: string;
  direction: 'inbound' | 'outbound';
  initiator: CallFacts['initiator'];
  status: string;
  handledBy: string;
  answeredAt: Date | null;
  endedAt: Date | null;
  startedAt: Date;
  providerCallRef: string | null;
  clientAddress: string | null;
  recordingDecision: Record<string, unknown>;
  aiTakeoverAt: Date | null;
  voicePlaybookVersionId: string | null;
  transferOutcome: string | null;
  transferredToUserId: string | null;
  voiceOutcome: string | null;
  handbackActionId: string | null;
}

export async function callRow(tx: Tx, where: { id: string } | { ref: string }, lock = false): Promise<AnswerCall | null> {
  const cond = 'id' in where ? sql`id = ${where.id}::uuid` : sql`provider_call_ref = ${where.ref}`;
  const r = await sql<{
    id: string; contact_id: string; direction: 'inbound' | 'outbound'; initiator: CallFacts['initiator']; status: string; handled_by: string; answered_at: Date | null; ended_at: Date | null;
    started_at: Date; provider_call_ref: string | null; client_address: string | null; recording_decision: Record<string, unknown>; ai_takeover_at: Date | null; voice_playbook_version_id: string | null;
    transfer_outcome: string | null; transferred_to_user_id: string | null; voice_outcome: string | null; handback_action_id: string | null;
  }>`
    SELECT id, contact_id, direction, initiator, status, handled_by, answered_at, ended_at, started_at, provider_call_ref, client_address, recording_decision,
           ai_takeover_at, voice_playbook_version_id, transfer_outcome, transferred_to_user_id, voice_outcome, handback_action_id
      FROM calls WHERE tenant_id = app.tenant_id() AND ${cond} ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id, contactId: x.contact_id, direction: x.direction, initiator: x.initiator, status: x.status, handledBy: x.handled_by, answeredAt: x.answered_at, endedAt: x.ended_at,
    startedAt: x.started_at, providerCallRef: x.provider_call_ref, clientAddress: x.client_address, recordingDecision: x.recording_decision ?? {}, aiTakeoverAt: x.ai_takeover_at,
    voicePlaybookVersionId: x.voice_playbook_version_id, transferOutcome: x.transfer_outcome, transferredToUserId: x.transferred_to_user_id, voiceOutcome: x.voice_outcome, handbackActionId: x.handback_action_id,
  };
}

/** The team's voice_answering playbook version a call would run under: the approved one, else the newest. */
export async function teamVoicePlaybook(tx: Tx): Promise<VoicePlaybookFacts | null> {
  const r = await sql<{ id: string; status: VoicePlaybookFacts['status']; steps: unknown }>`
    SELECT v.id, v.status, v.steps FROM playbook_versions v JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
     WHERE v.tenant_id = app.tenant_id() AND p.kind = 'voice_answering' AND p.scope = 'team' AND p.status = 'active'
     ORDER BY (v.status = 'approved') DESC, p.created_at DESC, v.version_no DESC LIMIT 1`.execute(tx);
  const x = r.rows[0];
  return x ? { versionId: x.id as PlaybookVersionId, kind: 'voice_answering', status: x.status, content: x.steps } : null;
}

export interface VoicePackFacts {
  platform: PlatformVoicePack;
  version: string | null;
  /** rules.max_turn_latency_ms; null when not a positive integer (the takeover is refused, VOICE_NOT_CLEARED) */
  maxTurnLatencyMs: number | null;
  /** rules.voice_transfer_hold_seconds (unseeded, known gap (b)); null when absent or not an integer 5-60 (R-VOICE-23) */
  holdSeconds: number | null;
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
/** R-VOICE-23: the pack's hold counts only as an integer 5-60; anything else falls back to the content's value. */
const holdInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_TRANSFER_HOLD_SECONDS && v <= MAX_TRANSFER_HOLD_SECONDS ? v : null;

export async function voicePack(tx: Tx): Promise<VoicePackFacts> {
  const row = (await listPlatformPacks(tx)).find((p) => p.key === 'platform:voice');
  if (!row) return { platform: { status: 'retired', reviewedByCounselAt: null, vendorReadyAt: null }, version: null, maxTurnLatencyMs: null, holdSeconds: null };
  const rules = (await sql<{ rules: Record<string, unknown> }>`SELECT rules FROM jurisdiction_packs WHERE key = 'platform:voice' AND status = 'published' AND version = ${row.version}`.execute(tx)).rows[0]?.rules ?? {};
  return {
    platform: { status: 'published', reviewedByCounselAt: row.reviewed_by_counsel_at ? instantFromDate(row.reviewed_by_counsel_at) : null, vendorReadyAt: row.vendor_ready_at },
    version: row.version,
    maxTurnLatencyMs: posInt(rules['max_turn_latency_ms']),
    holdSeconds: holdInt(rules['voice_transfer_hold_seconds']),
  };
}

export interface AnswerFacts {
  call: CallFacts;
  settings: VoiceSettings;
  hours: BusinessCalendar;
  aiEnabled: boolean;
  /** the active policy's recording_enabled: an AI call is always announced and recorded (O13) */
  recordingEnabled: boolean;
  pack: VoicePackFacts;
  settingsVersion: number;
}

export async function voiceSettingsRow(tx: Tx): Promise<{ answerAfterSeconds: number; answerWhen: VoiceSettings['answerWhen']; version: number; aiEnabled: boolean; answeringEnabled: boolean; attestation: string | null; recordingEnabled: boolean; activePolicyId: string | null }> {
  const r = await sql<{ voice_answer_after_seconds: number; voice_answer_when: VoiceSettings['answerWhen']; version: number; ai_enabled: boolean; voice_answering_enabled: boolean | null; voice_answering_attestation: string | null; recording_enabled: boolean | null; active_policy_id: string | null }>`
    SELECT s.voice_answer_after_seconds, s.voice_answer_when, s.version, s.ai_enabled, s.active_policy_id,
           cp.voice_answering_enabled, cp.voice_answering_attestation, cp.recording_enabled
      FROM tenant_settings s LEFT JOIN compliance_policy_versions cp ON cp.tenant_id = s.tenant_id AND cp.id = s.active_policy_id
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  if (!x) throw new Error('tenant settings not visible');
  return {
    answerAfterSeconds: x.voice_answer_after_seconds,
    answerWhen: x.voice_answer_when,
    version: x.version,
    aiEnabled: x.ai_enabled,
    answeringEnabled: x.voice_answering_enabled === true,
    attestation: x.voice_answering_attestation,
    recordingEnabled: x.recording_enabled !== false,
    activePolicyId: x.active_policy_id,
  };
}

export async function loadAnswerFacts(tx: Tx, call: AnswerCall): Promise<AnswerFacts> {
  const s = await voiceSettingsRow(tx);
  const pack = await voicePack(tx);
  const tenant = await loadTenantFacts(tx);
  const identity = await identityFacts(tx, { scope: 'team', agentUserId: null });
  return {
    call: { callId: call.id as CallId, direction: call.direction, initiator: call.initiator, playbook: await teamVoicePlaybook(tx), identity },
    settings: { answerAfterSeconds: s.answerAfterSeconds, answerWhen: s.answerWhen, answeringEnabled: s.answeringEnabled, attestation: s.attestation, platform: pack.platform },
    hours: tenant.calendar,
    aiEnabled: s.aiEnabled,
    recordingEnabled: s.recordingEnabled,
    pack,
    settingsVersion: s.version,
  };
}

/** R-VOICE-23: the hold is the pack's voice_transfer_hold_seconds when an integer 5-60, else the approved content's transferHoldSeconds, else 20 s. */
export function holdSecondsFor(pack: Pick<VoicePackFacts, 'holdSeconds'>, contentHold: number | undefined): number {
  return pack.holdSeconds ?? contentHold ?? DEFAULT_TRANSFER_HOLD_SECONDS;
}

async function ownerOf(tx: Tx, contactId: string): Promise<MemberFacts | null> {
  const r = await sql<{ user_id: string; role: MemberFacts['role']; status: MemberFacts['status']; accepting_leads: boolean }>`
    SELECT m.user_id, m.role, m.status, m.accepting_leads FROM contacts c
      JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
  const m = r.rows[0];
  return m ? { userId: m.user_id as UserId, role: m.role, status: m.status, acceptingLeads: m.accepting_leads } : null;
}

/** The owner's alert phone is verified (comms/voice.ts ringable): a transfer can ring them. */
export async function hasVerifiedAlertPhone(tx: Tx, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const r = await sql<{ ok: boolean }>`
    SELECT (alert_phone_e164 IS NOT NULL AND alert_phone_verified_at IS NOT NULL) AS ok FROM memberships
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status = 'active'`.execute(tx);
  return r.rows[0]?.ok === true;
}

/** The caller's opt-out facts as the send-time gate reads them (comms/reachability.ts:280-286; R-PAR-12). */
export async function optOutFactsOf(tx: Tx, contactId: string): Promise<VoiceFacts['optOuts']> {
  const pts = ((await rr.pointsForContacts(tx, [contactId])).get(contactId) ?? []).filter((p): p is typeof p & { kind: 'phone' | 'email' } => p.kind === 'phone' || p.kind === 'email');
  const removedPhoneHmacs = (await rr.removedFanoutPhones(tx, [contactId])).get(contactId) ?? [];
  const dnc = (await rr.personDoNotContactFor(tx, [contactId])).get(contactId) ?? null;
  const own = new Set(pts.map((p) => p.hmac));
  const keys = new Set([...own, ...removedPhoneHmacs]);
  const consent = await rr.consentStateFor(tx, [...keys]);
  const sups = await rr.suppressionsFor(tx, [...own]);
  const reach: ReachabilityInput = {
    points: pts.map((p): ReachPoint => ({ id: p.id, kind: p.kind, addressHmac: p.hmac, status: p.status, lineType: p.lineType })),
    removedPhoneHmacs,
    consent: consent.filter((r) => keys.has(r.addressHmac)),
    suppressions: sups.filter((x) => own.has(x.addressHmac)).map((x): ReachSuppression => ({ id: x.id, addressHmac: x.addressHmac, channel: x.channel, reason: x.reason, liftedAt: x.liftedAt ? instantFromDate(x.liftedAt) : null })),
    personDoNotContact: dnc !== null,
  };
  return { reach, personDoNotContact: dnc !== null };
}

export interface SessionFacts {
  facts: VoiceFacts;
  /** side facts module 48 needs (not core's) */
  ownerHasVerifiedPhone: boolean;
  identity: IdentityFacts;
}

/**
 * Core's VoiceFacts for an AI call, read in the takeover transaction (contact locked). `offeredSlots` is empty here:
 * slots are read after the takeover commits, in their own transaction (slots.ts, never under the contact lock).
 * null: the approved content or the pack's latency limit is missing (the takeover is refused).
 */
export async function loadSessionFacts(tx: Tx, call: AnswerCall, o: { playbook: VoicePlaybookFacts | null; pack: VoicePackFacts; hotRule: HotRule | null; hours: BusinessCalendar }): Promise<SessionFacts | null> {
  const identity = await identityFacts(tx, { scope: 'team', agentUserId: null });
  const content = approvedVoiceContent(o.playbook, identity);
  if (content === null || o.pack.maxTurnLatencyMs === null) return null;
  const owner = await ownerOf(tx, call.contactId);
  const { policy } = await resolvedPolicy(tx);
  const jurisdictions = (await sql<{ j: string[] }>`SELECT operating_jurisdictions AS j FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.j ?? [];
  const facts: VoiceFacts = {
    callId: call.id as CallId,
    content,
    contact: { contactId: call.contactId as ContactId, owner, routingHours: o.hours, holdSeconds: holdSecondsFor(o.pack, content.transferHoldSeconds) },
    claims: [],
    hotRule: o.hotRule,
    offeredSlots: [],
    keywords: policy.keywords,
    optOuts: await optOutFactsOf(tx, call.contactId),
    coveredLanguages: COVERED_LANGUAGES,
    maxTurnLatencyMs: o.pack.maxTurnLatencyMs,
    identity,
    fairHousing: await fairHousingPack(tx, jurisdictions),
  };
  return { facts, ownerHasVerifiedPhone: await hasVerifiedAlertPhone(tx, owner?.userId ?? null), identity };
}

export const instantOf = (d: Date | null): Instant | null => (d ? instantFromDate(d) : null);
