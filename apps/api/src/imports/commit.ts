// Commit: applies EXACTLY the reviewed snapshot records, ≤ 1,000 per transaction, resumable
// (BUILD_PLAN module 16; ARCHITECTURE §13; R-IMPORT-2, R-IMPORT-3, R-IMPORT-4, R-IMPORT-6,
// R-IMPORT-7, R-IMPORT-8, R-IMPORT-9, R-IMPORT-12, R-CONSENT-3, R-OWN-21).
//
//   requestCommit (Owner/Admin 🔒, audited): approved → committing. The DB trigger refuses the move
//                 unless every earlier stage is verified or skipped (R-IMPORT-3, IMPORT_STAGE_ORDER);
//                 the CHECK refuses it without a dry run and an approval (R-IMPORT-2).
//   runCommit     (job imports.commit, system actor 'import'): each chunk transaction locks the stage
//                 row, takes the next ≤ 1,000 records the reviewed plan applies and that are not
//                 applied yet, applies each inside a savepoint (a record error marks only that record
//                 rejected, COMMIT_FAILED, and never aborts its chunk), and marks each record in the
//                 same transaction. A crash between chunks resumes exactly where the last committed
//                 chunk stopped; two workers on the same stage serialize on the stage row.
//
// What each stage writes (all through the import actor, never a provider, never a touch):
//   contacts   (also the person's imported opt-outs: revocations + DNC suppressions, in the same
//              transaction as the contact, so they are in force before the later stages; outbound-2)
//              new contacts ONLY through the ownership engine (import_assign 'unassigned': an
//              `imported` ledger event, no offer, no SLA, no routing); exact phone/email matches are
//              filled only where empty (E41) and never change owner (R-IMPORT-7, R-OWN-21); name-only
//              matches become duplicate candidates, never merges.
//   ownership  import_assign to the mapped target, only for contacts this batch created that are
//              still in their imported creation state (core decides; R-IMPORT-8: no offer/SLA/notice).
//              Owner decision B4 (2026-11-11, E230-E232) for a member suspended since the approval,
//              applied by the implementation to every TARGET_NOT_ELIGIBLE refusal (also no longer an active
//              member, a role that holds no leads): nothing is assigned and the person stays as the contacts stage left them
//              (unassigned, never routed); the record is not imported for that documented reason
//              (OWNER_UNAVAILABLE, with the member and why), which the recount counts, so the stage
//              verifies and the later stages commit. Before a chunk commits it re-reads, FOR SHARE, every
//              member it assigned a lead to: one suspended meanwhile makes the chunk run again (and its
//              people come in unassigned); a suspension asked for after that waits for the chunk.
//   notes / messages / call_recordings
//              `imported = true` rows with the original timestamps (R-IMPORT-6); recordings point at the
//              copy made at snapshot time, labelled "recording notice unknown", not transcribed unless
//              transcribe_imported_recordings (R-IMPORT-12).
//   consent    grants at imported_unverified only; revokes full strength at commit; DNC → import_dnc
//              suppressions (R-CONSENT-3).
import {
  type ContactRef,
  type FubConsentFields,
  type NormalizedCall,
  type NormalizedContact,
  type NormalizedConsent,
  type NormalizedMessage,
  type NormalizedNote,
  type NormalizedOwnership,
  type NormalizedRecord,
  type PlanAction,
  classifyProtected,
  computeFill,
  contactTagNames,
  fieldKeyFrom,
  fieldKeyProtected,
  fieldValueInput,
  mappedStage,
  type ParityOptions,
  type ResolvedField,
  typedFieldValue,
  importedConsentKey,
  importedOptOuts,
  mapImportedConsent,
  mapImportedSuppressions,
  personRefOf,
} from '@realty/core/import';
import type { AddressKind } from '@realty/core/compliance';
import type { ContactId, Instant, SystemActor, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { canOwnLeads, toIso } from '@realty/core/foundation';
import { canReceiveLead } from '@realty/core/ownership';
import type { FieldDef } from '@realty/core/parity/fields';
import { type Tx, applyOwnershipCommandInTx, derivedCommandId, enqueueJob, lockContact, recordConsentEvent, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { TRANSCRIBE_JOB } from '../comms/recordings.js';
import { AppError } from '../errors.js';
import { addContactTags, ensureFieldDef, ensureTags, setFieldValue } from '../lists/index.js';
import { systemActor } from '../worker/systemActor.js';
import * as brepo from './repos/batches.js';
import * as existing from './repos/existing.js';
import * as prepo from './repos/parity.js';
import { parityOptionsOf, sourceKindOf } from './parity.js';
import * as rrepo from './repos/records.js';
import * as w from './repos/writes.js';
import { type ContactOptOuts, hmacIndex, loadBatchAndStage } from './stages.js';
import { type ImportDeps, OWNER_UNAVAILABLE, SOURCE_SYSTEM, type SourceSystem, type UnassignedReason } from './types.js';

export const COMMIT_JOB = { kind: 'imports.commit' as const, queue: 'bulk' as const };
/** Chunks per job run before the job yields (an early wake): keeps every lease short on 50k stages. */
export const CHUNKS_PER_RUN = 10;

/** A record-level failure: the record is rejected with this code, its chunk continues. */
export class RecordError extends Error {
  override readonly name = 'RecordError';
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * E232: a member this chunk assigned a lead to can no longer hold leads (suspended while the chunk ran). Thrown
 * after the chunk's member fence, it rolls the whole chunk back and withTenantTx runs it again (40001, like a
 * serialization failure): the engine then sees the member as they are, and those people come in unassigned.
 */
class MemberChangedDuringChunk extends Error {
  override readonly name = 'MemberChangedDuringChunk';
  readonly code = '40001';
}

function pgCode(e: unknown): string {
  const x = e as { code?: string; message?: string };
  if (e instanceof RecordError) return e.code;
  const m = /^([A-Z][A-Z0-9_]{2,60})(:|$)/.exec(x.message ?? '');
  if (m) return m[1] as string;
  return x.code ? `PG_${x.code}` : 'ERROR';
}

/** POST …/commit */
export async function requestCommit(deps: ImportDeps, actor: UserActor, batchId: string, category: NormalizedRecord['category']): Promise<void> {
  try {
    await withTenantTx(
      actor,
      async (tx) => {
        const { batch, stage, stages } = await loadBatchAndStage(tx, batchId, category, { lock: true });
        if (['abandoned', 'reverting', 'reverted', 'snapshotting'].includes(batch.status)) throw new AppError('IMPORT_STATE_CONFLICT', { status: batch.status });
        if (stage.status !== 'approved') throw new AppError('IMPORT_STATE_CONFLICT', { status: stage.status });
        // R-IMPORT-3 first (the DB trigger refuses the move), then: the reviewed plan must have seen
        // every earlier stage's commit (its parents are resolved against committed rows)
        if (!(await brepo.transitionStage(tx, stage.id, ['approved'], 'committing'))) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'changed' });
        const ranAt = stage.dry_run_completed_at?.getTime() ?? 0;
        if (stages.some((s) => s.seq < stage.seq && s.committed_at !== null && s.committed_at.getTime() > ranAt)) throw new AppError('IMPORT_DRY_RUN_STALE');
        await brepo.setBatchStatus(tx, batchId, 'committing');
        await audit(tx, actor, { action: 'import.committed', entity: { type: 'import_stage', id: stage.id }, reason: `${category.toUpperCase()}_COMMIT_STARTED` });
        await enqueueJob(tx, { queue: COMMIT_JOB.queue, kind: COMMIT_JOB.kind, payload: { stageId: stage.id }, dedupeKey: `imports.commit:${stage.id}` });
      },
      { db: deps.db },
    );
  } catch (e) {
    if (/^IMPORT_STAGE_ORDER/.test((e as Error).message ?? '')) throw new AppError('IMPORT_STAGE_ORDER');
    throw e;
  }
}

