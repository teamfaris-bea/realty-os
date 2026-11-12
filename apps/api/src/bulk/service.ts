// Bulk actions (parity module 63; R-PAR-33..R-PAR-42, Q-PAR-7, Q-PAR-9, D1).
//
//   create  (draft)   as the creator: resolve the selection (detail-visible only), refuse the action as a
//                     whole when core says so (roles, caps, protected audience, marketing identity, the
//                     batch-text switch), then run core bulkPreflight for every person. People who pass
//                     become the FROZEN target (one pending item each, with their one address for sends);
//                     everyone else is counted by reason. The template's version and text are frozen
//                     here too, so Confirm sends exactly what the preview showed (R-PAR-26, E180, E186).
//   confirm           the creator, in the same role, as themself (DB guard): re-checks the action as a
//                     whole (the switch, the daily email cap under the tenant lock), then enqueues
//                     bulk.run. A second confirm is a no-op (never a second run, never a second send).
//   cancel            the creator or Owner/Admin: pending items are canceled, queued messages too (R-PAR-42).
//
// Job payloads hold only the action id (R-TEN-7). Counts and audits hold codes and numbers only.
import type { IdGenerator, UserActor } from '@realty/core/foundation';
import { type BulkKind, type BulkKindFacts, bulkActionPreflight, bulkPreflight, isSendKind, isStage, tally } from '@realty/core/parity/bulk';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { emailIdentityFacts } from '../comms/repos/gate.js';
import { AppError, fromCoreFailure } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { enqueueTyped } from '../worker/registry.js';
import * as P from '../assistant/repos/playbooks.js';
import * as T from '../templates/repos/templates.js';
import { BULK_RUN } from './contract.js';
import { assignTarget, kindFacts, personFacts, personRow, sendContext, sendFacts } from './facts.js';
import { anyProtected } from './audience.js';
import * as B from './repos/bulk.js';
import { type AudienceSource, type SelectionDef, resolveSelection, selectionOptionsFor } from './selection.js';
import { notifyFinished } from './notices.js';
import { selectionAudience } from '../lists/index.js';

export interface BulkDeps {
  db: Database;
  ids: IdGenerator;
}

export interface CreateInput {
  kind: BulkKind;
  selection: SelectionDef;
  /** the list people picked by id came from: one built on a protected tag refuses sends and plans (R-PAR-8; the server reads its plan) */
  audienceSource?: AudienceSource | undefined;
  /** tags the UI used to build the selection (a tag chip view): a protected one refuses sends (R-PAR-8) */
  audienceTagIds?: string[] | undefined;
  tagId?: string | undefined;
  stage?: string | undefined;
  toUserId?: string | undefined;
  playbookId?: string | undefined;
  templateId?: string | undefined;
  idempotencyKey: string;
}

export interface ActionView {
  id: string;
  kind: BulkKind;
  status: B.ActionRow['status'];
  mine: boolean;
  selected: number;
  targetCount: number;
  /** skipped at draft, by reason (nobody hidden: every selected person is counted somewhere) */
  preflight: Record<string, number>;
  /** people left out because someone earlier has the same address (R-PAR-38: "2 people share an address") */
  sharedAddresses: number;
  /**
   * assign: of the people it will assign, those on offer to an agent now (counted at draft): assigning them withdraws
   * those offers (R-OWN-18), and each agent is told (batch 6 review F6)
   */
  onOffer: number;
  counts: ReturnType<typeof tally>;
  templateId: string | null;
  templateVersion: number | null;
  subject: string | null;
  body: string | null;
  failureCode: string | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

interface StoredCounts {
  selected?: number;
  preflight?: Record<string, number>;
  sharedAddresses?: number;
  onOffer?: number;
  final?: ReturnType<typeof tally>;
  /** send/enroll: every tag the audience was built from, re-checked at confirm (R-PAR-8, security review); stage: read before a plan starts (batch 5 review F1) */
  audienceTagIds?: string[];
}

export function viewOf(actor: UserActor, a: B.ActionRow, items: { status: B.ItemRow['status']; reasonCode: string | null }[]): ActionView {
  const c = a.counts as StoredCounts;
  const selected = c.selected ?? a.targetCount ?? 0;
  const preflight = c.preflight ?? {};
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    mine: a.createdByUserId === actor.userId,
    selected,
    targetCount: a.targetCount ?? 0,
    preflight,
    sharedAddresses: c.sharedAddresses ?? 0,
    onOffer: c.onOffer ?? 0,
    counts: tally(selected, preflight, items),
    templateId: a.templateId,
    templateVersion: a.templateVersion,
    subject: a.subjectSnapshot,
    body: a.bodySnapshot,
    failureCode: a.failureCode,
    createdAt: a.createdAt.toISOString(),
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    finishedAt: a.finishedAt?.toISOString() ?? null,
  };
}

