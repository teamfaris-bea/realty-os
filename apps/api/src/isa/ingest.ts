// The inbound branch and the takeover hooks (R-ISA-3, R-ISA-28, R-ISA-29; docs/AI_ISA.md §2.1). Called from
// comms/inbound.ts inside the ingestion transaction, AFTER lock_contact and after step 6 (which runs unchanged for
// everyone). The assignment is read FOR SHARE (lock order §3.7), so a control that commits during ingestion is seen.
//
//   a turn (SMS or email, from a bound point, an aligned DKIM pass for email, no media or text part, not an auto-
//   reply) under a live, unpaused assignment whose chain holds  →  no per-reply handback and no pinned card; one
//   scored `ai_isa_activity` row, one debounced `ai_isa.turn` job and the answered-inbound backstop at +10 minutes.
//   anything else under live care (a call, chat, synced mail, MMS, another point, an unaligned From)  →  today's
//   R-AST-9 path exactly, and care is PAUSED (unverified_sender, call, chat, synced_mail, media).
//   a hold (switch off, a daily cap)  →  today's R-AST-9 path, no pause.
import type { Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { upsertFeedItem } from '../comms/repos/notify.js';
import type { IsaPauseReason } from './coreSeam.js';
import { systemPauseInTx } from './controls.js';
import { chainEnvOf, control, type IsaDeps } from './effects.js';
import { type AssignmentRow, evaluateChain, liveAssignmentOf } from './repo.js';
import { type DkimVerdict, domainOf, isUnder, normalizeDomain } from '../leadEmail/trust.js';

export const BACKSTOP_MS = 10 * 60_000;
export const TURN_DEBOUNCE_MS = 20_000;

export type IsaIngest = { kind: 'none' } | { kind: 'turn'; assignmentId: string } | { kind: 'paused'; assignmentId: string; reason: IsaPauseReason } | { kind: 'hold'; assignmentId: string };

export interface IsaInboundFacts {
  contactId: string;
  messageId: string | null;
  channel: 'sms' | 'mms' | 'email' | 'web_chat' | 'call' | 'synced_mail';
  fromAddress: string | null;
  isAutoReply: boolean;
  classification: string;
  dkimAligned: boolean | null;
  mediaCount: number;
  textParts: number;
  inboundSeq: number;
}

const OPT_OUT = new Set(['stop', 'opt_out_language', 'wrong_number']);

function pauseReasonFor(i: IsaInboundFacts): IsaPauseReason {
  if (i.channel === 'call') return 'call';
  if (i.channel === 'web_chat') return 'chat';
  if (i.channel === 'synced_mail') return 'synced_mail';
  if (i.channel === 'mms' || i.mediaCount > 0 || i.textParts > 0) return 'media';
  return 'unverified_sender';
}

async function fromBound(tx: Tx, a: AssignmentRow, i: IsaInboundFacts): Promise<boolean> {
  const ch = i.channel === 'email' ? 'email' : i.channel === 'sms' ? 'sms' : null;
  if (ch === null || i.fromAddress === null) return false;
  const p = a.boundPoints[ch];
  if (!p) return false;
  const r = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM contact_points WHERE tenant_id = app.tenant_id() AND id = ${p.point_id}
    AND address = ${i.fromAddress} AND removed_at IS NULL AND encode(address_hmac, 'hex') = ${p.hmac}) AS ok`.execute(tx);
  return r.rows[0]!.ok;
}

/** R-ISA-28: whether this inbound is a turn of `a`. */
export async function isTurn(tx: Tx, a: AssignmentRow, i: IsaInboundFacts): Promise<boolean> {
  if (i.channel !== 'sms' && i.channel !== 'email') return false;
  if (i.mediaCount > 0 || i.textParts > 0 || i.isAutoReply) return false;
  if (i.channel === 'email' && i.dkimAligned !== true) return false;
  return fromBound(tx, a, i);
}

export async function ingestForAiIsaInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, i: IsaInboundFacts, now: Instant): Promise<IsaIngest> {
  const a = await liveAssignmentOf(tx, i.contactId, 'share');
  if (a === null || a.pausedAt !== null) return { kind: 'none' };
  // an opt-out ends care through the stop-signal ledger (the consent writer's trigger, same transaction)
  if (OPT_OUT.has(i.classification)) return { kind: 'none' };
  if (!(await isTurn(tx, a, i))) {
    const reason = pauseReasonFor(i);
    await systemPauseInTx(tx, deps, actor, a, reason, now);
    return { kind: 'paused', assignmentId: a.id, reason };
  }
  const chain = await evaluateChain(tx, a, chainEnvOf(deps));
  if (chain.effect === 'hold') return { kind: 'hold', assignmentId: a.id };
  if (chain.effect !== 'ok') {
    if (chain.effect === 'pause') await systemPauseInTx(tx, deps, actor, a, (chain.worst!.reason ?? 'pack_withdrawn') as IsaPauseReason, now);
    else await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'sweep', epoch: a.epoch }, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:chain` });
    return { kind: 'none' };
  }
  await upsertFeedItem(tx, deps.ids, {
    userId: a.ownerUserId, itemType: 'ai_isa_activity', band: 'scored', contactId: a.contactId, subjectType: 'ai_isa_assignment', subjectId: a.id, assistantActionId: null,
    score: 30, reasons: [{ code: 'AI_ISA_REPLY_RECEIVED', text: 'They replied; the AI assistant is answering' }], dedupeKey: `ai_isa_activity:${a.id}`,
  });
  await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch },
    dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:${i.inboundSeq}`, runAt: (now + TURN_DEBOUNCE_MS) as Instant });
  if (i.messageId !== null) {
    await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.backstop', payload: { assignmentId: a.id, messageId: i.messageId },
      dedupeKey: `ai_isa.backstop:${i.messageId}`, runAt: (now + BACKSTOP_MS) as Instant });
  }
  return { kind: 'turn', assignmentId: a.id };
}

/**
 * Takeover (R-ISA-3, R-ISA-15): a one-to-one human message created or scheduled, a draft or handback reply approved,
 * a human dial, or a synced outbound pauses live care at once with `human_contact`. The pause is the user's own
 * write (RLS: whoever may send to the person sees the assignment); the cancels of queued AI messages run as the
 * system in the `ai_isa.after_control` job (the guard already refuses them: ISA_PAUSED). Bulk and marketing sends
 * never call this.
 */
export async function takeoverInTx(tx: Tx, ids: IsaDeps['ids'], actor: UserActor | SystemActor, contactId: string, now: Instant): Promise<boolean> {
  const a = await liveAssignmentOf(tx, contactId, 'update');
  if (a === null || a.pausedAt !== null) return false;
  const userId = actor.kind === 'user' ? actor.userId : null;
  const machine = { ...a.machine, resumePhase: a.machine.phase, phase: 'paused' as const, paused: { reason: 'human_contact' as const, byKind: (userId ? 'user' : 'system') as 'user' | 'system', since: now }, awaitingModel: false };
  const r = await sql<{ id: string }>`UPDATE ai_isa_assignments SET paused_at = ${new Date(now)}, paused_by_kind = ${userId ? 'user' : 'system'}, paused_by_user_id = ${userId},
      pause_reason = 'human_contact', state = 'paused', machine = ${JSON.stringify(machine)}::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${a.id} AND paused_at IS NULL AND ended_at IS NULL RETURNING id`.execute(tx);
  if (r.rows.length === 0) return false;
  await control(tx, ids, a, userId ? 'pause' : 'system_pause', 'human_contact', userId);
  await audit(tx, actor, { action: userId ? 'ai_isa.assignment_paused' : 'ai_isa.system_paused', entity: { type: 'ai_isa_assignment', id: a.id }, reason: 'human_contact' });
  await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.after_control', payload: { assignmentId: a.id, epoch: a.epoch }, dedupeKey: `ai_isa.after_control:${a.id}:${a.epoch}:human` });
  return true;
}

/**
 * R-ISA-28: an aligned DKIM pass for the From domain (the leadEmail/trust.ts alignment rule, without the lead-email
 * allowlist: a person writes from their own mailbox). No verdicts means not aligned: fail closed.
 */
export function dkimAligned(fromAddress: string | null, verdicts: readonly DkimVerdict[]): boolean {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return false;
  return verdicts.some((v) => v.result.toLowerCase() === 'pass' && (isUnder(fromDomain, normalizeDomain(v.domain)) || isUnder(normalizeDomain(v.domain), fromDomain)));
}
