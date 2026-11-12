// The AI ISA policy machine (R-ISA-5, R-ISA-6, R-ISA-12, R-ISA-13 core part, R-ISA-15 core part; E492, E500–E502,
// E505, E508, E510, E515, E529, E530; docs/AI_ISA.md §4).
//
// A pure transition `step(state, event, facts) → { state, actions }`, shaped like core/voice. Core never sends,
// books or changes ownership: module 75 (apps/api/src/isa) carries out the actions through dispatchOutbound, the
// booking job and the assignment transactions, where the gate and the DB guard decide again.
//
//   starting ─► awaiting_reply ◄─► engaged ─► scheduling ─► booking ─► ended(appointment_booked)
//   nurture ◄─► awaiting_reply; awaiting_agent{class} (hold topic; nurture continues off the topic)
//   any non-terminal ─► paused{reason} ─► (owner resume, epoch + 1) the previous phase
//   any non-terminal ─► ended{reason}: terminal, and it writes EXACTLY ONE handoff
//
// Invariants (property-tested): at most one handoff per assignment, exactly one once ended; no message is queued
// from a paused or ended state; escalations only accumulate; `book` only after the offer was delivered and a
// verified, unique client own-text match; the order of an inbound batch does not matter.
import type { InboundClassification } from '../compliance/index.js';
import type { FairHousingPack } from '../fairhousing/index.js';
import { type IanaZone, type Instant, DAY_MS, instant } from '../foundation/index.js';
import { CADENCE_MS, ISA_DEFAULT_LIMITS, ISA_TURN_LIMITS, type IsaCadence } from './constants.js';
import type { AiIsaContent } from './content.js';
import type { LineIdentity, IsaLineId } from './lines.js';
import type { Decision } from './output.js';
import { type IntentSignal, intentSignals, readiness, readinessEndReason, type ReadinessRule, READINESS_RULE_VERSION } from './readiness.js';
import { ESCALATION_TABLE, escalationPriority, inboundSignals, STOP_CLASSES, topClass } from './signals.js';
import { matchSlotChoice } from './slots.js';
import { isTeamText } from './ownText.js';
import type { EscalationClass, EscalationPriority, IsaChannel, IsaEndReason, IsaMessageKind, IsaPauseReason, IsaPhase, IsaSide, IsaSlot, UsableQualClaim } from './types.js';

export interface IsaOffer {
  id: string;
  status: 'requested' | 'pending_delivery' | 'offered' | 'accepting';
  appointmentKind: 'buyer_consult' | 'listing_appointment' | 'consult';
  slots: IsaSlot[];
  zones: IanaZone[];
  deliveredAt: Instant | null;
  expiresAt: Instant | null;
  clarifications: number;
  /** The slot the client agreed to (set when accepting). */
  acceptedIndex: number | null;
}

export interface IsaState {
  assignmentId: string;
  side: IsaSide;
  phase: IsaPhase;
  /** The phase a resume or a cleared hold returns to. */
  resumePhase: IsaPhase | null;
  epoch: number;
  startedAt: Instant;
  paused: { reason: IsaPauseReason; byKind: 'user' | 'system'; since: Instant } | null;
  ended: { reason: IsaEndReason; at: Instant; escalation: EscalationClass | null } | null;
  /** Hold topics (awaiting_agent), oldest first. */
  held: { class: EscalationClass; since: Instant }[];
  /** Every class raised, ever (monotone). */
  escalations: EscalationClass[];
  claims: UsableQualClaim[];
  intents: IntentSignal[];
  offer: IsaOffer | null;
  /** Classes raised together with a slot choice: handled with the booking's result (row 10). */
  afterBooking: EscalationClass[];
  appointment: { appointmentId: string; kind: IsaOffer['appointmentKind'] } | null;
  counters: { messagesSent: number; unansweredInitiated: number; undeliveredStreak: number; schemaFailures: number; guardBlocks: number; bookingFailures: number };
  lastInboundSeq: number;
  lastInboundChannel: IsaChannel | null;
  inboundUnanswered: boolean;
  awaitingModel: boolean;
  handoffs: number;
}

export interface IsaInbound {
  seq: number;
  messageId: string;
  channel: IsaChannel;
  at: Instant;
  /** `clientOwnText(...).text`. */
  ownText: string;
  ownTextReliable: boolean;
  classification: InboundClassification;
  reaction: boolean;
}

export type IsaTimer = 'follow_up' | 'offer_expiry' | 'pause_expiry' | 'inactivity_warning';
export type IsaControl = 'pause' | 'resume' | 'take_over' | 'end' | 'undo' | 'finalize';
export type StopSignalReason = 'opted_out' | 'suppressed' | 'do_not_contact' | 'wrong_number' | 'owner_change' | 'merged';

