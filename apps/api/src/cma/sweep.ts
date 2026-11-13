// The share's compliance-sweep cancel (module 71, D9 V2-A; R-CMA-9, R-CMA-7, R-MLS-3; E612). Called by module 24's
// mls.compliance_sweep (mls/sweep.ts), per tenant every 5 minutes, as the system in that one transaction.
//
// Driven from the shared CMAs through UQ cma_reports_share_message (0061; SHARED_READ, QUEUED_READ): a shared CMA's email that is still queued or
// scheduled (a message held for a re-tap after a client reply is still queued, so it is covered too) is canceled when
// the CMA's readiness fails now (readinessOf, the same check the share made), under the contact's lock (the lock
// dispatch takes), with status_reason 'CMA_' + the first blocker code; a message dispatched meanwhile is skipped (the
// gate had the last word). The CMA stays shared (R-CMA-8: the guard freezes it; the view says the email was canceled
// and to prepare a new one). The connections are read once per pass (agent verdicts), then readiness per row.
// Idempotent: a second pass finds nothing queued. Codes and ids only; nothing is sent.
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { readinessConnections } from './gates.js';
import { getCma } from './repos.js';
import { readinessOf } from './service.js';

/** The cancel reason of a blocker (messages.status_reason; the view words it, report.ts CANCEL_WORDS). */
export const cancelReason = (code: string) => `CMA_${code}`;

export interface CanceledShare {
  messageId: string;
  cmaId: string;
  reason: string;
}

/**
 * The sweep's reads (VERIFY 6), two index lookups with no scan of the tenant's messages (messages_due_idx is global and
 * not tenant-prefixed, so a join from messages would filter all of them): the tenant's shared CMAs with a message,
 * through the partial UQ cma_reports_share_message (0061; few rows: every CMA ever shared), then those messages still
 * queued or scheduled, by the messages primary key (tenant_id, id). No index is added (placeholder 0220_ unused).
 * QUEUED_READ is given at most `limit` ids at a time, so its LIMIT never cuts a page short (audit cma-v2a F5).
 * VERIFY 6 (open; audit cma-v2a F5): the brief's sweep reads from messages (review disposition #34 rejected driving it
 * from cma_reports, because SHARED_READ grows with every CMA ever shared). This read stays until the orchestrator
 * accepts it in writing, or an EXPLAIN on V1-A's volume fixture without enable_seqscan = off decides the brief's query
 * and its 0220_ tenant-prefixed partial index.
 */
export const SHARED_READ = sql`SELECT r.id, r.shared_message_id FROM cma_reports r
  WHERE r.tenant_id = app.tenant_id() AND r.shared_message_id IS NOT NULL AND r.status = 'shared'`;
export const QUEUED_READ = (ids: readonly string[], limit: number) => sql`SELECT m.id, m.contact_id FROM messages m
  WHERE m.tenant_id = app.tenant_id() AND m.id = ANY (${[...ids]}::uuid[]) AND m.direction = 'outbound' AND m.status IN ('queued','scheduled')
  LIMIT ${limit}`;

/** Cancels queued CMA share emails whose CMA is not client-ready now (E612). Returns what it canceled. */
export async function cancelIneligibleCmaSharesInTx(tx: Tx, now: Instant, o: { limit?: number } = {}): Promise<CanceledShare[]> {
  const shared = (await sql<{ id: string; shared_message_id: string }>`${SHARED_READ}`.execute(tx)).rows;
  if (shared.length === 0) return [];
  const cmaOf = new Map(shared.map((x) => [x.shared_message_id, x.id]));
  // Every shared message id, a page at a time in a stable order, so every queued share is re-checked on every pass. A
  // single read with a LIMIT and no ORDER BY read the same rows each pass: a share held for a re-tap stays queued while
  // it is ready, so more of them than the limit starved the rest (audit cma-v2a F5).
  const page = Math.max(1, o.limit ?? 500);
  const ids = [...cmaOf.keys()].sort();
  const rows: { id: string; contact_id: string }[] = [];
  for (let i = 0; i < ids.length; i += page) rows.push(...(await sql<{ id: string; contact_id: string }>`${QUEUED_READ(ids.slice(i, i + page), page)}`.execute(tx)).rows);
  // in contact order (sorted here: an ORDER BY in SQL would steer the plan onto messages_contact_idx and filter every
  // message of the tenant)
  const queued = rows
    .map((m) => ({ message_id: m.id, contact_id: m.contact_id, cma_id: cmaOf.get(m.id)! }))
    .sort((a, b) => (a.contact_id < b.contact_id ? -1 : a.contact_id > b.contact_id ? 1 : a.message_id < b.message_id ? -1 : 1));
  if (queued.length === 0) return [];
  const conns = await readinessConnections(tx, now); // once per pass
  const out: CanceledShare[] = [];
  for (const q of queued) {
    const row = await getCma(tx, q.cma_id);
    if (row === null) continue;
    const { share } = await readinessOf(tx, now, row, conns);
    const first = share.blockers[0];
    if (first === undefined) continue;
    // b13 review B13-MRG-6: no contact lock here. complianceSweepInTx (mls/sweep.ts) runs this pass in the same
    // transaction after the alerts pass, which locks its own contacts in order; a second sorted pass of contact locks
    // would break the global ascending order. The cancel is decided by the message row: dispatch holds it FOR UPDATE
    // and this UPDATE is conditional on queued/scheduled, so a dispatched message is never touched.
    const u = await sql<{ id: string }>`
      UPDATE messages SET status = 'canceled', status_reason = ${cancelReason(first.code)}
       WHERE tenant_id = app.tenant_id() AND id = ${q.message_id}::uuid AND status IN ('queued','scheduled') RETURNING id`.execute(tx);
    if (u.rows.length === 0) continue; // dispatched meanwhile: the send-time gate had the last word
    out.push({ messageId: q.message_id, cmaId: q.cma_id, reason: cancelReason(first.code) });
  }
  return out;
}
