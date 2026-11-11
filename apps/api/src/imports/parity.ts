// FUB/CSV import parity: stage map, tag catalog, typed custom fields (PARITY_PLAN module 65; R-PAR-46).
//
//   GET /imports/:id/parity   the distinct source stages (with counts and the current map), the tag plan
//                             (existing / new / over the 1,000 limit / protected), the custom fields
//                             (suggested type, fit / misfit counts, protected), the blockers, plain lines
//   PUT /imports/:id/parity   { stageMap, keepStageAsTag, fields }: stored in import_batches.options.parity;
//                             changing it resets the contacts dry run (it must be run and approved again)
//
// The contacts stage cannot be approved while a stage label is unmapped (STAGE_MAP_INCOMPLETE), the tags
// would pass the catalog limit (TAG_LIMIT, E190) or the new fields would pass 50 live (CUSTOM_FIELD_LIMIT).
// A field that reads like a protected fair-housing attribute is never created (R-PAR-18): its raw text
// stays in imported_fields, and naming one in a mapping is refused CUSTOM_FIELD_PROTECTED.
import type { TenantId, UserActor } from '@realty/core/foundation';
import {
  DEFAULT_PARITY_OPTIONS,
  type FieldOption,
  type FieldType,
  type NormalizedContact,
  type ParityOptions,
  type ParitySummary,
  classifyProtected,
  parityLines,
  parityReport,
  paritySummary,
} from '@realty/core/import';
import { type Tx, withTenantTx } from '@realty/db';
import { AppError } from '../errors.js';
import * as brepo from './repos/batches.js';
import * as prepo from './repos/parity.js';
import { stageSource } from './stages.js';
import type { ImportDeps } from './types.js';

const RESETTABLE: readonly brepo.StageStatus[] = ['pending', 'dry_run_ready', 'approved', 'failed'];

export function parityOptionsOf(b: brepo.BatchRow): ParityOptions {
  const o = b.options.parity;
  return { ...DEFAULT_PARITY_OPTIONS, ...(o ?? {}), stageMap: { ...(o?.stageMap ?? {}) }, fields: { ...(o?.fields ?? {}) } };
}

export const sourceKindOf = (b: brepo.BatchRow): 'fub' | 'csv' => (b.source === 'csv' ? 'csv' : 'fub');

/** The catalog facts the summary needs (as the caller: Owner/Admin or the import system actor see them all). */
export async function catalogContext(tx: Tx): Promise<{ catalogKeys: Set<string>; liveFields: number; existingFields: Map<string, { type: FieldType; options: FieldOption[] }>; defs: prepo.FieldDefRow[] }> {
  const [cat, defs] = await Promise.all([prepo.catalog(tx), prepo.fieldDefs(tx)]);
  return {
    catalogKeys: new Set(cat.keys()),
    liveFields: defs.filter((d) => !d.archived).length,
    existingFields: new Map(defs.filter((d) => !d.archived).map((d) => [d.id, { type: d.field_type, options: d.options }])),
    defs,
  };
}

export async function summarize(tx: Tx, b: brepo.BatchRow, contacts: readonly NormalizedContact[]): Promise<ParitySummary> {
  const ctx = await catalogContext(tx);
  return paritySummary(contacts, parityOptionsOf(b), { ...ctx, source: sourceKindOf(b) });
}

async function sourceContacts(deps: ImportDeps, tx: Tx, tenantId: TenantId, b: brepo.BatchRow): Promise<NormalizedContact[]> {
  // nothing is read before the snapshot exists (R-IMPORT-1): the plan is empty until then
  if (!b.source_snapshot_sha256) return [];
  const src = await stageSource(deps, tx, tenantId, b, 'contacts');
  return src.outcomes.flatMap((o) => (o.record && o.record.category === 'contacts' ? [o.record] : []));
}

export interface ParityView {
  options: ParityOptions;
  summary: ParitySummary;
  lines: string[];
  report: ReturnType<typeof parityReport>;
  /** the live custom fields an import field can map onto */
  existingFields: { id: string; key: string; label: string; type: FieldType }[];
}

async function viewIn(deps: ImportDeps, tx: Tx, tenantId: TenantId, b: brepo.BatchRow): Promise<ParityView> {
  const contacts = await sourceContacts(deps, tx, tenantId, b);
  const ctx = await catalogContext(tx);
  const summary = paritySummary(contacts, parityOptionsOf(b), { ...ctx, source: sourceKindOf(b) });
  return {
    options: parityOptionsOf(b),
    summary,
    lines: parityLines(summary, b.source === 'csv' ? 'your file' : 'Follow Up Boss'),
    report: parityReport(summary),
    existingFields: ctx.defs.filter((d) => !d.archived).map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.field_type })),
  };
}

export async function getParity(deps: ImportDeps, actor: UserActor, batchId: string): Promise<ParityView> {
  return withTenantTx(
    actor,
    async (tx) => {
      const b = await brepo.getBatch(tx, batchId);
      if (!b) throw new AppError('NOT_FOUND');
      return viewIn(deps, tx, actor.tenantId, b);
    },
    { db: deps.db },
  );
}

export async function setParity(deps: ImportDeps, actor: UserActor, batchId: string, input: ParityOptions): Promise<ParityView> {
  return withTenantTx(
    actor,
    async (tx) => {
      const b = await brepo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (['abandoned', 'reverting', 'reverted'].includes(b.status)) throw new AppError('IMPORT_STATE_CONFLICT', { status: b.status });
      const ctx = await catalogContext(tx);
      for (const [key, a] of Object.entries(input.fields)) {
        if (a.action === 'create' && (classifyProtected(a.label) || classifyProtected(key))) throw new AppError('CUSTOM_FIELD_PROTECTED', { field: key });
        if (a.action === 'existing' && !ctx.existingFields.has(a.fieldId)) throw new AppError('VALIDATION_FAILED', { issues: [{ path: `/fields/${key}`, code: 'field_not_found' }] });
      }
      const stages = await brepo.lockStages(tx, batchId);
      const contacts = stages.find((s) => s.category === 'contacts');
      if (contacts && !RESETTABLE.includes(contacts.status) && contacts.status !== 'skipped') throw new AppError('IMPORT_STATE_CONFLICT', { status: 'stage_committed' });
      const before = JSON.stringify(parityOptionsOf(b));
      const next: ParityOptions = { stageMap: input.stageMap, keepStageAsTag: input.keepStageAsTag, fields: input.fields };
      const nb: brepo.BatchRow = { ...b, options: { ...b.options, parity: next } };
      await brepo.setBatchOptions(tx, batchId, nb.options);
      // R-PAR-46: changing the map resets the contacts dry run (and any approval made on the old one)
      if (contacts && before !== JSON.stringify(next) && contacts.status !== 'pending' && RESETTABLE.includes(contacts.status)) await brepo.resetStageDryRun(tx, contacts.id, 'pending');
      return viewIn(deps, tx, actor.tenantId, nb);
    },
    { db: deps.db },
  );
}
