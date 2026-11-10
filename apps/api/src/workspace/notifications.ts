// Notifications: the in-app list, per-kind preferences, and the delivery job (BUILD_PLAN module 14;
// ARCHITECTURE §12 delivery guarantees).
//
//   GET  /notifications                 the caller's own notifications, newest first              self
//   POST /notifications/read            mark some / all read                                      self
//   GET  /notification-preferences      every kind with its channels (saved or default)            self
//   PUT  /notification-preferences      one kind's channels / mute / quiet hours                  self
//   (push subscriptions and the alert phone are module 8's device routes)
//
// Delivery (`notify.deliver`, one job per delivery row, sweeper contract NOTIFY_DELIVER):
//   - in-app is the durable record: its delivery row is `delivered` when the notification is created,
//     so the list is right even if every push fails;
//   - at least once per (notification, channel, target): the row is unique, a run claims it under a row
//     lock and only `pending` rows (or a `sending` row whose run died) are sent; the provider idempotency
//     key is the delivery id;
//   - failures retry with jittered backoff 1 m, 2 m, 5 m, 15 m, 1 h, then the row goes `dead` with a
//     platform alert;
//   - preferences apply at delivery time: a muted kind, a channel the user turned off, or personal quiet
//     hours suppress / defer it, EXCEPT the critical kinds (lead_offer, first_touch_due, handback_hot),
//     which can never be muted (DB CHECK + NOTIFICATION_CRITICAL) and are never held by quiet hours;
//   - SMS to the agent's own alert phone goes through api/comms (dispatchAgentAlertSms), which calls
//     canContact(recipient = user) at send time (an agent's STOP is honoured, E60);
//   - lock-screen payloads carry no phone number, email address or message body: the title is the
//     PII-minimized notification title (masked again), the body a fixed sentence per kind.
// The email channel has no outbound path for staff alerts in Phase 1 (contact email is api/comms' and
// R-GATE-2 forbids another sender), so an email delivery is closed as `suppressed`
// (EMAIL_ALERTS_UNAVAILABLE) instead of pretending it went out.
import type { Instant, TenantId, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { maskPii } from '../audit.js';
import { dispatchAgentAlertSms } from '../comms/dispatch.js';
import { asSystem } from '../comms/runtime.js';
import type { CommsDeps } from '../comms/types.js';
import { AppError } from '../errors.js';
import type { PushTarget } from '../providers/types.js';
import type { AlertSink } from '../worker/observability.js';
import { iso, isoOrNull } from './common.js';
import { CRITICAL_KINDS, NOTIFICATION_KINDS, type NotificationSchema, type NotificationsQuery, type PreferenceBody, type PreferenceSchema } from './schemas.js';

export type NotificationView = z.infer<typeof NotificationSchema>;
export type PreferenceView = z.infer<typeof PreferenceSchema>;
type Kind = (typeof NOTIFICATION_KINDS)[number];

export function isCriticalKind(kind: string): boolean {
  return (CRITICAL_KINDS as readonly string[]).includes(kind);
}

// ---- list / read -------------------------------------------------------------------------------------------

export async function listNotifications(tx: Tx, actor: UserActor, q: z.infer<typeof NotificationsQuery>): Promise<{ notifications: NotificationView[]; unread: number }> {
  const unreadOnly = q.unread === 'true';
  const r = await sql<{ id: string; kind: string; priority: NotificationView['priority']; title: string; body: string | null; subject_type: string | null; subject_id: string | null; created_at: Date; read_at: Date | null }>`
    SELECT id, kind, priority, title, body, subject_type, subject_id, created_at, read_at FROM notifications
     WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND (expires_at IS NULL OR expires_at > now())
       AND (NOT ${unreadOnly} OR read_at IS NULL)
     ORDER BY created_at DESC, id DESC LIMIT ${q.limit ?? 50}`.execute(tx);
  return {
    notifications: r.rows.map((n) => ({ id: n.id, kind: n.kind, priority: n.priority, title: n.title, body: n.body, subjectType: n.subject_type, subjectId: n.subject_id, createdAt: iso(n.created_at), readAt: isoOrNull(n.read_at) })),
    unread: await unreadCount(tx, actor),
  };
}

async function unreadCount(tx: Tx, actor: UserActor): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND read_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export async function markRead(tx: Tx, actor: UserActor, b: { ids?: string[]; all?: true }, now: Instant): Promise<{ marked: number; unread: number }> {
  const r = await sql`
    UPDATE notifications SET read_at = ${new Date(now).toISOString()}::timestamptz
     WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND read_at IS NULL
       AND (${b.all === true} OR id = ANY (${b.ids ?? []}::uuid[]))`.execute(tx);
  return { marked: Number(r.numAffectedRows ?? 0), unread: await unreadCount(tx, actor) };
}

// ---- preferences -------------------------------------------------------------------------------------------

const DEFAULT_CHANNELS = ['in_app', 'web_push', 'sms', 'email'];

interface PrefRow {
  kind: string;
  channels: string[];
  muted_until: Date | null;
  quiet_start: string | null;
  quiet_end: string | null;
}

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

function prefView(kind: Kind, row: PrefRow | undefined): PreferenceView {
  return {
    kind,
    channels: (row?.channels ?? DEFAULT_CHANNELS) as PreferenceView['channels'],
    mutedUntil: isoOrNull(row?.muted_until ?? null),
    quietStart: hhmm(row?.quiet_start ?? null),
    quietEnd: hhmm(row?.quiet_end ?? null),
    critical: isCriticalKind(kind),
    saved: row !== undefined,
  };
}

export async function listPreferences(tx: Tx, actor: UserActor): Promise<PreferenceView[]> {
  const r = await sql<PrefRow>`
    SELECT kind, channels, muted_until, quiet_start::text AS quiet_start, quiet_end::text AS quiet_end FROM notification_preferences
     WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}`.execute(tx);
  const byKind = new Map(r.rows.map((x) => [x.kind, x]));
  return NOTIFICATION_KINDS.map((k) => prefView(k, byKind.get(k)));
}

/**
 * PUT /notification-preferences. Critical kinds can never be muted and must keep web push or SMS: the API
 * refuses with NOTIFICATION_CRITICAL (422) before the DB CHECK would (defence in depth).
 */
export async function putPreference(tx: Tx, actor: UserActor, b: z.infer<typeof PreferenceBody>): Promise<PreferenceView> {
  const channels = [...new Set(['in_app', ...b.channels])].sort();
  if (isCriticalKind(b.kind) && ((b.mutedUntil ?? null) !== null || !channels.some((c) => c === 'web_push' || c === 'sms'))) {
    throw new AppError('NOTIFICATION_CRITICAL', { kind: b.kind });
  }
  const r = await sql<PrefRow>`
    INSERT INTO notification_preferences (tenant_id, user_id, kind, channels, muted_until, quiet_start, quiet_end)
    VALUES (app.tenant_id(), ${actor.userId}, ${b.kind}, ${channels}::text[], ${b.mutedUntil ?? null}::timestamptz, ${b.quietStart ?? null}::time, ${b.quietEnd ?? null}::time)
    ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET channels = EXCLUDED.channels, muted_until = EXCLUDED.muted_until,
      quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, updated_at = now()
    RETURNING kind, channels, muted_until, quiet_start::text AS quiet_start, quiet_end::text AS quiet_end`.execute(tx);
  return prefView(b.kind, r.rows[0]);
}

// ---- lock-screen payload -------------------------------------------------------------------------------------

const LOCK_SCREEN_BODY: Record<string, string> = {
  lead_offer: 'Open the app to accept or pass.',
  first_touch_due: 'Open the app to make first contact.',
  first_touch_escalation: 'A new lead still has no first contact.',
  handback: 'Open the app to see what they said.',
  handback_hot: 'Open the app to see what they said.',
  inbound_message: 'Open the app to read and reply.',
  missed_call: 'Open the app to call back.',
  pond_new: 'A lead is waiting in the pond.',
  task_due: 'Open the app to see the task.',
  promise_due: 'Something you promised is due.',
  exception: 'Something needs a look.',
  reassigned_to_you: 'A lead is now yours.',
  reassigned_away: 'A lead moved to someone else.',
  inactivity_warning: 'A lead needs contact soon.',
  opt_out: 'A contact opted out.',
  import_ready: 'Your import is ready to review.',
  system: 'Open the app for details.',
};

const SUBJECT_PATH: Record<string, string> = {
  contact: '/contacts/',
  assistant_action: '/approvals/',
  task: '/tasks/',
  appointment: '/appointments/',
  deal: '/deals/',
  message: '/inbox/',
  call: '/inbox/',
};

/**
 * What a push notification (and the lock screen) shows. Never a phone number, an email address or a
 * message body: the title is the creator's PII-minimized title masked again, the body a fixed sentence.
 */
export function lockScreenPayload(n: { id: string; kind: string; title: string; subjectType: string | null; subjectId: string | null }): { title: string; body: string; url: string; tag: string } {
  const prefix = n.subjectType ? SUBJECT_PATH[n.subjectType] : undefined;
  return {
    title: maskPii(n.title).slice(0, 120),
    body: LOCK_SCREEN_BODY[n.kind] ?? LOCK_SCREEN_BODY.system!,
    url: prefix && n.subjectId ? `${prefix}${n.subjectId}` : '/notifications',
    tag: n.id,
  };
}

// ---- delivery ------------------------------------------------------------------------------------------------

/** Retry delays after the 1st … 5th failed attempt (ARCHITECTURE §12); a 6th failure is `dead`. */
export const RETRY_SCHEDULE_MS = [60_000, 120_000, 300_000, 900_000, 3_600_000] as const;
/** A `sending` row older than this belongs to a run that died: it is sent again (at least once). */
export const SENDING_LEASE_MS = 2 * 60_000;

/** Jittered delay (±20 %) before the retry after `attempts` failures, or null when it is time to give up. */
export function retryDelay(attempts: number, random: () => number): number | null {
  const base = RETRY_SCHEDULE_MS[attempts - 1];
  if (base === undefined) return null;
  return Math.round(base * (0.8 + 0.4 * Math.min(Math.max(random(), 0), 1)));
}

/** Minutes from local `now` until the end of a quiet window, or null when not inside it. */
export function quietRemainingMs(now: Instant, zone: string, start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const cur = h * 60 + m;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(start);
  const e = toMin(end);
  const inside = s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inside) return null;
  return (((e - cur + 1440) % 1440) || 1440) * 60_000;
}