interface Ctx {
  deps: ImportDeps;
  tx: Tx;
  actor: SystemActor;
  tenantId: TenantId;
  batch: brepo.BatchRow;
  stage: brepo.StageRow;
  system: SourceSystem;
  now: Instant;
  keyOf: (kind: AddressKind, n: string) => string;
  members: Set<string>;
  settings: { recordingRetentionDays: number; transcribeImported: boolean };
  /** PARITY 65: the contacts stage's stage map / tag / field plan, and the resolved field definitions */
  parity: { options: ParityOptions; fields: Map<string, ImportField> };
}

/** A resolved field and its stored definition (module 60's setFieldValue validates each value against it). */
type ImportField = ResolvedField & { def: FieldDef };

/** PARITY 65: what one contact record wrote of the parity plan (merged into the batch only when the record commits). */
interface ParityApplied {
  tagIds: string[];
  counts: Record<string, number>;
}

interface Applied {
  target: { table: string; id: string } | null;
  created: rrepo.CreatedRow[];
  /** nothing new to write after all (e.g. the owner was kept): counted as duplicate */
  duplicate?: boolean;
  extraIssues?: { code: string; severity: 'info' }[];
  parity?: ParityApplied;
  /** owner decision B4 (E230): the planned assignment was not made; the person stays unassigned, for this reason */
  unassigned?: { contactId: string; userId: string; reason: UnassignedReason };
  /** the member this record assigned a lead to (fenced before the chunk commits, E232) */
  assignedTo?: string;
}

