// Pure page-table logic over the registry: which pages a role may open, the phone tab bar and More
// list, the desktop sidebar, how many taps each nav page is from anywhere in the app, and registry
// validation (duplicate paths, conflicting error sentences or evidence routes).
import type { Role } from '@realty/core/foundation';
import type { EvidenceRouteFn, EvidenceRoutes, EvidenceSourceType } from '../design/index.js';
import type { NavSection, PageDef, PageNav, SurfaceModule } from './types.js';

/** The bottom tab bar holds at most this many page tabs, plus the always-present More tab (PARITY_PLAN §5: People joins Home, Approvals, Search and Tasks). */
export const MAX_PHONE_TABS = 5;

export interface PageTable {
  pages: PageDef[];
  errorMessages: Record<string, string>;
  evidenceRoutes: EvidenceRoutes;
}

const CODE_KEY_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:\/[a-z0-9_]+)?$/;

/** Problems that make a registry unsound. The real registry is asserted to have none (test). */
export function validateRegistry(surfaces: readonly SurfaceModule[]): string[] {
  const problems: string[] = [];
  const paths = new Map<string, number>();
  const messages = new Map<string, { text: string; at: number }>();
  const opener = new Map<string, number>();
  surfaces.forEach((s, i) => {
    for (const p of s.pages) {
      if (!p.path.startsWith('/')) problems.push(`surface #${i}: path "${p.path}" must be absolute`);
      const key = normalizePath(p.path);
      const prev = paths.get(key);
      if (prev !== undefined) problems.push(`surface #${i}: path "${p.path}" is already registered by surface #${prev}`);
      else paths.set(key, i);
      if (p.roles !== 'all' && p.roles.length === 0) problems.push(`surface #${i}: page "${p.path}" allows no role`);
      if (!p.title.trim()) problems.push(`surface #${i}: page "${p.path}" has no title`);
      if (p.nav && p.nav.phone === 'none' && p.nav.desktop === 'none') problems.push(`surface #${i}: page "${p.path}" has nav but appears nowhere; omit nav instead`);
    }
    for (const [code, text] of Object.entries(s.errorMessages ?? {})) {
      if (!CODE_KEY_RE.test(code)) problems.push(`surface #${i}: error key "${code}" is not a CODE or CODE/rule`);
      if (!text.trim()) problems.push(`surface #${i}: error "${code}" has an empty sentence`);
      if (/\b[A-Z]{2,}_[A-Z_]+\b/.test(text)) problems.push(`surface #${i}: error "${code}" sentence shows a raw code`);
      const m = messages.get(code);
      if (m && m.text !== text) problems.push(`surface #${i}: error "${code}" conflicts with surface #${m.at}`);
      else if (!m) messages.set(code, { text, at: i });
    }
    for (const t of Object.keys(s.evidenceRoutes ?? {})) {
      const prev = opener.get(t);
      if (prev !== undefined) problems.push(`surface #${i}: evidence source "${t}" is already opened by surface #${prev}`);
      else opener.set(t, i);
    }
  });
  return problems;
}

function normalizePath(p: string): string {
  // '/contacts/:id' and '/contacts/:contactId' are the same route
  return p.replace(/:[^/]+/g, ':').replace(/\/+$/, '') || '/';
}

/**
 * Builds the page table. The first registration of a path wins (validateRegistry reports the
 * duplicate). `fallbackHome` is used for '/' only while no surface registers '/'.
 */
export function buildPageTable(surfaces: readonly SurfaceModule[], fallbackHome?: PageDef): PageTable {
  const pages: PageDef[] = [];
  const seen = new Set<string>();
  const errorMessages: Record<string, string> = {};
  const evidenceRoutes: Partial<Record<EvidenceSourceType, EvidenceRouteFn>> = {};
  for (const s of surfaces) {
    for (const p of s.pages) {
      const key = normalizePath(p.path);
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(p);
    }
    for (const [code, text] of Object.entries(s.errorMessages ?? {})) if (!Object.hasOwn(errorMessages, code)) errorMessages[code] = text;
    for (const [t, fn] of Object.entries(s.evidenceRoutes ?? {}) as [EvidenceSourceType, EvidenceRouteFn][]) if (!evidenceRoutes[t]) evidenceRoutes[t] = fn;
  }
  if (fallbackHome && !seen.has('/')) pages.unshift(fallbackHome);
  return { pages, errorMessages, evidenceRoutes };
}

export function canOpen(page: PageDef, role: Role): boolean {
  return page.roles === 'all' || page.roles.includes(role);
}

export function pagesFor(table: PageTable, role: Role): PageDef[] {
  return table.pages.filter((p) => canOpen(p, role));
}

export interface NavItem {
  path: string;
  label: string;
  icon: PageNav['icon'];
  section: NavSection;
}

export interface NavModel {
  /** phone bottom tabs (≤ MAX_PHONE_TABS), then the More tab */
  tabs: NavItem[];
  /** phone More list: `more` pages plus tab overflow */
  more: NavItem[];
  /** desktop sidebar groups in fixed order: work, team, admin, then account at the bottom */
  sidebar: { section: NavSection; items: NavItem[] }[];
}

const SECTIONS: NavSection[] = ['work', 'team', 'admin', 'account'];

function ordered(pages: readonly PageDef[]): (PageDef & { nav: PageNav })[] {
  return pages
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: PageDef & { nav: PageNav }; i: number } => x.p.nav !== undefined)
    .sort((a, b) => a.p.nav.order - b.p.nav.order || a.i - b.i)
    .map((x) => x.p);
}

function item(p: PageDef & { nav: PageNav }): NavItem {
  return { path: p.path, label: p.nav.label ?? p.title, icon: p.nav.icon, section: p.nav.section ?? 'work' };
}

/** Navigation for the pages one role may open (pass `pagesFor(...)`). */
export function navFor(pages: readonly PageDef[]): NavModel {
  const list = ordered(pages);
  const tabCandidates = list.filter((p) => p.nav.phone === 'tab');
  const tabs = tabCandidates.slice(0, MAX_PHONE_TABS).map(item);
  const overflow = tabCandidates.slice(MAX_PHONE_TABS);
  const more = list.filter((p) => p.nav.phone === 'more' || overflow.includes(p)).map(item);
  const side = list.filter((p) => p.nav.desktop === 'sidebar').map(item);
  const sidebar = SECTIONS.map((section) => ({ section, items: side.filter((i) => i.section === section) })).filter((g) => g.items.length > 0);
  return { tabs, more, sidebar };
}

/**
 * Taps (phone) or clicks (desktop) needed to open `path` from any page of the app: 1 for a tab or
 * a sidebar entry (always on screen), 2 for a More entry (More, then the entry), null when the page
 * is not in navigation (a detail page reached from another page).
 */
export function tapsTo(nav: NavModel, path: string, viewport: 'phone' | 'desktop'): 1 | 2 | null {
  if (viewport === 'desktop') return nav.sidebar.some((g) => g.items.some((i) => i.path === path)) ? 1 : null;
  if (nav.tabs.some((i) => i.path === path)) return 1;
  if (nav.more.some((i) => i.path === path)) return 2;
  return null;
}

/** Longest common prefix match: which nav item a location belongs to (for aria-current). */
export function activeNavPath(items: readonly NavItem[], pathname: string): string | null {
  let best: string | null = null;
  for (const i of items) {
    const match = i.path === '/' ? pathname === '/' : pathname === i.path || pathname.startsWith(`${i.path}/`);
    if (match && (best === null || i.path.length > best.length)) best = i.path;
  }
  return best;
}
