// The voice policy state machine (R-VOICE-2, R-VOICE-5, R-VOICE-6, R-VOICE-7, R-VOICE-8,
// R-VOICE-10, R-FH-3, R-CONSENT-8; E112–E117, E119, E150).
//
// A pure transition function `step(state, event, facts) → { state, actions }`. Module 48 feeds it
// platform events (played / failed, caller and model turns, tool requests, booking and transfer
// results, vendor errors, latency, silence, hang-up, clock ticks) and carries out its actions
// (speak, ask the model, apply an inbound classification, book, transfer, voicemail, end).
//
//   start        the approved disclosure, then the recording announcement. An AI call always plays
//                both, whatever decideRecording's one-party result (the DB requires
//                recording_announced_at). No caller speech is processed and no tool is allowed until
//                both played. A failed disclosure or a failed or declined announcement ⇒
//                fallback_voicemail, never answered (E116). VERIFY WITH COUNSEL (C2).
//   caller turn  only through callerTurnSignals: an opt-out (classifyInbound on 'voice') is acknowledged
//                and handed to module 48's planInboundEffects; an uncovered language ⇒ voicemail and
//                says so (E119); "are you a person?" ⇒ the truthful line (E113); an area question ⇒
//                AREA_QUESTION_CLIENT_REPLY and its agent note (R-FH-3); price, offers, contracts,
//                commission, legal and lending ⇒ the decline line and a message (E114). Anything else
//                goes to the model.
//   model turn   spoken only if voiceTurnGuard passes; otherwise VOICE_LINES.replacement.
//   tools        decideToolCall; a deny changes nothing but the ledger.
//   transfer     pending until the hold ends; no answer or declined ⇒ back to the caller, a booking or
//                a message, a critical handback and a promise task (E115).
//   failures     a vendor error, or a turn slower than max_turn_latency_ms ⇒ fallback_voicemail (E117).
//   bounds       maxCallSeconds; silence ⇒ bounded re-prompts, then voicemail; hang-up ⇒ the session
//                ends with no booking unless the booking result had already arrived.
//   end          exactly one terminal outcome from the voice_outcome set and exactly one handback,
//                critical for every caller not transferred live. Events after the end change nothing
//                (a late tool request is only logged as denied).
// Enablement is read at session start (the facts carry the approved content, not the switch), so a
// session in progress when voice is turned off or its playbook revoked finishes with its handback
// (E150). Core never sends, dials or books: those are module 48's, through dispatchOutbound and the
// booking transaction (R-GATE-14, E151).
import { taskDueFromClaim, claimUsable } from '../assistant/index.js';
import type { InboundClassification } from '../compliance/index.js';
import { type Instant, type UserId, plusSeconds } from '../foundation/index.js';
import { voiceTurnGuard } from './guard.js';
import { SCOPE_TOPIC, callerTurnSignals } from './lexicon.js';
import { VOICE_LINES, type VoiceLineId } from './lines.js';
import { confirmationChannel, phoneCallbackAllowed } from './optouts.js';
import type { HeardOptOut, LedgerEntry, NeedsReviewItem, VoiceState } from './state.js';
import { decideToolCall, requestedSlot, sameSlot } from './tools.js';
import { transferTarget } from './transfer.js';
import type { AppointmentKind, LedgerRow, MessageTopic, OfferedSlot, ToolRequest, TransferOutcome, VerifiedClaim, VoiceEndReason, VoiceFacts, VoiceOutcome } from './types.js';

export const DEFAULT_SILENCE_SECONDS = 8;
export const DEFAULT_MAX_SILENCE_REPROMPTS = 2;
export const DEFAULT_PLAYBACK_TIMEOUT_SECONDS = 60;

