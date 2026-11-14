// module 46 (R-PORTALWEB-3, R-PORTALWEB-4; E700-E703, E719): the sign-in link and the team, read ONCE before the first
// render (boot.tsx calls readLink before createRoot), and again only when a new link arrives as a fragment change
// (rereadLink, b15 audit P46-SEC-2).
//
// Token: only a fragment that is exactly `#token=` and 43 base64url characters is well-formed; any other fragment that
// names a token is "incomplete" (no Sign in button, nothing posted). The fragment is removed from the address bar and
// from the current history entry at once (history.replaceState), so a reload, the back button or a Referer never
// carry it. The token lives in this module's variable only: never in storage, a URL, a log or React state, and it is
// sent only in the body of POST /api/portal/session when the client taps Sign in (screens/LinkLanding.tsx).
//
// Team: `?team=` (lowercased, the tenants slug pattern) stays in the address bar: it is not a secret and no query is
// logged. A valid one is also remembered on this device (localStorage, the slug only; Q-PORTALWEB-2, VERIFY WITH
// COUNSEL) for the token link, which carries no team. An invalid slug is never guessed at (E719).
import { LINK_TOKEN_RE, TEAM_SLUG_RE } from './copy.js';

export type LinkKind = 'none' | 'token' | 'incomplete';
export interface LinkRead {
  link: LinkKind;
  team: string | null;
}

export const TEAM_STORAGE_KEY = 'realty-portal-team';

let token: string | null = null;
let read: LinkRead | null = null;

interface Loc {
  pathname: string;
  search: string;
  hash: string;
}
interface Hist {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}
interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Whether a fragment names a token in any spelling (encoded, upper case, after other parameters). */
function namesToken(hash: string): boolean {
  let decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    /* a malformed escape still names a token if the raw text does */
  }
  return /token/i.test(hash) || /token/i.test(decoded);
}

/** The fragment's link kind, and the token when well-formed. Pure. */
export function classifyHash(hash: string): { kind: LinkKind; token: string | null } {
  if (hash === '' || hash === '#') return { kind: 'none', token: null };
  const m = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (m && LINK_TOKEN_RE.test(m[1]!)) return { kind: 'token', token: m[1]! };
  return namesToken(hash) ? { kind: 'incomplete', token: null } : { kind: 'none', token: null };
}

/** A team slug from the query, or null. Pure. */
export function teamFromSearch(search: string): { present: boolean; slug: string | null } {
  const raw = new URLSearchParams(search).get('team');
  if (raw === null) return { present: false, slug: null };
  const slug = raw.toLowerCase();
  return { present: true, slug: TEAM_SLUG_RE.test(slug) ? slug : null };
}

function storage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the link and the team once, and strips a token fragment from the address bar before anything renders. Later
 * calls return the first answer (a re-render or a second import never reads the address again).
 */
export function readLink(loc: Loc = window.location, hist: Hist = window.history, store: Store | null = storage()): LinkRead {
  if (read) return read;
  const h = classifyHash(loc.hash);
  if (h.kind !== 'none') hist.replaceState(hist.state, '', loc.pathname + loc.search);
  token = h.token;
  const q = teamFromSearch(loc.search);
  let team: string | null = q.slug;
  try {
    if (q.slug) store?.setItem(TEAM_STORAGE_KEY, q.slug);
    else if (!q.present) {
      const kept = store?.getItem(TEAM_STORAGE_KEY) ?? null;
      team = kept !== null && TEAM_SLUG_RE.test(kept) ? kept : null;
    }
  } catch {
    // storage that throws (private mode, blocked): the query alone decides
  }
  read = { link: h.kind, team };
  return read;
}

/**
 * b15 audit P46-SEC-2: a sign-in link opened in a tab already on the portal is a fragment change only (no load). When
 * the new fragment names a token, it is read in place exactly as readLink reads a first load: stripped from the address
 * bar and from the history entry the fragment change made, before anything renders, the token kept in memory only.
 * Returns null when the fragment names no token (the skip link's #main): nothing changes.
 */
export function rereadLink(loc: Loc = window.location, hist: Hist = window.history, store: Store | null = storage()): LinkRead | null {
  if (classifyHash(loc.hash).kind === 'none') return null;
  token = null;
  read = null;
  return readLink(loc, hist, store);
}

/** The well-formed token, while it has not been used (LinkLanding posts it on the tap only). */
export function linkToken(): string | null {
  return token;
}

/**
 * Forgets the token (after the tap succeeded or the link was refused, on sign-out and on a session 401). With `sent`,
 * only that token is forgotten: a tap whose answer arrives after a newer link was read in place (rereadLink) leaves the
 * newer token for the new Sign in (b15 review B15R-PORTAL-2).
 */
export function dropToken(sent?: string): void {
  if (sent === undefined || token === sent) token = null;
}

/** Tests only: forget what was read. */
export function resetLinkForTests(): void {
  token = null;
  read = null;
}
