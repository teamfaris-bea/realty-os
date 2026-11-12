// Module 48's dependencies and its in-process session registry (keyed tenantId:callId; sessionId = calls.id).
//
// A session runs in the process that took the call over. A restart, or a provider retry that reaches another
// instance, finds no session here: that call gets the voicemail TwiML and voice.reconcile writes its recovery
// handback (R-VOICE-7, R-VOICE-21). Nothing here sends, dials or changes ownership.
import type { Clock, IdGenerator } from '@realty/core/foundation';
import type { HotRule } from '@realty/core/voice';
import type { Database } from '@realty/db';
import { type CalendarDeps, bookSlot } from '../calendar/service.js';
import { calendarDeps } from '../calendar/routes.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { depsFromPlatform } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import type { Providers } from '../providers/index.js';
import type { Platform } from '../server.js';
import type { VoiceAgentProvider } from './provider.js';
import type { SessionResult } from './session.js';

export interface VoiceDeps {
  db: Database;
  ids: IdGenerator;
  clock: Clock;
  envelope: EnvelopeService;
  providers: Providers;
  voiceAgent: VoiceAgentProvider;
  comms: CommsDeps;
  calendar: CalendarDeps;
  /** which telephony adapter is live (a fake voice agent never answers real telephony) */
  telephonyProvider: 'fake' | 'twilio';
  /** batch 9's kill switch (TELEPHONY_LIVE_REQUESTS): off ⇒ no AI takeover on real telephony (O5) */
  telephonyLiveRequests: boolean;
  /** O2: no hot-rule storage exists; production answers null for every tenant (nobody is transferred live) */
  hotRuleFor: (tenantId: string) => HotRule | null;
  /** bookSlot (calendar/service.ts); a test seam for late booking results */
  bookSlot: typeof bookSlot;
  registry: SessionRegistry;
}

export interface SessionEntry {
  tenantId: string;
  callId: string;
  /** null: the session failed (voice.reconcile recovers it) */
  done: Promise<SessionResult | null>;
}

const MAX_FINISHED = 200;

/** The sessions running in this process. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly finished = new Map<string, Promise<SessionResult | null>>();

  key(tenantId: string, callId: string): string {
    return `${tenantId}:${callId}`;
  }

  add(e: SessionEntry): void {
    const k = this.key(e.tenantId, e.callId);
    this.sessions.set(k, e);
    this.finished.set(k, e.done);
    // keep the last results only (tests read them; production never needs old ones)
    while (this.finished.size > MAX_FINISHED) this.finished.delete(this.finished.keys().next().value as string);
    void e.done.finally(() => this.sessions.delete(k));
  }

  has(tenantId: string, callId: string): boolean {
    return this.sessions.has(this.key(tenantId, callId));
  }

  /** Resolves when the session of this call finished (immediately when none ran here). */
  async settled(tenantId: string, callId: string): Promise<SessionResult | null> {
    return (await this.finished.get(this.key(tenantId, callId))) ?? null;
  }

  get size(): number {
    return this.sessions.size;
  }
}

const registries = new WeakMap<object, SessionRegistry>();
type Seams = Partial<Pick<VoiceDeps, 'hotRuleFor' | 'bookSlot' | 'telephonyProvider' | 'telephonyLiveRequests' | 'voiceAgent'>>;
const seams = new WeakMap<object, Seams>();

/** Tests only: a hot rule (none ships, O2), a delayed bookSlot, another telephony setting or voice agent, for one server. */
export function setVoiceTestSeams(p: Platform, s: Seams): void {
  seams.set(p, { ...(seams.get(p) ?? {}), ...s });
}

export function clearVoiceTestSeams(p: Platform): void {
  seams.delete(p);
}

export function voiceDeps(p: Platform): VoiceDeps {
  let registry = registries.get(p);
  if (!registry) {
    registry = new SessionRegistry();
    registries.set(p, registry);
  }
  const s = seams.get(p) ?? {};
  return {
    db: p.db,
    ids: p.ids,
    clock: p.clock,
    envelope: p.envelope,
    providers: p.providers,
    voiceAgent: s.voiceAgent ?? p.providers.voiceAgent,
    comms: depsFromPlatform(p),
    calendar: calendarDeps(p),
    telephonyProvider: s.telephonyProvider ?? p.config.providers.telephony,
    telephonyLiveRequests: s.telephonyLiveRequests ?? p.config.telephonyLiveRequests,
    hotRuleFor: s.hotRuleFor ?? (() => null),
    bookSlot: s.bookSlot ?? bookSlot,
    registry,
  };
}