export type IsaEvent =
  | { type: 'start'; at: Instant }
  | { type: 'inbound'; at: Instant; messages: readonly IsaInbound[] }
  | { type: 'timer'; at: Instant; timer: IsaTimer }
  | { type: 'listing_event'; at: Instant; factKind: 'listings' | 'competition'; handles: readonly string[] }
  | { type: 'model_output'; at: Instant; epoch: number; decision: Decision }
  | { type: 'model_failed'; at: Instant; epoch: number; reason: 'schema' | 'provider' }
  | { type: 'send_result'; at: Instant; messageId: string; messageKind: IsaMessageKind; status: 'sent' | 'delivered' | 'failed' | 'undelivered' | 'blocked' | 'canceled' | 'dispatch_unknown'; reasonCodes?: readonly string[] }
  | { type: 'offer_ready'; at: Instant; offerId: string; slots: readonly IsaSlot[]; zones: readonly IanaZone[]; expiresAt: Instant }
  | { type: 'offer_unavailable'; at: Instant }
  | { type: 'booking_result'; at: Instant; ok: true; appointmentId: string }
  | { type: 'booking_result'; at: Instant; ok: false; code: 'SLOT_TAKEN' | 'SLOT_SOURCE_CHANGED' | 'CALENDAR_UNAVAILABLE' | 'MEMBER_NOT_ACTIVE' }
  | { type: 'human_control'; at: Instant; control: IsaControl; byOwner: boolean }
  | { type: 'human_contact'; at: Instant }
  | { type: 'authorization_lost'; at: Instant; effect: 'hold' | 'pause' | 'end'; pauseReason?: IsaPauseReason; endReason?: IsaEndReason }
  | { type: 'stop_signal'; at: Instant; reason: StopSignalReason }
  | { type: 'escalation_resolved'; at: Instant; class: EscalationClass };

export interface IsaFacts {
  who: LineIdentity;
  content: AiIsaContent;
  /** The safety line is sent only when the window is open NOW in every zone (never deferred, row 3). */
  windowOpenNow: boolean;
  /** Every team text of the thread (outbounds and offer renderings), for QUOTE_IS_TEAM_TEXT. */
  teamTexts: readonly string[];
  /** Inbounds from the person in the last 10 minutes, this batch included (flood, §4.2). */
  recentInboundCount: number;
  zone: IanaZone;
  mlsListedElsewhere: boolean;
  subjectConfirmed: boolean;
  fairHousing?: FairHousingPack;
}

/** One message for module 75 to plan and queue (channel and time are the send policy's; purpose is always marketing). */
export interface QueueMessage {
  kind: 'queue_message';
  messageKind: IsaMessageKind;
  purpose: 'marketing';
  /** The preferred channel (the inbound's for a reply); planSend decides. */
  channel: IsaChannel;
  /** Fixed lines in order; `{Agent}` already filled by module 75 with `fillLine`. */
  lines: IsaLineId[];
  /** Model conversation text (never together with facts). */
  text: string | null;
  handles: string[];
  /** The offer's slots to render (offer and clarification) or the booked slot index (confirmation). */
  offerId: string | null;
  slotIndex: number | null;
  /** Initiated (follow-up, facts) versus a reply to this batch; the send policy re-derives it. */
  initiated: boolean;
}

export interface Handoff {
  reason: IsaEndReason;
  escalation: EscalationClass | null;
  priority: EscalationPriority;
  basis: { rule: ReadinessRule; ruleVersion: string; claimIds: string[] } | null;
  appointment: { appointmentId: string; kind: IsaOffer['appointmentKind']; confirmationQueued: boolean } | null;
  openOffer: { offerId: string; slots: IsaSlot[]; deliveredAt: Instant | null; expiresAt: Instant | null } | null;
  /** The fixed lines sent with this handoff (commitments, §4.4). */
  commitments: IsaLineId[];
  inboundUnanswered: boolean;
  claims: string[];
}

export type IsaAction =
  | { kind: 'await_model'; repair: boolean; initiated: boolean }
  | QueueMessage
  | { kind: 'request_offer'; appointmentKind: IsaOffer['appointmentKind'] }
  | { kind: 'book'; offerId: string; slotIndex: number; messageId: string }
  | { kind: 'record_claims'; claims: UsableQualClaim[]; unusable: Decision['unusableClaims'] }
  | { kind: 'propose_saved_search' }
  | { kind: 'escalate'; class: EscalationClass; type: 'terminal' | 'hold_topic' | 'check_this'; priority: EscalationPriority }
  | { kind: 'handoff'; handoff: Handoff }
  | { kind: 'schedule_timer'; timer: IsaTimer; at: Instant }
  | { kind: 'cancel_timers' }
  | { kind: 'cancel_messages' }
  | { kind: 'pause'; reason: IsaPauseReason }
  | { kind: 'resume'; epoch: number }
  | { kind: 'block_person'; reason: IsaEndReason | EscalationClass }
  | { kind: 'end'; reason: IsaEndReason }
  | { kind: 'denied'; codes: string[] };

export interface StepResult {
  state: IsaState;
  actions: IsaAction[];
}

export function initialState(i: { assignmentId: string; side: IsaSide; startedAt: Instant }): IsaState {
  return {
    assignmentId: i.assignmentId,
    side: i.side,
    phase: 'starting',
    resumePhase: null,
    epoch: 1,
    startedAt: i.startedAt,
    paused: null,
    ended: null,
    held: [],
    escalations: [],
    claims: [],
    intents: [],
    offer: null,
    afterBooking: [],
    appointment: null,
    counters: { messagesSent: 0, unansweredInitiated: 0, undeliveredStreak: 0, schemaFailures: 0, guardBlocks: 0, bookingFailures: 0 },
    lastInboundSeq: 0,
    lastInboundChannel: null,
    inboundUnanswered: false,
    awaitingModel: false,
    handoffs: 0,
  };
}

