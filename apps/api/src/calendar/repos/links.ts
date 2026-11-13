// SQL of api/calendar (module 34). Every query runs inside withTenantTx: RLS decides what exists. On
// user_calendar_links that is the link's own person or the system actor only (0018 calendar_links_self, R-CAL-1).
// The token columns (access_enc, refresh_enc) are selected ONLY by loadSecrets, which the service calls as the
// system actor (R-INT-4); no other query here reads them, and nothing returns them to a route.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { CalendarProviderKey } from '../catalog.js';

export interface LinkRow {
  id: string;
  user_id: string;
  provider: CalendarProviderKey;
  status: 'pending_review' | 'connected' | 'degraded' | 'revoked';
  scopes: string[];
  external_calendar_ref: string | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** updated_at in microseconds: the OAuth state fence */
  fence: string;
}

const LINK_COLS = sql`id, user_id, provider, status, scopes, external_calendar_ref, last_synced_at, last_error_code, revoked_at, created_at, updated_at,
  (extract(epoch FROM updated_at) * 1000000)::bigint::text AS fence`;

export async function linksOfUser(tx: Tx, userId: string): Promise<LinkRow[]> {
  return (await sql<LinkRow>`SELECT ${LINK_COLS} FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${userId} ORDER BY provider`.execute(tx)).rows;
}

