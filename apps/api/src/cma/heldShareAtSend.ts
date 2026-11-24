// Call-time import of the held-share re-check for comms/dispatch.ts (R-CMA-7, E900).
//
// cma/deps.ts re-exports dispatch, so a static import of retap.ts from dispatch.ts would cycle at load.
// dispatch.ts itself cannot use import(): R-PUSH-13 (E1242) scans that file and forbids it, so the
// call-time import lives here and dispatch imports this module statically.
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import type { HeldShareRefusal } from './retap.js';

export async function heldCmaShareRefusalAtSend(tx: Tx, now: Instant, messageId: string): Promise<HeldShareRefusal | null> {
  const { heldCmaShareRefusalInTx } = await import('./retap.js');
  return heldCmaShareRefusalInTx(tx, now, messageId);
}
