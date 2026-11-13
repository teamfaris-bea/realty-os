// The API modules' merge steps (packages/db ownership/merge.ts MergeStep): what a merge does to rows of modules the
// ownership engine does not know, in the merge's move transaction (inline, or in the ownership.followup). Both paths
// that apply a merge pass this list: leads/ownership.ts runOwnershipCommand and worker/handlers/followup.ts.
import type { MergeStep } from '@realty/db';
import { cmaMergeStep } from './cma/merge.js';

export const MERGE_STEPS: readonly MergeStep[] = [cmaMergeStep];