const asUserTx = <R>(deps: BulkDeps, actor: UserActor, fn: (tx: Tx, now: number) => Promise<R>) => withTenantTx(actor, (tx, now) => fn(tx, now), { db: deps.db, retries: 2 });
const asSys = <R>(deps: BulkDeps, tenantId: string, fn: (tx: Tx) => Promise<R>) => withTenantTx(systemActor(tenantId, 'worker'), (tx) => fn(tx), { db: deps.db, retries: 2 });

const sendsToAudience = (kind: CreateInput['kind']): boolean => kind === 'email' || kind === 'text' || kind === 'enroll';
/**
 * The kinds whose draft records the tags its audience was built from: the sends and enrollments (re-checked at
 * confirm), and a stage change (batch 5 review F1, R-PAR-8): the stage automation reads them before one of its stage
 * changes starts a plan, and skips the plan for a protected audience (bulk/audience.ts stageAudienceProtected). The
 * stage change itself is allowed on a protected audience (one-to-one work, not a send).
 */
const recordsAudience = (kind: CreateInput['kind']): boolean => sendsToAudience(kind) || kind === 'stage';

/** The tags a send/enroll/stage audience was built from: its list or definition, the list people were picked from, and the client's chips. */
async function audienceTagsOf(tx: Tx, input: CreateInput): Promise<string[]> {
  const out = new Set((input.audienceTagIds ?? []).map((t) => t.toLowerCase()));
  const sources: AudienceSource[] = [];
  if ('listId' in input.selection) sources.push({ listId: input.selection.listId });
  else if ('definition' in input.selection) sources.push({ definition: input.selection.definition });
  if (input.audienceSource) sources.push(input.audienceSource);
  for (const src of sources) for (const t of (await selectionAudience(tx, src)).tagIds) out.add(t);
  return [...out].sort();
}

function requiredParams(input: CreateInput): Record<string, string> {
  const need = (k: keyof CreateInput, v: unknown) => {
    if (typeof v !== 'string' || v.length === 0) throw new AppError('BULK_PARAMS_INVALID', { missing: k });
    return v;
  };
  switch (input.kind) {
    case 'tag':
    case 'untag':
      return { tagId: need('tagId', input.tagId) };
    case 'stage':
      if (!input.stage || !isStage(input.stage)) throw new AppError('BULK_PARAMS_INVALID', { missing: 'stage' });
      return { stage: input.stage };
    case 'assign':
      return { toUserId: need('toUserId', input.toUserId) };
    case 'enroll':
      return { playbookId: need('playbookId', input.playbookId) };
    case 'email':
    case 'text':
      return { templateId: need('templateId', input.templateId) };
  }
}

