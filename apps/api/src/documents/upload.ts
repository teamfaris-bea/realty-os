// Upload and versions (PHASE2_3_PLAN §5.4 #42 deliverable 3; R-DOC-3, R-DOC-5, R-DOC-6, E400, E401, E406-E409).
//
//   1. the per-user limit is counted on every attempt, before any work (60 an hour);
//   2. the form holds exactly one File named `file`, plus `kind` (not on versions) and an optional `displayName`;
//   3. the type is judged by the bytes (%PDF-, FF D8 FF, the PNG signature) and must equal the declared one;
//   4. the bytes are stored unmodified (sha256 recorded), encrypted under a fresh DEK, purpose 'document';
//   5. the display name defaults to the file name, cleaned (no path, CR/LF, control or bidi characters; 200 max);
//   6. one transaction as the person: refuse a merged-away contact, the object row, the document row (the DB forces
//      pending and unshared, binds the object and the version; 0018 documents_guard, 0069 integrity guard), the
//      scan job when a scanner is configured, and the audit row with kind, version, size and type only.
// No file or display name reaches a log, a job payload or an audit row.
import type { Clock, TenantId, UserActor } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { enforceLimits } from '../auth/rateLimit.js';
import { refuseMergedAway } from '../comms/merged.js';
import { putObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import * as R from './repos.js';
import { DISPLAY_NAME_FIELD_MAX_BYTES, DISPLAY_NAME_MAX, DOCUMENT_JOBS, DOCUMENT_KINDS, DOCUMENT_MAX_BYTES, type DocumentDeps, type DocumentKind, type DocumentScope, type DocumentType, UPLOADS_PER_HOUR } from './types.js';

// ---- the multipart form -----------------------------------------------------------------------------------

export type FormEntry = { name: string; text: string } | { name: string; file: { bytes: Uint8Array; type: string; filename: string } };

/** At most this many entries are read from a form; anything beyond fails validation anyway. */
export const MAX_FORM_ENTRIES = 8;

/** Parses a buffered multipart body with the platform's Response.formData() (comms/webhooks.ts precedent). */
export async function parseMultipart(body: Uint8Array, contentType: string): Promise<FormEntry[]> {
  const fd = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  const out: FormEntry[] = [];
  for (const [name, v] of fd) {
    if (out.length >= MAX_FORM_ENTRIES) throw new AppError('VALIDATION_FAILED', { reason: 'TOO_MANY_FIELDS' });
    if (typeof v === 'string') out.push({ name, text: v });
    else out.push({ name, file: { bytes: new Uint8Array(await v.arrayBuffer()), type: v.type, filename: v.name } });
  }
  return out;
}

export interface UploadForm {
  bytes: Uint8Array;
  declaredType: string;
  filename: string;
  kind: DocumentKind | null;
  displayName: string | null;
}

/** Exactly one file named `file`; `kind` when `needsKind`, never otherwise; an optional `displayName`; nothing else. */
export function readForm(entries: readonly FormEntry[], needsKind: boolean): UploadForm {
  const allowed = new Set(['file', 'displayName', ...(needsKind ? ['kind'] : [])]);
  const seen = new Map<string, number>();
  for (const e of entries) {
    if (!allowed.has(e.name)) throw new AppError('VALIDATION_FAILED', { reason: 'UNKNOWN_FIELD' });
    seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  }
  if ([...seen.values()].some((n) => n > 1)) throw new AppError('VALIDATION_FAILED', { reason: 'DUPLICATE_FIELD' });
  const file = entries.find((e) => e.name === 'file');
  if (!file || !('file' in file)) throw new AppError('VALIDATION_FAILED', { reason: 'FILE_REQUIRED' });
  let kind: DocumentKind | null = null;
  if (needsKind) {
    const k = entries.find((e) => e.name === 'kind');
    if (!k || !('text' in k) || !(DOCUMENT_KINDS as readonly string[]).includes(k.text)) throw new AppError('VALIDATION_FAILED', { reason: 'KIND_INVALID' });
    kind = k.text as DocumentKind;
  }
  const dn = entries.find((e) => e.name === 'displayName');
  if (dn && !('text' in dn)) throw new AppError('VALIDATION_FAILED', { reason: 'DISPLAY_NAME_INVALID' });
  if (dn && 'text' in dn && Buffer.byteLength(dn.text, 'utf8') > DISPLAY_NAME_FIELD_MAX_BYTES) throw new AppError('VALIDATION_FAILED', { reason: 'DISPLAY_NAME_TOO_LONG' });
  return { bytes: file.file.bytes, declaredType: file.file.type.split(';')[0]!.trim().toLowerCase(), filename: file.file.filename, kind, displayName: dn && 'text' in dn ? dn.text : null };
}

// ---- bytes and names --------------------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (b: Uint8Array, sig: readonly number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** The type the bytes are (never the name or the declared type), or null for anything else (E400). */
export function sniffDocumentType(b: Uint8Array): DocumentType | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, PNG_SIG)) return 'image/png';
  return null;
}

// C0 and C1 controls (CR/LF included) and DEL become spaces; the invisible bidi formatting characters are removed
// (a name can never reorder its text)
// eslint-disable-next-line no-control-regex -- control characters are the point of this pattern
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A display name from a file name or a typed name: no path, no control or bidi characters, at most 200 characters. */
export function cleanDisplayName(raw: string, o: { stripPath: boolean }): string {
  let s = raw;
  if (o.stripPath) s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  s = s.replace(BIDI_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...s].slice(0, DISPLAY_NAME_MAX).join('').trim();
  return cut === '' ? 'Document' : cut;
}

