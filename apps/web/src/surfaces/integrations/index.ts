// Integrations surface: the Owner/Admin MLS page (lane/spark-prep's Connect MLS page, extended in place by
// module 41 with sync status and the licence-pack editor). Owner and Admin only; the server authorizes every
// call regardless (Agents, Team Leads and support get NOT_FOUND).
// Desktop: sidebar, Admin section. Phone: More → MLS (2 taps).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { INTEGRATION_ERROR_MESSAGES } from './mls/messages.js';

const ADMINS = ['owner', 'admin'] as const;

export const SPARK_PAGE_PATH = '/admin/integrations/mls';

export const surface: SurfaceModule = {
  pages: [
    {
      path: SPARK_PAGE_PATH,
      title: 'MLS',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'listing', label: 'MLS', order: 250, section: 'admin' },
      component: lazy(() => import('./mls/MlsPage.js')),
    },
  ],
  errorMessages: INTEGRATION_ERROR_MESSAGES,
};
