// The session runner of an AI-answered call (module 48 item 5; R-VOICE-2, R-VOICE-4, R-VOICE-7, R-VOICE-10, R-VOICE-14;
// E117, E150, E425, E427, E429).
//
// core/voice decides, module 48 executes. The runner starts core's session, then runs one serial loop over the
// earliest of: an event the runner made itself (a hang-up when the call had ended, a transfer result), a settled
// booking (booking_result), a platform event from the transport, and a 250 ms tick. Each tick reads
// calls.transfer_outcome and calls.ended_at. The runner never re-decides a tool, target, slot, outcome or opt-out
// and never classifies the model's words; where it must stop a session (ledger cap, lost transport, any exception)
// it feeds core a vendor_error, and core ends it (to voicemail). At the end, after any in-flight booking settled, it
// writes the one handback (handback.ts). The facts are read once, at the takeover (E150).
import { type Claim, normalizeClaims, sourceIndex } from '@realty/core/assistant';
import type { Clock, IanaZone, Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type StepResult, type VerifiedClaim, type VoiceAction, type VoiceEvent, type VoiceFacts, type VoiceHandback, type VoiceState, startSession, step } from '@realty/core/voice';
import { withTenantTx } from '@realty/db';
import type { BookResult } from '../calendar/service.js';
import { markAnnounced, markDisclosed, voicemailFor } from './effects.js';
import { type HandbackResult, writeHandback } from './handback.js';
import { type Unlogged, writeLedger } from './ledger.js';
import { applyHeardOptOut } from './optout.js';
import type { PlatformEvent, VoiceTransport } from './provider.js';
import type { VoiceDeps } from './runtime.js';
import { aiCallState, claimTransferOutcome, startTransfer } from './transfer.js';

export const TICK_MS = 250;

export interface SessionInput {
  actor: SystemActor;
  callId: string;
  contactId: string;
  callerAddress: string;
  zone: IanaZone;
  facts: VoiceFacts;
  transport: VoiceTransport;
  providerKind: string;
  playbookVersionId: string;
}

export interface SessionResult {
  state: VoiceState;
  handback: VoiceHandback;
  written: HandbackResult | null;
  unlogged: Unlogged[];
  ledgerWritten: number;
  appointmentId: string | null;
  /** every action core returned, with the instant of the event that produced it (tests: sessionViolations) */
  trace: { at: Instant; action: VoiceAction }[];
}

interface Booking {
  promise: Promise<void>;
  result: BookResult | null;
  error: boolean;
  fed: boolean;
}

