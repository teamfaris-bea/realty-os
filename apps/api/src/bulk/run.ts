// The bulk.run job (parity module 63; R-PAR-34..R-PAR-42, E183..E188).
//
// The action runs AS ITS CREATOR, rebuilt from the action row while their membership is active (like a
// human scheduled message, comms/runtime senderActor). Each item is ONE transaction: RLS and core re-decide
// it now (visibility, role, opt-outs, the switch), so a person reassigned away mid-run is skipped
// NOT_VISIBLE, an unsubscribe that arrives mid-run blocks the rest, and a suspended creator stops the run.
//
// No item is ever sent twice:
//   - a processed item is final (DB guard), and an item's send has ONE message idempotency key, derived
//     from (action, address): a retry (crash, duplicate job, double confirm) finds the message it already
//     created instead of creating another;
//   - dispatchOutbound only sends a queued/scheduled message under its row lock, so a replay is a no-op;
//     a message left 'dispatching' by a crash is the stale-dispatch sweeper's (never re-sent), and its item
//     stays pending until that resolves (the job comes back for it);
//   - a bulk message must match a PENDING item at exactly its frozen address (messages_bulk_guard).
// Every send goes through compose → dispatchOutbound (D1: canContact and both DB guards, no bulk exemption).
import { type ContactId, type Instant, type UserActor, MINUTE_MS, plusMs } from '@realty/core/foundation';
import { type ItemOutcome, bulkPreflight, bulkSendKey, derivedCommandId, itemOutcomeForDispatch, itemOutcomeForMessageStatus, skipForGateReasons, tally } from '@realty/core/parity/bulk';
import { type Tx, applyOwnershipCommandInTx, lockContact, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { enqueueStep } from '../assistant/enrollments.js';
import * as P from '../assistant/repos/playbooks.js';
import { composeHumanMessage } from '../comms/compose.js';
import { canContact } from '@realty/core/compliance';
import { dispatchOutbound } from '../comms/dispatch.js';
import { insertBlockedDecision, resolvedPolicy, verdictOf } from '../comms/gateInput.js';
import { senderActor } from '../comms/runtime.js';
import type { CommsDeps, DispatchResult } from '../comms/types.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { assignTarget, kindFacts, personFacts, personRow, sendContext, sendFacts } from './facts.js';
import { notifyAssignSummaries, notifyFinished, notifyOfferSummaries } from './notices.js';
import * as B from './repos/bulk.js';

export type RunResult = { kind: 'finished'; status: 'completed' | 'canceled' | 'failed' } | { kind: 'retry'; at: Instant } | { kind: 'noop' };

const sys = <R>(deps: CommsDeps, tenantId: string, fn: (tx: Tx, now: Instant) => Promise<R>) => withTenantTx(systemActor(tenantId, 'worker'), fn, { db: deps.db, retries: 2 });
const asCreator = <R>(deps: CommsDeps, actor: UserActor, fn: (tx: Tx, now: Instant) => Promise<R>) => withTenantTx(actor, fn, { db: deps.db, retries: 2 });

const CODE_RE = /([A-Z][A-Z0-9_]{2,63}):/;
/** The guard code of a DB refusal ("STAGE_NEEDS_CONTACT: reach this lead first" → STAGE_NEEDS_CONTACT). */
export function dbCode(e: unknown): string | null {
  if (e instanceof AppError) return e.code;
  const m = CODE_RE.exec(String((e as { message?: unknown })?.message ?? ''));
  return m ? m[1]! : null;
}

interface StoredCounts {
  selected?: number;
  preflight?: Record<string, number>;
  assignFrom?: Record<string, number>;
  /** assign: per agent, the leads on offer to them that this action assigned (their offers withdrawn, batch 6 review F6) */
  offerFrom?: Record<string, number>;
  [k: string]: unknown;
}

/** Runs (or resumes) one bulk action. Idempotent: any number of runs end in the same item states. */
export async function runBulkAction(actionId: string, deps: CommsDeps, tenantId: string): Promise<RunResult> {
  const start = await sys(deps, tenantId, async (tx) => {
    const a = await B.actionById(tx, actionId, { lock: true });
    if (!a || a.status === 'draft' || a.status === 'completed' || a.status === 'canceled' || a.status === 'failed') return null;
    if (a.status === 'confirmed') await B.markRunning(tx, actionId);
    return { a, creator: await senderActor(tx, tenantId, a.createdByUserId, `bulk:${actionId}`) };
  });
  if (!start) return { kind: 'noop' };
  const { a } = start;
  if (!start.creator) return finish(deps, tenantId, actionId, 'failed', 'CREATOR_INACTIVE');

  let after: string | null = null;
  for (;;) {
    const page: B.ItemRow[] = await sys(deps, tenantId, (tx) => B.pendingItems(tx, actionId, after, 50));
    if (page.length === 0) break;
    for (const it of page) {
      after = it.contactId;
      const live = await sys(deps, tenantId, async (tx) => ({ a: await B.actionById(tx, actionId), creator: await senderActor(tx, tenantId, a.createdByUserId, `bulk:${actionId}`) }));
      if (!live.a || live.a.status === 'canceled') return { kind: 'finished', status: 'canceled' };
      if (!live.creator) return finish(deps, tenantId, actionId, 'failed', 'CREATOR_INACTIVE'); // R-PAR-34: a suspended creator stops the run
      if (a.kind === 'email' || a.kind === 'text') await sendItem(deps, tenantId, live.creator, a, it);
      else await editItem(deps, tenantId, live.creator, a, it);
    }
  }
  // items whose message is still 'dispatching' wait for the comms sweeper; come back for them
  const waiting = await sys(deps, tenantId, async (tx, now) => {
    const pending = (await B.itemOutcomes(tx, actionId)).filter((x) => x.status === 'pending').length;
    return pending > 0 ? plusMs(now, MINUTE_MS) : null;
  });
  if (waiting !== null) return { kind: 'retry', at: waiting };
  return finish(deps, tenantId, actionId, 'completed', null);
}

async function finish(deps: CommsDeps, tenantId: string, actionId: string, status: 'completed' | 'failed', failureCode: string | null): Promise<RunResult> {
  return sys(deps, tenantId, async (tx) => {
    const a = await B.actionById(tx, actionId, { lock: true });
    if (!a || (a.status !== 'running' && a.status !== 'confirmed')) return { kind: 'noop' } as const;
    if (status === 'failed') await skipPending(tx, actionId, failureCode ?? 'FAILED');
    const c = a.counts as StoredCounts;
    const final = tally(c.selected ?? a.targetCount ?? 0, c.preflight ?? {}, await B.itemOutcomes(tx, actionId));
    if (!(await B.markFinished(tx, actionId, status, { ...c, final }, failureCode))) return { kind: 'noop' } as const;
    await notifyFinished(tx, deps.ids, a, final, status);
    if (a.kind === 'assign') {
      const to = String(a.params['toUserId']);
      const gained = new Map<string, number>(final.done > 0 ? [[to, final.done]] : []);
      const lost = new Map<string, number>(Object.entries(c.assignFrom ?? {}).filter(([u, n]) => u !== to && n > 0));
      gained.delete(a.createdByUserId);
      lost.delete(a.createdByUserId);
      await notifyAssignSummaries(tx, deps.ids, actionId, gained, lost);
      const withdrawn = new Map<string, number>(Object.entries(c.offerFrom ?? {}).filter(([u, n]) => u !== to && u !== a.createdByUserId && n > 0));
      await notifyOfferSummaries(tx, deps.ids, actionId, withdrawn);
    }
    await audit(tx, systemActor(tenantId, 'worker'), { action: 'bulk.completed', entity: { type: 'bulk_action', id: actionId }, changes: redactSnapshot({ kind: a.kind, status, doneCount: final.done, skippedCount: final.skipped, blockedCount: final.blocked, failedCount: final.failed }, { entity: 'bulk_action' }), reason: failureCode ?? 'COMPLETED' });
    return { kind: 'finished', status } as const;
  });
}

async function skipPending(tx: Tx, actionId: string, reason: string): Promise<void> {
  await sql`UPDATE bulk_action_items SET status = 'skipped', reason_code = ${reason}, processed_at = now()
             WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND status = 'pending'`.execute(tx);
}

/** An item the creator can no longer see is skipped by the system (RLS hides it from the creator). */
async function markInvisible(deps: CommsDeps, tenantId: string, actionId: string, contactId: string): Promise<void> {
  await sys(deps, tenantId, (tx) => B.finishItem(tx, actionId, contactId, 'skipped', 'NOT_VISIBLE'));
}

async function applyOutcome(deps: CommsDeps, tenantId: string, actionId: string, contactId: string, o: ItemOutcome, messageId: string | null): Promise<void> {
  await sys(deps, tenantId, async (tx) => {
    if (o.status === 'pending') {
      if (messageId) await sql`UPDATE bulk_action_items SET message_id = ${messageId} WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${actionId} AND contact_id = ${contactId} AND status = 'pending'`.execute(tx);
      return;
    }
    if (o.cancelMessage && messageId) await B.cancelMessage(tx, messageId, o.reasonCode ?? 'CANCELED');
    await B.finishItem(tx, actionId, contactId, o.status, o.reasonCode, messageId);
  });
}

// ---- sends ------------------------------------------------------------------------------------------

type Prepared = { kind: 'skip' } | { kind: 'send'; body: string; subject: string | null; pointId: string; key: string; channel: 'sms' | 'email' } | { kind: 'existing'; messageId: string; status: string } | { kind: 'disabled'; messageId: string } | { kind: 'invisible' };

async function sendItem(deps: CommsDeps, tenantId: string, creator: UserActor, a: B.ActionRow, it: B.ItemRow): Promise<void> {
  const key = bulkSendKey(a.id, it.addressHmac!);
  const composeKey = `h:${creator.userId}:${key}`;
  const prep: Prepared = await asCreator(deps, creator, async (tx, now) => {
    const cur = await B.lockItem(tx, a.id, it.contactId);
    if (!cur) return { kind: 'invisible' };
    if (cur.status !== 'pending') return { kind: 'skip' };
    // a replay after a crash: the message this item already created decides (never a second message)
    const prior = await B.messageByKey(tx, composeKey);
    // R-PAR-40 (E185): the switch is re-read at every message, including one a crash left queued: a replay
    // never dispatches it once the Owner turned batch text off (security review; dispatch does not re-read it)
    const textOff = a.kind === 'text' && !(await B.batchTextEnabled(tx));
    const unsent = prior !== null && prior !== undefined && (prior.status === 'queued' || prior.status === 'scheduled');
    if (prior && !(textOff && unsent)) return { kind: 'existing', messageId: prior.id, status: prior.status };
    if (textOff) {
      if (prior) return { kind: 'disabled', messageId: prior.id };
      await B.finishItem(tx, a.id, it.contactId, 'skipped', 'BATCH_TEXT_DISABLED'); // E185
      return { kind: 'skip' };
    }
    const p = await personRow(tx, it.contactId);
    const person = await personFacts(tx, p);
    if (!p || !person.detailVisible) return { kind: 'invisible' };
    const ctx = await sendContext(tx, a.kind as 'email' | 'text', creator.userId);
    const s = await sendFacts(tx, a, ctx, it.contactId, p, null, now, it.addressHmac);
    if (s.point === null) {
      await B.finishItem(tx, a.id, it.contactId, 'skipped', 'NO_ADDRESS'); // the frozen address was removed since
      return { kind: 'skip' };
    }
    const r = bulkPreflight(a.kind, person, s.facts, { actor: creator, now });
    if (!r.ok) {
      if (r.gateReasons && s.facts.gate) {
        // R-PAR-41: the normal blocked-send evidence row (no failed_send exception for bulk)
        // the decision of exactly the input preflight evaluated (it includes the removed phones, R-PAR-12)
        const intent = { contactId: it.contactId, recipient: { kind: 'contact' as const, addressHmac: s.point.hmac, channel: ctx.channel, pointId: s.point.id }, purpose: 'marketing' as const, initiator: 'human' as const, category: 'none' as const, sender: { phoneNumberId: ctx.senderPhoneId, emailIdentityId: ctx.senderEmailId }, body: s.text?.body ?? null };
        const { policy, tenant } = await resolvedPolicy(tx);
        const decision = canContact(s.facts.gate);
        await insertBlockedDecision(tx, { ids: deps.ids, intent, evaluated: { input: s.facts.gate, decision, policy, tenant }, verdict: verdictOf(decision), actorUserId: creator.userId, now });
        await B.finishItem(tx, a.id, it.contactId, 'blocked', r.reason);
      } else await B.finishItem(tx, a.id, it.contactId, 'skipped', r.reason);
      return { kind: 'skip' };
    }
    return { kind: 'send', body: s.text!.body, subject: s.text!.subject, pointId: s.point.id, key, channel: ctx.channel };
  });
  if (prep.kind === 'invisible') return markInvisible(deps, tenantId, a.id, it.contactId);
  if (prep.kind === 'skip') return;
  if (prep.kind === 'disabled') return applyOutcome(deps, tenantId, a.id, it.contactId, { status: 'skipped', reasonCode: 'BATCH_TEXT_DISABLED', cancelMessage: true }, prep.messageId);
  if (prep.kind === 'existing') {
    // run dispatch again (a no-op unless the message is still queued), then record what happened
    const r = prep.status === 'queued' ? await dispatchOutbound(prep.messageId, deps, { tenantId, actor: creator }).catch(() => null) : null;
    const status = r ? null : (await sys(deps, tenantId, (tx) => B.messageStatus(tx, prep.messageId)))?.status ?? 'missing';
    return applyOutcome(deps, tenantId, a.id, it.contactId, r ? itemOutcomeForDispatch(dispatchOutcome(r)) : itemOutcomeForMessageStatus(status!), prep.messageId);
  }
  try {
    const out = await composeHumanMessage(creator, it.contactId, { channel: prep.channel, body: prep.body, subject: prep.subject ?? undefined, idempotencyKey: prep.key, toPointId: prep.pointId, bulkActionId: a.id, purposeOverride: 'marketing' }, deps);
    const messageId = out.message?.id ?? null;
    let o: ItemOutcome;
    if (out.result === 'not_created') o = { status: 'blocked', reasonCode: skipForGateReasons(out.decision?.reasons ?? []) };
    else if (out.result === 'noop') o = itemOutcomeForMessageStatus(out.message?.status ?? 'missing');
    else if (out.result === 'scheduled') o = { status: 'pending', reasonCode: null };
    else o = itemOutcomeForDispatch(composeOutcome(out.result, out.decision?.reasons ?? [], out.message?.statusReason ?? null));
    await applyOutcome(deps, tenantId, a.id, it.contactId, o, messageId);
  } catch (e) {
    const code = dbCode(e);
    if (code === 'NOT_FOUND') return markInvisible(deps, tenantId, a.id, it.contactId);
    // a refusal after the message was created (a DB dispatch guard: an opt-out that arrived since) leaves the
    // message queued: cancel it and record the reason; nothing was sent
    const m = await sys(deps, tenantId, (tx) => B.messageByKey(tx, composeKey));
    if (m && m.status !== 'queued' && m.status !== 'scheduled') return applyOutcome(deps, tenantId, a.id, it.contactId, itemOutcomeForMessageStatus(m.status), m.id);
    const reason = code === 'BATCH_TEXT_DISABLED' ? 'BATCH_TEXT_DISABLED' : skipForGateReasons(code ? [code] : []);
    const status = reason === 'BATCH_TEXT_DISABLED' ? 'skipped' : reason === 'SEND_BLOCKED' && code === 'BULK_MESSAGE_INVALID' ? 'canceled' : 'blocked';
    await applyOutcome(deps, tenantId, a.id, it.contactId, { status, reasonCode: code === 'BULK_MESSAGE_INVALID' ? 'CANCELED' : reason, ...(m ? { cancelMessage: true as const } : {}) }, m?.id ?? null);
  }
}

function dispatchOutcome(r: DispatchResult): Parameters<typeof itemOutcomeForDispatch>[0] {
  switch (r.kind) {
    case 'blocked':
      return { kind: 'blocked', reasons: r.decision.reasons };
    case 'failed':
      return { kind: 'failed', reason: r.reason };
    case 'noop':
      return { kind: 'noop', status: r.status };
    default:
      return { kind: r.kind };
  }
}

function composeOutcome(result: string, reasons: string[], statusReason: string | null): Parameters<typeof itemOutcomeForDispatch>[0] {
  switch (result) {
    case 'blocked':
      return { kind: 'blocked', reasons };
    case 'failed':
      return { kind: 'failed', reason: statusReason ?? 'SEND_FAILED' };
    case 'sent':
    case 'dispatch_unknown':
    case 'needs_retap':
    case 'not_due':
      return { kind: result };
    default:
      return { kind: 'noop', status: 'missing' };
  }
}

// ---- edits: tag, untag, stage, assign, enroll -----------------------------------------------------------

async function editItem(deps: CommsDeps, tenantId: string, creator: UserActor, a: B.ActionRow, it: B.ItemRow): Promise<void> {
  let failed: unknown = null;
  let invisible = false;
  try {
    await asCreator(deps, creator, async (tx, now) => {
      const cur = await B.lockItem(tx, a.id, it.contactId);
      if (!cur) {
        invisible = true;
        return;
      }
      if (cur.status !== 'pending') return;
      await lockContact(tx, it.contactId as ContactId);
      const p = await personRow(tx, it.contactId);
      const person = await personFacts(tx, p);
      if (!p || !person.detailVisible) {
        invisible = true;
        return;
      }
      const target = a.kind === 'assign' ? await assignTarget(tx, String(a.params['toUserId'])) : null;
      if (a.kind === 'assign' && (!target || !target.active)) {
        await B.finishItem(tx, a.id, it.contactId, 'skipped', 'TARGET_NOT_ELIGIBLE');
        return;
      }
      const facts = await kindFacts(tx, a, p, now, target ? { role: target.role } : undefined);
      const r = bulkPreflight(a.kind, person, facts, { actor: creator, now });
      if (!r.ok) {
        await B.finishItem(tx, a.id, it.contactId, 'skipped', r.reason);
        return;
      }
      const skipped = await apply(tx, deps, creator, a, p, now);
      if (skipped) {
        await B.finishItem(tx, a.id, it.contactId, 'skipped', skipped);
        return;
      }
      if (a.kind === 'assign' && p.ownerUserId) {
        // whose leads moved, for the one summary per user at the end (R-PAR-35); atomic with the item
        await sql`UPDATE bulk_actions
                     SET counts = jsonb_set(jsonb_set(counts, '{assignFrom}', COALESCE(counts -> 'assignFrom', '{}'::jsonb), true),
                                            ARRAY['assignFrom', ${p.ownerUserId}::text],
                                            to_jsonb(COALESCE((counts #>> ARRAY['assignFrom', ${p.ownerUserId}::text])::int, 0) + 1), true)
                   WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
      }
      if (a.kind === 'assign' && p.ownershipState === 'offered' && p.offeredToUserId) {
        // whose offers the engine withdrew (R-OWN-18), for one summary per agent at the end (batch 6 review F6)
        await sql`UPDATE bulk_actions
                     SET counts = jsonb_set(jsonb_set(counts, '{offerFrom}', COALESCE(counts -> 'offerFrom', '{}'::jsonb), true),
                                            ARRAY['offerFrom', ${p.offeredToUserId}::text],
                                            to_jsonb(COALESCE((counts #>> ARRAY['offerFrom', ${p.offeredToUserId}::text])::int, 0) + 1), true)
                   WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
      }
      await B.finishItem(tx, a.id, it.contactId, 'done', null);
    });
  } catch (e) {
    failed = e;
  }
  if (invisible) return markInvisible(deps, tenantId, a.id, it.contactId);
  if (failed !== null) {
    // the item's transaction rolled back (a DB guard refused it, e.g. STAGE_NEEDS_CONTACT, or a concurrent
    // enrollment): the item is skipped with the guard's code; nothing of it was written
    const code = dbCode(failed);
    if (code === null) throw failed;
    await sys(deps, tenantId, (tx) => B.finishItem(tx, a.id, it.contactId, 'skipped', code === 'NOT_FOUND' ? 'NOT_VISIBLE' : code));
  }
}

/** Applies one person's edit as the creator. Returns a skip reason when the engine refuses, else null. */
async function apply(tx: Tx, deps: CommsDeps, creator: UserActor, a: B.ActionRow, p: { id: string; ownerUserId: string | null }, now: Instant): Promise<string | null> {
  switch (a.kind) {
    case 'tag':
      // provenance 'bulk' (the DB refuses a protected tag in bulk, review S7)
      await sql`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id)
                VALUES (app.tenant_id(), ${p.id}, ${String(a.params['tagId'])}, 'bulk', app.user_id()) ON CONFLICT DO NOTHING`.execute(tx);
      return null;
    case 'untag': {
      // core refuses a protected tag in bulk at draft (TAG_PROTECTED); a tag protected since (protect, or a
      // merge into a protected tag, R-PAR-9) is re-read here so the run agrees with a fresh draft (security review)
      const t = await sql<{ p: boolean }>`SELECT protected_proxy AS p FROM tags WHERE tenant_id = app.tenant_id() AND id = ${String(a.params['tagId'])}`.execute(tx);
      if (t.rows[0]?.p) return 'TAG_PROTECTED';
      await sql`DELETE FROM contact_tags WHERE tenant_id = app.tenant_id() AND contact_id = ${p.id} AND tag_id = ${String(a.params['tagId'])}`.execute(tx);
      return null;
    }
    case 'stage':
      // the DB stage guard re-decides R-PAR-14; the definer trigger writes the stage history (R-PAR-15), naming this
      // action (it keeps the id only for the creator's running stage action): the stage automation never starts a
      // plan for a protected audience from it (R-PAR-8, batch 5 review F1, migration 0041)
      await sql`SELECT set_config('app.bulk_action_id', ${a.id}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = ${String(a.params['stage'])} WHERE tenant_id = app.tenant_id() AND id = ${p.id}`.execute(tx);
      await sql`SELECT set_config('app.bulk_action_id', '', true)`.execute(tx);
      return null;
    case 'assign': {
      // R-PAR-35: one ownership command per person, id derived from (action, person): a retry is a replay
      const r = await applyOwnershipCommandInTx(tx, creator, p.id as ContactId, { kind: 'assign', toUserId: String(a.params['toUserId']) as never, reason: 'BULK_ASSIGN' }, { commandId: derivedCommandId(a.id, p.id), ids: deps.ids, summaryNotices: true });
      await setOwnershipCommand(tx, null);
      return r.outcome.ok ? null : r.outcome.code; // E187: the engine's rejection, recorded in ownership_command_rejections
    }
    case 'enroll': {
      const v = await P.approvedVersionOf(tx, String(a.params['playbookId']));
      if (!v) return 'PLAYBOOK_NOT_APPROVED';
      const pb = await P.playbookById(tx, String(a.params['playbookId']));
      if (!pb || pb.status !== 'active') return 'PLAYBOOK_NOT_APPROVED';
      if (pb.scope === 'agent' && pb.ownerUserId !== p.ownerUserId) return 'NOT_PERMITTED';
      if (await P.liveEnrollmentOf(tx, p.id)) return 'ALREADY_ENROLLED';
      const id = deps.ids.next<'EnrollmentId'>();
      await P.insertEnrollment(tx, { id, playbookId: pb.id, versionId: v.id, contactId: p.id, enrolledBy: 'bulk', userId: creator.userId, dueAt: now, anchor: null });
      await enqueueStep(tx, id, now);
      await audit(tx, creator, { action: 'enrollment.changed', entity: { type: 'playbook_enrollment', id }, reason: `enrolled:bulk:${a.id}` });
      return null;
    }
    default:
      throw new TypeError(`apply: ${a.kind} is a send`);
  }
}
