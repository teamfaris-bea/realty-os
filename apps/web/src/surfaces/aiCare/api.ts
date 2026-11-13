// Module 76 data layer: the AI ISA view types (they mirror apps/api/src/isa/schemas.ts and isaWeb/routes.ts field for
// field; apps/web may not import @realty/api, and aiCare/api.contract.test.tsx proves the fixtures and requests fit
// isaWeb/webContract.json), the query keys, the one shared live query and useIsaAction.
//
// - useIsaAction never sends a command id: every ISA body is a z.strictObject, so useCommand's commandId would be a
//   400 (V2). One tap sends one request (a second tap while it is in flight gets the same promise); REAUTH_REQUIRED
//   opens the shell's password prompt once and re-sends the same request (R-PERM-13).
// - useIsaLive is the ONE source every AI care surface reads for the hold sentence and for "is this contact under live
//   care" (V3): ['ai-isa','list',{scope:'all',state:'live'}], 30 s stale, refetched on focus and after every control.
//   It is never fetched for a TC (R-PERM-5), and a 403/404 on any read renders nothing.
import { type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, useApi, useRequestReauth, useSession } from '../../shell/index.js';
import { isaMessage } from './words.js';

export type Side = 'buyer' | 'seller' | 'both';
export type Channel = 'sms' | 'email';
export type IsaState = 'starting' | 'awaiting_reply' | 'engaged' | 'nurture' | 'scheduling' | 'booking' | 'awaiting_agent' | 'paused' | 'ended';
export type LinkEffect = 'ok' | 'hold' | 'pause' | 'end';
export type ChipKind = 'active' | 'waiting_reply' | 'reply_scheduled' | 'scheduling' | 'waiting_on_agent' | 'paused' | 'held' | 'ended';