/** POST /bulk-actions: builds the draft and its preview. Idempotent by the caller's key. */
export async function createDraft(actor: UserActor, input: CreateInput, deps: BulkDeps): Promise<ActionView> {
  const key = `${actor.userId}:${input.idempotencyKey}`.slice(0, 100);
  const params = requiredParams(input);
  const id = await asUserTx(deps, actor, async (tx, now) => {
    const prior = await B.actionByKey(tx, key);
    if (prior) {
      if (prior.createdByUserId !== actor.userId) throw new AppError('NOT_FOUND');
      return prior.id;
    }
    const requested = 'contactIds' in input.selection ? new Set(input.selection.contactIds.map((s) => s.toLowerCase())).size : 0;
    // module 60's resolveSelection: detail-visible people only, at most the kind's cap (BULK_TOO_LARGE past
    // it), LIST_TOO_SLOW past the list's 3 s, and a list or definition built on a protected tag is never a
    // send/enroll audience, nor are people picked one by one from it (audienceSource, R-PAR-8)
    const ids = await resolveSelection(tx, input.selection, { ...selectionOptionsFor(input.kind), audienceSource: input.audienceSource });
    const selected = Math.max(requested, ids.length);

    // ---- the action as a whole (core) ----
    let template: T.TemplateRow | null = null;
    if (isSendKind(input.kind)) {
      template = await T.templateById(tx, params['templateId']!);
      if (!template || template.archivedAt) throw new AppError('NOT_FOUND');
    }
    let tagProtected: boolean | undefined;
    if (input.kind === 'tag' || input.kind === 'untag') {
      const t = await sql<{ p: boolean }>`SELECT protected_proxy AS p FROM tags WHERE tenant_id = app.tenant_id() AND id = ${params['tagId']!}`.execute(tx);
      if (!t.rows[0]) throw new AppError('NOT_FOUND');
      tagProtected = t.rows[0].p;
    }
    let target: Awaited<ReturnType<typeof assignTarget>> = null;
    if (input.kind === 'assign') {
      target = await assignTarget(tx, params['toUserId']!);
      if (!target || !target.active) throw new AppError('NOT_FOUND');
    }
    let playbook: P.PlaybookRow | null = null;
    let approved = false;
    if (input.kind === 'enroll') {
      playbook = await P.playbookById(tx, params['playbookId']!);
      if (!playbook || playbook.status !== 'active' || playbook.kind === 'new_lead_response') throw new AppError('NOT_FOUND');
      approved = (await P.approvedVersionOf(tx, playbook.id)) !== null;
    }
    const ctx = isSendKind(input.kind) ? await sendContext(tx, input.kind, actor.userId) : null;
    const tenant = ctx ? await sql<{ brokerage: string; postal: string | null }>`SELECT brokerage_legal_name AS brokerage, brokerage_postal_address AS postal FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx) : null;
    const ident = ctx?.senderEmailId ? await emailIdentityFacts(tx, ctx.senderEmailId) : null;
    const pre = bulkActionPreflight({
      kind: input.kind,
      role: actor.role,
      selected,
      audienceProtected: await anyProtected(tx, input.audienceTagIds ?? []),
      ...(tagProtected === undefined ? {} : { tagProtected }),
      ...(template ? { templateChannelMatches: template.channel === (input.kind === 'email' ? 'email' : 'sms') } : {}),
      ...(input.kind === 'text' ? { batchTextEnabled: await B.batchTextEnabled(tx), smsMarketingRegistered: await B.smsMarketingRegistered(tx) } : {}),
      ...(tenant ? { brokerageNamePresent: (tenant.rows[0]?.brokerage ?? '').trim() !== '', postalAddressPresent: (tenant.rows[0]?.postal ?? '').trim() !== '' } : {}),
      ...(input.kind === 'email' ? { emailDomainVerified: ident?.status === 'active' && ident.domain?.verifiedAt != null, emailsConfirmedToday: 0 } : {}),
      ...(input.kind === 'enroll' ? { playbookApproved: approved } : {}),
    });
    if (!pre.ok) throw fromCoreFailure(pre, 'cap' in pre ? { cap: pre.cap } : undefined);

    // ---- the draft and its frozen target ----
    const actionId = deps.ids.next<'BulkActionId'>();
    const inserted = await B.insertDraft(tx, {
      id: actionId,
      kind: input.kind,
      role: actor.role,
      source: 'listId' in input.selection ? 'smart_list' : 'selection',
      smartListId: 'listId' in input.selection ? input.selection.listId : null,
      params,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      subject: template?.subject ?? null,
      body: template?.body ?? null,
      idempotencyKey: key,
    });
    if (!inserted) {
      const winner = await B.actionByKey(tx, key);
      if (!winner) throw new AppError('NOT_FOUND');
      return winner.id;
    }
    const preflight: Record<string, number> = {};
    const skip = (r: string) => (preflight[r] = (preflight[r] ?? 0) + 1);
    for (let i = ids.length; i < requested; i++) skip('NOT_VISIBLE');
    const items: { contactId: string; addressHmac: string | null }[] = [];
    const seen = new Set<string>();
    let shared = 0;
    let onOffer = 0;
    const run = { actor, now: now as never };
    for (const cid of ids) {
      const p = await personRow(tx, cid);
      const person = await personFacts(tx, p);
      let facts: BulkKindFacts | null = null;
      let address: string | null = null;
      if (p && person.detailVisible) {
        if (isSendKind(input.kind)) {
          const s = await sendFacts(tx, { kind: input.kind, subjectSnapshot: template!.subject, bodySnapshot: template!.body }, ctx!, cid, p, seen, now as never);
          facts = s.facts;
          address = s.point?.hmac ?? null;
        } else facts = await kindFacts(tx, { kind: input.kind, params }, p, now as never, target ? { role: target.role } : undefined);
      }
      const r = facts ? bulkPreflight(input.kind, person, facts, run) : ({ ok: false, reason: 'NOT_VISIBLE' } as const);
      if (r.ok && input.kind === 'enroll' && playbook?.scope === 'agent' && playbook.ownerUserId !== p?.ownerUserId) {
        skip('NOT_PERMITTED'); // an agent playbook covers only its agent's own contacts
        continue;
      }
      if (!r.ok) {
        if (r.reason === 'SHARED_ADDRESS') shared += 1;
        skip(r.reason);
        continue;
      }
      if (input.kind === 'assign' && p?.ownershipState === 'offered') onOffer += 1;
      items.push({ contactId: cid, addressHmac: isSendKind(input.kind) ? address : null });
    }
    await B.insertItems(tx, actionId, items);
    const audienceTagIds = recordsAudience(input.kind) ? await audienceTagsOf(tx, input) : undefined;
    await B.setDraftCounts(tx, actionId, items.length, { selected, preflight, sharedAddresses: shared, ...(input.kind === 'assign' ? { onOffer } : {}), ...(audienceTagIds ? { audienceTagIds } : {}) });
    await audit(tx, actor, { action: 'bulk.created', entity: { type: 'bulk_action', id: actionId }, changes: redactSnapshot({ kind: input.kind, status: 'draft', targetCount: items.length, selectedCount: selected }, { entity: 'bulk_action' }) });
    return actionId;
  });
  return getAction(actor, id, deps);
}

export async function getAction(actor: UserActor, id: string, deps: BulkDeps): Promise<ActionView> {
  return asUserTx(deps, actor, async (tx) => {
    const a = await B.actionById(tx, id);
    if (!a) throw new AppError('NOT_FOUND');
    return viewOf(actor, a, await B.itemOutcomes(tx, id));
  });
}

export async function listActions(actor: UserActor, deps: BulkDeps): Promise<ActionView[]> {
  return asUserTx(deps, actor, async (tx) => {
    const rows = await B.recentActions(tx, 50);
    const out: ActionView[] = [];
    for (const a of rows) out.push(viewOf(actor, a, await B.itemOutcomes(tx, a.id)));
    return out;
  });
}

/** POST /bulk-actions/:id/confirm: the creator, in the same role. Idempotent: a second confirm changes nothing. */
export async function confirmAction(actor: UserActor, id: string, deps: BulkDeps): Promise<ActionView> {
  await asUserTx(deps, actor, async (tx) => {
    const a = await B.actionById(tx, id, { lock: true });
    if (!a || a.createdByUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (a.status === 'confirmed' || a.status === 'running' || a.status === 'completed') return; // double confirm: no second run
    if (a.status !== 'draft') throw new AppError('BULK_NOT_DRAFT', { status: a.status });
    if (a.createdByRole !== actor.role) throw new AppError('BULK_CONFIRM_ROLE_CHANGED');
    if ((a.targetCount ?? 0) === 0) throw new AppError('BULK_NOTHING_TO_DO');
    const selected = (a.counts as StoredCounts).selected ?? a.targetCount ?? 0;
    if (a.kind === 'text' && !(await B.batchTextEnabled(tx))) throw new AppError('BATCH_TEXT_DISABLED');
    // R-PAR-8 (E189): a tag protected (or merged into a protected one) between draft and confirm still never
    // defines the audience: re-read the protection of the tags the draft was built from, and the saved list.
    if (sendsToAudience(a.kind)) {
      let audienceProtected = await anyProtected(tx, (a.counts as StoredCounts).audienceTagIds ?? []);
      if (!audienceProtected && a.smartListId) audienceProtected = await selectionAudience(tx, { listId: a.smartListId }).then((x) => x.audienceProtected, () => false);
      if (audienceProtected) throw new AppError('AUDIENCE_PROTECTED_PROXY');
    }
    if (a.kind === 'email') {
      // Q-PAR-7: the tenant's daily budget, counted across every creator (as the system), under a tenant lock
      await B.lockEmailBudget(tx);
      const today = await asSys(deps, actor.tenantId, (s) => B.emailsConfirmedToday(s));
      const pre = bulkActionPreflight({ kind: 'email', role: actor.role, selected, audienceProtected: false, templateChannelMatches: true, brokerageNamePresent: true, postalAddressPresent: true, emailDomainVerified: true, emailsConfirmedToday: today });
      if (!pre.ok) throw fromCoreFailure(pre, 'remaining' in pre ? { remaining: pre.remaining, cap: pre.cap } : undefined);
    }
    await B.markConfirmed(tx, id);
    await enqueueTyped(tx, BULK_RUN, { actionId: id }, { dedupeKey: BULK_RUN.dedupeKey({ actionId: id }) });
    await audit(tx, actor, { action: 'bulk.confirmed', entity: { type: 'bulk_action', id }, changes: redactSnapshot({ kind: a.kind, status: 'confirmed', targetCount: a.targetCount }, { entity: 'bulk_action' }) });
  });
  return getAction(actor, id, deps);
}

/** POST /bulk-actions/:id/cancel: the creator or Owner/Admin. Done items stay done (no "unsend", R-PAR-42). */
export async function cancelAction(actor: UserActor, id: string, deps: BulkDeps): Promise<ActionView> {
  const was = await asUserTx(deps, actor, async (tx) => {
    const a = await B.actionById(tx, id);
    if (!a) throw new AppError('NOT_FOUND');
    // R-PAR-33: the creator, or an Owner/Admin (RLS lets a TL read their team's actions, never cancel them)
    if (a.createdByUserId !== actor.userId && actor.role !== 'owner' && actor.role !== 'admin') throw new AppError('NOT_FOUND');
    if (a.status === 'canceled') return null;
    if (a.status === 'completed' || a.status === 'failed') throw new AppError('BULK_NOT_LIVE', { status: a.status });
    return a;
  });
  if (was) {
    // the items and queued messages are the creator's (or anyone's, for an Owner/Admin cancel): the system
    // writes the cancel outcome, the human decision is audited as the human
    await asSys(deps, actor.tenantId, async (tx) => {
      const locked = await B.actionById(tx, id, { lock: true });
      if (!locked || locked.status === 'canceled' || locked.status === 'completed' || locked.status === 'failed') return;
      await B.cancelQueuedMessages(tx, id);
      await B.cancelPendingItems(tx, id, 'CANCELED');
      const c = locked.counts as StoredCounts;
      const final = tally(c.selected ?? 0, c.preflight ?? {}, await B.itemOutcomes(tx, id));
      await sql`UPDATE bulk_actions SET cancel_requested_at = now(), cancel_requested_by = ${actor.userId} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
      await B.markCanceled(tx, id, { ...c, final });
      if (locked.status !== 'draft') await notifyFinished(tx, deps.ids, locked, final, 'canceled');
    });
    await asUserTx(deps, actor, (tx) => audit(tx, actor, { action: 'bulk.canceled', entity: { type: 'bulk_action', id }, changes: redactSnapshot({ kind: was.kind, status: 'canceled' }, { entity: 'bulk_action' }) }));
  }
  return getAction(actor, id, deps);
}