export interface DeliveryDeps extends CommsDeps {
  alerts?: AlertSink;
  random?: () => number;
}

export type DeliveryOutcome =
  | { kind: 'sent' }
  | { kind: 'suppressed'; reason: string }
  | { kind: 'retry'; at: Instant; reason: string }
  | { kind: 'dead'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'noop' };

interface DeliveryRow {
  id: string;
  status: string;
  channel: 'in_app' | 'web_push' | 'sms' | 'email';
  target_ref: string;
  attempts: number;
  updated_at: Date;
  notification_id: string;
  user_id: string;
  kind: string;
  title: string;
  subject_type: string | null;
  subject_id: string | null;
  expires_at: Date | null;
  channels: string[] | null;
  muted_until: Date | null;
  quiet_start: string | null;
  quiet_end: string | null;
  zone: string;
}

async function setStatus(tx: Tx, id: string, status: string, o: { error?: string | null; nextAt?: Instant | null; bump?: boolean; providerRef?: string | null } = {}): Promise<void> {
  await sql`
    UPDATE notification_deliveries SET status = ${status}, last_error = ${o.error ?? null},
           next_attempt_at = ${o.nextAt ? new Date(o.nextAt).toISOString() : null}::timestamptz,
           attempts = attempts + ${o.bump ? 1 : 0}, provider_ref = COALESCE(${o.providerRef ?? null}, provider_ref), updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** After a failed attempt: back to pending at the next backoff step, or dead with an alert. */
async function failAttempt(tx: Tx, deps: DeliveryDeps, tenantId: string, d: { id: string; attempts: number; channel: string }, reason: string, now: Instant): Promise<DeliveryOutcome> {
  const delay = retryDelay(d.attempts, deps.random ?? Math.random);
  if (delay === null) {
    await setStatus(tx, d.id, 'dead', { error: reason });
    deps.alerts?.raise({ severity: 'P2', code: 'JOB_DEAD', tenantId, details: { kind: 'notify.deliver', deliveryId: d.id, channel: d.channel, reason } });
    return { kind: 'dead', reason };
  }
  const at = (now + delay) as Instant;
  await setStatus(tx, d.id, 'pending', { error: reason, nextAt: at });
  return { kind: 'retry', at, reason };
}

/**
 * One delivery attempt of one notification delivery row, as the system actor of its tenant. Idempotent:
 * a row that is no longer due (sent, suppressed, dead, or being sent by a live run) is a no-op.
 */
export async function deliverNotification(deliveryId: string, deps: DeliveryDeps, tenantId: string): Promise<DeliveryOutcome> {
  type Plan = { kind: 'done'; out: DeliveryOutcome } | { kind: 'push'; d: DeliveryRow; target: PushTarget } | { kind: 'sms'; d: DeliveryRow };
  const plan: Plan = await asSystem(deps, tenantId, 'worker', async (tx, now) => {
    const r = await sql<DeliveryRow>`
      SELECT d.id, d.status, d.channel, d.target_ref, d.attempts, d.updated_at, n.id AS notification_id, n.user_id, n.kind, n.title, n.subject_type, n.subject_id,
             n.expires_at, p.channels, p.muted_until, p.quiet_start::text AS quiet_start, p.quiet_end::text AS quiet_end, s.default_timezone AS zone
        FROM notification_deliveries d
        JOIN notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id
        JOIN tenant_settings s ON s.tenant_id = d.tenant_id
        LEFT JOIN notification_preferences p ON p.tenant_id = n.tenant_id AND p.user_id = n.user_id AND p.kind = n.kind
       WHERE d.tenant_id = app.tenant_id() AND d.id = ${deliveryId}
       FOR UPDATE OF d SKIP LOCKED`.execute(tx);
    const d = r.rows[0];
    if (!d) return { kind: 'done', out: { kind: 'noop' } };
    const crashed = d.status === 'sending' && now - d.updated_at.getTime() > SENDING_LEASE_MS;
    if (d.status !== 'pending' && !crashed) return { kind: 'done', out: { kind: 'noop' } };
    if (d.channel === 'in_app') {
      await setStatus(tx, d.id, 'delivered');
      return { kind: 'done', out: { kind: 'sent' } };
    }
    const suppress = async (reason: string): Promise<Plan> => {
      await setStatus(tx, d.id, 'suppressed', { error: reason });
      return { kind: 'done', out: { kind: 'suppressed', reason } };
    };
    if (d.expires_at && d.expires_at.getTime() <= now) return suppress('EXPIRED');
    if (!isCriticalKind(d.kind)) {
      if (d.muted_until && d.muted_until.getTime() > now) return suppress('MUTED');
      if (d.channels && !d.channels.includes(d.channel)) return suppress('CHANNEL_OFF');
      const wait = quietRemainingMs(now, d.zone, d.quiet_start, d.quiet_end);
      if (wait !== null) {
        const at = (now + wait) as Instant;
        await setStatus(tx, d.id, 'pending', { error: 'QUIET_HOURS', nextAt: at });
        return { kind: 'done', out: { kind: 'retry', at, reason: 'QUIET_HOURS' } };
      }
    }
    if (d.channel === 'email') return suppress('EMAIL_ALERTS_UNAVAILABLE');
    if (d.channel === 'sms') {
      // a crashed `sending` SMS row goes back to pending so comms' send-time gate runs again
      if (crashed) await setStatus(tx, d.id, 'pending', { nextAt: now });
      return { kind: 'sms', d };
    }
    // web push: the subscription is the target (encrypted at rest, AAD bound to the row)
    const s = await sql<{ id: string; endpoint_enc: Buffer; keys_enc: Buffer; revoked_at: Date | null; user_id: string }>`
      SELECT id, endpoint_enc, keys_enc, revoked_at, user_id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND id::text = ${d.target_ref}`.execute(tx);
    const sub = s.rows[0];
    if (!sub || sub.revoked_at !== null || sub.user_id !== d.user_id) return suppress('SUBSCRIPTION_REVOKED');
    const env = deps.envelope.inTx(tx, tenantId as TenantId);
    const endpoint = Buffer.from(await env.decrypt(tenantId as TenantId, { table: 'push_subscriptions', column: 'endpoint_enc', rowId: sub.id }, new Uint8Array(sub.endpoint_enc))).toString('utf8');
    const keys = JSON.parse(Buffer.from(await env.decrypt(tenantId as TenantId, { table: 'push_subscriptions', column: 'keys_enc', rowId: sub.id }, new Uint8Array(sub.keys_enc))).toString('utf8')) as PushTarget['keys'];
    await setStatus(tx, d.id, 'sending', { bump: true });
    return { kind: 'push', d: { ...d, attempts: d.attempts + 1 }, target: { endpoint, keys } };
  });
  if (plan.kind === 'done') return plan.out;

  if (plan.kind === 'sms') {
    const res = await dispatchAgentAlertSms(deliveryId, deps, tenantId);
    if (res.kind !== 'failed') return res.kind === 'sent' ? { kind: 'sent' } : res.kind === 'suppressed' ? { kind: 'suppressed', reason: res.reasons[0] ?? 'DENIED' } : { kind: 'noop' };
    return asSystem(deps, tenantId, 'worker', async (tx, now) => {
      const a = await sql<{ attempts: number; status: string }>`SELECT attempts, status FROM notification_deliveries WHERE tenant_id = app.tenant_id() AND id = ${deliveryId} FOR UPDATE`.execute(tx);
      const row = a.rows[0];
      if (!row || row.status !== 'failed') return { kind: 'noop' } as DeliveryOutcome;
      return failAttempt(tx, deps, tenantId, { id: deliveryId, attempts: row.attempts, channel: 'sms' }, res.reason, now);
    });
  }

  const d = plan.d;
  let status: 'sent' | 'gone' | 'failed';
  try {
    status = (await deps.providers.push.deliverPush(plan.target, lockScreenPayload({ id: d.notification_id, kind: d.kind, title: d.title, subjectType: d.subject_type, subjectId: d.subject_id }))).status;
  } catch {
    status = 'failed';
  }
  return asSystem(deps, tenantId, 'provider', async (tx, now) => {
    if (status === 'sent') {
      await setStatus(tx, d.id, 'sent');
      await sql`UPDATE push_subscriptions SET last_seen_at = now() WHERE tenant_id = app.tenant_id() AND id::text = ${d.target_ref}`.execute(tx);
      return { kind: 'sent' } as DeliveryOutcome;
    }
    if (status === 'gone') {
      // the device unsubscribed (410/404): revoke it, never retry this target
      await sql`UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, now()) WHERE tenant_id = app.tenant_id() AND id::text = ${d.target_ref}`.execute(tx);
      await setStatus(tx, d.id, 'failed', { error: 'SUBSCRIPTION_GONE' });
      return { kind: 'failed', reason: 'SUBSCRIPTION_GONE' } as DeliveryOutcome;
    }
    return failAttempt(tx, deps, tenantId, { id: d.id, attempts: d.attempts, channel: d.channel }, 'PUSH_FAILED', now);
  });
}