export async function linkOf(tx: Tx, userId: string, provider: CalendarProviderKey, o: { forUpdate?: boolean } = {}): Promise<LinkRow | null> {
  const r = await sql<LinkRow>`SELECT ${LINK_COLS} FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND provider = ${provider}
    ${o.forUpdate ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

/** The person's live link (connected or degraded). The connect flow keeps at most one live link per person. */
export async function liveLinkOf(tx: Tx, userId: string): Promise<LinkRow | null> {
  const r = await sql<LinkRow>`SELECT ${LINK_COLS} FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status IN ('connected','degraded')
    ORDER BY provider LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

export interface LinkSecrets {
  access_enc: Buffer | null;
  refresh_enc: Buffer | null;
}

/** System actor only (R-INT-4): the encrypted token columns of one link. */
export async function loadSecrets(tx: Tx, linkId: string): Promise<LinkSecrets | null> {
  const r = await sql<LinkSecrets>`SELECT access_enc, refresh_enc FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND id = ${linkId} AND app.actor_kind() = 'system'`.execute(tx);
  return r.rows[0] ?? null;
}

export async function insertConnected(tx: Tx, l: { id: string; userId: string; provider: CalendarProviderKey; scopes: string[]; accessEnc: Uint8Array; refreshEnc: Uint8Array | null; keyVersion: number; calendarRef: string }): Promise<void> {
  await sql`INSERT INTO user_calendar_links (tenant_id, id, user_id, provider, status, scopes, access_enc, refresh_enc, key_version, external_calendar_ref)
    VALUES (app.tenant_id(), ${l.id}, ${l.userId}, ${l.provider}, 'connected', ${l.scopes}::text[], ${Buffer.from(l.accessEnc)}, ${l.refreshEnc ? Buffer.from(l.refreshEnc) : null},
            ${l.keyVersion}, ${l.calendarRef})`.execute(tx);
}

export async function reconnect(tx: Tx, id: string, l: { scopes: string[]; accessEnc: Uint8Array; refreshEnc: Uint8Array | null; keyVersion: number; calendarRef: string }): Promise<void> {
  await sql`UPDATE user_calendar_links SET status = 'connected', scopes = ${l.scopes}::text[], access_enc = ${Buffer.from(l.accessEnc)}, refresh_enc = ${l.refreshEnc ? Buffer.from(l.refreshEnc) : null},
      key_version = ${l.keyVersion}, external_calendar_ref = ${l.calendarRef}, last_error_code = NULL, revoked_at = NULL, purge_after = NULL
    WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** A fresh token from the lazy refresh (system actor). */
export async function storeRefreshed(tx: Tx, id: string, l: { accessEnc: Uint8Array; refreshEnc: Uint8Array | null; keyVersion: number }): Promise<void> {
  await sql`UPDATE user_calendar_links SET access_enc = ${Buffer.from(l.accessEnc)}, refresh_enc = COALESCE(${l.refreshEnc ? Buffer.from(l.refreshEnc) : null}, refresh_enc), key_version = ${l.keyVersion}
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('connected','degraded')`.execute(tx);
}

/**
 * Revoked locally AND purged in the same statement (R-INT-5, R-CAL-4): no token survives the row's revocation.
 * `code` is null for a person's own disconnect, a code (GRANT_REVOKED, MEMBER_REMOVED) otherwise.
 */
export async function revokeAndPurge(tx: Tx, id: string, code: string | null): Promise<number> {
  const r = await sql`UPDATE user_calendar_links SET status = 'revoked', access_enc = NULL, refresh_enc = NULL, key_version = NULL, revoked_at = clock_timestamp(),
      purge_after = clock_timestamp() + interval '30 days', last_error_code = ${code}
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND status <> 'revoked'`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** The person dismissed "needs reconnect": the (already purged) link becomes plainly not connected. */
export async function clearRevokeCode(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE user_calendar_links SET last_error_code = NULL WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'revoked'`.execute(tx);
}

export async function markSynced(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE user_calendar_links SET last_synced_at = clock_timestamp(), status = 'connected', last_error_code = NULL
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('connected','degraded')`.execute(tx);
}

export async function markDegraded(tx: Tx, id: string, code: string): Promise<void> {
  await sql`UPDATE user_calendar_links SET status = 'degraded', last_error_code = ${code}
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('connected','degraded')`.execute(tx);
}

/**
 * Links reconcile must finish (system actor; R-INT-5): a removed member's link not yet revoked (a safety net:
 * the 0049 trigger revokes it in the removal transaction), and any revoked link that still holds a token (the
 * trigger keeps it so the grant can be revoked at the provider before the purge). Suspension is not removal.
 */
export async function linksToFinishRevoking(tx: Tx): Promise<{ id: string; user_id: string; provider: CalendarProviderKey }[]> {
  return (
    await sql<{ id: string; user_id: string; provider: CalendarProviderKey }>`
      SELECT l.id, l.user_id, l.provider FROM user_calendar_links l
        JOIN memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id
       WHERE l.tenant_id = app.tenant_id()
         AND ((l.status <> 'revoked' AND m.status = 'removed') OR (l.status = 'revoked' AND (l.access_enc IS NOT NULL OR l.refresh_enc IS NOT NULL)))
       ORDER BY l.id LIMIT 500`.execute(tx)
  ).rows;
}

export async function memberActive(tx: Tx, userId: string): Promise<boolean> {
  return (await memberStatus(tx, userId)) === 'active';
}

export async function memberStatus(tx: Tx, userId: string): Promise<string | null> {
  const r = await sql<{ status: string }>`SELECT status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  return r.rows[0]?.status ?? null;
}

/** Purges the token of a link that is already revoked (system actor). */
export async function purgeRevokedTokens(tx: Tx, id: string): Promise<number> {
  const r = await sql`UPDATE user_calendar_links SET access_enc = NULL, refresh_enc = NULL, key_version = NULL
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'revoked' AND (access_enc IS NOT NULL OR refresh_enc IS NOT NULL)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/**
 * The person's appointments the calendar does not have at their current version (sync stopped, a failure, a
 * new connection): not detached, not over, newest content never accepted.
 */
export async function pendingPushesOf(tx: Tx, userId: string): Promise<{ id: string; sync_version: number }[]> {
  return (
    await sql<{ id: string; sync_version: number }>`SELECT id, sync_version FROM appointments
      WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND external_sync_status <> 'detached' AND ends_at > clock_timestamp()
        AND (external_pushed_version IS NULL OR external_pushed_version < sync_version)
      ORDER BY starts_at LIMIT 200`.execute(tx)
  ).rows;
}

/**
 * calendar.reconcile's catch-up (system actor; R-CAL-2, R-INT-5): the appointments of ACTIVE members with a
 * connected link that the calendar does not have at their current version. A push that ran while the member was
 * suspended or deactivating paused (member_inactive) and nothing else re-enqueues it, so the hourly reconcile
 * does once they are active again. Same selection as pendingPushesOf, minus what can never be pushed (a
 * canceled or rescheduled appointment that never reached THIS calendar: no event, or one on another provider;
 * push.ts returns not_pushable for it and records nothing, so it would be re-enqueued every hour). Degraded links are left to their own
 * recovery path (the next in-app write), so a failing provider is not retried hourly.
 */
export async function pendingPushesOfActiveLinks(tx: Tx): Promise<{ id: string; sync_version: number }[]> {
  return (
    await sql<{ id: string; sync_version: number }>`SELECT a.id, a.sync_version FROM appointments a
        JOIN user_calendar_links l ON l.tenant_id = a.tenant_id AND l.user_id = a.user_id AND l.status = 'connected'
        JOIN memberships m ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id AND m.status = 'active'
      WHERE a.tenant_id = app.tenant_id() AND a.external_sync_status <> 'detached' AND a.ends_at > clock_timestamp()
        AND (a.external_pushed_version IS NULL OR a.external_pushed_version < a.sync_version)
        AND NOT (a.status IN ('canceled','rescheduled')
                 AND split_part(COALESCE(a.external_event_ref, ''), ':', 1) <> CASE l.provider WHEN 'microsoft_calendar' THEN 'microsoft' ELSE 'google' END)
      ORDER BY a.starts_at LIMIT 500`.execute(tx)
  ).rows;
}

// ---- appointments (sync bookkeeping only; content columns are module 14's) -------------------------------

/**
 * Serializes every booking and appointment write of ONE person (E151): the booking re-reads in-app
 * appointments only after it holds this lock, and module 14's write takes it too (enqueueCalendarPush), so a slot
 * booked in-app is seen by a concurrent booking. The live free/busy is read before, holding no lock, and its calendar
 * link is re-checked under it (b12 recheck R9).
 */
export async function lockPersonBookings(tx: Tx, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('calendar.book:' || app.tenant_id()::text || ':' || ${userId}::text, 0))`.execute(tx);
}

/** One push of one appointment at a time (R-CAL-2): pushes of the same appointment never overlap. */
export async function lockAppointmentPush(tx: Tx, appointmentId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('calendar.push:' || app.tenant_id()::text || ':' || ${appointmentId}::text, 0))`.execute(tx);
}

export interface PushRow {
  id: string;
  user_id: string;
  kind: 'buyer_consult' | 'listing_appointment' | 'consult' | 'other';
  starts_at: Date;
  ends_at: Date;
  status: 'scheduled' | 'held' | 'no_show' | 'canceled' | 'rescheduled';
  contact_name: string | null;
  external_event_ref: string | null;
  external_etag: string | null;
  external_sync_status: 'not_synced' | 'synced' | 'detached' | 'failed';
  sync_version: number;
  external_pushed_version: number | null;
  title_detail: 'first_name_initial' | 'none';
  now: Date;
}

export async function appointmentForPush(tx: Tx, id: string): Promise<PushRow | null> {
  const r = await sql<PushRow>`
    SELECT a.id, a.user_id, a.kind, a.starts_at, a.ends_at, a.status, c.display_name AS contact_name, a.external_event_ref, a.external_etag,
           a.external_sync_status, a.sync_version, a.external_pushed_version,
           COALESCE((SELECT s.calendar_title_detail FROM tenant_settings s WHERE s.tenant_id = a.tenant_id), 'first_name_initial') AS title_detail,
           clock_timestamp() AS now
      FROM appointments a LEFT JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
     WHERE a.tenant_id = app.tenant_id() AND a.id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function versionOf(tx: Tx, id: string): Promise<{ user_id: string; sync_version: number } | null> {
  const r = await sql<{ user_id: string; sync_version: number }>`SELECT user_id, sync_version FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * The fence (R-CAL-2): records what the calendar accepted only if nothing newer was recorded, and never on a
 * detached appointment. Sync bookkeeping never moves sync_version (0018 trigger).
 */
export async function recordPushed(tx: Tx, id: string, p: { ref: string; etag: string; version: number }): Promise<number> {
  const r = await sql`UPDATE appointments SET external_event_ref = ${p.ref}, external_etag = ${p.etag}, external_sync_status = 'synced', external_pushed_version = ${p.version}
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND external_sync_status <> 'detached'
      AND (external_pushed_version IS NULL OR external_pushed_version < ${p.version}) AND sync_version >= ${p.version}`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** E103: edited (or removed) in the calendar: detached, never overwritten. */
export async function recordDetached(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE appointments SET external_sync_status = 'detached', external_detached_at = clock_timestamp()
    WHERE tenant_id = app.tenant_id() AND id = ${id} AND external_sync_status <> 'detached'`.execute(tx);
}

export async function recordFailed(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE appointments SET external_sync_status = 'failed' WHERE tenant_id = app.tenant_id() AND id = ${id} AND external_sync_status IN ('not_synced','synced')`.execute(tx);
}

export interface DetachedRow {
  id: string;
  kind: PushRow['kind'];
  starts_at: Date;
  external_event_ref: string | null;
  external_detached_at: Date;
}

/** The person's own detached appointments that still matter (not ended more than a week ago). */
export async function detachedOf(tx: Tx, userId: string): Promise<DetachedRow[]> {
  return (
    await sql<DetachedRow>`SELECT id, kind, starts_at, external_event_ref, external_detached_at FROM appointments
      WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND external_sync_status = 'detached' AND ends_at > clock_timestamp() - interval '7 days'
      ORDER BY starts_at LIMIT 20`.execute(tx)
  ).rows;
}

/** The person's own in-app appointments that occupy time in [from, to) (scheduled or held). */
export async function busyAppointments(tx: Tx, userId: string, from: string, to: string): Promise<{ starts_at: Date; ends_at: Date }[]> {
  return (
    await sql<{ starts_at: Date; ends_at: Date }>`SELECT starts_at, ends_at FROM appointments
      WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status IN ('scheduled','held')
        AND ends_at > ${from}::timestamptz AND starts_at < ${to}::timestamptz ORDER BY starts_at LIMIT 500`.execute(tx)
  ).rows;
}

export async function insertBooked(tx: Tx, a: { id: string; userId: string; contactId: string | null; kind: PushRow['kind']; startsAt: string; endsAt: string; createdByKind: 'assistant' | 'system' | 'user'; setByUserId: string | null }): Promise<void> {
  await sql`INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, created_by_kind)
    VALUES (app.tenant_id(), ${a.id}, ${a.contactId}, ${a.userId}, ${a.setByUserId}, ${a.kind}, ${a.startsAt}::timestamptz, ${a.endsAt}::timestamptz, ${a.createdByKind})`.execute(tx);
}
