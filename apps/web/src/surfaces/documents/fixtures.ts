// Test fixtures of the documents surface (imported by *.test.tsx only). Shapes as the API sends them: every fixture
// passes the staff contract (StaffFake checks each answer against apps/api/src/staffWeb/contract.json). Synthetic
// names and reserved ids only.
import type { Role } from '@realty/core/foundation';
import type { FakeFetch } from '../../shell/testing/fakeApi.js';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import type { SurfaceModule } from '../../shell/index.js';
import type { ClaimView, DetailResponse, DocumentView, ExtractionResponse, ListEntry, ListResponse, PlatformView } from './types.js';

export const ME = '01900000-0000-7000-8000-0000000000aa';
export const OTHER = '01900000-0000-7000-8000-0000000000bb';
export const DEAL = '01900000-0000-7000-8000-00000000de01';
export const LISTING = '01900000-0000-7000-8000-00000000a501';
export const CONTACT = '01900000-0000-7000-8000-00000000c001';
export const DOC = '01900000-0000-7000-8000-000000000d01';
export const DOC2 = '01900000-0000-7000-8000-000000000d02';
export const ACTION = '01900000-0000-7000-8000-00000000ac01';
export const CLAIM1 = '01900000-0000-7000-8000-00000000c101';
export const CLAIM2 = '01900000-0000-7000-8000-00000000c102';
export const CLAIM3 = '01900000-0000-7000-8000-00000000c103';
export const DATE1 = '01900000-0000-7000-8000-00000000da01';

/** the API's sentences (documents/copy.ts, documents/provider.ts), verbatim */
export const COPY = {
  checking: 'Checking this file for viruses. Only you and the Owner or Admin can see it until the check passes.',
  noScanner: 'This platform has no virus scanner yet, so the file stays locked. Nobody can open it until a scanner checks it.',
  scannerNotSetUp: 'This platform has no virus scanner yet',
  scannerTest: 'This deployment uses a test virus scanner: files are not really checked.',
  extractorNotSetUp: 'Reading dates from PDFs is not set up on this platform',
  extractorTest: 'This deployment uses a test PDF reader: dates are read only from test files.',
  sharedNotCleared: 'Marked for the client portal. Clients see nothing until the portal is turned on.',
  unshared: "Downloads stop now. The client's portal still lists it until it is retracted there.",
  explanation: 'Dates found in this contract. Confirm each one; nothing is added to the timeline until you do.',
  photo: 'Photos and scans are not read. Enter the dates by hand.',
  noText: 'No text found in this PDF; enter the dates by hand',
  noDates: 'No dates found next to the labels we read. Enter the dates by hand.',
  unreadable: 'This PDF could not be read. Enter the dates by hand.',
  relative: 'Deadlines written as a number of days are not read here; plan them from the acceptance date.',
  needsReview: 'Not found in the document as quoted: enter this date by hand if it is right.',
  conflict: 'This contract states more than one date for this. Check which applies before you confirm one.',
  previousShared: 'Version 1 is still shared to the client portal. When this version passes the virus check, share it and stop sharing version 1.',
} as const;

export function platform(over: Partial<{ scanner: Partial<PlatformView['scanner']>; extractor: Partial<PlatformView['extractor']>; portalCleared: boolean }> = {}): PlatformView {
  return {
    scanner: { configured: true, test: false, statusText: 'Virus check on', ...over.scanner },
    extractor: { configured: true, test: false, statusText: 'PDF reader on', ...over.extractor },
    portalCleared: over.portalCleared ?? false,
  };
}

export function doc(over: Partial<DocumentView> = {}): DocumentView {
  return {
    id: DOC,
    scope: { kind: 'deal', id: DEAL },
    kind: 'purchase_contract',
    displayName: 'Purchase contract 12 Oak St.pdf',
    versionNo: 1,
    supersedesId: null,
    contentType: 'application/pdf',
    byteSize: 2048,
    uploadedByUserId: ME,
    uploadedAt: '2026-11-12T17:00:00.000Z',
    scan: 'clean',
    scanText: null,
    blockedReason: null,
    legalHold: false,
    retentionUntil: null,
    portal: { shared: false, portalCleared: false, text: null },
    extraction: { status: 'not_started', outcome: null, claimCount: 0, text: null },
    canShare: false,
    canHold: false,
    ...over,
  };
}

export const entry = (over: Partial<ListEntry> = {}): ListEntry => ({ ...doc(over), newerVersion: over.newerVersion ?? null });
export const list = (documents: ListEntry[], p: PlatformView = platform()): ListResponse => ({ documents, platform: p });
export const detail = (d: DocumentView = doc(), versions: DocumentView[] = [d], p: PlatformView = platform()): DetailResponse => ({ document: d, versions, platform: p });

export function claim(over: Partial<ClaimView> = {}): ClaimView {
  return {
    id: CLAIM1,
    ordinal: 1,
    text: 'Closing on Dec 18, 2026',
    milestone: { kind: 'closing', label: 'Closing', dueOn: '2026-12-18' },
    page: 3,
    needsReview: false,
    reviewNote: null,
    reviewStatus: 'unreviewed',
    evidence: [{ sourceType: 'document', locator: { kind: 'char_range', page: 3, start: 10, end: 40 }, snippet: 'Closing Date: December 18, 2026', verified: true, line: '“Closing Date: December 18, 2026” in the document' }],
    liveDates: [],
    appliedDateId: null,
    appliedNote: null,
    conflictsWith: [],
    conflictNote: null,
    ...over,
  };
}

export function extraction(over: Partial<ExtractionResponse> = {}, d: Partial<DocumentView> = {}): ExtractionResponse {
  const claims = over.claims ?? [claim()];
  return {
    document: doc({ extraction: { status: 'proposed', outcome: 'dates', claimCount: claims.length, text: COPY.explanation }, ...d }),
    action: { id: ACTION, status: 'proposed', outcome: 'dates', text: COPY.explanation },
    claims,
    relativeDeadlineText: null,
    platform: platform(),
    ...over,
  };
}

/** GET /deals/:id/milestones as the API sends it, with the server's canConfirm. */
export function milestones(canConfirm: boolean) {
  return {
    deal: { id: DEAL, name: '12 Oak St purchase', side: 'buy', stage: 'under_contract', ownerUserId: ME },
    acceptanceDate: '2026-11-10',
    templates: [],
    calendar: { note: 'The holiday calendar is not reviewed by counsel.', reviewed: false },
    updates: { approved: false, roles: [], teamRoles: [], side: 'buy' },
    dates: [],
    riskItems: [],
    canConfirm,
  };
}

export function signIn(fake: FakeFetch, role: Role): void {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant], reauthenticatedAt: new Date().toISOString() } });
}

export function app(fake: FakeFetch, path: string, role: Role = 'agent', ...extra: SurfaceModule[]) {
  signIn(fake, role);
  return renderApp({ fake, path, table: tableWith(...extra) });
}

/** CONVENTIONS §7 / brief: no raw code, platform key, notice id or ISO time in rendered text. */
export const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;