export type VoiceEvent =
  | { type: 'disclosure_played'; at: Instant }
  | { type: 'disclosure_failed'; at: Instant }
  | { type: 'announcement_played'; at: Instant }
  | { type: 'announcement_failed'; at: Instant }
  | { type: 'announcement_declined'; at: Instant }
  /** `language`: what the STT reported, or null when it reports none (VERIFY, vendor). */
  | { type: 'caller_turn'; at: Instant; text: string; language: string | null }
  | { type: 'model_turn'; at: Instant; text: string; latencyMs?: number }
  | { type: 'tool_request'; at: Instant; request: ToolRequest }
  | { type: 'booking_result'; at: Instant; ok: boolean }
  | { type: 'transfer_result'; at: Instant; outcome: TransferOutcome }
  | { type: 'claims'; at: Instant; claims: readonly VerifiedClaim[] }
  | { type: 'vendor_error'; at: Instant }
  | { type: 'turn_latency'; at: Instant; ms: number }
  | { type: 'silence'; at: Instant }
  | { type: 'hangup'; at: Instant }
  | { type: 'tick'; at: Instant }
  /** E150: voice turned off or the playbook revoked while this session runs. Changes nothing. */
  | { type: 'enablement_changed'; at: Instant };

export type SayAction = { kind: 'say'; source: 'disclosure' | 'announcement' | 'script' | 'model'; line: VoiceLineId | null; text: string };

export interface PromiseTask {
  /** tasks.kind */
  kind: 'promise';
  /** The usable claim the due time comes from (R-AST-5), or null. */
  claimId: string | null;
  dueAt: Instant | null;
  dueAllDay: boolean;
  dueTz: string | null;
  needsReview: boolean;
}

/** Exactly one per session (R-VOICE-7); module 48 stores it with the transcript evidence. */
export interface VoiceHandback {
  callId: VoiceState['callId'];
  outcome: VoiceOutcome;
  endReason: VoiceEndReason;
  /** From transferTarget: the owner, or for an unowned caller whoever the intake offer reaches. */
  to: { kind: 'owner'; userId: UserId } | { kind: 'intake_offer' };
  /** Critical for every caller who was not transferred live (R-VOICE-6). */
  critical: boolean;
  categories: VoiceState['categories'];
  messageTopics: MessageTopic[];
  agentNotes: string[];
  /** Unverified details: never appointment times (R-VOICE-7). */
  needsReview: NeedsReviewItem[];
  optOut: HeardOptOut | null;
  transferOutcome: TransferOutcome | null;
  booked: OfferedSlot | null;
  /** E115: after a failed transfer. */
  promiseTask: PromiseTask | null;
  /** E112: no phone callback may be offered or promised. */
  noPhoneCallback: boolean;
  /** The only channel a confirmation may be sent on (module 48 still gates it at send time). */
  confirmationChannel: 'sms' | 'email' | null;
}

export type VoiceAction =
  | SayAction
  /** Ask the model for its next turn. */
  | { kind: 'await_model' }
  /** Run planInboundEffects for this classification of the caller's own words (channel 'voice'). */
  | { kind: 'apply_inbound'; channel: 'voice'; classification: InboundClassification }
  /** Write this row to voice_tool_calls (append-only). */
  | { kind: 'ledger'; entry: LedgerEntry }
  /** Give the model the owner's free slots (from the facts only). */
  | { kind: 'offer_slots'; slots: OfferedSlot[] }
  | { kind: 'book'; slot: OfferedSlot; appointmentKind: AppointmentKind }
  | { kind: 'start_transfer'; userId: UserId; holdSeconds: number }
  | { kind: 'voicemail' }
  | { kind: 'end'; outcome: VoiceOutcome; handback: VoiceHandback };

export interface StepResult {
  state: VoiceState;
  actions: VoiceAction[];
}

function say(line: VoiceLineId): SayAction {
  return { kind: 'say', source: 'script', line, text: VOICE_LINES[line] };
}

/** Starts a session at the takeover instant: the disclosure is the first thing said. */
export function startSession(facts: VoiceFacts, now: Instant): StepResult {
  const state: VoiceState = {
    callId: facts.callId,
    phase: 'disclosing',
    startedAt: now,
    disclosedAt: null,
    announcedAt: null,
    waiting: { for: 'platform', since: now },
    reprompts: 0,
    optOut: null,
    booking: null,
    failedSlots: [],
    transfer: null,
    messageTaken: false,
    messageTopics: [],
    categories: [],
    agentNotes: [],
    needsReview: [],
    claims: [],
    ledger: [],
    outcome: null,
    endReason: null,
  };
  return { state, actions: [{ kind: 'say', source: 'disclosure', line: null, text: facts.content.disclosure }] };
}