export interface AdminView {
  enabled: boolean;
  aiEnabled: boolean;
  dailyCap: number;
  sentToday: number;
  packCleared: boolean;
  liveSends: boolean;
  holdSentence: string | null;
  enabledByUserId: string | null;
  enabledAt: string | null;
  overdueHandoffs: number;
  underCare: number;
  noticeSentence: string;
}
export interface AdminPutBody {
  enabled: boolean;
  dailyCap: number;
  attestation?: string;
}
export interface AvailabilityWindow {
  weekday: number;
  start: string;
  end: string;
}
export interface OptInBody {
  versionId: string;
  capabilities: string[];
  channels: Channel[];
  timezone: string;
  availability: AvailabilityWindow[];
  bookingKinds: ('buyer_consult' | 'listing_appointment' | 'consult')[];
}
export interface MeView {
  optIn: { id: string; versionId: string; capabilities: string[]; channels: string[]; timezone: string; availability: AvailabilityWindow[]; bookingKinds: string[]; createdAt: string } | null;
  policy: { versionId: string; versionSha: string; capabilities: string[]; channels: string[] } | null;
  attestationText: string | null;
  needsReattest: boolean;
  calendarLive: boolean;
  /** b13 review B13S-2: the capabilities this deployment builds (the API's one list) */
  builtCapabilities: string[];
  underCare: number;
  sentence: string;
}
export interface OptInResult {
  optInId: string;
  change: 'created' | 'narrowed' | 'superseded';
}
export interface ReattestResult {
  continued: { contactId: string; assignmentId: string }[];
  notContinued: { contactId: string; code: string; sentence: string }[];
}
export interface StateChip {
  kind: ChipKind;
  sentence: string;
}
export interface ListRow {
  assignmentId: string;
  contactId: string;
  name: string;
  side: Side;
  chip: StateChip;
  lastAction: { code: string; at: string; sentence: string } | null;
  nextTouchAt: string | null;
  capsSentence: string;
  inactivityReleaseAt: string | null;
  ownerUserId: string;
  ownerName: string;
  handoffOverdue: boolean;
}
export interface ListResponse {
  rows: ListRow[];
  holdSentence: string | null;
}
export interface ChainLink {
  link: number;
  name: string;
  effect: LinkEffect;
  code: string | null;
  sentence: string;
}
export interface PanelAssignment {
  id: string;
  side: Side;
  state: IsaState;
  chip: StateChip;
  epoch: number;
  startedAt: string;
  pausedAt: string | null;
  pauseReason: string | null;
  pausedSentence: string | null;
  endedAt: string | null;
  endReason: string | null;
  undoUntil: string | null;
  ownerUserId: string;
}
export interface PanelHandoff {
  id: string;
  reason: string;
  slaClass: SlaClass;
  slaDueAt: string;
  slaMetAt: string | null;
  overdue: boolean;
  confirmationStatus: string;
  closedReason: HandoffClosedReason | null;
}
export interface PanelResponse {
  contactId: string;
  assignment: PanelAssignment | null;
  canStart: boolean;
  startRefusal: { code: string; sentence: string } | null;
  canResume: boolean;
  chain: ChainLink[];
  capabilities: { capability: string; allowed: boolean; built: boolean; sentence: string }[];
  consent: { channel: Channel; sentence: string }[];
  zones: { zones: string[]; source: 'explicit' | 'union'; sentence: string };
  nextAllowedSendAt: string | null;
  capsSentence: string;
  lastDecision: { status: string; codes: string[]; at: string; sentence: string } | null;
  factsSent: { factKind: string; listingId: string | null; sentAt: string; source: string | null; asOf: string | null }[];
  openOffer: { id: string; status: string; slots: { startsAt: string; endsAt: string }[]; expiresAt: string } | null;
  heldTopics: { class: string; since: string; sentence: string }[];
  handoff: PanelHandoff | null;
  /** batch 13 isa-4 (b12 recheck R16 follow-up): the newest still-open handoff of an earlier assignment (a restart with no touch leaves it open) */
  earlierHandoff: PanelHandoff | null;
  inactivityReleaseAt: string | null;
  inactivitySentence: string | null;
  block: { reason: string; since: string; sentence: string } | null;
  /** ISA-3 (not built): the seller subject to confirm; absent today */
  seller?: Record<string, unknown> | null;
}
export interface TurnRow {
  id: string;
  seq: number;
  epoch: number;
  attempt: number;
  triggerKind: string;
  status: string;
  stateBefore: string;
  stateAfter: string | null;
  channel: Channel | null;
  messageKind: 'reply' | 'initiated' | null;
  messageId: string | null;
  notBefore: string | null;
  zones: string[] | null;
  decision: Record<string, unknown>;
  denied: unknown[];
  versions: { rules: string; policy: string; prompt: string };
  createdAt: string;
}
export interface TurnsResponse {
  turns: TurnRow[];
}
export interface ControlResult {
  assignmentId: string;
  state: IsaState;
  epoch: number;
  inFlight: { messageId: string; at: string; sentence: string }[];
  canceled: number;
  undoUntil: string | null;
  sentence: string;
}
export interface StartResult extends ControlResult {
  stoppedEnrollment: boolean;
  supersededProposals: number;
}
export interface AckResult {
  handoffId: string;
  acknowledgedAt: string;
  slaMet: boolean;
  confirmationStatus: string;
  /** why the system closed the handoff (0081, b12 recheck R19); null while it is open */
  closedReason: HandoffClosedReason | null;
}
export interface ResolveResult {
  assignmentId: string;
  cleared: string;
}

/** A handoff's deadline class (0080's CHECK, plus 0081's 'none': no human touch can clear it, so no deadline). */
export const SLA_CLASSES = ['critical', 'high', 'normal', 'low', 'none'] as const;
export type SlaClass = (typeof SLA_CLASSES)[number];
/** Why the system closed a handoff (0081's ai_isa_handoffs.closed_reason CHECK; api isa/schemas.ts HANDOFF_CLOSE_REASONS). */
export const HANDOFF_CLOSED_REASONS = ['deadline_met', 'acknowledged', 'lead_closed', 'care_restarted', 'care_continued'] as const;
export type HandoffClosedReason = (typeof HANDOFF_CLOSED_REASONS)[number];

