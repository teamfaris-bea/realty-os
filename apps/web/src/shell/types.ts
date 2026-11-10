// Page registry types (CONVENTIONS §3). A surface exports `surface: SurfaceModule` from
// apps/web/src/surfaces/<surface>/index.ts and is listed in registry.ts.
import type { Role } from '@realty/core/foundation';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { EvidenceRoutes, IconName } from '../design/index.js';

/**
 * Where a page appears in navigation.
 * - phone `tab`: the bottom tab bar (at most 4 tabs; the rest move to More, by `order`). 1 tap.
 *   phone `more`: listed under the More tab. 2 taps. `none`: reached from other pages only.
 * - desktop `sidebar`: the left sidebar. 1 click. `none`: reached from other pages only.
 * A page without `nav` is a detail page (e.g. /contacts/:id).
 */
export type NavSection = 'work' | 'team' | 'admin' | 'account';

export interface PageNav {
  phone: 'tab' | 'more' | 'none';
  desktop: 'sidebar' | 'none';
  /** short label for the tab bar / sidebar; defaults to the title */
  label?: string;
  icon: IconName;
  /** lower first; ties keep registry order */
  order: number;
  /** sidebar grouping on desktop ('account' sits at the bottom of the sidebar); default 'work' */
  section?: NavSection;
}

export interface PageDef {
  /** absolute react-router path, e.g. '/', '/contacts/:contactId' */
  path: string;
  /** the page's name: document title, top bar and the h1 that receives focus after navigation */
  title: string;
  nav?: PageNav;
  /** roles that may open the page ('all' = every role). The server still authorizes every call. */
  roles: readonly Role[] | 'all';
  /** e.g. `lazy(() => import('./FeedPage.js'))`; a plain component works for tiny pages */
  component: LazyExoticComponent<ComponentType> | ComponentType;
}

export interface SurfaceModule {
  pages: PageDef[];
  /** code → sentence for codes this surface shows (looked up before shell/errorMessages.ts) */
  errorMessages?: Record<string, string>;
  /**
   * How to open an evidence source this surface owns (EvidenceLink), e.g. the thread surface maps
   * `message` → `/contacts/${ref.contactId}/thread#${ref.sourceId}`. Return null when it can't.
   */
  evidenceRoutes?: EvidenceRoutes;
}
