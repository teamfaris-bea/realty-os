// The one call module 14 (appointments) makes into api/calendar (PHASE2_3_PLAN §5.3 flagged edit).
//
// enqueueCalendarPush(tx, appointmentId) runs in the appointment write's own transaction, after the write: it
// takes the organizer's booking lock (E151: a concurrent booking of that person waits for this write to commit
// and then sees it) and enqueues calendar.push for the version just written. It reads only the appointment's
// organizer and sync_version (visible to whoever just wrote it) and never the organizer's calendar link, which
// RLS hides from everyone else (R-CAL-1); the job, as the system actor, decides whether a calendar is connected.
import type { Tx } from '@realty/db';
import { enqueueTyped } from '../worker/registry.js';
import { CALENDAR_PUSH_JOB } from './jobs.js';
import * as repo from './repos/links.js';

export async function enqueueCalendarPush(tx: Tx, appointmentId: string): Promise<void> {
  const a = await repo.versionOf(tx, appointmentId);
  if (!a) return;
  await repo.lockPersonBookings(tx, a.user_id);
  await enqueueTyped(tx, CALENDAR_PUSH_JOB, { appointmentId }, { dedupeKey: `calendar.push:${appointmentId}:${a.sync_version}` });
}

/** For a caller that already holds the organizer's booking lock (bookSlot). */
export async function enqueueCalendarPushLocked(tx: Tx, appointmentId: string): Promise<void> {
  const a = await repo.versionOf(tx, appointmentId);
  if (!a) return;
  await enqueueTyped(tx, CALENDAR_PUSH_JOB, { appointmentId }, { dedupeKey: `calendar.push:${appointmentId}:${a.sync_version}` });
}
