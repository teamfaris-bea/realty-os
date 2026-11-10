// Search surface (web/agent): type-ahead over contacts, listings, deals, notes and messages.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/search',
      title: 'Search',
      roles: 'all',
      nav: { phone: 'tab', desktop: 'sidebar', icon: 'search', order: 20 },
      component: lazy(() => import('./SearchPage.js')),
    },
  ],
};