export async function runSession(deps: VoiceDeps, s: SessionInput): Promise<SessionResult> {
  const clock: Clock = (s.transport as { clock?: Clock }).clock ?? deps.clock;
  const facts = s.facts;
  const queue: VoiceEvent[] = [];
  const unlogged: Unlogged[] = [];
  const segments: { startMs: number; endMs: number; speaker: string; text: string }[] = [];
  const claims: VerifiedClaim[] = [];
  let ledgerWritten = 0;
  let dbAnnounced = false;
  let spokeBeforeProcessing = 0;
  let appointmentId: string | null = null;
  let bookingFailureCode: string | null = null;
  // mutated from the effect closures (a holder, so the loop's reads are not narrowed away)
  const ctl: { booking: Booking | null; endAction: Extract<VoiceAction, { kind: 'end' }> | null } = { booking: null, endAction: null };
  let vendorErrorFed = false;
  let hangupFed = false;

  const trace: { at: Instant; action: VoiceAction }[] = [];
  const first = startSession(facts, clock.now());
  let state: VoiceState = first.state;

  async function effect(a: VoiceAction, all: readonly VoiceAction[], at: Instant): Promise<void> {
    switch (a.kind) {
      case 'say':
        await s.transport.say(a.text, a.source);
        return;
      case 'await_model':
        await s.transport.awaitModel();
        return;
      case 'apply_inbound': {
        const last = segments.at(-1);
        await withTenantTx(s.actor, (tx) => applyHeardOptOut(tx, s.actor, deps, { callId: s.callId, contactId: s.contactId, callerAddress: s.callerAddress, classification: a.classification, at, offsetMs: last?.startMs ?? at - state.startedAt }), { db: deps.db, retries: 2 });
        return;
      }
      case 'ledger': {
        const w = await withTenantTx(s.actor, (tx) => writeLedger(tx, deps.ids, s.callId, a.entry, { disclosedAt: state.disclosedAt, announcedAt: dbAnnounced ? state.announcedAt : null, written: ledgerWritten }), { db: deps.db, retries: 2 });
        if (w.kind === 'written') ledgerWritten += 1;
        else unlogged.push(w.unlogged);
        if (w.kind === 'cap' && !vendorErrorFed) queue.push({ type: 'vendor_error', at });
        const offer = all.find((x): x is Extract<VoiceAction, { kind: 'offer_slots' }> => x.kind === 'offer_slots');
        await s.transport.toolResult(a.entry.seq, a.entry.decision, a.entry.reason, offer ? offer.slots.map((x) => ({ start: toIso(x.start), end: toIso(x.end) })) : undefined);
        return;
      }
      case 'offer_slots':
        return; // sent with its ledger row's tool result
      case 'book': {
        const owner = facts.contact.owner;
        const b: Booking = { promise: Promise.resolve(), result: null, error: false, fed: false };
        b.promise = (async () => {
          try {
            b.result = owner === null ? { ok: false, code: 'MEMBER_NOT_ACTIVE' } : await deps.bookSlot(deps.calendar, s.actor.tenantId, { userId: owner.userId, contactId: s.contactId, kind: a.appointmentKind, startsAt: toIso(a.slot.start), endsAt: toIso(a.slot.end), createdByKind: 'assistant' });
          } catch {
            b.error = true;
          }
        })();
        ctl.booking = b;
        return;
      }
      case 'start_transfer': {
        const t = await startTransfer(s.actor, deps, s.callId, a.userId, a.holdSeconds);
        if (t.kind === 'ring') await s.transport.handOff(t.twiml);
        else queue.push({ type: 'transfer_result', at, outcome: 'no_answer' }); // E434: nobody to ring
        return;
      }
      case 'voicemail':
        await s.transport.handOff(await voicemailFor(s.actor, deps, s.callId));
        return;
      case 'end':
        ctl.endAction = a;
        return;
    }
  }

  async function apply(r: StepResult, at: Instant): Promise<void> {
    const prev = state;
    state = r.state;
    if (prev.disclosedAt === null && state.disclosedAt !== null) await markDisclosed(s.actor, deps, s.callId, state.disclosedAt);
    if (prev.announcedAt === null && state.announcedAt !== null) {
      dbAnnounced = await markAnnounced(s.actor, deps, s.callId, state.announcedAt);
      if (!dbAnnounced) queue.push({ type: 'hangup', at }); // the caller was gone already
    }
    for (const a of r.actions) {
      trace.push({ at, action: a });
      await effect(a, r.actions, at);
    }
  }

  async function feed(e: VoiceEvent): Promise<void> {
    if (e.type === 'hangup') hangupFed = true;
    if (e.type === 'vendor_error') vendorErrorFed = true;
    try {
      await apply(step(state, e, facts), e.at);
    } catch {
      if (!vendorErrorFed) {
        vendorErrorFed = true;
        try {
          await apply(step(state, { type: 'vendor_error', at: clock.now() }, facts), clock.now());
        } catch {
          // the voicemail effect failed too: end in memory, the handback still records the outcome
          const r = step(state, { type: 'vendor_error', at: clock.now() }, facts);
          state = r.state;
          ctl.endAction = (r.actions.find((x) => x.kind === 'end') as typeof ctl.endAction) ?? ctl.endAction;
        }
      }
    }
  }

  function platformEvent(e: PlatformEvent): VoiceEvent | null {
    if (e.type === 'claim_proposals') {
      const src = sourceIndex([{ kind: 'transcript', sourceType: 'call', sourceId: s.callId, startedAt: state.startedAt, segments }]);
      const fresh: Claim[] = normalizeClaims(e.raw, src, { contactZone: s.zone, ids: deps.ids });
      for (const c of fresh) claims.push({ ...c, reviewStatus: 'unreviewed' });
      // core replaces the session's claims with each `claims` event: always the cumulative set
      return { type: 'claims', at: e.at, claims: [...claims] };
    }
    if (e.type === 'caller_turn') {
      if (state.phase === 'conversing') {
        const startMs = Math.max(0, e.at - state.startedAt);
        segments.push({ startMs, endMs: startMs + 1000, speaker: 'caller', text: e.text.slice(0, 2000) });
      } else if (state.phase === 'disclosing' || state.phase === 'announcing') spokeBeforeProcessing += 1;
    }
    return e;
  }

  try {
    await apply(first, clock.now());
    while (state.phase !== 'ended') {
      const queued = queue.shift();
      if (queued) {
        await feed(queued);
        continue;
      }
      const b = ctl.booking;
      if (b !== null && !b.fed && (b.result !== null || b.error)) {
        b.fed = true;
        const ok = b.result?.ok === true;
        if (b.result?.ok) appointmentId = b.result.appointmentId;
        else bookingFailureCode = b.error ? 'BOOKING_ERROR' : (b.result as { code: string }).code;
        await feed({ type: 'booking_result', at: clock.now(), ok });
        continue;
      }
      const st = await aiCallState(s.actor, deps, s.callId).catch(() => null);
      if (st?.endedAt && !hangupFed) {
        await feed({ type: 'hangup', at: clock.now() });
        continue;
      }
      if (state.phase === 'transferring' && st?.transferOutcome) {
        await feed({ type: 'transfer_result', at: clock.now(), outcome: st.transferOutcome });
        continue;
      }
      let r: PlatformEvent | 'idle' | null;
      try {
        r = await s.transport.next({ until: (clock.now() + TICK_MS) as Instant, pending: ctl.booking && !ctl.booking.fed ? ctl.booking.promise : null });
      } catch {
        r = null;
      }
      if (r === null) {
        if (state.phase === 'transferring') {
          await new Promise((x) => setTimeout(x, TICK_MS));
          continue;
        }
        if (!vendorErrorFed) await feed({ type: 'vendor_error', at: clock.now() }); // lost transport
        else break;
        continue;
      }
      if (r === 'idle') {
        const now = clock.now();
        const t = state.transfer;
        if (state.phase === 'transferring' && t !== null && t.outcome === null && now >= t.holdEndsAt) {
          // the hold ended: claim it first; a press or a dial result that won is fed instead
          const c = await claimTransferOutcome(s.actor, deps, s.callId, 'no_answer');
          if (!c.won && c.stored) {
            await feed({ type: 'transfer_result', at: now, outcome: c.stored });
            continue;
          }
        }
        await feed({ type: 'tick', at: now });
        continue;
      }
      const ev = platformEvent(r);
      if (ev) await feed(ev);
    }
  } catch {
    if (state.phase !== 'ended') {
      const r = step(state, { type: 'vendor_error', at: clock.now() }, facts);
      state = r.state;
      ctl.endAction = (r.actions.find((x) => x.kind === 'end') as typeof ctl.endAction) ?? ctl.endAction;
    }
  }

  // a booking still in flight settles before the handback (E427: one the session did not count is canceled)
  const last = ctl.booking;
  if (last !== null) {
    await last.promise;
    if (!last.fed) {
      if (last.result?.ok) appointmentId = last.result.appointmentId;
      else bookingFailureCode = last.error ? 'BOOKING_ERROR' : ((last.result as { code?: string } | null)?.code ?? null);
    }
  }
  await s.transport.close().catch(() => undefined);
  const end = ctl.endAction;
  if (end === null) throw new Error('VOICE_SESSION_WITHOUT_END');
  const handback = end.handback;
  const written = await writeHandback(s.actor, deps, {
    tenantId: s.actor.tenantId,
    callId: s.callId,
    contactId: s.contactId,
    handback,
    appointmentId,
    bookingFailureCode,
    unlogged,
    spokeBeforeProcessing,
    providerKind: s.providerKind,
    playbookVersionId: s.playbookVersionId,
    at: clock.now(),
  });
  return { state, handback, written, unlogged, ledgerWritten, appointmentId, trace };
}