function addUnique<T>(xs: readonly T[], x: T): T[] {
  return xs.includes(x) ? [...xs] : [...xs, x];
}

/** The terminal outcome of a session that ends now (precedence: live transfer, booking, opt-out, message). */
export function outcomeOf(s: VoiceState): VoiceOutcome {
  if (s.transfer?.outcome === 'connected') return 'transferred';
  if (s.booking?.status === 'booked') return 'booked';
  if (s.optOut !== null) return 'opted_out';
  if (s.messageTaken) return 'message_taken';
  return 'caller_ended';
}

function promiseTaskOf(claims: readonly VerifiedClaim[]): PromiseTask {
  const dated = claims.find((c) => (c.kind === 'commitment' || c.kind === 'date_time') && c.structured?.due !== undefined && c.structured.due !== null && claimUsable(c));
  if (dated === undefined) return { kind: 'promise', claimId: null, dueAt: null, dueAllDay: false, dueTz: null, needsReview: false };
  return { kind: 'promise', claimId: dated.id, ...taskDueFromClaim(dated) };
}

function needsReviewOf(s: VoiceState): NeedsReviewItem[] {
  const out: NeedsReviewItem[] = [...s.needsReview];
  if (s.booking?.status === 'pending') out.push({ code: 'UNCONFIRMED_SLOT', slot: s.booking.slot });
  for (const e of s.ledger) {
    if (e.reason === 'OPT_OUT_NOT_HEARD' && !out.some((x) => x.code === 'POSSIBLE_OPT_OUT')) out.push({ code: 'POSSIBLE_OPT_OUT' });
    if (e.reason === 'SLOT_NOT_OFFERED') out.push({ code: 'SLOT_NOT_OFFERED', slot: e.row !== null && e.row.tool === 'book_appointment' ? requestedSlot(e.row.args) : null });
  }
  for (const c of s.claims) if (!claimUsable(c)) out.push({ code: 'CLAIM_NEEDS_REVIEW', claimId: c.id });
  return out;
}

function handbackOf(s: VoiceState, facts: VoiceFacts, at: Instant, outcome: VoiceOutcome, endReason: VoiceEndReason): VoiceHandback {
  const target = transferTarget(facts.contact, at);
  const owner = facts.contact.owner;
  const to: VoiceHandback['to'] = target.kind === 'owner' ? { kind: 'owner', userId: target.userId } : target.handbackTo === 'owner' && owner !== null ? { kind: 'owner', userId: owner.userId } : { kind: 'intake_offer' };
  const transferFailed = s.transfer !== null && s.transfer.outcome !== null && s.transfer.outcome !== 'connected';
  return {
    callId: s.callId,
    outcome,
    endReason,
    to,
    critical: outcome !== 'transferred',
    categories: [...s.categories],
    messageTopics: [...s.messageTopics],
    agentNotes: [...s.agentNotes],
    needsReview: needsReviewOf(s),
    optOut: s.optOut,
    transferOutcome: s.transfer?.outcome ?? null,
    booked: s.booking?.status === 'booked' ? s.booking.slot : null,
    promiseTask: transferFailed ? promiseTaskOf([...facts.claims, ...s.claims]) : null,
    noPhoneCallback: !phoneCallbackAllowed(facts.optOuts, s.optOut),
    confirmationChannel: confirmationChannel(facts.optOuts, s.optOut),
  };
}

function end(s: VoiceState, facts: VoiceFacts, at: Instant, outcome: VoiceOutcome, reason: VoiceEndReason, before: VoiceAction[] = []): StepResult {
  const state: VoiceState = { ...s, phase: 'ended', outcome, endReason: reason, waiting: { for: 'platform', since: at } };
  const actions: VoiceAction[] = [...before];
  if (outcome === 'fallback_voicemail') actions.push({ kind: 'voicemail' });
  actions.push({ kind: 'end', outcome, handback: handbackOf(state, facts, at, outcome, reason) });
  return { state, actions };
}

