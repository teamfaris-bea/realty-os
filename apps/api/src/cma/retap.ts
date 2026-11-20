// The re-tap of a held CMA share (module 71; R-CMA-7, R-CMA-9; E612; ARCHITECTURE §21.48 VERIFY 9).
//
// A share's email is a human message. When the client replies before it is dispatched it is held for a re-tap (E27)
// and stays queued; the compliance sweep re-checks it every 5 minutes (sweep.ts). The re-tap itself
// (POST /messages/:id/send → comms dispatch TX1 with `retap`) used to send it without asking whether the CMA is still
// client-ready, so a tap between a gate failing and the next sweep reached the client. dispatch TX1 now asks here,
// under the contact's lock and the message's row lock, before its own send-time gate: the same check the share and
// the sweep make (readinessOf), for the CMA whose shared_message_id is this message (the link the sweep reads).
//
// It only reads. dispatch cancels the message with the sweep's reason ('CMA_' + the first blocker), so the CMA's view
// says the same thing whichever of the two found it, and sends nothing. Not a send path: nothing here calls a provider.
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { getCma } from './repos.js';
import { readinessOf } from './service.js';
import { cancelReason } from './sweep.js';

export interface HeldShareRefusal {
  cmaId: string;
  /** messages.status_reason of the cancel: 'CMA_' + the first blocker (the sweep's reason; report.ts words it) */
  reason: string;
  /** every readiness blocker that holds now, codes only (CMA_NOT_SHAREABLE details.blockers) */
  blockers: string[];
}

/**
 * Whether `messageId` is a CMA share whose CMA is not client-ready now: the refusal, or null when the message is no
 * CMA share or its CMA is ready. The caller (dispatch TX1 as the sender, who is the CMA's creator and so reads it
 * under RLS) holds the contact's lock and the message row.
 */
export async function heldCmaShareRefusalInTx(tx: Tx, now: Instant, messageId: string): Promise<HeldShareRefusal | null> {
  const linked = (await sql<{ id: string }>`SELECT id FROM cma_reports WHERE tenant_id = app.tenant_id() AND shared_message_id = ${messageId}::uuid`.execute(tx)).rows[0];
  if (linked === undefined) return null;
  const row = await getCma(tx, linked.id);
  if (row === null) return null;
  const { share } = await readinessOf(tx, now, row);
  const first = share.blockers[0];
  if (first === undefined) return null;
  return { cmaId: row.id, reason: cancelReason(first.code), blockers: share.blockers.map((b) => b.code) };
}