/** GET /ai-isa/handoffs/:id (apps/api/src/isaWeb/routes.ts) */
export interface HandoffPackage {
  v?: number;
  reason?: string;
  escalation?: string | null;
  priority?: string;
  basis?: { rule: string; ruleVersion: string; claimIds: string[] } | null;
  appointment?: { appointmentId: string; kind: string; confirmationQueued: boolean } | null;
  openOffer?: { offerId: string; slots: { startsAt: string; endsAt: string }[]; deliveredAt: string | null; expiresAt: string | null } | null;
  commitments?: string[];
  claims?: { claimId: string; field: string; value: unknown; quote: string; messageId: string }[];
  conversation?: { seq: number; status: string; messageId: string | null }[];
  factsSent?: { factKind: string; listingId: string | null; messageId: string | null }[];
  unansweredInbound?: string[];
  nextSteps?: string[];
  notes?: string[];
  startedAt?: string;
  epoch?: number;
  // ISA-2b (isa/handoff.ts, isa/booking/book.ts; batch 13 isa-4 F6)
  appointmentDetail?: { kind?: string; startsAt?: string | null; endsAt?: string | null; organizerUserId?: string | null; acceptedMessageId?: string | null; acceptedQuote?: string | null; zones?: string[]; [k: string]: unknown } | null;
  inactivityReleaseAt?: string | null;
  savedSearch?: { id: string; status: string; [k: string]: unknown } | null;
  recipientUserId?: string | null;
  endedByUserId?: string | null;
  [k: string]: unknown;
}
export interface HandoffView {
  id: string;
  assignmentId: string;
  contactId: string;
  reason: string;
  slaClass: SlaClass;
  slaDueAt: string;
  slaMetAt: string | null;
  overdue: boolean;
  closedReason: HandoffClosedReason | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  recipientUserId: string | null;
  canAcknowledge: boolean;
  confirmationStatus: string;
  pendingMessage: { id: string; kind: 'confirmation' | 'holding_line'; channel: string; status: string; scheduledFor: string | null } | null;
  package: HandoffPackage;
}

// ---- keys --------------------------------------------------------------------------------------------------------

export type ListScope = 'mine' | 'team' | 'all';
export type ListState = 'live' | 'paused' | 'ended' | 'any';
export const ISA_KEY = ['ai-isa'] as const;
export const isaKeys = {
  list: (scope: ListScope, state: ListState) => ['ai-isa', 'list', { scope, state }] as const,
  live: () => ['ai-isa', 'list', { scope: 'all', state: 'live' }] as const,
  panel: (contactId: string) => ['ai-isa', 'panel', contactId] as const,
  turns: (contactId: string) => ['ai-isa', 'turns', contactId] as const,
  me: () => ['ai-isa', 'me'] as const,
  admin: () => ['ai-isa', 'admin'] as const,
  handoff: (id: string) => ['ai-isa', 'handoff', id] as const,
};

/** A role that never sees AI care (R-PERM-5: tc has no ai_isa.view grant). */
export function useIsaVisible(): boolean {
  const role = useSession().session?.tenant?.role;
  return role !== undefined && role !== 'tc';
}

/** A 403 or 404 on a read renders nothing (R-PERM-5): no retry, no error state. */
const quiet = (failureCount: number, e: unknown) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && failureCount < 2;

export function useIsaLive(enabled = true) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<ListResponse, ApiError>({
    queryKey: isaKeys.live(),
    queryFn: ({ signal }) => api.get<ListResponse>('/ai-isa/assignments?scope=all&state=live', { signal }),
    enabled: visible && enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: quiet,
  });
}

/** The live row of a contact, from the shared query (one per contact: the newest). */
export function useLiveRow(contactId: string | null | undefined): ListRow | null {
  // no contact, no fetch (R-PERM-6: a pond or offer card requests nothing about AI care)
  const q = useIsaLive(!!contactId);
  if (!contactId) return null;
  return q.data?.rows.find((r) => r.contactId === contactId) ?? null;
}

export function useIsaList(scope: ListScope, state: ListState) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<ListResponse, ApiError>({
    queryKey: isaKeys.list(scope, state),
    queryFn: ({ signal }) => api.get<ListResponse>(`/ai-isa/assignments?scope=${scope}&state=${state}`, { signal }),
    enabled: visible,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: quiet,
  });
}

