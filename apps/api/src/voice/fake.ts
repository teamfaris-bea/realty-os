// The deterministic fake voice agent (module 48; R-VOICE-11). It replays @realty/core/voice/testing SCRIPTS on its own
// virtual clock, records what the session said, the tool results and the hand-offs, and injects faults (a connect
// failure, a vendor error at step n, model latency, a closed transport). Not for production paths: production uses
// UnconfiguredVoiceAgent (providers/index.ts). Every name in the scripts is generic (public repository).
//
// Virtual time: the transport's clock starts at the real instant of connect and only moves when the runner asks
// for the next event (`next({ until })`): to the next scripted event, or to `until` when none is due before it.
// While the runner has a booking in flight (`pending`), the fake waits for it before letting time pass the next
// scripted event, so a script replays the same way every time. After a hand-off with `pauseOnHandOff`, the clock
// stands still until the test moves it (`advance`) or the session reconnects, so a test can interleave webhooks.
//
// Events module 48 makes itself (booking_result, transfer_result, tick, enablement_changed) are dropped from the
// script; a `claims` event becomes the model's raw claim proposals quoting the caller's latest turn (sent right
// after that turn when none was said yet), so module 48's normalizeClaims checks them like a real model's output.
import type { Clock, Instant, ManualClock } from '@realty/core/foundation';
import { fixedClock, instant } from '@realty/core/foundation';
import type { VoiceEvent } from '@realty/core/voice';
import { SLOT_A, SLOT_B, type VoiceScript } from '@realty/core/voice/testing';
import { toIso } from '@realty/core/foundation';
import { ProviderError } from '../providers/types.js';
import type { NextResult, OfferedSlotIso, PlatformEvent, SaySource, VoiceAgentProvider, VoiceSessionContext, VoiceTransport } from './provider.js';

export interface FakeFaults {
  connectFailure?: boolean;
  /** Replaces scripted step n (0-based) with a vendor_error. */
  vendorErrorAtStep?: number;
  /** Added to every model turn's latencyMs. */
  latencyMs?: number;
  /** The transport closes (next() ⇒ null) before scripted step n. */
  closeAtStep?: number;
  /** After a hand-off the virtual clock stands still until advance() or reconnect. */
  pauseOnHandOff?: boolean;
  /** Keep the scripts' fixture slots as they are (default: SLOT_A/SLOT_B become the 1st/2nd slot the session offered). */
  literalSlots?: boolean;
  /**
   * Ids the scripted model uses for real ones (the scripts' fixture OWNER_ID ⇒ this tenant's owner). The session
   * context carries no owner or contact field (R-VOICE-13): how a real model names the transfer target is VERIFY (N12).
   */
  idMap?: Readonly<Record<string, string>>;
  /** Do not wait for the runner's in-flight booking (a late booking result, E427). */
  ignorePending?: boolean;
  /** Stand still (real time passes, virtual time does not) before scripted step n until resume(). */
  holdBeforeStep?: number;
}

export interface FakeSessionLog {
  sessionId: string;
  tenantId: string;
  callRef: string;
  context: VoiceSessionContext;
  says: { at: Instant; text: string; source: SaySource; queued: boolean }[];
  toolResults: { at: Instant; seq: number; decision: 'allow' | 'deny'; reason: string; slots?: readonly OfferedSlotIso[] }[];
  handOffs: { at: Instant; twiml: string }[];
  reconnects: number;
  awaitModel: number;
  closed: boolean;
}

const DROPPED: ReadonlySet<VoiceEvent['type']> = new Set(['booking_result', 'transfer_result', 'tick', 'enablement_changed']);

function claimProposals(ev: Extract<VoiceEvent, { type: 'claims' }>, sessionId: string, turn: { ms: number; text: string }): unknown {
  return {
    claims: ev.claims.map((c) => ({
      kind: c.kind,
      text: c.text,
      evidence: [{ sourceType: 'call', sourceId: sessionId, locator: { kind: 'transcript_offset', startMs: turn.ms, endMs: turn.ms + 1 }, snippet: turn.text }],
      ...(c.structured?.criterion ? { criterion: c.structured.criterion } : {}),
    })),
  };
}