// ---- helpers ------------------------------------------------------------------------------------------------

const BLOCKING_ENDS: ReadonlySet<IsaEndReason> = new Set<IsaEndReason>(['opted_out', 'wrong_number', 'do_not_contact', 'has_agent']);
const STOP_END: Readonly<Record<StopSignalReason, IsaEndReason>> = { opted_out: 'opted_out', suppressed: 'suppressed', do_not_contact: 'do_not_contact', wrong_number: 'wrong_number', owner_change: 'owner_change', merged: 'merged' };
const GUARD_END: Readonly<Record<string, IsaEndReason>> = { CONSENT_REVOKED: 'opted_out', RECIPIENT_OPTED_OUT: 'opted_out', SUPPRESSED: 'suppressed', RECIPIENT_SUPPRESSED: 'suppressed', PERSON_DO_NOT_CONTACT: 'do_not_contact', WRONG_NUMBER: 'wrong_number', ISA_STOPPED: 'opted_out' };

function live(s: IsaState): boolean {
  return s.ended === null && s.paused === null;
}

function addClass(s: IsaState, c: EscalationClass): IsaState {
  return s.escalations.includes(c) ? s : { ...s, escalations: [...s.escalations, c] };
}

function msg(s: IsaState, o: Partial<QueueMessage> & Pick<QueueMessage, 'messageKind'>): QueueMessage {
  return { kind: 'queue_message', purpose: 'marketing', channel: s.lastInboundChannel ?? 'sms', lines: [], text: null, handles: [], offerId: null, slotIndex: null, initiated: !s.inboundUnanswered, ...o };
}

function sla(reason: IsaEndReason, escalation: EscalationClass | null, inboundUnanswered: boolean): EscalationPriority {
  if (escalation !== null) return escalationPriority(escalation, inboundUnanswered);
  if (reason === 'appointment_booked' || reason === 'ready_buyer' || reason === 'ready_seller') return 'critical';
  if (reason === 'dormant') return 'low';
  if (reason === 'opted_out' || reason === 'do_not_contact' || reason === 'wrong_number' || reason === 'suppressed') return 'normal';
  return inboundUnanswered ? 'high' : 'normal';
}

/** Ends care: exactly one handoff, the timers and queued messages cancelled, the person block when the end sets one. */
function end(
  s: IsaState,
  at: Instant,
  reason: IsaEndReason,
  o: { escalation?: EscalationClass | null; lines?: IsaLineId[]; basis?: Handoff['basis']; before?: IsaAction[]; confirmation?: QueueMessage | null } = {},
): StepResult {
  if (s.ended !== null) return { state: s, actions: o.before ?? [] };
  const escalation = o.escalation ?? null;
  const st: IsaState = { ...(escalation !== null ? addClass(s, escalation) : s), phase: 'ended', ended: { reason, at, escalation }, paused: null, awaitingModel: false, handoffs: s.handoffs + 1 };
  const lines = o.lines ?? [];
  const actions: IsaAction[] = [...(o.before ?? []), { kind: 'cancel_timers' }, { kind: 'cancel_messages' }];
  const handoff: Handoff = {
    reason,
    escalation,
    priority: sla(reason, escalation, s.inboundUnanswered),
    basis: o.basis ?? null,
    appointment: s.appointment === null ? null : { ...s.appointment, confirmationQueued: o.confirmation !== undefined && o.confirmation !== null },
    openOffer: s.offer === null || s.offer.status === 'requested' ? null : { offerId: s.offer.id, slots: s.offer.slots, deliveredAt: s.offer.deliveredAt, expiresAt: s.offer.expiresAt },
    commitments: [...lines, ...(o.confirmation?.lines ?? [])],
    inboundUnanswered: s.inboundUnanswered,
    claims: s.claims.map((c) => c.claimId),
  };
  actions.push({ kind: 'handoff', handoff });
  // the line the handoff commits to goes in the same transaction as the handoff (the post-handoff closed set)
  if (o.confirmation) actions.push(o.confirmation);
  else if (lines.length > 0) actions.push(msg(s, { messageKind: 'holding_line', lines, initiated: false }));
  const blocks = BLOCKING_ENDS.has(reason) || (escalation !== null && ESCALATION_TABLE[escalation].block);
  if (blocks) actions.push({ kind: 'block_person', reason: escalation ?? reason });
  actions.push({ kind: 'end', reason });
  return { state: st, actions };
}

function pause(s: IsaState, at: Instant, reason: IsaPauseReason, byKind: 'user' | 'system', before: IsaAction[] = []): StepResult {
  if (s.ended !== null) return { state: s, actions: [] };
  if (s.paused !== null) return { state: s.paused.reason === reason ? s : { ...s, paused: { ...s.paused, reason } }, actions: before };
  const st: IsaState = { ...s, resumePhase: s.phase, phase: 'paused', paused: { reason, byKind, since: at }, awaitingModel: false };
  return { state: st, actions: [...before, { kind: 'pause', reason }, { kind: 'cancel_messages' }, { kind: 'cancel_timers' }, { kind: 'schedule_timer', timer: 'pause_expiry', at: instant(at + ISA_TURN_LIMITS.pauseExpiryMs) }] };
}

