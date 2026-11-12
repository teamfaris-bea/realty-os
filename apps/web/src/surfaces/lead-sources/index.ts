// Lead sources surface (module 22): where new leads come from, and how each source's paths are set up. Owner and Admin
// only; the server authorizes every call regardless. Desktop: sidebar, Admin section (one click). Phone: More → Lead
// sources (2 taps from Home). The list's primary job (copy a source's lead-email address) is one tap on the page.
//   /admin/lead-sources       every source with its status sentence, path chips and one primary action; Add a source
//   /admin/lead-sources/:id   one source: each path's steps, values to copy, state and actions; where a new lead would
//                             go; rename, consent text, turn off / on
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { LEAD_SOURCES_ERROR_MESSAGES } from './messages.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/admin/lead-sources',
      title: 'Lead sources',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'inbox', label: 'Lead sources', order: 205, section: 'admin' },
      component: lazy(() => import('./LeadSourcesPage.js')),
    },
    {
      path: '/admin/lead-sources/:sourceId',
      title: 'Lead source',
      roles: ADMINS,
      component: lazy(() => import('./LeadSourceDetailPage.js')),
    },
  ],
  errorMessages: LEAD_SOURCES_ERROR_MESSAGES,
};
