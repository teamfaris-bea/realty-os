// Integrations surface (module 41, web/admin-p2): the Owner/Admin page with every service's state and every
// platform pack's counsel-review state. The provider callback lands here (/admin/integrations?result=…).
// Desktop: sidebar, Admin section. Phone: More → Integrations (2 taps). The server authorizes every call.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';
import { PAGE_PATH } from './words.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: PAGE_PATH,
      title: 'Integrations',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'external', label: 'Integrations', order: 240, section: 'admin' },
      component: lazy(() => import('./IntegrationsPage.js')),
    },
  ],
};