export class FakeVoiceTransport implements VoiceTransport {
  readonly clock: ManualClock;
  private step = 0;
  private handedOff = false;
  private paused = false;
  private lastCallerTurn: { ms: number; text: string } | null = null;
  private deferredClaims: Extract<VoiceEvent, { type: 'claims' }>[] = [];
  private ready: PlatformEvent[] = [];

  constructor(
    readonly log: FakeSessionLog,
    private readonly script: VoiceScript,
    private readonly faults: FakeFaults,
    readonly startedAt: Instant,
  ) {
    this.clock = fixedClock(startedAt);
  }

  /** Moves virtual time forward while paused after a hand-off (tests). */
  advance(ms: number): void {
    this.clock.advance(ms);
  }

  private released = false;

  resume(): void {
    this.paused = false;
    this.released = true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isHandedOff(): boolean {
    return this.handedOff;
  }

  reconnected(): void {
    this.handedOff = false;
    this.paused = false;
    for (const s of this.log.says) if (s.queued) s.queued = false;
    this.log.reconnects += 1;
  }

  async next(o: { until: Instant; pending: Promise<unknown> | null }): Promise<NextResult> {
    if (this.log.closed) return null;
    if (this.ready.length > 0) return this.ready.shift()!;
    if (this.faults.holdBeforeStep !== undefined && this.step === this.faults.holdBeforeStep && !this.released) this.paused = true;
    if (this.paused) {
      // real time passes so the test's webhooks interleave; virtual time stands still
      await new Promise((r) => setTimeout(r, 2));
      return 'idle';
    }
    if (o.pending && !this.faults.ignorePending) await o.pending.catch(() => undefined);
    for (;;) {
      if (this.faults.closeAtStep !== undefined && this.step >= this.faults.closeAtStep) {
        this.log.closed = true;
        return null;
      }
      const s = this.script.steps[this.step];
      if (s === undefined) {
        // the script is over: time passes in ticks until the session ends (a real call would hang up)
        await new Promise((r) => setImmediate(r));
        if (o.until > this.clock.now()) this.clock.set(o.until);
        return 'idle';
      }
      const at = (this.startedAt + s.ms) as Instant;
      if (at > o.until) {
        await new Promise((r) => setImmediate(r));
        if (o.until > this.clock.now()) this.clock.set(o.until);
        return 'idle';
      }
      const index = this.step;
      this.step += 1;
      if (at > this.clock.now()) this.clock.set(at);
      const t = this.clock.now();
      if (this.faults.vendorErrorAtStep === index) return { type: 'vendor_error', at: t };
      const ev = s.event(t);
      if (DROPPED.has(ev.type)) continue;
      if (ev.type === 'claims') {
        if (this.lastCallerTurn) return { type: 'claim_proposals', at: t, raw: claimProposals(ev, this.log.sessionId, this.lastCallerTurn) };
        this.deferredClaims.push(ev);
        continue;
      }
      if (ev.type === 'caller_turn') {
        this.lastCallerTurn = { ms: s.ms, text: ev.text };
        for (const d of this.deferredClaims.splice(0)) this.ready.push({ type: 'claim_proposals', at: t, raw: claimProposals(d, this.log.sessionId, this.lastCallerTurn) });
      }
      if (ev.type === 'tool_request' && ev.request.tool === 'book_appointment' && !this.faults.literalSlots) return { ...ev, request: { ...ev.request, args: this.mapSlot(ev.request.args) } };
      if (ev.type === 'tool_request' && this.faults.idMap) return { ...ev, request: { ...ev.request, args: this.mapIds(ev.request.args) } };
      if (ev.type === 'model_turn' && this.faults.latencyMs !== undefined) return { ...ev, latencyMs: (ev.latencyMs ?? 0) + this.faults.latencyMs };
      return ev as PlatformEvent;
    }
  }

  /** The scripts name fixture slots; a real model picks from what the session offered: SLOT_A/B ⇒ the 1st/2nd offered. */
  private mapSlot(args: unknown): unknown {
    if (typeof args !== 'object' || args === null) return args;
    const a = args as Record<string, unknown>;
    const offered = [...this.log.toolResults].reverse().find((r) => r.slots !== undefined)?.slots ?? [];
    const pick = a['slot_start'] === toIso(SLOT_A.start) ? offered[0] : a['slot_start'] === toIso(SLOT_B.start) ? offered[1] : undefined;
    return pick ? { ...a, slot_start: pick.start, slot_end: pick.end } : args;
  }

  private mapIds(args: unknown): unknown {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
    const m = this.faults.idMap ?? {};
    return Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' && m[v] !== undefined ? m[v] : v]));
  }

  async say(text: string, source: SaySource): Promise<void> {
    this.log.says.push({ at: this.clock.now(), text, source, queued: this.handedOff });
  }

  async awaitModel(): Promise<void> {
    this.log.awaitModel += 1;
  }

  async toolResult(seq: number, decision: 'allow' | 'deny', reason: string, slots?: readonly OfferedSlotIso[]): Promise<void> {
    this.log.toolResults.push({ at: this.clock.now(), seq, decision, reason, ...(slots ? { slots } : {}) });
  }

  async handOff(twiml: string): Promise<void> {
    this.log.handOffs.push({ at: this.clock.now(), twiml });
    this.handedOff = true;
    if (this.faults.pauseOnHandOff) this.paused = true;
  }

  async close(): Promise<void> {
    this.log.closed = true;
  }
}

/** The opaque answer the fake hands back (no media endpoint exists; nothing is fetched). */
export const fakeStreamTwiml = (sessionId: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="fake-voice://session/${sessionId}"/></Connect></Response>`;

export class FakeVoiceAgent implements VoiceAgentProvider {
  readonly kind = 'fake';
  readonly configured = true;
  readonly statusText = 'Deterministic fake voice agent (tests and development only). No call reaches a vendor.';
  readonly sessions: FakeSessionLog[] = [];
  readonly transports = new Map<string, FakeVoiceTransport>();
  private queue: { script: VoiceScript; faults: FakeFaults }[] = [];
  /** The script every connect without a queued one plays. */
  defaultScript: VoiceScript = { name: 'hang up at once', steps: [] };
  defaultFaults: FakeFaults = {};

  constructor(private readonly clock: Clock = { now: () => instant(Date.now()) }) {}

  /** The next connect plays `script` with `faults`. */
  nextCall(script: VoiceScript, faults: FakeFaults = {}): void {
    this.queue.push({ script, faults });
  }

  transportOf(tenantId: string, sessionId: string): FakeVoiceTransport | undefined {
    return this.transports.get(`${tenantId}:${sessionId}`);
  }

  async connect(i: { callRef: string; sessionId: string; tenantId: string; context: VoiceSessionContext }): Promise<{ response: string; transport: VoiceTransport }> {
    const q = this.queue.shift() ?? { script: this.defaultScript, faults: this.defaultFaults };
    if (q.faults.connectFailure) throw new ProviderError('unavailable', 'FAKE_VOICE_CONNECT_FAILED');
    const log: FakeSessionLog = { sessionId: i.sessionId, tenantId: i.tenantId, callRef: i.callRef, context: i.context, says: [], toolResults: [], handOffs: [], reconnects: 0, awaitModel: 0, closed: false };
    this.sessions.push(log);
    const t = new FakeVoiceTransport(log, q.script, q.faults, this.clock.now());
    this.transports.set(`${i.tenantId}:${i.sessionId}`, t);
    return { response: fakeStreamTwiml(i.sessionId), transport: t };
  }

  async reconnect(i: { sessionId: string; tenantId: string }): Promise<{ response: string }> {
    const t = this.transports.get(`${i.tenantId}:${i.sessionId}`);
    if (!t || t.log.closed) throw new ProviderError('rejected', 'VOICE_SESSION_UNKNOWN');
    t.reconnected();
    return { response: fakeStreamTwiml(i.sessionId) };
  }
}
