// The takeover of a missed inbound call by the assistant (module 48 item 4; R-VOICE-1, R-VOICE-3, R-VOICE-9, R-VOICE-12,
// R-GATE-9; E420, E421, E423, E425, E436).
//
//   planTakeover  right after Phase 1's planInboundCall, once per call: core's shouldAnswer on the DB clock plus the
//                 platform checks core cannot see (R-VOICE-12: ai_enabled, a configured vendor, no fake agent on real
//                 telephony, the kill switch, recording on). The decision {at, code} is stored on the call
//                 (recording_decision.voiceTakeover, and ai_takeover_at for a yes) and a retried fetch replays it.
//                 A ring plan with a takeover rings for voice_answer_after_seconds; a voicemail plan (nobody to
//                 ring) is taken over at once (E421, O3).
//   takeOver      the Dial ended unanswered (or nobody could be rung): contact lock, then ONE update makes the call
//                 the assistant's; app.calls_voice_guard decides (VOICE_PLAYBOOK_NOT_APPROVED, VOICE_ANSWERING_OFF,
//                 VOICE_NOT_CLEARED) and a refusal is Phase 1's voicemail (E420). The session facts are read in the
//                 same transaction (E150), the slots after it commits, then the vendor connects; a connect failure
//                 starts and ends the session with vendor_error, to voicemail (E425).
// Every branch is idempotent on a re-run (batch 9's webhook re-arm): an AI call's retried fetch replays reconnect
// (E423), never Phase 1's hang-up for a non-ringing call or its voicemail switch.
import { type Instant, type SystemActor, toIso } from '@realty/core/foundation';
import { type VoiceFacts, VOICE_LINE_IDS, approvedVoiceContent, enabledLedgerTools, platformVoiceCleared, shouldAnswer, voiceAnsweringOn } from '@realty/core/voice';
import { type IanaZone, isBusinessOpen } from '@realty/core/foundation';
import { type ContactId, instantFromDate } from '@realty/core/foundation';
import { lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { sayAndHangupTwiml } from '../providers/twilio/voiceTwiml.js';
import { voicemailFor } from './effects.js';
import { type AnswerFacts, callRow, loadAnswerFacts, loadSessionFacts } from './facts.js';
import { type NextResult, type VoiceSessionContext, type VoiceTransport } from './provider.js';
import type { VoiceDeps } from './runtime.js';
import { runSession } from './session.js';
import { offeredSlots } from './slots.js';
import { claimTransferOutcome } from './transfer.js';

/** Why the assistant did not answer (stored in recording_decision.voiceTakeover.code). Codes only. */
export const TAKEOVER_REFUSALS = {
  AI_DISABLED: 'the assistant is turned off for this team.',
  VOICE_VENDOR_NOT_CONFIGURED: 'no voice vendor is set up on this platform yet.',
  VOICE_FAKE_ON_REAL_TELEPHONY: 'the test voice agent never answers calls on real phone numbers.',
  TELEPHONY_LIVE_OFF: 'live phone requests are switched off on this platform.',
  VOICE_RECORDING_OFF: 'call recording is off in the team policy, and an AI call is always announced and recorded.',
  VOICE_PLAYBOOK_NOT_APPROVED: 'the AI answering playbook is not approved.',
  VOICE_ANSWERING_OFF: 'the Owner has not turned AI answering on.',
  VOICE_NOT_CLEARED: 'AI answering is waiting for counsel review and the voice vendor check.',
  VOICE_AFTER_HOURS_ONLY: 'AI answering is set to after hours only, and this call came in during routing hours.',
  VOICE_SETTINGS_INVALID: 'the AI answering settings are not valid.',
  CALL_NOT_RINGING: 'the call was no longer ringing.',
} as const;
export type TakeoverRefusal = keyof typeof TAKEOVER_REFUSALS;
export const refusalSentence = (code: string | null): string =>
  `The assistant did not answer: ${(TAKEOVER_REFUSALS as Record<string, string>)[code ?? ''] ?? 'this call was not set up for AI answering.'}`;

export interface TakeoverDecision {
  at: string | null;
  code: TakeoverRefusal | null;
  answerAfterSeconds: number;
}

const DB_CODES = ['VOICE_PLAYBOOK_NOT_APPROVED', 'VOICE_ANSWERING_OFF', 'VOICE_NOT_CLEARED'] as const;

/** R-VOICE-12: the checks core cannot see, in order; then core's own predicates name its refusal. */
export function refusalOf(f: AnswerFacts, deps: Pick<VoiceDeps, 'voiceAgent' | 'telephonyProvider' | 'telephonyLiveRequests'>, now: Instant): TakeoverRefusal | null {
  if (!f.aiEnabled) return 'AI_DISABLED';
  if (!deps.voiceAgent.configured) return 'VOICE_VENDOR_NOT_CONFIGURED';
  if (deps.voiceAgent.kind === 'fake' && deps.telephonyProvider === 'twilio') return 'VOICE_FAKE_ON_REAL_TELEPHONY';
  if (deps.telephonyProvider === 'twilio' && !deps.telephonyLiveRequests) return 'TELEPHONY_LIVE_OFF';
  if (!f.recordingEnabled) return 'VOICE_RECORDING_OFF';
  if (shouldAnswer(f.call, f.settings, f.hours, now) === null) {
    if (approvedVoiceContent(f.call.playbook, f.call.identity) === null) return 'VOICE_PLAYBOOK_NOT_APPROVED';
    if (!voiceAnsweringOn(f.settings)) return 'VOICE_ANSWERING_OFF';
    if (!platformVoiceCleared(f.settings.platform)) return 'VOICE_NOT_CLEARED';
    if (f.settings.answerWhen === 'after_hours_only' && isBusinessOpen(now, f.hours)) return 'VOICE_AFTER_HOURS_ONLY';
    return 'VOICE_SETTINGS_INVALID';
  }
  if (f.pack.maxTurnLatencyMs === null) return 'VOICE_NOT_CLEARED';
  return null;
}

function storedDecision(d: Record<string, unknown>): TakeoverDecision | null {
  const v = d['voiceTakeover'];
  if (typeof v !== 'object' || v === null) return null;
  const x = v as Record<string, unknown>;
  return { at: typeof x['at'] === 'string' ? x['at'] : null, code: typeof x['code'] === 'string' ? (x['code'] as TakeoverRefusal) : null, answerAfterSeconds: typeof x['answerAfterSeconds'] === 'number' ? x['answerAfterSeconds'] : 20 };
}

/** Decides once whether the assistant takes this call over (and when). null: not a call this applies to. */
export async function planTakeover(actor: SystemActor, deps: VoiceDeps, callSid: string, immediate: boolean): Promise<TakeoverDecision | null> {
  return withTenantTx(actor, async (tx, now) => {
    const first = await callRow(tx, { ref: callSid });
    if (!first || first.direction !== 'inbound') return null;
    await lockContact(tx, first.contactId as ContactId);
    const c = (await callRow(tx, { id: first.id }, true))!;
    const prior = storedDecision(c.recordingDecision);
    if (prior) return prior;
    if (c.handledBy !== 'human' || c.status !== 'ringing' || c.answeredAt) return null;
    const f = await loadAnswerFacts(tx, c);
    const code = refusalOf(f, deps, now);
    const takeoverAt = code === null ? (immediate ? now : (shouldAnswer(f.call, f.settings, f.hours, now)!.takeoverAt as Instant)) : null;
    const d: TakeoverDecision = { at: takeoverAt === null ? null : toIso(takeoverAt), code, answerAfterSeconds: f.settings.answerAfterSeconds };
    await sql`
      UPDATE calls SET recording_decision = recording_decision || ${JSON.stringify({ voiceTakeover: d })}::jsonb,
             ai_takeover_at = COALESCE(${d.at}::timestamptz, ai_takeover_at)
       WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    return d;
  }, { db: deps.db, retries: 2 });
}

/** A transport that is already closed: the session starts and ends at once with vendor_error (E425). */
class ClosedTransport implements VoiceTransport {
  handedOff: string | null = null;
  async next(): Promise<NextResult> {
    return null;
  }
  async say(): Promise<void> {}
  async awaitModel(): Promise<void> {}
  async toolResult(): Promise<void> {}
  async handOff(twiml: string): Promise<void> {
    this.handedOff = twiml;
  }
  async close(): Promise<void> {}
}

export type TakeOver = { kind: 'answered'; response: string } | { kind: 'already' } | { kind: 'refused'; code: string };

export function sessionContext(facts: VoiceFacts): VoiceSessionContext {
  return {
    disclosure: facts.content.disclosure,
    recordingAnnouncement: facts.content.recordingAnnouncement,
    enabledTools: [...enabledLedgerTools(facts.content)],
    maxCallSeconds: facts.content.maxCallSeconds,
    coveredLanguages: facts.coveredLanguages,
    maxTurnLatencyMs: facts.maxTurnLatencyMs,
    lineIds: VOICE_LINE_IDS,
  };
}

/** Makes the call the assistant's (or refuses, E420), then connects the vendor and starts the session. */
export async function takeOver(actor: SystemActor, deps: VoiceDeps, callId: string): Promise<TakeOver> {
  const r = await withTenantTx(actor, async (tx) => {
    const first = await callRow(tx, { id: callId });
    if (!first) return { kind: 'refused', code: 'CALL_NOT_RINGING' } as const;
    await lockContact(tx, first.contactId as ContactId);
    const c = (await callRow(tx, { id: callId }, true))!;
    if (c.handledBy === 'assistant') return { kind: 'already' } as const;
    const dec = storedDecision(c.recordingDecision);
    if (!dec?.at) return { kind: 'refused', code: dec?.code ?? 'VOICE_ANSWERING_OFF' } as const;
    const refuse = async (code: string) => {
      await sql`UPDATE calls SET recording_decision = recording_decision || ${JSON.stringify({ voiceTakeover: { ...dec, at: null, code } })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
      return { kind: 'refused', code } as const;
    };
    if (c.handledBy !== 'human' || c.status !== 'ringing' || c.answeredAt) return refuse('CALL_NOT_RINGING');
    const f = await loadAnswerFacts(tx, c);
    if (!f.call.playbook) return refuse('VOICE_PLAYBOOK_NOT_APPROVED');
    await sql`SAVEPOINT voice_takeover`.execute(tx);
    try {
      const u = await sql`
        UPDATE calls SET handled_by = 'assistant', voice_playbook_version_id = ${f.call.playbook.versionId}, recording_mode = 'announced_all_parties',
               recording_decision = recording_decision || ${JSON.stringify({ mode: 'announced_all_parties', announce: true, basis: 'AI_CALL_ANNOUNCES' })}::jsonb,
               recording_announced_at = NULL
         WHERE tenant_id = app.tenant_id() AND id = ${c.id} AND handled_by = 'human' AND status = 'ringing' AND answered_at IS NULL`.execute(tx);
      if (Number(u.numAffectedRows ?? 0) === 0) {
        await sql`ROLLBACK TO SAVEPOINT voice_takeover`.execute(tx);
        return refuse('CALL_NOT_RINGING');
      }
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      const code = DB_CODES.find((x) => msg.startsWith(x));
      if (!code) throw e;
      await sql`ROLLBACK TO SAVEPOINT voice_takeover`.execute(tx);
      return refuse(code);
    }
    const sf = await loadSessionFacts(tx, c, { playbook: f.call.playbook, pack: f.pack, hotRule: deps.hotRuleFor(actor.tenantId), hours: f.hours });
    if (!sf) {
      await sql`ROLLBACK TO SAVEPOINT voice_takeover`.execute(tx);
      return refuse('VOICE_NOT_CLEARED');
    }
    const zone = (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!.z as IanaZone;
    return { kind: 'ok', call: c, sf, hours: f.hours, zone, versionId: f.call.playbook.versionId as string } as const;
  }, { db: deps.db, retries: 2 });
  if (r.kind !== 'ok') return r;
  const facts: VoiceFacts = {
    ...r.sf.facts,
    offeredSlots: await offeredSlots({ db: deps.db, calendar: deps.calendar, tenantId: actor.tenantId, ownerUserId: r.sf.facts.contact.owner?.userId ?? null, hours: r.hours, now: deps.clock.now() }).catch(() => []),
  };
  const base = { actor, callId, contactId: r.call.contactId, callerAddress: r.call.clientAddress ?? '', zone: r.zone, facts, providerKind: deps.voiceAgent.kind, playbookVersionId: r.versionId };
  let connected: { response: string; transport: VoiceTransport } | null = null;
  try {
    connected = await deps.voiceAgent.connect({ callRef: r.call.providerCallRef ?? callId, sessionId: callId, tenantId: actor.tenantId, context: sessionContext(facts) });
  } catch {
    connected = null;
  }
  if (connected === null) {
    // E425: the vendor did not connect: the session starts and ends with vendor_error (to voicemail, never answered)
    const closed = new ClosedTransport();
    await runSession(deps, { ...base, transport: closed });
    return { kind: 'answered', response: closed.handedOff ?? (await voicemailFor(actor, deps, callId)) };
  }
  const transport = connected.transport;
  const done = runSession(deps, { ...base, transport }).then(
    () => undefined,
    () => undefined, // a lost session is recovered by voice.reconcile (R-VOICE-7)
  );
  deps.registry.add({ tenantId: actor.tenantId, callId, done });
  return { kind: 'answered', response: connected.response };
}

/** An AI call's provider fetch: replay the stream; an unknown session gets voicemail (voice.reconcile recovers it). */
export async function reconnectTwiml(actor: SystemActor, deps: VoiceDeps, callId: string): Promise<string> {
  try {
    return (await deps.voiceAgent.reconnect({ sessionId: callId, tenantId: actor.tenantId })).response;
  } catch {
    return voicemailFor(actor, deps, callId);
  }
}

/** The AI call this provider ref names, or null (not an AI call). */
export async function aiCallByRef(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callSid: string): Promise<{ id: string; status: string } | null> {
  return withTenantTx(actor, async (tx) => {
    const c = await callRow(tx, { ref: callSid });
    return c && c.handledBy === 'assistant' ? { id: c.id, status: c.status } : null;
  }, { db: deps.db });
}

/**
 * /voice/dial-result for a call module 48 handles; null hands it to Phase 1 (inboundDialResult) unchanged.
 *   AI call, transfer open      ⇒ the owner did not take it: claim no_answer, the caller goes back to the assistant
 *   AI call, transfer connected ⇒ the bridged call ended: hang up
 *   AI call otherwise           ⇒ reconnect (a retried takeover dial-result, E423)
 *   ringing call with a takeover decision ⇒ take it over (a refusal is Phase 1's voicemail, E420)
 */
export async function aiDialResult(actor: SystemActor, deps: VoiceDeps, callId: string): Promise<string | null> {
  const c = await withTenantTx(actor, (tx) => callRow(tx, { id: callId }), { db: deps.db });
  if (!c) return null;
  if (c.handledBy === 'assistant') {
    if (c.transferredToUserId && c.transferOutcome === null) {
      const r = await claimTransferOutcome(actor, deps, callId, 'no_answer');
      if (r.stored === 'connected') return sayAndHangupTwiml(null);
      return reconnectTwiml(actor, deps, callId);
    }
    if (c.transferOutcome === 'connected') return sayAndHangupTwiml(null);
    return reconnectTwiml(actor, deps, callId);
  }
  const dec = storedDecision(c.recordingDecision);
  if (c.handledBy !== 'human' || c.status !== 'ringing' || c.answeredAt || !dec?.at) return null;
  const t = await takeOver(actor, deps, callId);
  if (t.kind === 'answered') return t.response;
  if (t.kind === 'already') return reconnectTwiml(actor, deps, callId);
  return null;
}

export { instantFromDate };
