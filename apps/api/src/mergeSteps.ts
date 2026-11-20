// The API modules' merge steps (packages/db ownership/merge.ts MergeStep): what a merge does to rows of modules the
// ownership engine does not know, in the merge's move transaction (inline, or in the ownership.followup). Both paths
// that apply a merge pass this list: leads/ownership.ts runOwnershipCommand and worker/handlers/followup.ts.
import type { MergeStep } from '@realty/db';
import { cmaMergeStep } from './cma/merge.js';
import { teamQueueMergeStep } from './leads/mergeStep.js';

// teamQueueMergeStep (b19 R-TEAMQ-26): the person's inquiries and a backup's live time-boxed grant go to the survivor
export const MERGE_STEPS: readonly MergeStep[] = [cmaMergeStep, teamQueueMergeStep];