/** The line a class sends (only when the send checks pass now; the safety line only inside the window now). */
function classLines(c: EscalationClass, facts: IsaFacts): IsaLineId[] {
  const line = ESCALATION_TABLE[c].line;
  if (line === null) return [];
  if (c === 'safety' && !facts.windowOpenNow) return [];
  return [line];
}

/** Applies one escalation class (terminal ends; hold_topic holds; check_this pauses). */
function escalate(s: IsaState, at: Instant, c: EscalationClass, facts: IsaFacts, before: IsaAction[] = []): StepResult {
  const row = ESCALATION_TABLE[c];
  const card: IsaAction = { kind: 'escalate', class: c, type: row.type, priority: escalationPriority(c, s.inboundUnanswered) };
  const st = addClass(s, c);
  if (row.type === 'terminal') {
    const reason: IsaEndReason = c === 'opt_out' ? 'opted_out' : c === 'wrong_number' ? 'wrong_number' : c === 'limit' || c === 'flood' ? 'limit_reached' : 'escalated';
    return end(st, at, reason, { escalation: c, lines: classLines(c, facts), before: [...before, card] });
  }
  if (row.type === 'check_this') return pause(st, at, 'check_this', 'system', [...before, card]);
  // hold topic: the holding line (within the caps); a later inbound on the same topic gets only the line again
  const already = st.held.some((h) => h.class === c);
  const held = already ? st.held : [...st.held, { class: c, since: at }];
  const phase: IsaPhase = 'awaiting_agent';
  const resumePhase = st.phase === 'awaiting_agent' ? st.resumePhase : st.phase === 'starting' ? 'engaged' : st.phase;
  const line = facts.content.holdingLines[c as keyof AiIsaContent['holdingLines']] !== undefined ? 'holding' : (row.line ?? 'holding');
  return { state: { ...st, held, phase, resumePhase, awaitingModel: false }, actions: [...before, ...(already ? [] : [card]), msg(st, { messageKind: 'holding_line', lines: [line], initiated: false })] };
}

function readinessNow(s: IsaState, facts: IsaFacts, at: Instant): ReturnType<typeof readiness> {
  return readiness({
    side: s.side,
    now: at,
    zone: facts.zone,
    claims: s.claims,
    intents: s.intents,
    offerLive: s.offer !== null,
    appointmentBooked: null,
    mlsListedElsewhere: facts.mlsListedElsewhere,
    subjectConfirmed: facts.subjectConfirmed,
    timelineDaysMax: facts.content.readiness.timelineDays,
  });
}

function cadenceMs(s: IsaState, facts: IsaFacts, asked: IsaCadence | null): number {
  const base = CADENCE_MS[asked ?? facts.content.cadence];
  return s.counters.unansweredInitiated >= facts.content.limits.slowAfterUnanswered ? Math.max(base, ISA_DEFAULT_LIMITS.slowCadenceDays * DAY_MS) : base;
}

// ---- inbound ------------------------------------------------------------------------------------------------

