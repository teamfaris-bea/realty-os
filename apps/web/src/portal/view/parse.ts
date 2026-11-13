// module 46 (R-PORTALWEB-5, E688): strict allowlist parsers for every portal answer the web reads. Only the contract's
// keys survive (an injected note, score, value, AI draft or id never reaches a component); every kept field is checked
// (UUIDs, YYYY-MM-DD dates, ISO instants, the item kinds, lengths, an E.164 number, a single email address). A missing
// or malformed required field throws ParseError, which the client API turns into BAD_RESPONSE. Pure: no I/O, no DOM.
// The staff preview (surfaces/client-portal) parses GET /portal-grants/:id/preview with parsePreview, so it renders
// exactly what the client's parsers keep (R-PORTAL-16).

export class ParseError extends Error {
  constructor(readonly path: string) {
    super(`BAD_RESPONSE at ${path}`);
    this.name = 'ParseError';
  }
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** 45's E.164 check (shared/view.ts displayOf): a plus, a non-zero digit, 6 to 14 more digits. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;
/** One address: no whitespace, control, separator or header-injection character. */
const ADDR_PART = String.raw`[^\s@?&,;:/%<>"()[\]\\\p{Cc}\p{Cf}]+`;
export const SINGLE_EMAIL = new RegExp(`^${ADDR_PART}@${ADDR_PART}\\.${ADDR_PART}$`, 'u');
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const NAME_MAX = 120;

/** The client item kinds (45: shared/schemas.ts Item; documents come apart). */
export const ITEM_KINDS = ['milestone', 'showing', 'feedback', 'seller_update', 'next_step'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type Scope = 'purchase' | 'sale' | 'listing';

export interface ContactView {
  agentName: string | null;
  textTo: string | null;
  emailTo: string | null;
}
export interface GrantView {
  id: string;
  scope: Scope | null;
  title: string;
  contact: ContactView | null;
  expiresOn: string | null;
}
export interface MeView {
  grants: GrantView[];
  csrfToken: string;
}
export interface ItemView {
  itemId: string;
  kind: ItemKind;
  title: string;
  body: string | null;
  occursOn: string | null;
  publishedAt: string;
}
export interface TimelineView {
  grantId: string;
  items: ItemView[];
  nextSteps: ItemView[];
}
export interface DocumentView {
  itemId: string;
  title: string;
  body: string | null;
  publishedAt: string;
}
export interface DocumentsView {
  grantId: string;
  documents: DocumentView[];
}
export interface StreamTokenView {
  url: string;
  expiresAt: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}
export interface SessionView {
  csrfToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}
export interface PreviewView {
  visibleNow: boolean;
  why: string[];
  grant: GrantView;
  timeline: { items: ItemView[]; nextSteps: ItemView[] };
  documents: DocumentView[];
}

type Obj = Record<string, unknown>;
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function obj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ParseError(path);
  return v as Obj;
}
function arr(v: unknown, path: string, max = 1000): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new ParseError(path);
  return v;
}
function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new ParseError(path);
  return v;
}
function nonEmpty(v: unknown, path: string, max: number): string {
  const s = str(v, path, max);
  if (s.trim() === '') throw new ParseError(path);
  return s;
}
function nullable<T>(v: unknown, path: string, f: (v: unknown, path: string) => T): T | null {
  return v === null ? null : f(v, path);
}
function uuid(v: unknown, path: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ParseError(path);
  return v.toLowerCase();
}
/** A real calendar date, YYYY-MM-DD (2026-02-30 is refused). */
export function isLocalDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
function date(v: unknown, path: string): string {
  if (!isLocalDate(v)) throw new ParseError(path);
  return v;
}
function instant(v: unknown, path: string): string {
  if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) throw new ParseError(path);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ParseError(path);
  return v;
}

/** A contact value the web may turn into a link only through view/contact.ts; anything malformed is dropped (null). */
function textTo(v: unknown): string | null {
  return typeof v === 'string' && E164.test(v) ? v : null;
}
function emailTo(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 320 && SINGLE_EMAIL.test(v) ? v : null;
}
function agentName(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= NAME_MAX && !/\p{Cc}/u.test(v) ? v : null;
}

function contact(v: unknown, path: string): ContactView | null {
  if (v === null) return null;
  const o = obj(v, path);
  const c = { agentName: agentName(own(o, 'agentName')), textTo: textTo(own(o, 'textTo')), emailTo: emailTo(own(o, 'emailTo')) };
  return c.agentName || c.textTo || c.emailTo ? c : null;
}

function scope(v: unknown, path: string): Scope | null {
  if (v === null) return null;
  if (v === 'purchase' || v === 'sale' || v === 'listing') return v;
  throw new ParseError(path);
}

export function parseGrant(v: unknown, path = 'grant'): GrantView {
  const o = obj(v, path);
  return {
    id: uuid(own(o, 'id'), `${path}.id`),
    scope: scope(own(o, 'scope'), `${path}.scope`),
    title: nonEmpty(own(o, 'title'), `${path}.title`, TITLE_MAX),
    contact: contact(own(o, 'contact'), `${path}.contact`),
    expiresOn: nullable(own(o, 'expiresOn'), `${path}.expiresOn`, date),
  };
}

