// Ownership commands for api/leads (BUILD_PLAN module 11; R-OWN-2, R-OWN-5, R-OWN-7, R-OWN-8,
// R-OWN-16…18, R-OWN-24, R-OWN-26, R-PERM-5, R-PERM-7).
//
//   runOwnershipCommand(actor, contactId, cmd, commandId, expectedSeq?)
//
// Every ownership change in this module goes through db/client's applyOwnershipCommand (the single
// code path: contact lock → DB clock → core.decide → ledger | rejection log → projection → effects,
// with the audit mirror of human commands written by the engine itself, so nothing is double
// audited here). This file only maps outcomes to the HTTP contract:
//   accepted / replayed            200, the events, and the projection AS THE CALLER NOW SEES IT
//                                  (null after a decline, release or reassign-away: R-PERM-7)
//   LEAD_OFFER_NOT_YOURS, NOT_FOUND 404 NOT_FOUND (existence is never revealed: R-PERM-5)
//   LEAD_STATE_CHANGED             409 with the fresh projection when the caller can still see it
//   every other rejection          409/422 with its code (the rejection is already in the log)
import type { Actor, ContactId, IdGenerator } from '@realty/core/foundation';
import type { OwnershipCommand, OwnershipErrorCode, OwnershipEvent, OwnershipProjection } from '@realty/core/ownership';
import { type Database, type Tx, applyOwnershipCommandInTx, applyOwnershipCommandThen, setOwnershipCommand, withTenantTx } from '@realty/db';

/** module 22: the engine did not apply the command; the hook's writes are rolled back with it */
class NotApplied extends Error {}
import type { z } from 'zod';
import { AppError, type ErrorCode, isErrorCode } from '../errors.js';
import { projectionOfRow, projectionRow } from './repos/ownership.js';
import type { ProjectionView } from './schemas.js';

export interface OwnershipEventSummary {
  seq: number;
  type: string;
  reasonCode: string;
  occurredAt: string;
}

export type OwnershipResult =
  | { ok: true; contactId: ContactId; replayed: boolean; events: OwnershipEventSummary[]; projection: z.infer<typeof ProjectionView> | null }
  | { ok: false; contactId: ContactId; replayed: boolean; code: OwnershipErrorCode; observedSeq: number | null; payload: Record<string, unknown>; projection: z.infer<typeof ProjectionView> | null };

export interface RunOptions {
  db?: Database;
  ids?: IdGenerator;
  /**
   * Module 22 (F19): work that must commit in the SAME transaction as the command and only if the engine applies it
   * (not a rejection, not a replay), e.g. closing as do_not_contact records the person-level opt-out. It runs BEFORE
   * the engine (a close takes the lead out of the closer's sight); when the engine does not apply the command, the
   * whole transaction is rolled back and the command runs again on its own, so its rejection or replay is recorded
   * exactly as without the hook.
   */
  beforeApply?: (tx: Tx) => Promise<void>;
}

function summary(events: readonly OwnershipEvent[], contactId: ContactId): OwnershipEventSummary[] {
  return events
    .filter((e) => e.contactId === contactId)
    .map((e) => ({ seq: e.seq, type: e.type, reasonCode: e.reasonCode, occurredAt: new Date(e.occurredAt).toISOString() }));
}

/**
 * The projection the caller can see once the command commits: read in the command's own transaction
 * after its last write, with app.ownership_command cleared (applyOwnershipCommandThen), i.e. under the
 * caller's plain RLS exactly as a fresh transaction would see it, without holding a second pooled
 * connection per tap (lane perf-misses: 45 agents tapping at once queued for connections).
 */
async function visibleProjection(tx: Tx, contactId: ContactId): Promise<z.infer<typeof ProjectionView> | null> {
  const row = await projectionRow(tx, contactId);
  return row ? projectionOfRow(row) : null;
}

/**
 * BUILD_PLAN interface. Runs one ownership command through the engine and reports the outcome
 * (it never throws for an expected rejection: callers map `ok: false` themselves).
 */
export async function runOwnershipCommand(
  actor: Actor,
  contactId: ContactId,
  cmd: OwnershipCommand,
  commandId: string,
  expectedSeq?: number,
  opts: RunOptions = {},
): Promise<OwnershipResult> {
  const id = (cmd.kind === 'merge' ? cmd.survivorId : contactId) as ContactId;
  if (opts.beforeApply) {
    const hook = opts.beforeApply;
    try {
      return await withTenantTx(
        actor,
        async (tx) => {
          await hook(tx);
          const r = await applyOwnershipCommandInTx(tx, actor, contactId, cmd, { commandId, ...(expectedSeq !== undefined ? { expectedSeq } : {}), ...(opts.ids ? { ids: opts.ids } : {}) });
          if (!r.outcome.ok || r.replayed) throw new NotApplied();
          await setOwnershipCommand(tx, null);
          return { ok: true as const, contactId: id, replayed: false, events: summary(r.outcome.events, id), projection: await visibleProjection(tx, id) };
        },
        { retries: 3, ...(opts.db ? { db: opts.db } : {}) },
      );
    } catch (e) {
      if (!(e instanceof NotApplied)) throw e;
    }
  }
  const { result: r, after: projection } = await applyOwnershipCommandThen(
    actor,
    contactId,
    cmd,
    {
      commandId,
      ...(expectedSeq !== undefined ? { expectedSeq } : {}),
      ...(opts.ids ? { ids: opts.ids } : {}),
      ...(opts.db ? { db: opts.db } : {}),
    },
    (tx) => visibleProjection(tx, id),
  );
  if (r.outcome.ok) {
    return { ok: true, contactId: id, replayed: r.replayed, events: summary(r.outcome.events, id), projection };
  }
  const rej = r.outcome.rejection;
  return { ok: false, contactId: id, replayed: r.replayed, code: r.outcome.code, observedSeq: rej.observedSeq, payload: rej.payload, projection };
}

const NOT_FOUND_CODES = new Set<OwnershipErrorCode>(['NOT_FOUND', 'LEAD_OFFER_NOT_YOURS']);

/** The HTTP error for a rejected command (details: ids, codes and the fresh projection only). */
export function rejectionError(r: Extract<OwnershipResult, { ok: false }>): AppError {
  if (NOT_FOUND_CODES.has(r.code)) return new AppError('NOT_FOUND');
  // A caller who can no longer see the contact learns only the code (R-PERM-7), never its new state.
  const details: Record<string, unknown> = { observedSeq: r.observedSeq };
  if (r.projection) details.projection = r.projection;
  if (r.code === 'MERGE_OWNER_REQUIRED' && typeof r.payload.preselected === 'string') details.preselectedOwnerUserId = r.payload.preselected;
  const code: ErrorCode = isErrorCode(r.code) ? r.code : 'INTERNAL_ERROR';
  return new AppError(code, details);
}

export type { OwnershipProjection };
