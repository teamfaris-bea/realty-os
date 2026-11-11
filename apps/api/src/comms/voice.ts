// Inbound calls on a real provider (Twilio voice webhook): ring an agent, else voicemail.
//
//   1 the first voice request (CallStatus ringing): ingestInbound stores the call (an "Unknown" contact
//     for a new caller, through intake routing); planInboundCall then decides, ONCE per call (stored on
//     the calls row, so a retried provider fetch gets the same answer):
//       whom to ring  the contact's owner when they have a verified phone, else the team's on-duty
//                     target: the first enabled routing rule that matches a call (one with no source,
//                     type, zip or price criteria), its next candidate by the stored rotation cursor
//                     (read only, never advanced: an inbound call is not a routed offer), among active,
//                     accepting members with a verified phone. Nobody ⇒ straight to voicemail.
//       recording     core.decideRecording(direction inbound) with the person rung; when it announces,
//                     the announcement is the first thing the caller hears (R-CONSENT-16), and the
//                     agent hears it in the whisper too.
//   2 the agent leg's whisper asks for a key press; only a key press accepts (the agent becomes the
//     call's agent_user_id, status in_progress). So the agent's own phone voicemail never takes the call.
//   3 the dial result: accepted ⇒ done. Otherwise the call is missed (status no_answer, handled_by
//     voicemail: the existing missed-call feed item and notification for whoever handles the contact) and
//     the caller hears the voicemail greeting, a fixed recording notice and the beep.
//   4 a voicemail recording callback marks the call 'voicemail' (the feed item says so) and the recording
//     is copied into encrypted storage and transcribed like any recording (comms.recording_copy →
//     comms.transcribe); the thread shows it with play and transcript (audited, R-PERM-8 scope).
// Settings (voice_settings, Owner/Admin): ring timeout (5–60 s, default 20) and the greeting text.
import { decideRecording } from '@realty/core/compliance';
import type { ContactId, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { type Candidate, type RotationCursor, type RuleFacts, matchRule, parseRoutingMatch, selectCandidate } from '@realty/core/ownership';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { RECORDING_ANNOUNCEMENT, applyCallStatus } from './dial.js';
import { resolvedPolicy } from './gateInput.js';
import { recordMissedInboundCall } from './inbound.js';
import { signedRef } from './render.js';
import { asUser } from './runtime.js';
import type { CommsDeps } from './types.js';

export const DEFAULT_RING_TIMEOUT_S = 20;
export const VOICEMAIL_MAX_S = 120;
/** Spoken after every greeting and not editable by the tenant. VERIFY WITH COUNSEL (wording per state). */
export const VOICEMAIL_NOTICE = 'After the tone, your message will be recorded. Press the pound key when you are done.';
export const VOICEMAIL_DONE = 'Thank you. Your message was saved. Goodbye.';

export function defaultVoicemailGreeting(team: string): string {
  return `You have reached ${team}. We can't take your call right now. Please leave your name and number.`;
}

/** The agent's whisper. Says that the call may be recorded when it will be (the agent is a party too). */
export function screenPrompt(team: string, announce: boolean): string {
  return `Call for ${team}.${announce ? ' This call may be recorded.' : ''} Press 1 to answer.`;
}

export const SIGNED_REF_PURPOSE = 'call-inbound';
export const inboundCallRef = (deps: Pick<CommsDeps, 'linkSecret'>, tenantId: string, callId: string) => signedRef(deps.linkSecret, SIGNED_REF_PURPOSE, tenantId, callId);

/** Absolute provider callback URLs for one inbound call (all signed by the provider, carrying our ref). */
export function inboundUrls(deps: Pick<CommsDeps, 'linkSecret' | 'publicBaseUrl'>, tenantId: string, callId: string) {
  const c = inboundCallRef(deps, tenantId, callId);
  const u = (path: string) => new URL(`/api/webhooks/telephony/${path}?c=${c}`, deps.publicBaseUrl).toString();
  return { screen: u('voice/screen'), accept: u('voice/accept'), dialResult: u('voice/dial-result'), voicemailDone: u('voice/voicemail-done'), callRecording: new URL('/api/webhooks/telephony/recording', deps.publicBaseUrl).toString(), voicemailRecording: new URL(`/api/webhooks/telephony/recording?vm=${c}`, deps.publicBaseUrl).toString() };
}

// ---- settings --------------------------------------------------------------------------------------

export interface VoiceSettings {
  ringTimeoutSeconds: number;
  voicemailGreeting: string | null;
  /** what callers hear when no greeting is set */
  defaultGreeting: string;
  version: number;
}

async function teamLabel(tx: Tx): Promise<string> {
  const r = await sql<{ team_name: string | null; brokerage_legal_name: string }>`
    SELECT team_name, brokerage_legal_name FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  return (x?.team_name ?? x?.brokerage_legal_name ?? 'our team').trim() || 'our team';
}

export async function voiceSettingsIn(tx: Tx): Promise<VoiceSettings> {
  const r = await sql<{ ring_timeout_seconds: number; voicemail_greeting: string | null; version: number }>`
    SELECT ring_timeout_seconds, voicemail_greeting, version FROM voice_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  return { ringTimeoutSeconds: x?.ring_timeout_seconds ?? DEFAULT_RING_TIMEOUT_S, voicemailGreeting: x?.voicemail_greeting ?? null, defaultGreeting: defaultVoicemailGreeting(await teamLabel(tx)), version: x?.version ?? 0 };
}

export async function getVoiceSettings(actor: UserActor, deps: CommsDeps): Promise<VoiceSettings> {
  return asUser(deps, actor, (tx) => voiceSettingsIn(tx));
}

/** Owner/Admin. `version` is the version read (0 before the first save); a stale one is 409 VERSION_CONFLICT. */
export async function updateVoiceSettings(actor: UserActor, input: { version: number; ringTimeoutSeconds: number; voicemailGreeting: string | null }, deps: CommsDeps): Promise<VoiceSettings> {
  return asUser(deps, actor, async (tx) => {
    const cur = await voiceSettingsIn(tx);
    if (input.version !== cur.version) throw new AppError('VERSION_CONFLICT');
    const greeting = input.voicemailGreeting === null ? null : input.voicemailGreeting.trim() || null;
    const r = await sql<{ version: number }>`
      INSERT INTO voice_settings (tenant_id, ring_timeout_seconds, voicemail_greeting, version, updated_by_user_id)
      VALUES (app.tenant_id(), ${input.ringTimeoutSeconds}, ${greeting}, 1, ${actor.userId})
      ON CONFLICT (tenant_id) DO UPDATE SET ring_timeout_seconds = EXCLUDED.ring_timeout_seconds, voicemail_greeting = EXCLUDED.voicemail_greeting,
             version = voice_settings.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id
       WHERE voice_settings.version = ${input.version}
      RETURNING version`.execute(tx);
    if (!r.rows[0]) throw new AppError('VERSION_CONFLICT');
    await audit(tx, actor, {
      action: 'settings.changed',
      entity: { type: 'voice_settings', id: actor.tenantId },
      // ring_timeout_seconds is plain ({from, to}); the greeting text is free text ({changed: true})
      changes: redactDiff({ ring_timeout_seconds: cur.ringTimeoutSeconds, voicemail_greeting: cur.voicemailGreeting }, { ring_timeout_seconds: input.ringTimeoutSeconds, voicemail_greeting: greeting }, { entity: 'voice_settings' }),
    });
    return voiceSettingsIn(tx);
  });
}

// ---- whom to ring ----------------------------------------------------------------------------------

interface Ringable {
  userId: string;
  phone: string;
  jurisdiction: string | null;
}

async function ringable(tx: Tx, userId: string | null): Promise<Ringable | null> {
  if (!userId) return null;
  const r = await sql<{ alert_phone_e164: string | null; home_jurisdiction: string | null }>`
    SELECT alert_phone_e164, home_jurisdiction FROM memberships
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status = 'active' AND alert_phone_verified_at IS NOT NULL`.execute(tx);
  const x = r.rows[0];
  return x?.alert_phone_e164 ? { userId, phone: x.alert_phone_e164, jurisdiction: x.home_jurisdiction } : null;
}

/**
 * The team's on-duty target for a call nobody owns: the first enabled routing rule a call matches (no
 * inquiry facts, so only a catch-all rule), and its next candidate by the stored cursor (peek only).
 * Eligibility for ringing: active, routable role, accepting leads, a verified phone (the phone is the
 * "critical channel" here). Capacity and release cooldowns are lead-offer rules and do not apply.
 */
export async function onDutyTarget(tx: Tx, exclude: string | null): Promise<string | null> {
  const rows = await sql<{ id: string; position: number; name: string; enabled: boolean; version: number; strategy: RuleFacts['strategy']; match: unknown; direct_user_id: string | null; target_pond_id: string | null; fallback_pond_id: string | null; offer_window_seconds: number | null; max_offers: number | null }>`
    SELECT id, position, name, enabled, version, strategy, match, direct_user_id, target_pond_id, fallback_pond_id, offer_window_seconds, max_offers
      FROM routing_rules WHERE tenant_id = app.tenant_id() AND enabled AND archived_at IS NULL ORDER BY position, id`.execute(tx);
  const rules: RuleFacts[] = [];
  for (const x of rows.rows) {
    const m = parseRoutingMatch(x.match);
    if (!m.ok) continue; // fail closed, as the router does
    rules.push({ id: x.id as RuleFacts['id'], position: x.position, name: x.name, enabled: x.enabled, version: x.version, strategy: x.strategy, match: m.match, directUserId: x.direct_user_id as RuleFacts['directUserId'], targetPondId: x.target_pond_id as RuleFacts['targetPondId'], fallbackPondId: x.fallback_pond_id as RuleFacts['fallbackPondId'], offerWindowSeconds: x.offer_window_seconds, maxOffers: x.max_offers });
  }
  const rule = matchRule(rules, { leadSourceId: null, inquiryType: null, postalCode: null, priceMinCents: null, priceMaxCents: null });
  if (!rule || rule.strategy === 'pond') return null;
  const members =
    rule.strategy === 'direct'
      ? [{ user_id: rule.directUserId as string, weight: 1 }]
      : (await sql<{ user_id: string; weight: number }>`SELECT user_id, weight FROM routing_rule_members WHERE tenant_id = app.tenant_id() AND rule_id = ${rule.id} ORDER BY user_id`.execute(tx)).rows;
  if (members.length === 0) return null;
  const facts = await sql<{ user_id: string; role: Candidate['role']; status: Candidate['status']; accepting_leads: boolean; phone: boolean }>`
    SELECT user_id, role, status, accepting_leads, (alert_phone_e164 IS NOT NULL AND alert_phone_verified_at IS NOT NULL) AS phone
      FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ANY (${members.map((m) => m.user_id)}::uuid[])`.execute(tx);
  const byId = new Map(facts.rows.map((f) => [f.user_id, f]));
  const candidates: Candidate[] = [];
  for (const m of members) {
    const f = byId.get(m.user_id);
    if (!f || m.user_id === exclude) continue;
    candidates.push({ userId: m.user_id as Candidate['userId'], weight: m.weight, role: f.role, status: f.status, acceptingLeads: f.accepting_leads, hasCriticalChannel: f.phone, inReleaseCooldown: false, uncontactedOwned: 0 });
  }
  let cursor: RotationCursor = {};
  if (rule.strategy === 'round_robin' || rule.strategy === 'weighted') {
    const c = await sql<{ cursor: RotationCursor }>`SELECT cursor FROM routing_rotation_state WHERE tenant_id = app.tenant_id() AND rule_id = ${rule.id}`.execute(tx);
    cursor = c.rows[0]?.cursor ?? {};
  }
  return selectCandidate(rule, candidates, cursor, { capacityCap: Number.MAX_SAFE_INTEGER }).pick;
}

// ---- the call plan ---------------------------------------------------------------------------------

export type InboundCallPlan =
  | { kind: 'ring'; callId: string; callerId: string; agentPhone: string; timeoutS: number; announcement: string | null; record: boolean; screenPrompt: string }
  | { kind: 'voicemail'; callId: string; greeting: string }
  | { kind: 'hangup' };

interface InboundCallRow {
  id: string;
  contact_id: string;
  status: string;
  handled_by: string;
  agent_user_id: string | null;
  ring_user_id: string | null;
  answered_at: Date | null;
  recording_decision: Record<string, unknown>;
  provider_call_ref: string | null;
  e164: string | null;
}

async function inboundCall(tx: Tx, where: { ref: string } | { id: string }, lock: boolean): Promise<InboundCallRow | null> {
  const cond = 'ref' in where ? sql`c.provider_call_ref = ${where.ref}` : sql`c.id = ${where.id}`;
  const r = await sql<InboundCallRow>`
    SELECT c.id, c.contact_id, c.status, c.handled_by, c.agent_user_id, c.ring_user_id, c.answered_at, c.recording_decision, c.provider_call_ref, n.e164
      FROM calls c LEFT JOIN phone_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.phone_number_id
     WHERE c.tenant_id = app.tenant_id() AND c.direction = 'inbound' AND ${cond} ${lock ? sql`FOR UPDATE OF c` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

async function lockedCall(tx: Tx, where: { ref: string } | { id: string }): Promise<InboundCallRow | null> {
  const first = await inboundCall(tx, where, false);
  if (!first) return null;
  await lockContact(tx, first.contact_id as ContactId); // global lock order: contact, then its rows
  return inboundCall(tx, { id: first.id }, true);
}

async function greetingOf(tx: Tx): Promise<string> {
  const s = await voiceSettingsIn(tx);
  return s.voicemailGreeting ?? s.defaultGreeting;
}

/**
 * What to do with an inbound call the provider is asking about (idempotent: the decision is stored on
 * the first request and replayed after). A call that already went to voicemail replays the voicemail.
 */
export async function planInboundCall(actor: SystemActor, providerCallRef: string, deps: CommsDeps): Promise<InboundCallPlan> {
  return withTenantTx(actor, async (tx, now) => {
    const c = await lockedCall(tx, { ref: providerCallRef });
    if (!c || !c.e164) return { kind: 'hangup' } as const;
    if (c.handled_by === 'voicemail' && c.status === 'no_answer') return { kind: 'voicemail', callId: c.id, greeting: await greetingOf(tx) } as const;
    if (c.status !== 'ringing') return { kind: 'hangup' } as const;
    let ringUserId = c.ring_user_id;
    let decision = c.recording_decision as { mode?: string; announce?: boolean; planned?: boolean };
    if (decision.planned !== true) {
      const owner = await ringable(tx, c.agent_user_id);
      const target = owner ?? (await ringable(tx, await onDutyTarget(tx, c.agent_user_id)));
      ringUserId = target?.userId ?? null;
      let rec: { mode: string; announce: boolean; basis: string } = { mode: 'off', announce: false, basis: 'INBOUND_NO_AGENT' };
      if (target) {
        const { policy, packs } = await resolvedPolicy(tx);
        const juris = await sql<{ jurisdiction: string | null }>`
          SELECT jurisdiction FROM contact_addresses WHERE tenant_id = app.tenant_id() AND contact_id = ${c.contact_id}`.execute(tx);
        rec = decideRecording({
          ...(target.jurisdiction ? { agentJurisdiction: target.jurisdiction } : {}),
          clientJurisdictions: juris.rows.map((j) => j.jurisdiction).filter((j): j is string => !!j),
          packs,
          mode: policy.recordingMode,
          direction: 'inbound',
          enabled: policy.recordingEnabled,
        });
      }
      decision = { ...rec, planned: true };
      // the announcement TwiML is handed to the provider in this response and plays before the dial
      await sql`
        UPDATE calls SET ring_user_id = ${ringUserId}, recording_mode = ${rec.mode}, recording_decision = ${JSON.stringify(decision)}::jsonb,
               recording_announced_at = CASE WHEN ${rec.announce} THEN ${new Date(now).toISOString()}::timestamptz ELSE recording_announced_at END
         WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    }
    const target = await ringable(tx, ringUserId);
    if (!target) return { kind: 'voicemail', callId: c.id, greeting: await greetingOf(tx) } as const;
    const settings = await voiceSettingsIn(tx);
    const announce = decision.announce === true && decision.mode !== 'off';
    return {
      kind: 'ring',
      callId: c.id,
      callerId: c.e164,
      agentPhone: target.phone,
      timeoutS: settings.ringTimeoutSeconds,
      announcement: announce ? RECORDING_ANNOUNCEMENT : null,
      record: decision.mode !== undefined && decision.mode !== 'off',
      screenPrompt: screenPrompt(await teamLabel(tx), announce),
    } as const;
  }, { db: deps.db, retries: 2 });
}

