// Shared helpers of api/insights (PHASE2_3_PLAN module 33): the request transaction, the tenant zone and the
// calendar arithmetic the owner view, goals and the weekly plan share (months and ISO weeks as local dates).
import {
  DAY_MS,
  type IanaZone,
  type Instant,
  type LocalDate,
  type UserActor,
  ianaZone,
  localDate,
  localDateOf,
  localTimeFromSeconds,
  resolveLocal,
} from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { actorOf, mapWorkspaceDbError, platformOf } from '../workspace/common.js';

export { actorOf, platformOf };

/** One request transaction as the session's HUMAN actor (RLS-bound), with DB errors mapped. */
export async function insightsTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  // R-OWNER-1: the owner view and costs are computed only in a human transaction. Routes are user-only by
  // construction (the session resolver builds a user actor); this is the belt to that brace.
  if (actor.kind !== 'user') throw new AppError('NOT_FOUND');
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const mapped = mapWorkspaceDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

/** The tenant's default zone (users have no zone of their own: the scoreboard uses the same one). */
export async function tenantZone(tx: Tx): Promise<IanaZone> {
  const r = await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const z = ianaZone(r.rows[0]?.z);
  if (!z) throw new AppError('NOT_FOUND');
  return z;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM' → its first day. */
export function monthStart(ym: string): LocalDate {
  return localDate(`${ym}-01`);
}

/** The first day of the month after `ym`. */
export function nextMonthStart(ym: string): LocalDate {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 12 ? localDate(`${pad(y + 1, 4)}-01-01`) : localDate(`${pad(y, 4)}-${pad(m + 1)}-01`);
}

/** 'YYYY-MM' of an instant in `z`. */
export function monthOf(t: Instant, z: IanaZone): string {
  return localDateOf(t, z).slice(0, 7);
}

/** Months from `from` to `to` inclusive (both 'YYYY-MM'). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/** 'YYYY-MM' shifted by `n` months. */
export function addMonthsYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}`;
}

/** Local midnight of `d` in `z` as an instant. */
export function midnight(d: LocalDate, z: IanaZone): Instant {
  return resolveLocal(d, localTimeFromSeconds(0), z, 'earlier');
}

function utcDays(d: LocalDate): number {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd) / DAY_MS;
}

function fromUtcDays(n: number): LocalDate {
  const t = new Date(n * DAY_MS);
  return localDate(`${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
}

export function addDaysLocal(d: LocalDate, n: number): LocalDate {
  return fromUtcDays(utcDays(d) + n);
}

/** ISO weekday 1 (Monday) … 7 (Sunday) of a local date. */
export function isoWeekday(d: LocalDate): number {
  const w = new Date(utcDays(d) * DAY_MS).getUTCDay();
  return w === 0 ? 7 : w;
}

/** The Monday of `d`'s ISO week. */
export function mondayOf(d: LocalDate): LocalDate {
  return addDaysLocal(d, 1 - isoWeekday(d));
}

/** ISO week label 'YYYY-Www' of a local date (the week of the weekly_plan:{user}:{week} key). */
export function isoWeekOf(d: LocalDate): string {
  const thursday = addDaysLocal(mondayOf(d), 3);
  const year = Number(thursday.slice(0, 4));
  const jan4 = localDate(`${pad(year, 4)}-01-04`);
  const week = Math.round((utcDays(mondayOf(thursday)) - utcDays(mondayOf(jan4))) / 7) + 1;
  return `${pad(year, 4)}-W${pad(week)}`;
}

export const ISO_WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/** The Monday of an ISO week label, or null when the label is not a real week. */
export function mondayOfIsoWeek(week: string): LocalDate | null {
  if (!ISO_WEEK_RE.test(week)) return null;
  const year = Number(week.slice(0, 4));
  const n = Number(week.slice(6));
  const monday = addDaysLocal(mondayOf(localDate(`${pad(year, 4)}-01-04`)), (n - 1) * 7);
  return isoWeekOf(monday) === week ? monday : null;
}
