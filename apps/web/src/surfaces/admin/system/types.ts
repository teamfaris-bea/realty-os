// Response shapes of the System page API (apps/api/src/observability/systemRoutes.ts, Zod schemas
// JobView / StuckMessage / LateTimer / Overview / CommandResponse). Kept field-for-field in step.

export interface JobView {
  id: string;
  kind: string;
  kindLabel: string;
  queue: string;
  state: 'dead' | 'retrying';
  attempts: number;
  maxAttempts: number;
  reason: { code: string; sentence: string; retryHelps: boolean };
  /** scrubbed technical error text (codes, SQLSTATE; never PII), for support */
  detail: string | null;
  nextRunAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  canRetry: boolean;
  canCancel: boolean;
}

export type ReconcileState = 'sending' | 'awaiting_recovery' | 'checking_provider' | 'unresolved';

export interface StuckMessage {
  id: string;
  contactId: string;
  channel: string;
  status: 'dispatching' | 'dispatch_unknown';
  dispatchedAt: string | null;
  ageSeconds: number;
  reconcile: { state: ReconcileState; sentence: string; nextStepAt: string | null };
}

export interface LateTimer {
  contactId: string;
  kind: 'offer_expired' | 'first_touch_breached' | 'auto_released';
  label: string;
  dueAt: string;
  firedAt: string;
  lateSeconds: number;
}

export interface ConnectionHealth {
  id: string;
  kind: string;
  name: string;
  status: string;
  statusReason: string | null;
  lastErrorCode: string | null;
  lastSyncedAt: string | null;
}

export interface RegistrationHealth {
  id: string;
  kind: string;
  status: string;
  changedAt: string;
}

export interface ChannelResult {
  channel: string;
  sent: number;
  failed: number;
  inFlight: number;
}

export interface SystemOverview {
  generatedAt: string;
  jobs: { counts: { dead: number; retrying: number }; dead: JobView[]; retrying: JobView[] };
  messages: StuckMessage[];
  timers: { windowHours: number; thresholdSeconds: number; fired: number; lateCount: number; late: LateTimer[] };
  connections: ConnectionHealth[];
  registrations: RegistrationHealth[];
  channels: ChannelResult[];
}

export interface JobCommandResponse {
  result: 'retried' | 'cancelled';
  job: JobView | null;
}