export function usePanel(contactId: string, enabled = true) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<PanelResponse, ApiError>({
    queryKey: isaKeys.panel(contactId),
    queryFn: ({ signal }) => api.get<PanelResponse>(`/contacts/${contactId}/ai-isa`, { signal }),
    enabled: visible && enabled && contactId !== '',
    staleTime: 15_000,
    retry: quiet,
  });
}

export function useTurns(contactId: string, enabled = true) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<TurnsResponse, ApiError>({
    queryKey: isaKeys.turns(contactId),
    queryFn: ({ signal }) => api.get<TurnsResponse>(`/contacts/${contactId}/ai-isa/turns`, { signal }),
    enabled: visible && enabled && contactId !== '',
    staleTime: 15_000,
    retry: quiet,
  });
}

export function useMe(enabled = true) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<MeView, ApiError>({ queryKey: isaKeys.me(), queryFn: ({ signal }) => api.get<MeView>('/me/ai-isa', { signal }), enabled: visible && enabled, retry: quiet });
}

export function useAdmin(enabled = true) {
  const api = useApi();
  return useQuery<AdminView, ApiError>({ queryKey: isaKeys.admin(), queryFn: ({ signal }) => api.get<AdminView>('/admin/ai-isa', { signal }), enabled, retry: quiet });
}

export function useHandoff(id: string | null | undefined) {
  const api = useApi();
  const visible = useIsaVisible();
  return useQuery<HandoffView, ApiError>({
    queryKey: isaKeys.handoff(id ?? ''),
    queryFn: ({ signal }) => api.get<HandoffView>(`/ai-isa/handoffs/${id}`, { signal }),
    enabled: visible && !!id,
    retry: quiet,
  });
}

// ---- actions -----------------------------------------------------------------------------------------------------

export type IsaFailure = { ok: false; code: string; message: string; status: number; details: Record<string, unknown> | null };
export type IsaResult<R> = { ok: true; data: R } | IsaFailure;

export interface IsaAction<B, R> {
  run(path: string, body?: B): Promise<IsaResult<R>>;
  pending: boolean;
  error: IsaFailure | null;
  reset(): void;
}

export function failureOf(e: unknown, local?: Readonly<Record<string, string>>): IsaFailure {
  const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
  return { ok: false, code: err.code, status: err.status, details: err.details, message: isaMessage(err, local) };
}

/**
 * What an action refetches: every AI care query, the feed and the contact's timeline; start and continue also the
 * inbox (they supersede drafts and handbacks).
 */
export function invalidationsFor(kind: string, contactId?: string | null): QueryKey[] {
  const keys: QueryKey[] = [[...ISA_KEY], ['feed']];
  if (contactId) keys.push(['timeline', contactId]);
  if (kind === 'start' || kind === 'continue') keys.push(['inbox']);
  return keys;
}

export function useIsaAction<B = Record<string, never>, R = unknown>(method: 'POST' | 'PUT', o: { kind: string; contactId?: string | null; local?: Readonly<Record<string, string>> }): IsaAction<B, R> {
  const api = useApi();
  const qc = useQueryClient();
  const requestReauth = useRequestReauth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<IsaFailure | null>(null);
  const inFlight = useRef<Promise<IsaResult<R>> | null>(null);
  const opts = useRef(o);
  opts.current = o;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    (path: string, body?: B): Promise<IsaResult<R>> => {
      if (inFlight.current) return inFlight.current;
      const p = (async (): Promise<IsaResult<R>> => {
        setPending(true);
        setError(null);
        let reauthed = false;
        try {
          for (;;) {
            try {
              const data = await api.request<R>(method, path, body ?? {});
              return { ok: true as const, data };
            } catch (e) {
              if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && !reauthed) {
                reauthed = true;
                if (await requestReauth()) continue;
              }
              const f = failureOf(e, opts.current.local);
              if (mounted.current) setError(f);
              return f;
            }
          }
        } finally {
          inFlight.current = null;
          if (mounted.current) setPending(false);
          for (const key of invalidationsFor(opts.current.kind, opts.current.contactId)) void qc.invalidateQueries({ queryKey: key });
        }
      })();
      inFlight.current = p;
      return p;
    },
    [api, method, qc, requestReauth],
  );
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}