/** Ends by precedence; a session with nothing to show goes to voicemail instead (silence). */
function endOrVoicemail(s: VoiceState, facts: VoiceFacts, at: Instant, reason: VoiceEndReason, before: VoiceAction[]): StepResult {
  const o = outcomeOf(s);
  return end(s, facts, at, o === 'caller_ended' ? 'fallback_voicemail' : o, reason, before);
}

function heardOptOut(c: InboundClassification): HeardOptOut | null {
  if ((c.kind !== 'stop' && c.kind !== 'opt_out_language') || c.scope === undefined) return null;
  return { kind: c.kind, scope: c.scope, channel: c.scope === 'person' ? 'all' : 'voice', classification: c };
}

function callerTurn(s: VoiceState, facts: VoiceFacts, e: Extract<VoiceEvent, { type: 'caller_turn' }>): StepResult {
  const base: VoiceState = { ...s, reprompts: 0 };
  const sig = callerTurnSignals(e.text, { keywords: facts.keywords, language: e.language, coveredLanguages: facts.coveredLanguages });
  const heard = heardOptOut(sig.optOut);
  const waitCaller = { for: 'caller' as const, since: e.at };
  if (heard !== null) {
    // the strongest opt-out heard in the call is kept (person scope over a keyword)
    const optOut = s.optOut === null || (s.optOut.scope !== 'person' && heard.scope === 'person') ? heard : s.optOut;
    return { state: { ...base, optOut, waiting: waitCaller }, actions: [{ kind: 'apply_inbound', channel: 'voice', classification: sig.optOut }, say('optOutAck')] };
  }
  if (sig.uncoveredLanguage) {
    const st: VoiceState = { ...base, categories: addUnique(base.categories, 'language'), messageTopics: addUnique(base.messageTopics, 'LANGUAGE') };
    return end(st, facts, e.at, 'fallback_voicemail', 'UNCOVERED_LANGUAGE', [say('uncoveredLanguage')]);
  }
  if (sig.humanQuestion) return { state: { ...base, waiting: waitCaller }, actions: [say('truthfulAnswer')] };
  if (sig.area.action === 'handback') {
    const st: VoiceState = {
      ...base,
      waiting: waitCaller,
      messageTaken: true,
      categories: addUnique(base.categories, 'fair_housing'),
      messageTopics: addUnique(base.messageTopics, 'AREA_QUESTION'),
      agentNotes: addUnique(base.agentNotes, sig.area.agentNote),
    };
    return { state: st, actions: [say('areaQuestion')] };
  }
  if (sig.scope.length > 0) {
    let categories = base.categories;
    let messageTopics = base.messageTopics;
    for (const c of sig.scope) {
      categories = addUnique(categories, c);
      messageTopics = addUnique(messageTopics, SCOPE_TOPIC[c]);
    }
    return { state: { ...base, waiting: waitCaller, messageTaken: true, categories, messageTopics }, actions: [say('decline')] };
  }
  return { state: { ...base, waiting: { for: 'model', since: e.at } }, actions: [{ kind: 'await_model' }] };
}

function modelTurn(s: VoiceState, facts: VoiceFacts, e: Extract<VoiceEvent, { type: 'model_turn' }>): StepResult {
  const late = s.waiting.for === 'model' && e.at - s.waiting.since > facts.maxTurnLatencyMs;
  if ((e.latencyMs !== undefined && e.latencyMs > facts.maxTurnLatencyMs) || late) return end(s, facts, e.at, 'fallback_voicemail', 'TURN_LATENCY');
  const g = voiceTurnGuard(e.text, facts.identity, facts.fairHousing);
  const line: SayAction = g.pass ? { kind: 'say', source: 'model', line: null, text: e.text } : say('replacement');
  return { state: { ...s, waiting: { for: 'caller', since: e.at } }, actions: [line] };
}

