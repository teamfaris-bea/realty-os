// The answered-inbound backstop (R-ISA-29; docs/AI_ISA.md §2.1 step 8).
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import * as auto from '../comms/repos/automation.js';
import { contactLabel, notifyUser, upsertFeedItem } from '../comms/repos/notify.js';
import type { IsaDeps } from './effects.js';
import type { AssignmentRow } from './repo.js';

/**
 * The answered-inbound backstop (R-ISA-29): a reply under AI care is answered (an AI message after it sent or
 * delivered, or scheduled by quiet hours), handed off, or answered by a human; otherwise today's pinned
 * `unanswered_inbound` card (dedupe inbound:{contact}) and an R-AST-9 handback (dedupe handback:ai_isa:{a}:{inbound})
 * are written: at 10 minutes, or at once when care is no longer live.
 */
export async function backstopInTx(tx: Tx, deps: IsaDeps, a: AssignmentRow, messageId: string | null, now: Instant): Promise<number> {
  const live = a.endedAt === null && a.pausedAt === null;
  const rows = await sql<{ id: string; created_at: Date; channel: string; body: string }>`SELECT m.id, m.created_at, m.channel, m.body FROM messages m
    WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${a.contactId} AND m.direction = 'inbound' AND m.created_at >= ${new Date(a.startedAt)}
      ${messageId ? sql`AND m.id = ${messageId}` : sql``}
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.tenant_id = m.tenant_id AND o.contact_id = m.contact_id AND o.direction = 'outbound' AND o.created_at > m.created_at
                        AND (o.status IN ('sent','delivered','dispatching') OR (o.initiator = 'assistant' AND o.status = 'scheduled')))
      AND NOT EXISTS (SELECT 1 FROM ai_isa_handoffs h WHERE h.tenant_id = m.tenant_id AND h.assignment_id = ${a.id} AND h.package->'unansweredInbound' ? m.id::text)
    ORDER BY m.created_at`.execute(tx);
  let n = 0;
  for (const m of rows.rows) {
    if (live && now - m.created_at.getTime() < 10 * 60_000) continue;
    const id = deps.ids.next<'X'>() as string;
    const ins = await auto.insertHandback(tx, {
      id, contactId: a.contactId, ownerUserId: a.ownerUserId, explanation: 'They replied and the AI assistant did not answer. Reply to them yourself.',
      payload: { inboundMessageId: m.id, inboundCallId: null, enrollmentId: null, autoReply: false, sentAtSameMoment: [], canceledMessageIds: [], aiIsaAssignmentId: a.id } as never,
      pinnedInboundSeq: a.lastInboundSeq, boundOwnershipSeq: a.boundOwnershipSeq, dedupeKey: `handback:ai_isa:${a.id}:${m.id}`,
      claims: [{ id: deps.ids.next<'X'>() as string, kind: 'client_statement', text: m.body.slice(0, 300), evidence: { id: deps.ids.next<'X'>() as string, sourceType: m.channel === 'email' ? 'email' : 'message', sourceId: m.id, locator: { kind: 'message' }, snippet: m.body.slice(0, 200) } }] as never,
    });
    const label = (await contactLabel(tx, a.contactId)) ?? 'A lead';
    await upsertFeedItem(tx, deps.ids, { userId: a.ownerUserId, itemType: 'unanswered_inbound', band: 'pinned', contactId: a.contactId, subjectType: 'message', subjectId: m.id,
      assistantActionId: ins ? id : null, score: 90, reasons: [{ code: 'UNANSWERED_INBOUND', text: 'Waiting on your reply' }], dedupeKey: `inbound:${a.contactId}` });
    await notifyUser(tx, deps.ids, { userId: a.ownerUserId, kind: 'inbound_message', priority: 'high', title: `${label} is waiting on a reply`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: a.contactId, dedupeKey: `inbound:${m.id}` }, now);
    n += 1;
  }
  return n;
}

