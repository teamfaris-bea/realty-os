// module 46 (R-PORTALWEB-7; E649, E693, E694, E696): a document is saved only from the client's Download tap, and only
// through 45's re-checked stream: POST …/stream-token (CSRF), then the same-origin /api/portal/files/<43-character
// token> it names, and nothing else. Only a 200 whose Content-Type matches the announced type (MIME essence) and whose
// body is exactly the announced byte size becomes a Blob, saved through a temporary <a download> with the object URL
// revoked after. Anything else saves and opens nothing and never navigates; the caller shows the sentence and refetches.
// CSRF_INVALID (a sign-in in another tab): /me is refetched for a fresh token and the tap retried once.
import { type PortalApi, PortalError } from './api.js';
import { type StreamTokenView, parseStreamToken } from './view/index.js';

export const FILE_URL_RE = /^\/api\/portal\/files\/[A-Za-z0-9_-]{43}$/;
const MAX_BYTES = 10_000_000;

export type DownloadResult = { ok: true; fileName: string; bytes: number } | { ok: false; reason: 'csrf' | 'session' | 'unavailable' };

export interface SaveDeps {
  createObjectURL(b: Blob): string;
  revokeObjectURL(u: string): void;
  /** clicks a temporary <a download> (main.tsx gives the real one) */
  clickDownload(href: string, fileName: string): void;
  later(fn: () => void, ms: number): void;
}

export const browserSave = (): SaveDeps => ({
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
  clickDownload(href, fileName) {
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  later: (fn, ms) => void setTimeout(fn, ms),
});

/** A file name that is only a name: no path, control, separator or reserved character, no leading dot; ≤ 120. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned === '' ? 'document' : cleaned;
}

/** The MIME essence: "application/pdf; charset=x" → "application/pdf". */
export const essence = (t: string | null): string => (t ?? '').split(';')[0]!.trim().toLowerCase();

/** Reads at most `max` bytes; null when the body is longer (the read is cancelled). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    return b.length > max ? null : b;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function streamToken(api: PortalApi, itemId: string): Promise<StreamTokenView> {
  return api.request('POST', `/api/portal/documents/${encodeURIComponent(itemId)}/stream-token`, parseStreamToken);
}

async function fetchAndSave(api: PortalApi, t: StreamTokenView, save: SaveDeps): Promise<DownloadResult> {
  if (!FILE_URL_RE.test(t.url) || t.byteSize > MAX_BYTES) return { ok: false, reason: 'unavailable' };
  let res: Response;
  try {
    res = await api.fetchFile(t.url);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (res.status !== 200 || essence(res.headers.get('content-type')) !== essence(t.contentType) || essence(t.contentType) === '') {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'unavailable' };
  }
  const len = res.headers.get('content-length');
  if (len !== null && /^\d+$/.test(len) && Number(len) > t.byteSize) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'unavailable' };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, t.byteSize);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!bytes || bytes.length !== t.byteSize) return { ok: false, reason: 'unavailable' };
  const fileName = safeFileName(t.fileName);
  const url = save.createObjectURL(new Blob([bytes as BlobPart], { type: essence(t.contentType) }));
  try {
    save.clickDownload(url, fileName);
  } finally {
    save.later(() => save.revokeObjectURL(url), 1000);
  }
  return { ok: true, fileName, bytes: bytes.length };
}

/**
 * One Download tap. `refreshCsrf` refetches /me (a 401 there signs the client out, through api.ts); a CSRF_INVALID is
 * retried once after it, then reported.
 */
export async function downloadDocument(api: PortalApi, itemId: string, refreshCsrf: () => Promise<void>, save: SaveDeps = browserSave()): Promise<DownloadResult> {
  let t: StreamTokenView;
  try {
    t = await streamToken(api, itemId);
  } catch (e) {
    if (e instanceof PortalError && e.code === 'PORTAL_SESSION_REQUIRED') return { ok: false, reason: 'session' };
    if (!(e instanceof PortalError) || e.code !== 'CSRF_INVALID') return { ok: false, reason: 'unavailable' };
    try {
      await refreshCsrf();
      t = await streamToken(api, itemId);
    } catch (e2) {
      if (e2 instanceof PortalError && e2.code === 'PORTAL_SESSION_REQUIRED') return { ok: false, reason: 'session' };
      return { ok: false, reason: e2 instanceof PortalError && e2.code === 'CSRF_INVALID' ? 'csrf' : 'unavailable' };
    }
  }
  return fetchAndSave(api, t, save);
}