function toolRequest(s: VoiceState, facts: VoiceFacts, e: Extract<VoiceEvent, { type: 'tool_request' }>): StepResult {
  const req: ToolRequest = { ...e.request, at: e.at };
  const d = decideToolCall(s, req, facts);
  const entry: LedgerEntry = { seq: s.ledger.length + 1, at: e.at, decision: d.decision, reason: d.reason, row: d.ledger };
  const logged: VoiceState = { ...s, ledger: [...s.ledger, entry] };
  const log: VoiceAction = { kind: 'ledger', entry };
  if (d.decision === 'deny') return { state: logged, actions: [log] };
  // allowed ⇒ a closed-set tool with valid arguments ⇒ a projection exists
  const row = d.ledger as LedgerRow;
  const args = row.args;
  const waitModel = { for: 'model' as const, since: e.at };
  switch (row.tool) {
    case 'check_availability': {
      const slots = facts.offeredSlots.filter((x) => !s.failedSlots.some((f) => sameSlot(f, x)));
      return { state: { ...logged, waiting: waitModel }, actions: [log, { kind: 'offer_slots', slots }] };
    }
    case 'book_appointment': {
      const slot = requestedSlot(args);
      const appointmentKind = (args.kind ?? 'consult') as AppointmentKind;
      return { state: { ...logged, booking: { slot, kind: appointmentKind, status: 'pending' }, waiting: { for: 'booking', since: e.at } }, actions: [log, { kind: 'book', slot, appointmentKind }] };
    }
    case 'warm_transfer': {
      // decideToolCall allowed it ⇒ transferTarget names the owner right now
      const t = transferTarget(facts.contact, e.at) as { kind: 'owner'; userId: UserId; holdSeconds: number };
      return {
        state: { ...logged, phase: 'transferring', transfer: { userId: t.userId, holdEndsAt: plusSeconds(e.at, t.holdSeconds), outcome: null }, waiting: { for: 'transfer', since: e.at } },
        actions: [log, say('transferHold'), { kind: 'start_transfer', userId: t.userId, holdSeconds: t.holdSeconds }],
      };
    }
    case 'take_message': {
      const topic = (args.topic ?? 'GENERAL') as MessageTopic;
      return { state: { ...logged, messageTaken: true, messageTopics: addUnique(logged.messageTopics, topic), waiting: waitModel }, actions: [log] };
    }
    case 'record_opt_out':
      return { state: { ...logged, waiting: waitModel }, actions: [log] };
    case 'end_call':
      return end(logged, facts, e.at, outcomeOf(logged), 'MODEL_ENDED_CALL', [log]);
  }
}

function transferEnded(s: VoiceState, facts: VoiceFacts, at: Instant, outcome: TransferOutcome): StepResult {
  const transfer = { ...(s.transfer as NonNullable<VoiceState['transfer']>), outcome };
  const st: VoiceState = { ...s, transfer };
  if (outcome === 'connected') return end(st, facts, at, 'transferred', 'TRANSFER_CONNECTED');
  const line: VoiceLineId = phoneCallbackAllowed(facts.optOuts, s.optOut) ? 'ownerUnavailableCallback' : 'ownerUnavailableNoCallback';
  return { state: { ...st, phase: 'conversing', waiting: { for: 'caller', since: at } }, actions: [say(line)] };
}

function silence(s: VoiceState, facts: VoiceFacts, at: Instant): StepResult {
  if (s.optOut !== null) return end(s, facts, at, outcomeOf(s), 'SILENCE');
  if (s.reprompts < (facts.maxSilenceReprompts ?? DEFAULT_MAX_SILENCE_REPROMPTS)) {
    return { state: { ...s, reprompts: s.reprompts + 1, waiting: { for: 'caller', since: at } }, actions: [say('reprompt')] };
  }
  return endOrVoicemail(s, facts, at, 'SILENCE', [say('silenceGoodbye')]);
}