/** The whisper of the agent leg (what the agent hears before pressing 1), or null when the call is gone. */
export async function screenFor(actor: SystemActor, callId: string, deps: CommsDeps): Promise<string | null> {
  return withTenantTx(actor, async (tx) => {
    const c = await inboundCall(tx, { id: callId }, false);
    if (!c || c.status !== 'ringing' || !c.ring_user_id) return null;
    const d = c.recording_decision as { mode?: string; announce?: boolean };
    return screenPrompt(await teamLabel(tx), d.announce === true && d.mode !== 'off');
  }, { db: deps.db });
}

/**
 * The agent pressed 1: they are now on the call (agent_user_id), status in_progress. Idempotent: a retried
 * accept of an already accepted call is true again. False when it is too late (the call is no longer ringing).
 */
export async function acceptInboundCall(actor: SystemActor, callId: string, now: Instant, deps: CommsDeps): Promise<boolean> {
  const ref = await withTenantTx(actor, async (tx) => {
    const c = await lockedCall(tx, { id: callId });
    if (!c || !c.ring_user_id || !c.provider_call_ref) return null;
    if (c.status === 'in_progress' && c.agent_user_id === c.ring_user_id) return { ref: c.provider_call_ref, already: true };
    if (c.status !== 'ringing') return null;
    await sql`UPDATE calls SET agent_user_id = ring_user_id WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    return { ref: c.provider_call_ref, already: false };
  }, { db: deps.db, retries: 2 });
  if (!ref) return false;
  if (!ref.already) await applyCallStatus(actor, { providerCallRef: ref.ref, status: 'in_progress', occurredAt: now }, deps);
  return true;
}

/**
 * The Dial ended. Accepted ⇒ nothing more to do. Otherwise the call is missed: no_answer + handled_by
 * voicemail, the missed-call feed item and notification, and the voicemail greeting for the caller.
 */
export async function inboundDialResult(actor: SystemActor, callId: string, deps: CommsDeps): Promise<InboundCallPlan> {
  const r = await withTenantTx(actor, async (tx, now) => {
    const c = await lockedCall(tx, { id: callId });
    if (!c) return { kind: 'hangup' } as const;
    if (c.answered_at || (c.status !== 'ringing' && !(c.status === 'no_answer' && c.handled_by === 'voicemail'))) return { kind: 'hangup' } as const;
    await sql`
      UPDATE calls SET status = 'no_answer', handled_by = 'voicemail',
             recording_decision = recording_decision || ${JSON.stringify({ voicemailNoticeAt: new Date(now).toISOString() })}::jsonb
       WHERE tenant_id = app.tenant_id() AND id = ${c.id} AND status IN ('ringing', 'no_answer')`.execute(tx);
    return { kind: 'voicemail', callId: c.id, greeting: await greetingOf(tx) } as const;
  }, { db: deps.db, retries: 2 });
  if (r.kind === 'voicemail') await recordMissedInboundCall(actor, callId, deps);
  return r;
}

/** Sends a call nobody can be rung for straight to voicemail (same effects as an unanswered dial). */
export const sendToVoicemail = inboundDialResult;

/** A voicemail recording arrived: the call becomes 'voicemail' (the feed item says "Left a voicemail"). */
export async function voicemailLeft(actor: SystemActor, callId: string, deps: CommsDeps): Promise<boolean> {
  const changed = await withTenantTx(actor, async (tx) => {
    const c = await lockedCall(tx, { id: callId });
    if (!c || c.handled_by !== 'voicemail') return false;
    const u = await sql`UPDATE calls SET status = 'voicemail' WHERE tenant_id = app.tenant_id() AND id = ${c.id} AND status = 'no_answer'`.execute(tx);
    return Number(u.numAffectedRows ?? 0) > 0;
  }, { db: deps.db, retries: 2 });
  if (changed) await recordMissedInboundCall(actor, callId, deps);
  return changed;
}

/** The provider's final status of an inbound call: ended_at and duration, whatever the stored status. */
export async function finishInboundCall(actor: SystemActor, providerCallRef: string, durationS: number | null, at: Instant, deps: CommsDeps): Promise<string | null> {
  return withTenantTx(actor, async (tx) => {
    const c = await lockedCall(tx, { ref: providerCallRef });
    if (!c) return null;
    // a call that ended while still ringing (the caller hung up) was never answered: missed
    await sql`
      UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'no_answer' ELSE status END,
             ended_at = COALESCE(ended_at, ${new Date(at).toISOString()}::timestamptz),
             duration_s = COALESCE(${durationS}::int, duration_s)
       WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    return c.id;
  }, { db: deps.db, retries: 2 });
}