let sp = 0;
async function inSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const name = sql.raw(`imp_rec_${(sp = (sp + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    const r = await fn();
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return r;
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    throw e;
  }
}

/** Follows merge redirects to the surviving, non-deleted contact; null when there is none. */
async function liveId(tx: Tx, id: string): Promise<{ id: string; rowVersion: number; seq: number } | null> {
  let cur = id;
  for (let i = 0; i < 8; i++) {
    const c = await w.liveContact(tx, cur);
    if (!c) return null;
    if (c.merged_into_contact_id) {
      cur = c.merged_into_contact_id;
      continue;
    }
    if (c.deleted_at !== null || c.closed_reason === 'deleted') return null;
    return { id: cur, rowVersion: c.row_version, seq: Number(c.ownership_seq) };
  }
  return null;
}

/** The live contact a record's parent ref resolves to now, with its ownership ledger head (the revert's baseline). */
async function resolveLive(c: Ctx, ref: ContactRef): Promise<{ id: string; seq: number }> {
  const id = 'contactId' in ref ? ref.contactId : await w.externalRef(c.tx, c.system, 'contact', ref.pendingPersonRef);
  if (id === null) throw new RecordError('PARENT_NOT_FOUND');
  const live = await liveId(c.tx, id);
  if (!live) throw new RecordError('PARENT_NOT_FOUND');
  return { id: live.id, seq: live.seq };
}

async function resolveRef(c: Ctx, ref: ContactRef): Promise<string> {
  return (await resolveLive(c, ref)).id;
}

async function addPoints(c: Ctx, contactId: string, phones: NormalizedContact['phones'], emails: NormalizedContact['emails']): Promise<rrepo.CreatedRow[]> {
  const pts = [
    ...phones.map((p) => ({ id: c.deps.ids.next<'ContactPointId'>(), kind: 'phone' as const, address: p.e164, hmacHex: c.keyOf('phone', p.e164), label: p.label, status: p.status, isPrimary: p.isPrimary })),
    ...emails.map((e) => ({ id: c.deps.ids.next<'ContactPointId'>(), kind: 'email' as const, address: e.email, hmacHex: c.keyOf('email', e.email), label: e.label, status: e.status, isPrimary: e.isPrimary })),
  ];
  return (await w.insertPoints(c.tx, contactId, c.batch.id, pts)).map((id) => ({ table: 'contact_points', id, contactId }));
}

async function addAddresses(c: Ctx, contactId: string, addrs: NormalizedContact['addresses']): Promise<rrepo.CreatedRow[]> {
  const out: rrepo.CreatedRow[] = [];
  for (const a of addrs) {
    const id = c.deps.ids.next<'ContactAddressId'>();
    await w.insertAddress(c.tx, { id, contactId, kind: a.kind, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country, batchId: c.batch.id });
    out.push({ table: 'contact_addresses', id, contactId });
  }
  return out;
}

/** Duplicate candidates: the planned ones, plus exact matches that appeared after the dry run (never merged). */
async function addDuplicates(c: Ctx, contactId: string, n: NormalizedContact, planned: { contactId: string; reason: string }[]): Promise<void> {
  for (const d of planned) await w.insertDuplicate(c.tx, c.deps.ids.next<'DuplicateCandidateId'>(), contactId, d.contactId, d.reason);
  const hmacs = [...n.phones.map((p) => c.keyOf('phone', p.e164)), ...n.emails.map((e) => c.keyOf('email', e.email))];
  for (const m of await w.contactsWithHmacs(c.tx, hmacs, contactId)) {
    await w.insertDuplicate(c.tx, c.deps.ids.next<'DuplicateCandidateId'>(), contactId, m.contact_id, m.kind === 'phone' ? 'shared_phone' : 'shared_email');
  }
}

/** The record's carried-over opt-outs (stored at the dry run; CSV rows dry-run before it read their own columns). */
function optOutsOf(c: Ctx, rec: rrepo.RecordRow, n: NormalizedContact): ContactOptOuts | null {
  const stored = (rec.plan as { optOuts?: ContactOptOuts } | null)?.optOuts;
  if (stored) return stored;
  if (c.batch.source !== 'csv' || !n.consent) return null;
  const fields = importedOptOuts(n.consent.fields, n.consent.issues);
  return fields.addresses.length > 0 ? { fields, provenance: { source: 'csv', sourceRef: rec.source_ref } } : null;
}

/**
 * outbound-2 / R-CONSENT-3 / E40: the person's imported revocations and do-not-contact flags take
 * effect in the same transaction that creates or fills the contact, so an imported opt-out is never
 * sendable while the later stages are still pending. Revocations already in the ledger are not written
 * twice (the consent stage's dry run then sees them as already imported). Both stay on revert.
 */
async function applyOptOuts(c: Ctx, rec: rrepo.RecordRow, n: NormalizedContact, contactId: string | null): Promise<rrepo.CreatedRow[]> {
  const o = optOutsOf(c, rec, n);
  if (!o) return [];
  const have = await w.importedOptOutKeys(c.tx, o.fields.addresses.map((a) => c.keyOf(a.kind, a.address)));
  const fresh: FubConsentFields = {
    occurredAt: o.fields.occurredAt,
    addresses: o.fields.addresses
      .map((a) => {
        const k = c.keyOf(a.kind, a.address);
        return {
          ...a,
          grants: [],
          revokes: a.revokes.filter((ch) => !have.has(importedConsentKey(k, ch, 'revoke'))),
          doNotContact: a.doNotContact && !have.has(importedConsentKey(k, a.kind === 'email' ? 'email' : 'sms', 'dnc')),
        };
      })
      .filter((a) => a.revokes.length > 0 || a.doNotContact),
  };
  if (fresh.addresses.length === 0) return [];
  const source = c.system === 'fub' ? 'import_fub' : 'import_csv';
  const created: rrepo.CreatedRow[] = [];
  const of = contactId === null ? {} : { contactId };
  for (const s of mapImportedConsent(fresh, o.provenance, { ids: c.deps.ids, now: c.now, hmac: c.keyOf, source, contactId, importRecordId: rec.id })) {
    await recordConsentEvent(c.tx, s);
    created.push({ table: 'consent_events', id: s.id, ...of });
  }
  for (const s of mapImportedSuppressions(fresh, { ids: c.deps.ids, hmac: c.keyOf, source, importRecordId: rec.id })) {
    const id = await w.insertImportedSuppression(c.tx, { id: s.id, addressKind: s.addressKind, addressHmac: s.addressHmac, addressHint: s.addressHint, sourceRef: s.sourceRef, importRecordId: rec.id });
    if (id) created.push({ table: 'suppressions', id, ...of });
  }
  return created;
}

/**
 * The live contact a contacts record skipped as a duplicate points at (B6): for an in-file duplicate, the contact the
 * earlier row of the stage wrote (or the existing contact that row matched, when it was itself skipped); otherwise
 * the existing contact it matched (`existingId`). Null when there is none (the earlier row was rejected or failed).
 */
async function skipTarget(c: Ctx, rec: rrepo.RecordRow): Promise<string | null> {
  const plan = rec.plan as { kind?: string; existingId?: string } | null;
  if (plan?.kind !== 'skip' || !plan.existingId) return null;
  const inFile = (r: rrepo.RecordRow) => r.issues.some((i) => i.code === 'IN_FILE_DUPLICATE');
  let id: string | null = plan.existingId;
  if (inFile(rec)) {
    const earlier = (await rrepo.getRecordsByRefs(c.tx, c.stage.id, [plan.existingId]))[0];
    const ep = earlier?.plan as { kind?: string; existingId?: string } | null | undefined;
    if (earlier?.outcome === 'imported' && earlier.target_table === 'contacts') id = earlier.target_id;
    else id = earlier && ep?.kind === 'skip' && !inFile(earlier) ? (ep.existingId ?? null) : null;
  }
  return id === null ? null : ((await liveId(c.tx, id))?.id ?? null);
}

/**
 * B6 review R2 (outbound-2, R-CONSENT-3, E40): a contacts record skipped as a duplicate commits nothing of its person,
 * but the opt-outs it carries (stored with its plan at the dry run) take effect at the contacts commit like everyone
 * else's: address-keyed revocations and import_dnc suppressions, in this chunk's transaction, naming the contact the
 * skip points at when there is one. Like every imported revocation they stay on revert. The consent stage then finds
 * them in the ledger and adds only the history.
 */
async function applySkippedOptOuts(c: Ctx, rec: rrepo.RecordRow): Promise<rrepo.CreatedRow[]> {
  const n = rec.normalized as NormalizedRecord | null;
  if (n?.category !== 'contacts') return [];
  return applyOptOuts(c, rec, n, await skipTarget(c, rec));
}

/** A definition row as module 60's writers take it. */
function fieldDefOf(r: prepo.FieldDefRow): FieldDef {
  return { id: r.id, key: r.key, label: r.label, fieldType: r.field_type, options: r.options, annual: r.annual, archived: r.archived };
}

/**
 * PARITY 65 (R-PAR-46): the definitions this contacts commit writes values into: existing fields as mapped,
 * and new typed fields created once per chunk, OUTSIDE the per-record savepoints (a rejected record never
 * takes a definition with it), through module 60's ensureFieldDef (core validates the type, key, choices and
 * the protected-trait lexicon). A protected-looking field is never created (R-PAR-18).
 */
async function resolveFields(tx: Tx, batch: brepo.BatchRow, options: ParityOptions, ids: ImportDeps['ids']): Promise<{ fields: Map<string, ImportField>; createdIds: string[] }> {
  const fields = new Map<string, ImportField>();
  const createdIds: string[] = [];
  if (Object.keys(options.fields).length === 0) return { fields, createdIds };
  const defs = await prepo.fieldDefs(tx);
  const summary = batch.options.paritySummary;
  const use = (sourceKey: string, d: FieldDef) => fields.set(sourceKey, { sourceKey, fieldId: d.id, key: d.key, type: d.fieldType, options: d.options, def: d });
  for (const [sourceKey, a] of Object.entries(options.fields)) {
    if (a.action === 'skip') continue;
    if (a.action === 'existing') {
      const d = defs.find((x) => x.id === a.fieldId && !x.archived);
      if (d) use(sourceKey, fieldDefOf(d));
      continue;
    }
    if (classifyProtected(a.label) || fieldKeyProtected(sourceKey)) continue;
    const key = fieldKeyFrom(sourceKey, sourceKindOf(batch));
    if (key === null) continue;
    const have = defs.find((x) => x.key === key);
    if (have) {
      if (!have.archived && have.field_type === a.type) use(sourceKey, fieldDefOf(have));
      continue;
    }
    const opts = a.type === 'single_select' || a.type === 'multi_select' ? (summary?.fields.find((f) => f.sourceKey === sourceKey)?.options ?? []) : [];
    const label = defs.some((x) => !x.archived && x.label.toLowerCase() === a.label.toLowerCase()) ? `${a.label} (imported)`.slice(0, 60) : a.label;
    const made = await prepo.guarded(tx, () => ensureFieldDef(tx, ids, { label, fieldType: a.type, key, options: opts }, batch.source === 'csv' ? 'csv_import' : 'fub_import', null));
    if (!made.ok || !made.value.ok) continue;
    if (made.value.created) createdIds.push(made.value.def.id);
    use(sourceKey, made.value.def);
  }
  return { fields, createdIds };
}

/**
 * PARITY 65 (R-PAR-46, R-PAR-10): the person's tags go into the catalog and contact_tags (never
 * contacts.tags) through module 60's ensureTags / addContactTags, stamped with the batch (added_by_kind
 * 'import'); custom values go through setFieldValue with fillEmptyOnly (E41: written only where the person
 * has none); a value that does not fit stays as raw text in imported_fields. Each tag and value is written in
 * its own savepoint, so a limit hit skips that one, never the person. Tags never change whether anyone can
 * be contacted: a DNC-looking tag's opt-out comes from the consent rules (applyOptOuts), not from the tag.
 */
async function applyParity(c: Ctx, contactId: string, n: NormalizedContact, isNew: boolean): Promise<ParityApplied> {
  const counts: Record<string, number> = { tagLinks: 0, tagLinksExisting: 0, tagsSkipped: 0, values: 0, valuesKept: 0, valuesMisfit: 0, stagesSet: 0, stagesKept: 0 };
  const tagIds: string[] = [];
  for (const t of contactTagNames(n, c.parity.options, sourceKindOf(c.batch))) {
    const up = await prepo.guarded(c.tx, () => ensureTags(c.tx, c.deps.ids, [t.name], { kind: 'import' }));
    const tag = up.ok ? up.value.tags[0] : undefined;
    if (!tag) {
      counts.tagsSkipped! += 1; // TAG_LIMIT (E190) or a DB guard: the raw tag stays in imported_fields
      continue;
    }
    if (tag.created) tagIds.push(tag.id);
    const linked = await prepo.guarded(c.tx, () => addContactTags(c.tx, contactId, [tag.id], { kind: 'import', importBatchId: c.batch.id }));
    if (linked.ok && linked.value.added.length > 0) counts.tagLinks! += 1;
    else if (linked.ok) counts.tagLinksExisting! += 1;
    else counts.tagsSkipped! += 1;
  }
  for (const [sourceKey, raw] of Object.entries(n.customFields ?? {})) {
    const f = c.parity.fields.get(sourceKey);
    if (!f) continue;
    const v = typedFieldValue(f.type, f.options, raw);
    if (!v.ok) {
      counts.valuesMisfit! += 1;
      continue;
    }
    const wrote = await prepo.guarded(c.tx, () => setFieldValue(c.tx, contactId, f.def, fieldValueInput(v.value), { kind: 'import', importBatchId: c.batch.id }, { fillEmptyOnly: true }));
    if (wrote.ok && wrote.value.ok && wrote.value.changed) counts.values! += 1;
    else if (wrote.ok && wrote.value.ok) counts.valuesKept! += 1;
    else counts.valuesMisfit! += 1;
  }
  if (n.stageLabel) counts[isNew ? 'stagesSet' : 'stagesKept']! += 1;
  return { tagIds, counts };
}

async function applyContact(c: Ctx, rec: rrepo.RecordRow, n: NormalizedContact, plan: PlanAction & { mergeIntoContactId?: string }): Promise<Applied> {
  const personRef = personRefOf(n);
  if (plan.kind === 'create_contact' && rec.review_decision !== 'merge') {
    // R-PAR-46: a source stage becomes the Admin's mapped stage; a label nobody mapped never becomes `new`
    // silently (the approval is blocked, so this only trips on a stale plan)
    const stage = mappedStage(n.stageLabel, c.parity.options);
    if (stage === null) throw new RecordError('STAGE_UNMAPPED');
    const contactId = c.deps.ids.next<'ContactId'>();
    const r = await applyOwnershipCommandInTx(c.tx, c.actor, contactId, { kind: 'import_assign', target: 'unassigned' }, {
      commandId: derivedCommandId('import.contact', rec.id),
      ids: c.deps.ids,
      newContact: {
        displayName: n.displayName,
        firstName: n.firstName,
        lastName: n.lastName,
        contactType: n.contactType,
        intent: n.intent,
        stage,
        importBatchId: c.batch.id,
        originalSourceDetail: n.leadSourceLabel ? { import_source: n.leadSourceLabel.slice(0, 120), import_system: c.system } : { import_system: c.system },
      },
    });
    await setOwnershipCommand(c.tx, null);
    if (!r.outcome.ok) throw new RecordError(r.outcome.code);
    const id = r.replayed ? ((r.outcome.events[0]?.contactId as string | undefined) ?? contactId) : contactId;
    await w.setImportedFields(c.tx, id, n.importedFields);
    const parity = await applyParity(c, id, n, true);
    const created: rrepo.CreatedRow[] = [{ table: 'contacts', id, action: 'create', fp: await w.contactFingerprint(c.tx, id), seq: 1 }];
    created.push(...(await addPoints(c, id, n.phones, n.emails)));
    created.push(...(await addAddresses(c, id, n.addresses)));
    await addDuplicates(c, id, n, plan.duplicateCandidates);
    created.push(...(await applyOptOuts(c, rec, n, id)));
    await w.insertExternalRef(c.tx, { system: c.system, entityType: 'contact', externalId: personRef, entityId: id, batchId: c.batch.id });
    return { target: { table: 'contacts', id }, created, parity };
  }
  const targetId = rec.review_decision === 'merge' ? plan.mergeIntoContactId : 'contactId' in plan ? (plan as { contactId: string }).contactId : undefined;
  if (!targetId) throw new RecordError('RECORD_MALFORMED');
  const live = await liveId(c.tx, targetId);
  if (!live) throw new RecordError('MATCH_GONE');
  await lockContact(c.tx, live.id as ContactId);
  const ex = (await existing.loadContacts(c.tx, [live.id])).contacts[0];
  if (!ex) throw new RecordError('MATCH_GONE');
  // E41: only where empty, recomputed against the contact as it is now; ownership is never touched.
  const fill = computeFill(n, ex);
  await w.fillContact(c.tx, live.id, { ...(fill.firstName !== undefined ? { firstName: fill.firstName } : {}), ...(fill.lastName !== undefined ? { lastName: fill.lastName } : {}), ...(fill.intent !== undefined ? { intent: fill.intent } : {}), addImportedFields: fill.addImportedFields });
  // E41: tags are added (never removed), values only where empty, the existing stage is kept
  const parity = await applyParity(c, live.id, n, false);
  const action = plan.kind === 'update_contact' ? 'update' : 'attach';
  const created: rrepo.CreatedRow[] = [{ table: 'contacts', id: live.id, action, fp: await w.contactFingerprint(c.tx, live.id), seq: live.seq }];
  created.push(...(await addPoints(c, live.id, fill.addPhones, fill.addEmails)));
  created.push(...(await addAddresses(c, live.id, fill.addAddresses)));
  await addDuplicates(c, live.id, n, plan.kind === 'attach_contact' ? plan.duplicateCandidates : []);
  created.push(...(await applyOptOuts(c, rec, n, live.id)));
  await w.insertExternalRef(c.tx, { system: c.system, entityType: 'contact', externalId: personRef, entityId: live.id, batchId: c.batch.id });
  return { target: { table: 'contacts', id: live.id }, created, parity };
}

/** Why the engine refused the mapped member, as their membership reads now (the sentence names them, E230). */
function unassignedReason(m: w.MemberStatusRow | null): UnassignedReason {
  if (m === null) return 'inactive';
  if (m.status === 'suspended') return 'suspended';
  if (m.status !== 'active') return 'inactive';
  if (!canOwnLeads(m.role)) return 'role';
  return 'unavailable'; // eligible again by the time it was read (a race): the engine's refusal still stands
}

async function applyOwnership(c: Ctx, rec: rrepo.RecordRow, n: NormalizedOwnership, plan: Extract<PlanAction, { kind: 'assign' }>): Promise<Applied> {
  void n;
  const contactId = await resolveRef(c, plan.contact);
  const toUser = plan.target !== 'unassigned' && 'userId' in plan.target ? plan.target.userId : null;
  const r = await applyOwnershipCommandInTx(c.tx, c.actor, contactId as ContactId, { kind: 'import_assign', target: plan.target }, {
    commandId: derivedCommandId('import.ownership', rec.id),
    ids: c.deps.ids,
  });
  await setOwnershipCommand(c.tx, null);
  if (!r.outcome.ok) {
    // Owner decision B4 (E230): the mapped member can no longer hold leads (the engine decides: canReceiveLead).
    // Nothing is assigned to them, and the person stays exactly as the contacts stage left them: unassigned, never
    // routed, no offer, SLA or notice. Not a failure: a documented outcome the recount counts and the report lists.
    if (r.outcome.code === 'TARGET_NOT_ELIGIBLE' && toUser !== null) {
      return { target: { table: 'contacts', id: contactId }, created: [], unassigned: { contactId, userId: toUser, reason: unassignedReason(await w.memberStatus(c.tx, toUser)) } };
    }
    throw new RecordError(r.outcome.code);
  }
  const ev = r.outcome.events[0];
  if (!ev) return { target: null, created: [], duplicate: true, extraIssues: [{ code: 'OWNER_KEPT', severity: 'info' }] };
  return {
    target: { table: 'lead_ownership_events', id: ev.eventId },
    created: [{ table: 'lead_ownership_events', id: ev.eventId, contactId }],
    ...(ev.toState === 'owned' && ev.ownerUserId !== null ? { assignedTo: ev.ownerUserId } : {}),
  };
}

/**
 * E232: before a chunk commits, the members it assigned leads to are re-read and held FOR SHARE until it commits. If
 * one can no longer hold leads (a suspension committed while the chunk ran), the chunk runs again from the start.
 * A suspension asked for after this waits for the commit, so no import assignment ever commits after the
 * suspension of its member did.
 */
async function fenceAssignedMembers(tx: Tx, assignedTo: ReadonlySet<string>): Promise<void> {
  if (assignedTo.size === 0) return;
  const now = await w.lockMembers(tx, [...assignedTo]);
  const eligible = new Set(now.filter((m) => canReceiveLead({ userId: m.user_id as UserId, role: m.role, status: m.status, acceptingLeads: m.accepting_leads })).map((m) => m.user_id));
  if ([...assignedTo].some((id) => !eligible.has(id))) throw new MemberChangedDuringChunk('a member assigned in this chunk can no longer hold leads');
}

const member = (c: Ctx, id: string | null) => (id !== null && c.members.has(id) ? id : null);

// History rows carry the contact's ownership ledger head when the import wrote them (`seq`): the revert's "touched
// since import" baseline for a contact this batch's contacts stage did not write (a pre-existing contact a skipped
// duplicate's history went on, B6; a re-run's ALREADY_IMPORTED person), so a human event from before the import is
// never taken for a touch (review of B6, R1).
async function applyNote(c: Ctx, rec: rrepo.RecordRow, n: NormalizedNote, plan: Extract<PlanAction, { kind: 'insert_history' }>): Promise<Applied> {
  const { id: contactId, seq } = await resolveLive(c, plan.contact);
  const id = c.deps.ids.next<'NoteId'>();
  await w.insertNote(c.tx, { id, contactId, authorUserId: member(c, n.authorUserId), body: n.body, occurredAt: toIso(n.occurredAt), recordId: rec.id });
  await w.insertExternalRef(c.tx, { system: c.system, entityType: 'note', externalId: n.externalId, entityId: id, batchId: c.batch.id });
  return { target: { table: 'notes', id }, created: [{ table: 'notes', id, contactId, seq }] };
}

const OUR_SIDE = 'imported';

async function applyMessage(c: Ctx, rec: rrepo.RecordRow, n: NormalizedMessage, plan: Extract<PlanAction, { kind: 'insert_history' }>): Promise<Applied> {
  const { id: contactId, seq } = await resolveLive(c, plan.contact);
  const conv = await w.ensureConversation(c.tx, c.deps.ids.next<'ConversationId'>(), contactId);
  const client = (await w.primaryAddress(c.tx, contactId, n.channel === 'email' ? 'email' : 'phone')) ?? 'unknown';
  const id = c.deps.ids.next<'MessageId'>();
  await w.insertMessage(c.tx, {
    id,
    conversationId: conv,
    contactId,
    channel: n.channel,
    direction: n.direction,
    from: n.direction === 'inbound' ? client : OUR_SIDE,
    to: n.direction === 'inbound' ? OUR_SIDE : client,
    subject: n.subject,
    body: n.body,
    status: n.status,
    userId: member(c, n.userId),
    occurredAt: toIso(n.occurredAt),
    recordId: rec.id,
  });
  await w.insertExternalRef(c.tx, { system: c.system, entityType: 'message', externalId: n.externalId, entityId: id, batchId: c.batch.id });
  return { target: { table: 'messages', id }, created: [{ table: 'messages', id, contactId, seq }] };
}

async function applyCall(c: Ctx, rec: rrepo.RecordRow, n: NormalizedCall, plan: Extract<PlanAction, { kind: 'insert_history' }>): Promise<Applied> {
  const { id: contactId, seq } = await resolveLive(c, plan.contact);
  const conv = await w.ensureConversation(c.tx, c.deps.ids.next<'ConversationId'>(), contactId);
  const client = (await w.primaryAddress(c.tx, contactId, 'phone')) ?? 'unknown';
  const callId = c.deps.ids.next<'CallId'>();
  const objectId = n.recording ? (c.batch.options.recordings?.[n.externalId] ?? null) : null;
  await w.insertCall(c.tx, {
    id: callId,
    conversationId: conv,
    contactId,
    direction: n.direction,
    agentUserId: member(c, n.agentUserId),
    clientAddress: client,
    status: n.status,
    startedAt: toIso(n.startedAt),
    durationS: n.durationS,
    outcome: n.outcome,
    hasRecording: objectId !== null,
    recordId: rec.id,
  });
  const created: rrepo.CreatedRow[] = [{ table: 'calls', id: callId, contactId, seq }];
  const extraIssues: Applied['extraIssues'] = [];
  if (n.note) {
    const noteId = c.deps.ids.next<'NoteId'>();
    await w.insertNote(c.tx, { id: noteId, contactId, authorUserId: member(c, n.agentUserId), body: n.note, occurredAt: toIso(n.startedAt), recordId: rec.id });
    created.push({ table: 'notes', id: noteId, contactId, seq });
  }
  if (objectId !== null) {
    const recId = c.deps.ids.next<'RecordingId'>();
    await w.insertRecording(c.tx, { id: recId, callId, contactId, agentUserId: member(c, n.agentUserId), objectId, durationS: n.durationS, retainDays: c.settings.recordingRetentionDays });
    created.push({ table: 'recordings', id: recId, contactId, seq });
    // R-IMPORT-12: not transcribed unless the team turned it on (an agent may still ask for one)
    if (c.settings.transcribeImported) {
      await enqueueJob(c.tx, { queue: TRANSCRIBE_JOB.queue, kind: TRANSCRIBE_JOB.kind, payload: { recordingId: recId }, dedupeKey: TRANSCRIBE_JOB.dedupeKey(recId) });
    }
  } else if (n.recording) {
    extraIssues.push({ code: 'RECORDING_NOT_AVAILABLE', severity: 'info' });
  }
  await w.insertExternalRef(c.tx, { system: c.system, entityType: 'call', externalId: n.externalId, entityId: callId, batchId: c.batch.id });
  return { target: { table: 'calls', id: callId }, created, extraIssues };
}

async function applyConsent(c: Ctx, rec: rrepo.RecordRow, n: NormalizedConsent, plan: Extract<PlanAction, { kind: 'record_consent' }>): Promise<Applied> {
  let contactId: string | null = null;
  if (plan.contact) {
    try {
      contactId = await resolveRef(c, plan.contact);
    } catch {
      contactId = null; // consent is keyed by address, never blocked by a missing contact (R-CONSENT-1)
    }
  }
  const source = c.system === 'fub' ? 'import_fub' : 'import_csv';
  const specs = mapImportedConsent(plan.fields, n.provenance, { ids: c.deps.ids, now: c.now, hmac: c.keyOf, source, contactId, importRecordId: rec.id });
  const created: rrepo.CreatedRow[] = [];
  for (const s of specs) {
    await recordConsentEvent(c.tx, s);
    created.push({ table: 'consent_events', id: s.id });
  }
  for (const s of mapImportedSuppressions(plan.fields, { ids: c.deps.ids, hmac: c.keyOf, source, importRecordId: rec.id })) {
    const id = await w.insertImportedSuppression(c.tx, { id: s.id, addressKind: s.addressKind, addressHmac: s.addressHmac, addressHint: s.addressHint, sourceRef: s.sourceRef, importRecordId: rec.id });
    if (id) created.push({ table: 'suppressions', id });
  }
  const first = created[0];
  if (!first) return { target: null, created: [], duplicate: true };
  return { target: { table: first.table, id: first.id }, created };
}

async function applyRecord(c: Ctx, rec: rrepo.RecordRow): Promise<Applied> {
  const n = rec.normalized as NormalizedRecord | null;
  const plan = rec.plan as (PlanAction & { mergeIntoContactId?: string }) | null;
  if (!n || !plan) throw new RecordError('RECORD_MALFORMED');
  if (plan.kind === 'skip') return { target: null, created: [], duplicate: true };
  switch (n.category) {
    case 'contacts':
      return applyContact(c, rec, n, plan);
    case 'ownership':
      if (plan.kind !== 'assign') throw new RecordError('RECORD_MALFORMED');
      return applyOwnership(c, rec, n, plan);
    case 'notes':
      if (plan.kind !== 'insert_history') throw new RecordError('RECORD_MALFORMED');
      return applyNote(c, rec, n, plan);
    case 'messages':
      if (plan.kind !== 'insert_history') throw new RecordError('RECORD_MALFORMED');
      return applyMessage(c, rec, n, plan);
    case 'call_recordings':
      if (plan.kind !== 'insert_history') throw new RecordError('RECORD_MALFORMED');
      return applyCall(c, rec, n, plan);
    case 'consent':
      if (plan.kind !== 'record_consent') throw new RecordError('RECORD_MALFORMED');
      return applyConsent(c, rec, n, plan);
  }
}

async function addIssues(tx: Tx, id: string, issues: readonly { code: string; severity: string }[]): Promise<void> {
  if (issues.length === 0) return;
  await sql`UPDATE import_records SET issues = issues || ${JSON.stringify(issues)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

function addressesOfRecords(recs: readonly rrepo.RecordRow[]): { kind: AddressKind; address: string }[] {
  const out: { kind: AddressKind; address: string }[] = [];
  for (const r of recs) {
    const n = r.normalized as NormalizedRecord | null;
    if (n?.category === 'contacts') {
      out.push(...n.phones.map((p) => ({ kind: 'phone' as const, address: p.e164 })), ...n.emails.map((e) => ({ kind: 'email' as const, address: e.email })));
      const opt = (r.plan as { optOuts?: ContactOptOuts } | null)?.optOuts;
      out.push(...(opt?.fields.addresses ?? []).map((a) => ({ kind: a.kind, address: a.address })), ...(n.consent?.fields.addresses ?? []).map((a) => ({ kind: a.kind, address: a.address })));
    } else if (n?.category === 'consent') {
      out.push(...n.fields.addresses.map((a) => ({ kind: a.kind, address: a.address })));
    }
  }
  return out;
}

async function commitCtx(deps: ImportDeps, tx: Tx, actor: SystemActor, stage: brepo.StageRow, batch: brepo.BatchRow, now: Instant, recs: readonly rrepo.RecordRow[]): Promise<Ctx> {
  return {
    deps,
    tx,
    actor,
    tenantId: actor.tenantId,
    batch,
    stage,
    system: SOURCE_SYSTEM[batch.source],
    now,
    keyOf: await hmacIndex(deps, tx, actor.tenantId, new Map(), addressesOfRecords(recs)),
    members: await w.memberIds(tx),
    settings: await brepo.importSettings(tx),
    parity: { options: parityOptionsOf(batch), fields: new Map() },
  };
}

/**
 * The commit job (imports.commit). Runs chunk transactions until the stage is done or `maxChunks`
 * chunks ran ('more': the job re-queues itself). Idempotent and resumable.
 */
export async function runCommit(deps: ImportDeps, tenantId: string, stageId: string, o: { maxChunks?: number } = {}): Promise<'done' | 'more' | 'skipped'> {
  const actor = systemActor(tenantId, 'import');
  const size = Math.max(1, Math.min(deps.commitChunkSize ?? 1000, 1000));
  const maxChunks = o.maxChunks ?? CHUNKS_PER_RUN;
  for (let chunkNo = 1; chunkNo <= maxChunks; chunkNo++) {
    const r = await withTenantTx(
      actor,
      async (tx, now): Promise<'done' | 'more' | 'skipped'> => {
        const stage = await brepo.getStageById(tx, stageId, { forUpdate: true });
        if (!stage || stage.status !== 'committing') return 'skipped';
        const batch = (await brepo.getBatch(tx, stage.batch_id)) as brepo.BatchRow;
        const recs = await rrepo.nextCommitChunk(tx, stage.id, size);
        // B6 review R2: once the plan's own records are applied, the skipped duplicates' opt-outs, a chunk at a time
        const skips = recs.length === 0 && stage.category === 'contacts' ? await rrepo.nextSkippedOptOutChunk(tx, stage.id, size) : [];
        if (skips.length > 0) {
          const ctx = await commitCtx(deps, tx, actor, stage, batch, now, skips);
          for (const rec of skips) {
            try {
              await rrepo.markOptOutsCarried(tx, rec.id, await inSavepoint(tx, () => applySkippedOptOuts(ctx, rec)));
            } catch (e) {
              // never dropped silently: the record fails like any other (COMMIT_FAILED), so the recount refuses to verify
              await rrepo.markCommitFailed(tx, rec.id, pgCode(e));
            }
          }
          return 'more';
        }
        if (recs.length === 0) {
          await rrepo.settleUnapplied(tx, stage.id);
          const counts = await rrepo.recount(tx, stage.id);
          await brepo.finishCommit(tx, stage.id, counts);
          const stages = await brepo.getStages(tx, batch.id);
          const done = stages.every((s) => ['committed', 'verified', 'skipped'].includes(s.id === stage.id ? 'committed' : s.status));
          const busy = stages.some((s) => s.id !== stage.id && s.status === 'committing');
          if (!busy) await brepo.setBatchStatus(tx, batch.id, done ? 'committed' : 'partially_committed');
          return 'done';
        }
        const ctx = await commitCtx(deps, tx, actor, stage, batch, now, recs);
        const parityTotals: { tagIds: string[]; fieldIds: string[]; counts: Record<string, number> } = { tagIds: [], fieldIds: [], counts: {} };
        if (stage.category === 'contacts') {
          const r = await resolveFields(tx, batch, ctx.parity.options, deps.ids);
          ctx.parity.fields = r.fields;
          parityTotals.fieldIds.push(...r.createdIds);
        }
        const assignedTo = new Set<string>();
        for (const rec of recs) {
          try {
            const a = await inSavepoint(tx, () => applyRecord(ctx, rec));
            if (a.unassigned) {
              await rrepo.markUnassigned(tx, rec.id, a.unassigned.contactId, { code: OWNER_UNAVAILABLE, severity: 'info', reason: a.unassigned.reason, userId: a.unassigned.userId });
            } else {
              await rrepo.markImported(tx, rec.id, a.target, a.created, a.duplicate ? 'duplicate' : 'imported');
              await addIssues(tx, rec.id, a.extraIssues ?? []);
            }
            if (a.assignedTo) assignedTo.add(a.assignedTo);
            if (a.parity) {
              parityTotals.tagIds.push(...a.parity.tagIds);
              for (const [k, v] of Object.entries(a.parity.counts)) parityTotals.counts[k] = (parityTotals.counts[k] ?? 0) + v;
            }
          } catch (e) {
            await rrepo.markCommitFailed(tx, rec.id, pgCode(e));
          }
        }
        if (stage.category === 'contacts') await prepo.recordParity(tx, batch.id, parityTotals);
        await deps.inCommitChunk?.({ category: stage.category, phase: 'applied', assignedTo: [...assignedTo] });
        await fenceAssignedMembers(tx, assignedTo);
        await deps.inCommitChunk?.({ category: stage.category, phase: 'fenced', assignedTo: [...assignedTo] });
        return 'more';
      },
      { db: deps.db, retries: 2 },
    );
    if (r !== 'more') return r;
    await deps.afterCommitChunk?.(chunkNo);
  }
  return 'more';
}