function tick(s: VoiceState, facts: VoiceFacts, at: Instant): StepResult {
  const playback = (facts.playbackTimeoutSeconds ?? DEFAULT_PLAYBACK_TIMEOUT_SECONDS) * 1000;
  if (s.phase === 'disclosing' || s.phase === 'announcing') {
    return at - s.waiting.since >= playback ? end(s, facts, at, 'fallback_voicemail', 'PLAYBACK_TIMEOUT') : { state: s, actions: [] };
  }
  if (s.phase === 'transferring') {
    return at >= (s.transfer as NonNullable<VoiceState['transfer']>).holdEndsAt ? transferEnded(s, facts, at, 'no_answer') : { state: s, actions: [] };
  }
  if (at - s.startedAt >= facts.content.maxCallSeconds * 1000) return end(s, facts, at, outcomeOf(s), 'MAX_CALL_SECONDS', [say('wrapUp')]);
  const waited = at - s.waiting.since;
  if (s.waiting.for === 'model' && waited > facts.maxTurnLatencyMs) return end(s, facts, at, 'fallback_voicemail', 'TURN_LATENCY');
  if (s.waiting.for === 'booking' && waited >= playback) {
    // the booking result never came: the slot stays unconfirmed (needs review), the caller hears so
    return { state: { ...s, waiting: { for: 'caller', since: at } }, actions: [say('bookingUnconfirmed')] };
  }
  if (s.waiting.for === 'caller' && waited >= (facts.silenceSeconds ?? DEFAULT_SILENCE_SECONDS) * 1000) return silence(s, facts, at);
  return { state: s, actions: [] };
}

/** One transition. Pure and deterministic; events after the end change nothing but a late request's ledger row. */
export function step(s: VoiceState, e: VoiceEvent, facts: VoiceFacts): StepResult {
  const none: StepResult = { state: s, actions: [] };
  if (e.type === 'tool_request') return toolRequest(s, facts, e);
  if (s.phase === 'ended') return none;
  switch (e.type) {
    case 'disclosure_played':
      if (s.phase !== 'disclosing') return none;
      return { state: { ...s, phase: 'announcing', disclosedAt: e.at, waiting: { for: 'platform', since: e.at } }, actions: [{ kind: 'say', source: 'announcement', line: null, text: facts.content.recordingAnnouncement }] };
    case 'disclosure_failed':
      return s.phase === 'disclosing' ? end(s, facts, e.at, 'fallback_voicemail', 'DISCLOSURE_FAILED') : none;
    case 'announcement_played':
      if (s.phase !== 'announcing') return none;
      return { state: { ...s, phase: 'conversing', announcedAt: e.at, waiting: { for: 'model', since: e.at } }, actions: [{ kind: 'await_model' }] };
    case 'announcement_failed':
    case 'announcement_declined':
      return s.phase === 'announcing' ? end(s, facts, e.at, 'fallback_voicemail', e.type === 'announcement_failed' ? 'ANNOUNCEMENT_FAILED' : 'ANNOUNCEMENT_DECLINED') : none;
    case 'caller_turn':
      return s.phase === 'conversing' ? callerTurn(s, facts, e) : none;
    case 'model_turn':
      return s.phase === 'conversing' ? modelTurn(s, facts, e) : none;
    case 'booking_result': {
      if (s.booking?.status !== 'pending') return none;
      if (e.ok) {
        const ch = confirmationChannel(facts.optOuts, s.optOut);
        const line: VoiceLineId = ch === 'sms' ? 'bookedConfirmSms' : ch === 'email' ? 'bookedConfirmEmail' : 'bookedNoConfirmation';
        return { state: { ...s, booking: { ...s.booking, status: 'booked' }, waiting: { for: 'caller', since: e.at } }, actions: [say(line)] };
      }
      return { state: { ...s, booking: null, failedSlots: [...s.failedSlots, s.booking.slot], waiting: { for: 'model', since: e.at } }, actions: [say('bookingFailed'), { kind: 'await_model' }] };
    }
    case 'transfer_result':
      return s.phase === 'transferring' ? transferEnded(s, facts, e.at, e.outcome) : none;
    case 'claims':
      return { state: { ...s, claims: [...e.claims] }, actions: [] };
    case 'vendor_error':
      return end(s, facts, e.at, 'fallback_voicemail', 'VENDOR_ERROR');
    case 'turn_latency':
      return e.ms > facts.maxTurnLatencyMs ? end(s, facts, e.at, 'fallback_voicemail', 'TURN_LATENCY') : none;
    case 'silence':
      return s.phase === 'conversing' ? silence(s, facts, e.at) : none;
    case 'hangup':
      // before both disclosures played nothing was processed, so this is always caller_ended there
      return end(s, facts, e.at, outcomeOf(s), 'CALLER_HUNG_UP');
    case 'tick':
      return tick(s, facts, e.at);
    case 'enablement_changed':
      return none;
  }
}
