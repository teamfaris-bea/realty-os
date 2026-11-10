// ownership.followup (ARCHITECTURE §5 step 7, Design Review F1/F4): the cross-user effects of a
// user-actor ownership command, applied as the SYSTEM actor under the contact lock:
//   - route an `unassigned` lead whose route_due_at is set (after a decline, a reopen, …) with full
//     eligibility data (other agents' memberships, push subscriptions, claim stats, the cursor);
//   - other users' feed items; re-home open handbacks to the CURRENT owner (or the TL); invalidate
//     drafts bound to another owner/period (R-AST-7); pause agent enrollments (R-AST-8);
//     collaborator rows (ISA handoff); merge communication moves for non-tenant-wide actors;
//   - push / SMS delivery rows of notifications the user actor could only create in-app.
// The handler in apps/api/src/worker registers the job kind and calls `applyOwnershipFollowupInTx`
// in the job's withTenantTx({kind:'system', tenantId: job.tenantId}). Idempotent: every effect is a
// status/condition-guarded write, and routing uses a command id derived from the original one.
import type { ContactId, IdGenerator, SystemActor, UserId } from '@realty/core/foundation';
import type { Effect } from '@realty/core/ownership';
import { sql } from 'kysely';
import type { Database } from '../client.js';
import { lockContacts } from '../locks.js';
import { dbNow, type Tx, withTenantTx } from '../tenantTx.js';
import { type OwnershipCommandResult, applyOwnershipCommandInTx, defaultIds, derivedCommandId } from './apply.js';
import { loadPeople } from './context.js';
import { type FollowupPayload, addChannelDeliveries, applyEffects } from './effects.js';
import { mergeCommunication } from './merge.js';
import { projectionOf, selectContact } from './rows.js';

interface MergeCommunicationEffect {
  kind: 'mergeCommunication';
  survivorId: ContactId;
  loserId: ContactId;
  ownerUserId: UserId | null;
  previousOwnerUserId: UserId | null;
}

type FollowupEffect = Effect | MergeCommunicationEffect;

export class FollowupPayloadError extends TypeError {
  override readonly name = 'FollowupPayloadError';
}

function parsePayload(p: unknown): FollowupPayload {
  const x = p as Partial<FollowupPayload> | null;
  if (!x || typeof x.commandId !== 'string' || typeof x.contactId !== 'string' || !Array.isArray(x.effects) || !Array.isArray(x.fanoutNotificationIds)) {
    throw new FollowupPayloadError('ownership.followup payload must carry commandId, contactId, effects[], fanoutNotificationIds[]');
  }
  return x as FollowupPayload;
}

export interface FollowupResult {
  routed: OwnershipCommandResult | null;
  applied: number;
}

export async function applyOwnershipFollowupInTx(tx: Tx, actor: SystemActor, payload: unknown, opts: { ids?: IdGenerator } = {}): Promise<FollowupResult> {
  const p = parsePayload(payload);
  const ids = opts.ids ?? defaultIds();
  const contactId = p.contactId as ContactId;
  const effects = p.effects as unknown as FollowupEffect[];
  const merge = effects.find((e): e is MergeCommunicationEffect => e.kind === 'mergeCommunication');
  await lockContacts(tx, merge ? [merge.survivorId, merge.loserId] : [contactId]);
  const now = await dbNow(tx);
  const people = await loadPeople(tx);
  let routed: OwnershipCommandResult | null = null;
  let applied = 0;
  for (const e of effects) {
    if (e.kind === 'mergeCommunication') {
      await mergeCommunication(tx, now, ids, e.survivorId, e.loserId, e.ownerUserId, people, e.previousOwnerUserId);
      applied++;
      continue;
    }
    if (e.kind === 'route') {
      routed = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'route' }, { commandId: derivedCommandId('ownership.followup.route', p.commandId), ids });
      applied++;
      continue;
    }
    const row = await selectContact(tx, contactId);
    const cur = row ? projectionOf(row) : null;
    await applyEffects(tx, { actor, ids, now, contactId, before: null, after: cur, people, commandKind: 'followup' }, [e]);
    applied++;
  }
  for (const id of p.fanoutNotificationIds) {
    const n = await sql<{ user_id: string; priority: string }>`
      SELECT user_id, priority FROM notifications WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
    const row = n.rows[0];
    if (row) await addChannelDeliveries(tx, ids, id, row.user_id, row.priority, now);
  }
  return { routed, applied };
}

/** One follow-up job in its own transaction (what the api/jobs-worker handler runs). */
export function runOwnershipFollowup(actor: SystemActor, payload: unknown, opts: { ids?: IdGenerator; db?: Database } = {}): Promise<FollowupResult> {
  return withTenantTx(actor, (tx) => applyOwnershipFollowupInTx(tx, actor, payload, opts), { retries: 3, ...(opts.db ? { db: opts.db } : {}) });
}
