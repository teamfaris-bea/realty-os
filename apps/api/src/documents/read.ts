// Reads and the download of api/documents (deliverable 3; R-DOC-1, R-DOC-3, R-DOC-7, R-DOC-9, E402, E409).
//
// Everything a caller sees is what RLS shows them: a pending document only to its uploader and tenant-wide roles,
// a listing document only to the listing's writers and listing-side deal members. The download streams a document
// only when the SQL that fetches its key joins scan_status = 'clean' (repos.cleanObjectOf): the uploader and the
// Owner read the object row of a quarantined upload (objects_select), so the API, not RLS, refuses those bytes.
import type { Action, ResourceFacts, TenantId, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { getObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import { dealFacts } from '../workspace/deals.js';
import { listingFacts } from '../workspace/listings.js';
import { COPY } from './copy.js';
import { type DocumentTextExtractor, EXTRACTOR_NOT_SET_UP, type MalwareScanner } from './provider.js';
import * as R from './repos.js';
import { type DocumentDeps, type DocumentScope, EXTRACTABLE_KINDS } from './types.js';

export type ScanState = 'checking' | 'waiting_for_scanner' | 'clean' | 'blocked';
export type CanFn = (action: Action, facts: ResourceFacts) => boolean;

export interface PlatformState {
  scanner: { configured: boolean; test: boolean; statusText: string };
  extractor: { configured: boolean; test: boolean; statusText: string };
  portalCleared: boolean;
}

export interface ReadCtx {
  actor: UserActor | { kind: 'support' };
  can: CanFn;
  scanner: Pick<MalwareScanner, 'configured' | 'test' | 'statusText'>;
  extractor: Pick<DocumentTextExtractor, 'configured' | 'test' | 'statusText'>;
}

export async function platformState(tx: Tx, ctx: Pick<ReadCtx, 'scanner' | 'extractor'>): Promise<PlatformState> {
  return {
    scanner: { configured: ctx.scanner.configured, test: ctx.scanner.test, statusText: ctx.scanner.statusText },
    extractor: { configured: ctx.extractor.configured, test: ctx.extractor.test, statusText: ctx.extractor.statusText },
    portalCleared: await R.portalCleared(tx),
  };
}

/** The facts document.share is decided on: the scope's deal or listing facts (any Team Lead writes listings). */
export async function shareFacts(tx: Tx, d: Pick<R.DocRow, 'deal_id' | 'listing_id'>, role: string | null): Promise<ResourceFacts | null> {
  if (d.deal_id) return dealFacts(tx, d.deal_id);
  if (d.listing_id) {
    const f = await listingFacts(tx, d.listing_id);
    return f ? { ...f, team: role === 'team_lead' } : null;
  }
  return null;
}

function scanState(d: R.DocRow, scannerConfigured: boolean): ScanState {
  if (d.scan_status === 'clean') return 'clean';
  if (d.scan_status === 'infected') return 'blocked';
  return scannerConfigured ? 'checking' : 'waiting_for_scanner';
}

function scanText(state: ScanState, d: R.DocRow, reason: 'malware' | 'unscannable' | null): string | null {
  if (state === 'checking') return COPY.checking;
  if (state === 'waiting_for_scanner') return COPY.noScanner;
  // the reason is read from the document.scanned audit row (Owner/Admin only): anyone else gets the sentence that is
  // true for both reasons and still asks for a copy without a password (Q5; b11 reconciliation documents-6)
  if (state === 'blocked') return d.legal_hold ? COPY.blockedHeld : reason === 'unscannable' ? COPY.blockedUnscannable : reason === 'malware' ? COPY.blockedMalware : COPY.blockedReasonUnknown;
  return null;
}

export type ExtractionStatus = 'not_applicable' | 'photo' | 'not_set_up' | 'waiting_for_scan' | 'not_started' | 'not_visible' | 'proposed' | 'approved' | 'executed' | 'rejected' | 'superseded' | 'invalidated' | 'expired' | 'blocked';
export interface ExtractionSummary {
  status: ExtractionStatus;
  outcome: 'dates' | 'no_text' | 'no_dates' | 'unreadable' | null;
  claimCount: number;
  text: string | null;
}

export const extractionDedupeKey = (documentId: string) => `contract_extraction:${documentId}`;

export async function extractionAction(tx: Tx, documentId: string): Promise<{ id: string; status: string; payload: Record<string, unknown>; created_at: Date; decided_at: Date | null } | null> {
  const r = await sql<{ id: string; status: string; payload: Record<string, unknown>; created_at: Date; decided_at: Date | null }>`
    SELECT id, status, payload, created_at, decided_at FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND dedupe_key = ${extractionDedupeKey(documentId)} AND kind = 'contract_extraction'`.execute(tx);
  return r.rows[0] ?? null;
}

/** Whether the document is ever read for dates: a clean-able PDF deal document of a contract kind (E418). */
export function extractable(d: Pick<R.DocRow, 'deal_id' | 'kind' | 'content_type'>): boolean {
  return d.deal_id !== null && EXTRACTABLE_KINDS.includes(d.kind) && d.content_type === 'application/pdf';
}

async function extractionSummary(tx: Tx, d: R.DocRow, extractorConfigured: boolean): Promise<ExtractionSummary> {
  const none = (status: ExtractionStatus, text: string | null = null): ExtractionSummary => ({ status, outcome: null, claimCount: 0, text });
  if (d.deal_id === null || !EXTRACTABLE_KINDS.includes(d.kind)) return none('not_applicable');
  if (d.content_type === 'image/jpeg' || d.content_type === 'image/png') return none('photo', COPY.photo);
  if (d.content_type !== 'application/pdf') return none('not_applicable');
  const a = await extractionAction(tx, d.id);
  if (a) {
    const outcome = (a.payload['outcome'] as ExtractionSummary['outcome']) ?? null;
    const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM assistant_claims WHERE tenant_id = app.tenant_id() AND action_id = ${a.id}`.execute(tx);
    const text = outcome === 'no_text' ? COPY.noText : outcome === 'no_dates' ? COPY.noDates : outcome === 'unreadable' ? COPY.unreadable : COPY.extractionExplanation;
    return { status: a.status as ExtractionStatus, outcome, claimCount: n.rows[0]?.n ?? 0, text };
  }
  if (!extractorConfigured) return none('not_set_up', EXTRACTOR_NOT_SET_UP);
  if (d.scan_status !== 'clean') return none('waiting_for_scan');
  // the extraction is the uploader's own action: another member sees the dates once someone confirms them
  if (!(await extractionVisibleTo(tx, d))) return none('not_visible');
  return none('not_started');
}

async function extractionVisibleTo(tx: Tx, d: R.DocRow): Promise<boolean> {
  const r = await sql<{ x: boolean }>`SELECT (app.is_tenant_wide() OR app.user_id() = ${d.uploaded_by_user_id}::uuid) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

export interface DocumentView {
  id: string;
  scope: DocumentScope;
  kind: R.DocRow['kind'];
  displayName: string;
  versionNo: number;
  supersedesId: string | null;
  contentType: string | null;
  byteSize: number | null;
  uploadedByUserId: string;
  uploadedAt: string;
  scan: ScanState;
  scanText: string | null;
  blockedReason: 'malware' | 'unscannable' | null;
  legalHold: boolean;
  retentionUntil: string | null;
  portal: { shared: boolean; portalCleared: boolean; text: string | null };
  extraction: ExtractionSummary;
  canShare: boolean;
  canHold: boolean;
}

export async function documentView(tx: Tx, d: R.DocRow, ctx: ReadCtx, portal: boolean): Promise<DocumentView> {
  const state = scanState(d, ctx.scanner.configured);
  const reason = state === 'blocked' ? await R.blockedReasonOf(tx, d.id) : null;
  const role = ctx.actor.kind === 'user' ? ctx.actor.role : null;
  const sf = d.contact_id === null && d.scan_status === 'clean' ? await shareFacts(tx, d, role) : null;
  return {
    id: d.id,
    scope: R.scopeOf(d),
    kind: d.kind,
    displayName: d.display_name,
    versionNo: d.version_no,
    supersedesId: d.supersedes_id,
    contentType: d.content_type,
    byteSize: d.byte_size === null ? null : Number(d.byte_size),
    uploadedByUserId: d.uploaded_by_user_id,
    uploadedAt: d.created_at.toISOString(),
    scan: state,
    scanText: scanText(state, d, reason),
    blockedReason: reason,
    legalHold: d.legal_hold,
    retentionUntil: d.retention_until === null ? null : d.retention_until.toISOString(),
    portal: { shared: d.shared_to_portal, portalCleared: portal, text: d.shared_to_portal && !portal ? COPY.sharedNotCleared : null },
    extraction: await extractionSummary(tx, d, ctx.extractor.configured),
    canShare: sf !== null && ctx.can('document.share', sf),
    canHold: ctx.can('document.hold', {}),
  };
}

export interface ListEntry extends DocumentView {
  newerVersion: { id: string; versionNo: number; scan: ScanState } | null;
}

/**
 * One entry per visible chain, at its newest CLEAN version (or its newest visible one when none is clean yet), with
 * the newest pending or blocked version above it as `newerVersion` (a peer sees v1 while v2 is checked).
 */
export async function listScope(tx: Tx, scope: DocumentScope, ctx: ReadCtx): Promise<{ documents: ListEntry[]; platform: PlatformState }> {
  const rows = await R.docsOfScope(tx, scope);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childOf = new Map<string, R.DocRow>();
  for (const r of rows) if (r.supersedes_id && byId.has(r.supersedes_id)) childOf.set(r.supersedes_id, r);
  const roots = rows.filter((r) => !r.supersedes_id || !byId.has(r.supersedes_id));
  const platform = await platformState(tx, ctx);
  const out: ListEntry[] = [];
  for (const root of roots) {
    const chain: R.DocRow[] = [root];
    for (let c = childOf.get(root.id); c; c = childOf.get(c.id)) chain.push(c);
    const clean = [...chain].reverse().find((r) => r.scan_status === 'clean');
    const entry = clean ?? chain[chain.length - 1]!;
    const above = chain.filter((r) => r.version_no > entry.version_no && r.scan_status !== 'clean');
    const newer = above[above.length - 1];
    out.push({
      ...(await documentView(tx, entry, ctx, platform.portalCleared)),
      newerVersion: newer ? { id: newer.id, versionNo: newer.version_no, scan: scanState(newer, ctx.scanner.configured) } : null,
    });
  }
  out.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  return { documents: out, platform };
}

export async function documentDetail(tx: Tx, id: string, ctx: ReadCtx): Promise<{ document: DocumentView; versions: DocumentView[]; platform: PlatformState }> {
  const d = await R.docById(tx, id);
  if (!d) throw new AppError('NOT_FOUND');
  const platform = await platformState(tx, ctx);
  const chain = await R.chainOf(tx, id);
  const versions: DocumentView[] = [];
  for (const v of chain) versions.push(await documentView(tx, v, ctx, platform.portalCleared));
  return { document: await documentView(tx, d, ctx, platform.portalCleared), versions, platform };
}

// ---- download ---------------------------------------------------------------------------------------------

export interface Download {
  bytes: Uint8Array;
  contentType: string;
  /** ASCII fallback and the RFC 5987 UTF-8 form of the display name */
  asciiName: string;
  utf8Name: string;
}

const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function downloadNames(displayName: string, contentType: string): { asciiName: string; utf8Name: string } {
  const ext = EXT[contentType] ?? 'bin';
  const hasExt = new RegExp(`\\.${ext}$`, 'i').test(displayName) || (ext === 'jpg' && /\.jpeg$/i.test(displayName));
  const full = hasExt ? displayName : `${displayName}.${ext}`;
  const ascii = full.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%;]/g, '_').trim();
  return { asciiName: ascii === '' || ascii === `.${ext}` ? `document.${ext}` : ascii, utf8Name: encodeURIComponent(full) };
}

/** Streams a clean document the caller can read, as the person, audited by ids only (R-DOC-7, R-AUDIT-5). */
export async function downloadDocument(tx: Tx, deps: Pick<DocumentDeps, 'envelope' | 'providers'>, actor: UserActor, id: string): Promise<Download> {
  const d = await R.docById(tx, id);
  if (!d) throw new AppError('NOT_FOUND');
  const o = await R.cleanObjectOf(tx, id);
  if (!o) {
    if (d.scan_status === 'pending') throw new AppError('DOCUMENT_QUARANTINED');
    if (d.scan_status === 'infected') throw new AppError('DOCUMENT_BLOCKED');
    throw new AppError('NOT_FOUND'); // clean but the file is gone (erased): nothing to stream
  }
  const tenantId = actor.tenantId as TenantId;
  const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, o.object_id, o.storage_key, new Uint8Array(o.dek_wrapped));
  if (!bytes) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'document.downloaded', entity: { type: 'document', id } });
  return { bytes, contentType: o.content_type, ...downloadNames(o.display_name, o.content_type) };
}

