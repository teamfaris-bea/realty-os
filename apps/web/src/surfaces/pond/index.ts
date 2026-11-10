// Pond surface (web/agent): masked pond cards with one-tap Claim. Transaction coordinators never own
// or claim leads (R-PERM-15), so the page is not shown to them.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/pond',
      title: 'Pond',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'pond', order: 40 },
      component: lazy(() => import('./PondPage.js')),
    },
  ],
};
