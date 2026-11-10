// Shared types and dependencies of api/imports (BUILD_PLAN module 16).
import type { IdGenerator } from '@realty/core/foundation';
import type { Database } from '@realty/db';
import type { EnvelopeService } from '../crypto/envelope.js';
import type { ObjectStorage } from '../providers/types.js';
import type { FubConnector } from './fub.js';

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
  /** records per commit transaction (≤ 1,000, R-IMPORT-4); tests use a smaller size to force several chunks */
  commitChunkSize?: number;
}

/** Deps for the HTTP side: the import routes build them from the platform plus the FUB connector. */
export type ImportDepsFactory = () => ImportDeps;

/** Days after the last verified stage within which the FUB credential is purged (R-IMPORT-11: at most 30). */
export const FUB_KEY_PURGE_DAYS = 30;

export const SOURCE_SYSTEM = { csv: 'csv', fub_api: 'fub', fub_export: 'fub' } as const;

export type SourceSystem = (typeof SOURCE_SYSTEM)[keyof typeof SOURCE_SYSTEM];