function onInbound(s0: IsaState, e: Extract<IsaEvent, { type: 'inbound' }>, facts: IsaFacts): StepResult {
  if (!live(s0) || e.messages.length === 0) return { state: s0, actions: [] };
  // permutation invariance: the batch is read in seq order
  const batch = [...e.messages].sort((a, b) => a.seq - b.seq || (a.messageId < b.messageId ? -1 : 1));
  const fresh = batch.filter((m) => m.seq > s0.lastInboundSeq);
  if (fresh.length === 0) return { state: s0, actions: [] };
  const last = fresh[fresh.length - 1] as IsaInbound;
  const classes = new Set<EscalationClass>();
  let bot = false;
  const intents: IntentSignal[] = [...s0.intents];
  for (const m of fresh) {
    const sig = inboundSignals({ ownText: m.ownText, classification: m.classification, reaction: m.reaction, ...(facts.fairHousing ? { fairHousing: facts.fairHousing } : {}) });
    for (const c of sig.classes) classes.add(c);
    bot ||= sig.botQuestion;
    // intents only from reliable own text that is not team text (R-ISA-27)
    if ((m.channel === 'sms' || m.ownTextReliable) && !isTeamText(m.ownText, facts.teamTexts)) intents.push(...intentSignals(m.ownText, m.messageId));
  }
  if (facts.recentInboundCount >= ISA_TURN_LIMITS.floodInbounds) classes.add('flood');
  let s: IsaState = { ...s0, lastInboundSeq: last.seq, lastInboundChannel: last.channel, inboundUnanswered: true, counters: { ...s0.counters, unansweredInitiated: 0 }, intents, phase: s0.phase === 'starting' || s0.phase === 'nurture' || s0.phase === 'awaiting_reply' ? 'engaged' : s0.phase };

  // rows 1–9: the stop classes win over everything
  const stop = topClass([...classes].filter((c) => STOP_CLASSES.has(c)));
  if (stop !== null) return escalate(s, e.at, stop, facts);

  // row 10: a slot choice on a live, delivered offer: book first, then the rest in the same turn
  const rest = [...classes].filter((c) => !STOP_CLASSES.has(c));
  const o = s.offer;
  if (o !== null && o.status === 'offered' && o.deliveredAt !== null) {
    const after = fresh.filter((m) => m.at > (o.deliveredAt as Instant));
    let choice: { index: number; messageId: string } | null = null;
    let ambiguous = false;
    for (const m of after) {
      const unreliable = m.channel === 'email' && !m.ownTextReliable;
      const pasted = isTeamText(m.ownText, facts.teamTexts);
      const r = unreliable || pasted ? ({ kind: 'ambiguous' } as const) : matchSlotChoice(m.ownText, o.slots, o.zones, { reaction: m.reaction });
      if (r.kind === 'unique') {
        if (choice !== null && choice.index !== r.index) ambiguous = true;
        choice = { index: r.index, messageId: m.messageId };
      } else if (r.kind === 'ambiguous') ambiguous = true;
    }
    if (choice !== null && !ambiguous) {
      s = { ...s, phase: 'booking', offer: { ...o, status: 'accepting', acceptedIndex: choice.index }, afterBooking: rest, inboundUnanswered: true };
      return { state: s, actions: [{ kind: 'book', offerId: o.id, slotIndex: choice.index, messageId: choice.messageId }] };
    }
    if (ambiguous || choice !== null) {
      const terminal = topClass(rest.filter((c) => ESCALATION_TABLE[c].type === 'terminal'));
      if (terminal !== null) return escalate(s, e.at, terminal, facts);
      if (o.clarifications >= ISA_TURN_LIMITS.slotClarifications) return escalate(s, e.at, 'uncertain', facts);
      s = { ...s, offer: { ...o, clarifications: o.clarifications + 1 } };
      for (const c of rest) if (ESCALATION_TABLE[c].type === 'hold_topic' && !s.held.some((h) => h.class === c)) s = { ...addClass(s, c), held: [...s.held, { class: c, since: e.at }] };
      return { state: s, actions: [msg(s, { messageKind: 'offer', lines: ['slot_clarify_intro'], offerId: o.id, initiated: false })] };
    }
  }

  // rows 11+: terminal classes end, before readiness
  const terminal = topClass(rest.filter((c) => ESCALATION_TABLE[c].type === 'terminal'));
  if (terminal !== null) return escalate(s, e.at, terminal, facts);
  const check = topClass(rest.filter((c) => ESCALATION_TABLE[c].type === 'check_this'));
  if (check !== null) return escalate(s, e.at, check, facts);

  // readiness from usable claims and verified intents (it waits while an offer is live)
  const r = readinessNow(s, facts, e.at);
  if (r.ready) {
    const holdLines = rest.filter((c) => ESCALATION_TABLE[c].type === 'hold_topic').flatMap((c) => classLines(c, facts));
    let st = s;
    for (const c of rest) st = addClass(st, c);
    return end(st, e.at, readinessEndReason(r.rule), { basis: { rule: r.rule, ruleVersion: r.ruleVersion, claimIds: r.claimIds }, lines: [...holdLines, 'ready'] });
  }

  const hold = topClass(rest.filter((c) => ESCALATION_TABLE[c].type === 'hold_topic'));
  if (hold !== null) {
    let st = s;
    for (const c of rest) if (c !== hold && ESCALATION_TABLE[c].type === 'hold_topic' && !st.held.some((h) => h.class === c)) st = { ...addClass(st, c), held: [...st.held, { class: c, since: e.at }] };
    return escalate(st, e.at, hold, facts);
  }
  if (bot) return { state: s, actions: [msg(s, { messageKind: 'conversation', lines: ['bot_question'], initiated: false })] };
  return { state: { ...s, awaitingModel: true }, actions: [{ kind: 'await_model', repair: false, initiated: false }] };
}

// ---- model output -------------------------------------------------------------------------------------------

