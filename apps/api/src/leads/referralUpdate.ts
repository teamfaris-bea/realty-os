// Realtor.com / Opcity referral reminder.
//
// Opcity's membership rule is that a referral is updated at least every 7 days. This opens a task and a feed card
// at day 5 when nobody has logged an update since the inquiry arrived. An update is a person's note (not the
// lead-email timeline line), a human outbound call, or a human outbound message. An automated first response does
// not count, and this job never sends, drafts, or texts the client.
//
// One cue per inquiry (referral_update_cues). A lead that is not yet 5 days old, or that already has an update,
// is left alone and checked again next hour.
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { DAY_MS } from '@realty/core/foundation';
import { type Tx, defaultIds } from '@realty/db';
import { sql } from 'kysely';
import { jobPayload } from '../worker/payload.js';
import type { TxJobHandler } from '../worker/types.js';

export const REFERRAL_UPDATE_JOB = 'leads.referral_update_due' as const;
/** Their rule. The reminder is earlier so the agent still has two days. */
export const REFERRAL_RULE_DAYS = 7;
export const REFERRAL_REMIND_AFTER_DAYS = 5;
const REMIND_AFTER_MS = REFERRAL_REMIND_AFTER_DAYS * DAY_MS;
const PER_RUN = 100;

const TASK_TITLE = 'Update this realtor.com referral';
const TASK_NOTES =
  'Opcity and realtor.com require a referral update at least every 7 days. None has been logged in 5 days. Log a call, text, email, or note. Nothing was sent to the client.';

interface DueRow {
  id: string;
  contact_id: string;
  owner_user_id: string | null;
  offered_to_user_id: string | null;
}

async function dueInquiries(tx: Tx, cutoff: Date): Promise<DueRow[]> {
  const r = await sql<DueRow>`
    SELECT i.id, i.contact_id, c.owner_user_id, c.offered_to_user_id
      FROM lead_inquiries i
      JOIN contacts c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
     WHERE i.tenant_id = app.tenant_id()
       AND i.source_detail->>'referral_update' = 'true'
       AND i.outcome <> 'duplicate_ignored'
       AND i.received_at <= ${cutoff.toISOString()}::timestamptz
       AND c.deleted_at IS NULL
       AND c.merged_into_contact_id IS NULL
       AND c.ownership_state <> 'closed'
       AND NOT EXISTS (SELECT 1 FROM referral_update_cues u WHERE u.tenant_id = i.tenant_id AND u.inquiry_id = i.id)
     ORDER BY i.received_at, i.id
     LIMIT ${PER_RUN}`.execute(tx);
  return r.rows;
}

/** A person's own note, call, or outbound message after the inquiry. The lead-email line and automated replies do not count. */
async function loggedUpdateSince(tx: Tx, contactId: string, since: Date): Promise<boolean> {
  const at = since.toISOString();
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (
             SELECT 1 FROM notes n
              WHERE n.tenant_id = app.tenant_id() AND n.contact_id = ${contactId}::uuid
                AND n.source IN ('manual','logged_activity','call_summary')
                AND n.created_at > ${at}::timestamptz)
        OR EXISTS (
             SELECT 1 FROM messages m
              WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${contactId}::uuid
                AND m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported
                AND m.dispatched_at > ${at}::timestamptz)
        OR EXISTS (
             SELECT 1 FROM calls k
              WHERE k.tenant_id = app.tenant_id() AND k.contact_id = ${contactId}::uuid
                AND k.direction = 'outbound' AND k.initiator = 'human' AND NOT k.imported
                AND k.started_at > ${at}::timestamptz) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

async function assigneeOf(tx: Tx, row: DueRow): Promise<string | null> {
  if (row.owner_user_id) return row.owner_user_id;
  if (row.offered_to_user_id) return row.offered_to_user_id;
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships
     WHERE tenant_id = app.tenant_id() AND role = 'owner' AND status = 'active'
     ORDER BY user_id LIMIT 1`.execute(tx);
  return r.rows[0]?.user_id ?? null;
}

async function receivedAtOf(tx: Tx, inquiryId: string): Promise<Date | null> {
  const r = await sql<{ received_at: Date }>`
    SELECT received_at FROM lead_inquiries WHERE tenant_id = app.tenant_id() AND id = ${inquiryId}::uuid`.execute(tx);
  return r.rows[0]?.received_at ?? null;
}

/**
 * Opens the day-5 task for every realtor.com / Opcity referral with no logged update. Idempotent: the cue's unique
 * inquiry id means a second run adds nothing. Returns how many inquiries were considered and how many tasks opened.
 */
export async function remindReferralUpdates(tx: Tx, ids: IdGenerator, now: Instant): Promise<{ scanned: number; opened: number }> {
  const cutoff = new Date(now - REMIND_AFTER_MS);
  const rows = await dueInquiries(tx, cutoff);
  let opened = 0;
  for (const row of rows) {
    const since = await receivedAtOf(tx, row.id);
    if (!since || (await loggedUpdateSince(tx, row.contact_id, since))) continue;
    const userId = await assigneeOf(tx, row);
    if (!userId) continue;
    const taskId = ids.next<'TaskId'>();
    const due = new Date(now).toISOString();
    await sql`
      INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, notes, due_at, created_by_kind)
      VALUES (app.tenant_id(), ${taskId}::uuid, ${userId}::uuid, ${row.contact_id}::uuid, 'follow_up', ${TASK_TITLE}, ${TASK_NOTES},
              ${due}::timestamptz, 'system')`.execute(tx);
    await sql`
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at, score, reasons, dedupe_key)
      VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}::uuid, ${userId}::uuid, 'task_due', 'pinned', ${row.contact_id}::uuid, 'task', ${taskId}::uuid,
              ${due}::timestamptz, 80,
              ${JSON.stringify([{ code: 'REFERRAL_UPDATE_DUE', label: 'Realtor.com asks for an update every 7 days. None is logged. Nothing was sent to the client.' }])}::jsonb,
              ${`referral_update:${row.id}`})`.execute(tx);
    await sql`
      INSERT INTO referral_update_cues (tenant_id, id, inquiry_id, contact_id, task_id, user_id, opened_at)
      VALUES (app.tenant_id(), ${ids.next<'ReferralUpdateCueId'>()}::uuid, ${row.id}::uuid, ${row.contact_id}::uuid, ${taskId}::uuid, ${userId}::uuid, ${due}::timestamptz)`.execute(tx);
    opened++;
  }
  return { scanned: rows.length, opened };
}

/** Hourly, per tenant. The worker keeps it alive. */
export function referralUpdateHandler(): TxJobHandler<Record<string, never>> {
  const ids = defaultIds();
  return {
    kind: REFERRAL_UPDATE_JOB,
    queue: 'default',
    via: 'worker',
    schema: jobPayload({}),
    every: { ms: 60 * 60_000, offsetMs: 180_000 },
    periodicPayload: {},
    async run(ctx) {
      const r = await remindReferralUpdates(ctx.tx, ids, ctx.now);
      if (r.opened > 0) ctx.log.info('referral update due', { opened: r.opened, scanned: r.scanned });
      return undefined;
    },
  };
}
