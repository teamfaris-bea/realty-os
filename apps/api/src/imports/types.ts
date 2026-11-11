// Shared types and dependencies of api/imports (BUILD_PLAN module 16).
import type { IdGenerator } from '@realty/core/foundation';
import type { Category } from '@realty/core/import';
import type { Database } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
import type { ObjectStorage } from '../providers/types.js';
import type { FubConnector } from './fub.js';

/** Where a commit chunk transaction is when it calls the `inCommitChunk` test seam. */
export interface CommitChunkPoint {
  category: Category;
  /** `applied`: the chunk's records are applied; `fenced`: the members it assigned leads to are re-read and held (E232) */
  phase: 'applied' | 'fenced';
  /** the members this chunk assigned at least one lead to */
  assignedTo: readonly string[];
}

export interface ImportDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  storage: ObjectStorage;
  fub: FubConnector;
  /**
   * Test seam for the crash-resume proof: called after each committed chunk transaction. A throw here
   * behaves like a worker dying between transactions (the commit must resume without duplicates).
   */
  afterCommitChunk?: (chunkNo: number) => void | Promise<void>;
  /**
   * Test seam for the concurrency proofs of the ownership commit (E232): called inside every commit chunk
   * transaction, before it commits, once its records are applied and once the members it assigned are fenced.
   */
  inCommitChunk?: (p: CommitChunkPoint) => void | Promise<void>;
  /** records per commit transaction (≤ 1,000, R-IMPORT-4); tests use a smaller size to force several chunks */
  commitChunkSize?: number;
}

/**
 * Owner decision B4 (2026-11-11, E230): the issue on an ownership record whose planned assignment the commit did
 * not make because the mapped member could no longer hold leads. The owner decided it for a member suspended between
 * the ownership approval and the commit; the implementation handles every reason the engine refuses the target
 * (TARGET_NOT_ELIGIBLE) the same way. The record is `rejected` (not imported) for this documented reason, its target
 * is the person (unassigned), and the recount counts it so (core expectedAfterCommit).
 */
export const OWNER_UNAVAILABLE = 'OWNER_UNAVAILABLE';
/** Why, as the commit read the member: suspended, no longer an active member, a role that holds no leads, or (a race) none of these any more. */
export type UnassignedReason = 'suspended' | 'inactive' | 'role' | 'unavailable';
export interface UnassignedIssue {
  code: typeof OWNER_UNAVAILABLE;
  severity: 'info';
  /** as the commit read it: said in the present only while the member's membership still shows it (review B4-R2) */
  reason: UnassignedReason;
  /** the member the person was matched to (the name is looked up when shown, never stored here) */
  userId: string;
}

/**
 * Where a person the ownership commit brought in unassigned is now (E231, review B4-R1): still unassigned (the only
 * ones "Assign these people" selects), owned, on offer, in a pond, closed, deleted (or purged), or merged into another
 * contact. Only `owned` has an owner.
 */
export type UnassignedNow = 'unassigned' | 'owned' | 'offered' | 'in_pond' | 'closed' | 'deleted' | 'merged';

/** Deps for the HTTP side: the import routes build them from the platform plus the FUB connector. */
export type ImportDepsFactory = () => ImportDeps;

/** Days after the last verified stage within which the FUB credential is purged (R-IMPORT-11: at most 30). */
export const FUB_KEY_PURGE_DAYS = 30;

export const SOURCE_SYSTEM = { csv: 'csv', fub_api: 'fub', fub_export: 'fub' } as const;

export type SourceSystem = (typeof SOURCE_SYSTEM)[keyof typeof SOURCE_SYSTEM];