/** Validates the bytes: size first (413), then the sniffed type against the declared one (422). */
export function checkBytes(f: UploadForm): DocumentType {
  if (f.bytes.byteLength > DOCUMENT_MAX_BYTES) throw new AppError('DOCUMENT_TOO_LARGE', { limitBytes: DOCUMENT_MAX_BYTES });
  const sniffed = f.bytes.byteLength === 0 ? null : sniffDocumentType(f.bytes);
  if (sniffed === null || sniffed !== f.declaredType) throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED');
  return sniffed;
}

// ---- the upload -------------------------------------------------------------------------------------------

/** Test seam, never set in production: the limiter's fixed windows read this clock instead of the DB clock. */
let limitClock: Clock | undefined;
export function setUploadLimitClockForTests(c: Clock | undefined): void {
  limitClock = c;
}

export async function countUploadAttempt(deps: Pick<DocumentDeps, 'db' | 'linkSecret'>, actor: UserActor): Promise<void> {
  await enforceLimits(deps.db, deps.linkSecret, [{ kind: 'document_upload_user', parts: [actor.tenantId, actor.userId], max: UPLOADS_PER_HOUR, windowSeconds: 3600 }], limitClock);
}

export type UploadTarget = { scope: DocumentScope } | { supersedesId: string };

export interface UploadResult {
  documentId: string;
  versionNo: number;
  /** E409: the version this one replaces is still shared to the portal */
  previousVersionShared: boolean;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

/** The document row and its object, as the person; returns the new id. Caller has authorized the scope. */
export async function uploadDocument(deps: DocumentDeps, actor: UserActor, target: UploadTarget, form: UploadForm, type: DocumentType): Promise<UploadResult> {
  const displayName = form.displayName !== null ? cleanDisplayName(form.displayName, { stripPath: false }) : cleanDisplayName(form.filename, { stripPath: true });
  try {
    return await withTenantTx(actor, (tx) => insertInTx(tx, deps, actor, target, form, type, displayName), { db: deps.db });
  } catch (e) {
    const pe = (e ?? {}) as PgErrorLike;
    if (pe.code === '23505' && pe.constraint === 'documents_supersedes_uq') throw new AppError('DOCUMENT_VERSION_CONFLICT');
    throw e;
  }
}

async function insertInTx(tx: Tx, deps: DocumentDeps, actor: UserActor, target: UploadTarget, form: UploadForm, type: DocumentType, displayName: string): Promise<UploadResult> {
  let scope: DocumentScope;
  let kind: DocumentKind;
  let prev: R.DocRow | null = null;
  if ('supersedesId' in target) {
    prev = await R.docById(tx, target.supersedesId);
    if (!prev) throw new AppError('NOT_FOUND');
    scope = R.scopeOf(prev);
    kind = prev.kind;
  } else {
    scope = target.scope;
    if (form.kind === null) throw new AppError('VALIDATION_FAILED', { reason: 'KIND_INVALID' });
    kind = form.kind;
  }
  if (scope.kind === 'contact') {
    const c = await R.visibleContact(tx, scope.id);
    if (!c) throw new AppError('NOT_FOUND');
    await refuseMergedAway(tx, c);
  } else if (!(await R.scopeVisible(tx, scope))) throw new AppError('NOT_FOUND');
  const tenantId = actor.tenantId as TenantId;
  const objectId = deps.ids.next<'StoredObjectId'>();
  const documentId = deps.ids.next<'DocumentId'>();
  // the bytes are stored exactly as received (no rewrite): the sha256 is the evidence of what was uploaded
  const sealed = await putObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, objectId, 'document', form.bytes, type);
  await sql`
    INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
    VALUES (app.tenant_id(), ${objectId}, 'document', ${sealed.storageKey}, ${type}, ${sealed.byteSize}, ${Buffer.from(sealed.sha256)},
            ${Buffer.from(sealed.dekWrapped)}, ${sealed.keyVersion}, ${actor.userId})`.execute(tx);
  const row = await sql<{ version_no: number }>`
    INSERT INTO documents (tenant_id, id, deal_id, listing_id, contact_id, object_id, kind, display_name, supersedes_id, uploaded_by_user_id)
    VALUES (app.tenant_id(), ${documentId}, ${scope.kind === 'deal' ? scope.id : null}, ${scope.kind === 'listing' ? scope.id : null},
            ${scope.kind === 'contact' ? scope.id : null}, ${objectId}, ${kind}, ${displayName}, ${prev?.id ?? null}, ${actor.userId})
    RETURNING version_no`.execute(tx);
  const versionNo = row.rows[0]!.version_no;
  if (deps.providers.scanner.configured) await enqueueScan(tx, documentId);
  await audit(tx, actor, {
    action: 'document.uploaded',
    entity: { type: 'document', id: documentId },
    changes: redactDiff(null, { document_kind: kind, document_version_no: versionNo, byte_count: sealed.byteSize, content_type: type }),
  });
  return { documentId, versionNo, previousVersionShared: prev?.shared_to_portal === true };
}

export async function enqueueScan(tx: Tx, documentId: string): Promise<void> {
  await enqueueJob(tx, { queue: 'default', kind: DOCUMENT_JOBS.scan, payload: { documentId }, dedupeKey: `${DOCUMENT_JOBS.scan}:${documentId}` });
}