function onModelOutput(s0: IsaState, e: Extract<IsaEvent, { type: 'model_output' }>, facts: IsaFacts): StepResult {
  if (!live(s0) || !s0.awaitingModel || e.epoch !== s0.epoch) return { state: s0, actions: [] };
  const d = e.decision;
  let s: IsaState = { ...s0, awaitingModel: false, counters: { ...s0.counters, schemaFailures: 0 } };
  const actions: IsaAction[] = [];
  if (d.denied.length > 0) actions.push({ kind: 'denied', codes: d.denied.map((x) => `${x.item}:${x.code}`) });
  if (d.claims.length > 0 || d.unusableClaims.length > 0) {
    actions.push({ kind: 'record_claims', claims: d.claims, unusable: d.unusableClaims });
    s = { ...s, claims: [...s.claims, ...d.claims.filter((c) => !s.claims.some((x) => x.claimId === c.claimId))] };
  }
  // a model escalation can only add a class
  const modelTop = topClass(d.escalations);
  if (modelTop !== null) {
    const row = ESCALATION_TABLE[modelTop];
    if (row.type !== 'hold_topic' || !s.held.some((h) => h.class === modelTop)) return escalate(s, e.at, modelTop, facts, actions);
  }
  if (d.endProposal !== null) return pause(addClass(s, d.endProposal.reason === 'has_agent' ? 'other_agent' : 'uncertain'), e.at, 'check_this', 'system', [...actions, { kind: 'escalate', class: d.endProposal.reason === 'has_agent' ? 'other_agent' : 'uncertain', type: 'check_this', priority: 'high' }]);
  // booking first (row 10)
  if (d.bookSlot !== null && s.offer !== null && s.offer.status === 'offered') {
    return { state: { ...s, phase: 'booking', offer: { ...s.offer, status: 'accepting', acceptedIndex: d.bookSlot.slotIndex } }, actions: [...actions, { kind: 'book', offerId: s.offer.id, slotIndex: d.bookSlot.slotIndex, messageId: d.bookSlot.messageId }] };
  }
  if (d.slotAmbiguous && s.offer !== null) {
    if (s.offer.clarifications >= ISA_TURN_LIMITS.slotClarifications) return escalate(s, e.at, 'uncertain', facts, actions);
    s = { ...s, offer: { ...s.offer, clarifications: s.offer.clarifications + 1 } };
    return { state: s, actions: [...actions, msg(s, { messageKind: 'offer', lines: ['slot_clarify_intro'], offerId: s.offer!.id, initiated: false })] };
  }
  // readiness, recomputed from usable claims every turn (the model's `ready` is only a hint)
  const r = readinessNow(s, facts, e.at);
  if (r.ready) return end(s, e.at, readinessEndReason(r.rule), { basis: { rule: r.rule, ruleVersion: READINESS_RULE_VERSION, claimIds: r.claimIds }, lines: ['ready'], before: actions });
  if (d.proposeSavedSearch) actions.push({ kind: 'propose_saved_search' });
  let queued: QueueMessage | null = null;
  if (d.offerSlots !== null) {
    s = { ...s, phase: 'scheduling', offer: { id: `pending:${s.epoch}:${s.lastInboundSeq}`, status: 'requested', appointmentKind: d.offerSlots.kind, slots: [], zones: [], deliveredAt: null, expiresAt: null, clarifications: 0, acceptedIndex: null } };
    actions.push({ kind: 'request_offer', appointmentKind: d.offerSlots.kind });
  } else if (d.shareListings !== null) queued = msg(s, { messageKind: 'facts', handles: d.shareListings, initiated: true });
  else if (d.shareCompetition !== null) queued = msg(s, { messageKind: 'facts', handles: d.shareCompetition, initiated: true });
  else if (d.sendComps) queued = msg(s, { messageKind: 'facts', channel: 'email', handles: ['comps'], initiated: true });
  else if (d.reply !== null) {
    queued = msg(s, { messageKind: 'conversation', text: d.reply.text });
    s = { ...s, counters: { ...s.counters, guardBlocks: 0 } };
  } else if (d.replyBlocked !== null) {
    const blocks = s.counters.guardBlocks + 1;
    s = { ...s, counters: { ...s.counters, guardBlocks: blocks } };
    if (blocks >= ISA_TURN_LIMITS.guardBlocksBeforeUncertain) return escalate(s, e.at, 'uncertain', facts, actions);
    const line: IsaLineId = d.replyBlocked.fallback === 'pricing' ? 'pricing' : d.replyBlocked.fallback === 'fair_housing' ? 'fair_housing' : 'holding';
    queued = msg(s, { messageKind: 'holding_line', lines: [line] });
  }
  if (queued !== null) {
    actions.push(queued);
    actions.push({ kind: 'schedule_timer', timer: 'follow_up', at: instant(e.at + cadenceMs(s, facts, d.followUp)) });
    if (s.phase !== 'scheduling' && s.phase !== 'awaiting_agent') s = { ...s, phase: 'awaiting_reply' };
  } else if (d.followUp !== null) {
    actions.push({ kind: 'schedule_timer', timer: 'follow_up', at: instant(e.at + cadenceMs(s, facts, d.followUp)) });
  }
  return { state: s, actions };
}

// ---- results and controls -------------------------------------------------------------------------------------

