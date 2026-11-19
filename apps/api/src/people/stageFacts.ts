// The facts the stage rule reads from a person's row (R-PAR-14). A leaf module on purpose: the stage route
// (people/contacts.ts) and the outcome routes' stage suggestion (people/stageSuggestion.ts, loaded by comms/routes.ts)
// both need it, and contacts.ts loads the stage preview, which reaches comms/index.ts. Keeping this here keeps
// comms/routes.ts off that import cycle (imports/initOrder.architecture.test.ts, R-IMPORT-4).
import { instantFromDate } from '@realty/core/foundation';
import { type Stage, type StageFacts, isStage } from '@realty/core/parity/people';
import type * as repo from './repos/people.js';

export function stageFactsOf(r: repo.EditRow): StageFacts {
  return {
    stage: (isStage(r.stage) ? r.stage : 'new') as Stage,
    ownershipState: r.ownership_state,
    firstTouchDueAt: r.first_touch_due_at ? instantFromDate(r.first_touch_due_at) : null,
    firstTouchAt: r.first_touch_at ? instantFromDate(r.first_touch_at) : null,
  };
}