function kind(v: unknown, path: string): ItemKind {
  if (typeof v !== 'string' || !(ITEM_KINDS as readonly string[]).includes(v)) throw new ParseError(path);
  return v as ItemKind;
}

export function parseItem(v: unknown, path = 'item'): ItemView {
  const o = obj(v, path);
  return {
    itemId: uuid(own(o, 'itemId'), `${path}.itemId`),
    kind: kind(own(o, 'kind'), `${path}.kind`),
    title: nonEmpty(own(o, 'title'), `${path}.title`, TITLE_MAX),
    body: nullable(own(o, 'body'), `${path}.body`, (b, p) => str(b, p, BODY_MAX)),
    occursOn: nullable(own(o, 'occursOn'), `${path}.occursOn`, date),
    publishedAt: instant(own(o, 'publishedAt'), `${path}.publishedAt`),
  };
}

export function parseDocument(v: unknown, path = 'document'): DocumentView {
  const o = obj(v, path);
  return {
    itemId: uuid(own(o, 'itemId'), `${path}.itemId`),
    title: nonEmpty(own(o, 'title'), `${path}.title`, TITLE_MAX),
    body: nullable(own(o, 'body'), `${path}.body`, (b, p) => str(b, p, BODY_MAX)),
    publishedAt: instant(own(o, 'publishedAt'), `${path}.publishedAt`),
  };
}

const items = (v: unknown, path: string) => arr(v, path).map((x, i) => parseItem(x, `${path}[${i}]`));
const documents = (v: unknown, path: string) => arr(v, path).map((x, i) => parseDocument(x, `${path}[${i}]`));

/** GET /api/portal/me */
export function parseMe(v: unknown): MeView {
  const o = obj(v, 'me');
  const account = obj(own(o, 'account'), 'me.account');
  if (own(account, 'status') !== 'active') throw new ParseError('me.account.status');
  return {
    csrfToken: nonEmpty(own(o, 'csrfToken'), 'me.csrfToken', 256),
    grants: arr(own(o, 'grants'), 'me.grants', 200).map((g, i) => parseGrant(g, `me.grants[${i}]`)),
  };
}

/** GET /api/portal/timeline */
export function parseTimeline(v: unknown): TimelineView {
  const o = obj(v, 'timeline');
  return { grantId: uuid(own(o, 'grantId'), 'timeline.grantId'), items: items(own(o, 'items'), 'timeline.items'), nextSteps: items(own(o, 'nextSteps'), 'timeline.nextSteps') };
}

/** GET /api/portal/documents */
export function parseDocuments(v: unknown): DocumentsView {
  const o = obj(v, 'documents');
  return { grantId: uuid(own(o, 'grantId'), 'documents.grantId'), documents: documents(own(o, 'documents'), 'documents.documents') };
}

/** POST /api/portal/documents/:itemId/stream-token (the URL is guarded again in download.ts) */
export function parseStreamToken(v: unknown): StreamTokenView {
  const o = obj(v, 'stream');
  const byteSize = own(o, 'byteSize');
  if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > 10_000_000) throw new ParseError('stream.byteSize');
  return {
    url: str(own(o, 'url'), 'stream.url', 200),
    expiresAt: instant(own(o, 'expiresAt'), 'stream.expiresAt'),
    fileName: nonEmpty(own(o, 'fileName'), 'stream.fileName', 255),
    contentType: nonEmpty(own(o, 'contentType'), 'stream.contentType', 127),
    byteSize,
  };
}

/** POST /api/portal/session */
export function parseSession(v: unknown): SessionView {
  const o = obj(v, 'session');
  return {
    csrfToken: nonEmpty(own(o, 'csrfToken'), 'session.csrfToken', 256),
    idleExpiresAt: instant(own(o, 'idleExpiresAt'), 'session.idleExpiresAt'),
    absoluteExpiresAt: instant(own(o, 'absoluteExpiresAt'), 'session.absoluteExpiresAt'),
  };
}

/** POST /api/portal/login: 202 {status: 'sent_if_matched', message} (the web shows its own copy of 45's sentence). */
export function parseLoginAccepted(v: unknown): { status: 'sent_if_matched' } {
  const o = obj(v, 'login');
  if (own(o, 'status') !== 'sent_if_matched') throw new ParseError('login.status');
  str(own(o, 'message'), 'login.message', 1000);
  return { status: 'sent_if_matched' };
}

/** GET /api/portal-grants/:id/preview (staff): the client's view of the grant, and why the client cannot see it now. */
export function parsePreview(v: unknown): PreviewView {
  const o = obj(v, 'preview');
  const t = obj(own(o, 'timeline'), 'preview.timeline');
  return {
    visibleNow: bool(own(o, 'visibleNow'), 'preview.visibleNow'),
    why: arr(own(o, 'why'), 'preview.why', 20).map((w, i) => nonEmpty(w, `preview.why[${i}]`, 400)),
    grant: parseGrant(own(o, 'grant'), 'preview.grant'),
    timeline: { items: items(own(t, 'items'), 'preview.timeline.items'), nextSteps: items(own(t, 'nextSteps'), 'preview.timeline.nextSteps') },
    documents: documents(own(o, 'documents'), 'preview.documents'),
  };
}