function onSendResult(s: IsaState, e: Extract<IsaEvent, { type: 'send_result' }>, facts: IsaFacts): StepResult {
  if (s.ended !== null) return { state: s, actions: [] };
  const c = s.counters;
  if (e.status === 'sent' || e.status === 'delivered') {
    let st: IsaState = { ...s, counters: { ...c, undeliveredStreak: 0, messagesSent: e.status === 'sent' ? c.messagesSent + 1 : c.messagesSent }, inboundUnanswered: false };
    const actions: IsaAction[] = [];
    if (e.messageKind === 'offer' && st.offer !== null && st.offer.status === 'pending_delivery') {
      st = { ...st, phase: 'scheduling', offer: { ...st.offer, status: 'offered', deliveredAt: e.at } };
      if (st.offer!.expiresAt !== null) actions.push({ kind: 'schedule_timer', timer: 'offer_expiry', at: st.offer!.expiresAt });
    }
    if (st.counters.messagesSent >= facts.content.limits.maxMessagesPerAssignment && st.paused === null) return end(st, e.at, 'limit_reached', { escalation: 'limit', before: actions });
    return { state: st, actions };
  }
  if (e.status === 'failed' || e.status === 'undelivered') {
    const streak = c.undeliveredStreak + 1;
    let st: IsaState = { ...s, counters: { ...c, undeliveredStreak: streak } };
    if (e.messageKind === 'offer' && st.offer !== null && st.offer.status === 'pending_delivery') st = { ...st, offer: null, phase: 'engaged' };
    if (streak >= ISA_DEFAULT_LIMITS.undeliveredInARow && st.paused === null) return end(st, e.at, 'delivery_problem');
    return { state: st, actions: [] };
  }
  if (e.status === 'blocked' || e.status === 'canceled') {
    const endCode = (e.reasonCodes ?? []).map((r) => GUARD_END[r]).find((r) => r !== undefined);
    if (endCode !== undefined) return end(s, e.at, endCode);
    if (e.messageKind === 'offer' && s.offer !== null && s.offer.status === 'pending_delivery') return { state: { ...s, offer: null, phase: s.phase === 'paused' ? 'paused' : 'engaged' }, actions: [] };
  }
  return { state: s, actions: [] };
}

function onBooking(s: IsaState, e: Extract<IsaEvent, { type: 'booking_result' }>, facts: IsaFacts): StepResult {
  if (s.ended !== null || s.offer === null || s.offer.status !== 'accepting') return { state: s, actions: [] };
  const o = s.offer;
  if (e.ok) {
    const st: IsaState = { ...s, appointment: { appointmentId: e.appointmentId, kind: o.appointmentKind } };
    // E523: a control committed during the booking: booked, but the confirmation is not queued; the card is critical
    if (s.paused !== null) return end(st, e.at, 'appointment_booked');
    const holdLines = st.afterBooking.filter((c) => ESCALATION_TABLE[c].type === 'hold_topic').flatMap((c) => classLines(c, facts));
    let withClasses = st;
    for (const c of st.afterBooking) withClasses = addClass(withClasses, c);
    const confirmation = msg(withClasses, { messageKind: 'confirmation', lines: holdLines, offerId: o.id, slotIndex: o.acceptedIndex, initiated: false });
    return end(withClasses, e.at, 'appointment_booked', { confirmation, basis: { rule: s.side === 'seller' ? 'S1' : 'B1', ruleVersion: READINESS_RULE_VERSION, claimIds: [] } });
  }
  const failures = s.counters.bookingFailures + 1;
  const st: IsaState = { ...s, offer: null, afterBooking: [], counters: { ...s.counters, bookingFailures: failures } };
  if (s.paused !== null) return { state: st, actions: [] };
  if ((e.code === 'SLOT_TAKEN' || e.code === 'SLOT_SOURCE_CHANGED') && failures < ISA_TURN_LIMITS.bookingRetries) {
    // a new offer; never the alternative booked automatically
    const next: IsaState = { ...st, phase: 'scheduling', offer: { ...o, id: `pending:${s.epoch}:${failures}`, status: 'requested', slots: [], deliveredAt: null, expiresAt: null, clarifications: 0, acceptedIndex: null } };
    return { state: next, actions: [{ kind: 'request_offer', appointmentKind: o.appointmentKind }] };
  }
  return escalate({ ...st, phase: 'engaged' }, e.at, 'booking_unavailable', facts);
}

function onControl(s: IsaState, e: Extract<IsaEvent, { type: 'human_control' }>): StepResult {
  if (s.ended !== null) return { state: s, actions: [] };
  switch (e.control) {
    case 'pause':
      return pause(s, e.at, 'user', 'user');
    case 'take_over':
      return pause(s, e.at, 'taking_over', 'user');
    case 'end':
      return pause(s, e.at, 'ending', 'user');
    case 'undo':
      // Undo within 10 s leaves care paused, never live
      return s.paused !== null && (s.paused.reason === 'taking_over' || s.paused.reason === 'ending') ? { state: { ...s, paused: { ...s.paused, reason: 'user' } }, actions: [] } : { state: s, actions: [] };
    case 'finalize':
      if (s.paused?.reason === 'taking_over') return end(s, e.at, 'taken_over');
      if (s.paused?.reason === 'ending') return end(s, e.at, 'ended_by_user');
      return { state: s, actions: [] };
    case 'resume': {
      // owner only, never the system; not while a take over or an end is pending; the epoch increments
      if (!e.byOwner || s.paused === null || s.paused.reason === 'taking_over' || s.paused.reason === 'ending') return { state: s, actions: [] };
      const phase: IsaPhase = s.resumePhase === null || s.resumePhase === 'paused' || s.resumePhase === 'starting' ? 'engaged' : s.resumePhase === 'booking' || s.resumePhase === 'scheduling' ? 'engaged' : s.resumePhase;
      const epoch = s.epoch + 1;
      // any offer or proposed action from the old epoch is withdrawn
      return { state: { ...s, phase, paused: null, resumePhase: null, epoch, offer: null, afterBooking: [], awaitingModel: false }, actions: [{ kind: 'resume', epoch }, { kind: 'cancel_timers' }] };
    }
  }
}

