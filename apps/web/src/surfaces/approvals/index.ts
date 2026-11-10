// Approvals surface (web/agent): assistant drafts, handbacks and saved-search proposals.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/approvals',
      title: 'Approvals',
      roles: 'all',
      nav: { phone: 'tab', desktop: 'sidebar', icon: 'inbox', order: 10 },
      component: lazy(() => import('./ApprovalsPage.js')),
    },
  ],
};
