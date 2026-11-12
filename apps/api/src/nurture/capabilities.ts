// What a playbook step may need at send time (core Capability; R-INT-6, R-MKT-11, R-AVM-2).
//
//   review_requests  only once the `platform:review_requests` pack is counsel-reviewed (it ships unreviewed, so a
//                    review-request step is skipped visibly until then). VERIFY WITH COUNSEL (C8).
//   avm              never (P15, F7: one sender). Monthly home values are trigger firings of avm.refresh (wave 2C) and
//                    go out only through executeTriggerRun; the v1 post-closing enrollment's home_value step (requires
//                    ['avm'], no estimate in its text) therefore stays skipped visibly, even once platform:avm is
//                    cleared, so a client never gets a second, estimate-less home-value message.
// The enrollment step runner (assistant/enrollments.ts, one flagged line) passes this set to core planNextStep.
import type { Capability } from '@realty/core/assistant';
import type { Tx } from '@realty/db';
import { platformCleared } from './repos.js';

export async function stepCapabilities(tx: Tx): Promise<Set<Capability>> {
  const out = new Set<Capability>();
  if (await platformCleared(tx, 'platform:review_requests')) out.add('review_requests');
  return out;
}