function onTimer(s: IsaState, e: Extract<IsaEvent, { type: 'timer' }>, facts: IsaFacts): StepResult {
  if (s.ended !== null) return { state: s, actions: [] };
  switch (e.timer) {
    case 'pause_expiry':
      return s.paused !== null && e.at - s.paused.since >= ISA_TURN_LIMITS.pauseExpiryMs ? end(s, e.at, 'pause_expired') : { state: s, actions: [] };
    case 'inactivity_warning':
      return end(s, e.at, 'inactivity_warning');
    case 'offer_expiry':
      if (s.paused !== null || s.offer === null || (s.offer.status !== 'offered' && s.offer.status !== 'pending_delivery')) return { state: s, actions: [] };
      if (s.offer.expiresAt !== null && e.at < s.offer.expiresAt) return { state: s, actions: [] };
      return { state: { ...s, offer: null, phase: 'engaged' }, actions: [] };
    case 'follow_up': {
      if (s.paused !== null || s.awaitingModel || s.phase === 'booking' || s.phase === 'scheduling') return { state: s, actions: [] };
      if (e.at - s.startedAt >= facts.content.limits.maxDays * DAY_MS) return end(s, e.at, 'limit_reached', { escalation: 'limit' });
      const unanswered = s.counters.unansweredInitiated + 1;
      if (unanswered > facts.content.limits.dormantAfterUnanswered) return end(s, e.at, 'dormant');
      const st: IsaState = { ...s, phase: s.phase === 'awaiting_agent' ? 'awaiting_agent' : 'nurture', awaitingModel: true, inboundUnanswered: false, counters: { ...s.counters, unansweredInitiated: unanswered } };
      return { state: st, actions: [{ kind: 'await_model', repair: false, initiated: true }] };
    }
  }
}

/** One transition. Pure and deterministic. */
export function step(s: IsaState, e: IsaEvent, facts: IsaFacts): StepResult {
  const none: StepResult = { state: s, actions: [] };
  switch (e.type) {
    case 'start':
      if (s.phase !== 'starting' || !live(s)) return none;
      return { state: { ...s, phase: 'engaged', awaitingModel: true }, actions: [{ kind: 'await_model', repair: false, initiated: true }] };
    case 'inbound':
      return onInbound(s, e, facts);
    case 'model_output':
      return onModelOutput(s, e, facts);
    case 'model_failed': {
      if (!live(s) || !s.awaitingModel || e.epoch !== s.epoch) return none;
      const failures = s.counters.schemaFailures + 1;
      const st: IsaState = { ...s, counters: { ...s.counters, schemaFailures: failures } };
      if (failures >= ISA_TURN_LIMITS.schemaFailuresBeforeUncertain) return escalate({ ...st, awaitingModel: false }, e.at, 'uncertain', facts);
      return { state: st, actions: [{ kind: 'await_model', repair: true, initiated: !s.inboundUnanswered }] };
    }
    case 'timer':
      return onTimer(s, e, facts);
    case 'listing_event':
      if (!live(s) || s.phase === 'booking' || e.handles.length === 0) return none;
      return { state: s, actions: [msg(s, { messageKind: 'facts', handles: [...e.handles], initiated: true })] };
    case 'send_result':
      return onSendResult(s, e, facts);
    case 'offer_ready':
      if (!live(s) || s.offer === null || s.offer.status !== 'requested') return none;
      {
        const offer: IsaOffer = { ...s.offer, id: e.offerId, status: 'pending_delivery', slots: [...e.slots], zones: [...e.zones], expiresAt: e.expiresAt };
        const st: IsaState = { ...s, phase: 'scheduling', offer };
        return { state: st, actions: [msg(st, { messageKind: 'offer', offerId: e.offerId, initiated: false })] };
      }
    case 'offer_unavailable':
      if (!live(s) || s.offer === null || s.offer.status !== 'requested') return none;
      return escalate({ ...s, offer: null, phase: 'engaged' }, e.at, 'booking_unavailable', facts);
    case 'booking_result':
      return onBooking(s, e, facts);
    case 'human_control':
      return onControl(s, e);
    case 'human_contact':
      return live(s) ? pause(s, e.at, 'human_contact', 'system') : none;
    case 'authorization_lost':
      if (s.ended !== null || e.effect === 'hold') return none;
      if (e.effect === 'pause') return pause(s, e.at, e.pauseReason ?? 'pack_withdrawn', 'system');
      return end(s, e.at, e.endReason ?? 'tenant_off');
    case 'stop_signal':
      return end(s, e.at, STOP_END[e.reason]);
    case 'escalation_resolved': {
      if (s.ended !== null || !s.held.some((h) => h.class === e.class)) return none;
      const held = s.held.filter((h) => h.class !== e.class);
      if (held.length > 0 || s.phase !== 'awaiting_agent') return { state: { ...s, held }, actions: [] };
      return { state: { ...s, held, phase: s.resumePhase ?? 'engaged', resumePhase: null }, actions: [] };
    }
  }
}

/** The classes on hold right now (decideAction refuses actions on them). */
export function heldClasses(s: IsaState): Set<EscalationClass> {
  return new Set(s.held.map((h) => h.class));
}
