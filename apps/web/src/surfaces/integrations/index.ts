// Integrations surface (lane/spark-prep): the Owner/Admin "Connect MLS (Spark)" page. Owner and Admin
// only; the server authorizes every call regardless (Agents, Team Leads and support get NOT_FOUND).
// Desktop: sidebar, Admin section. Phone: More → Connect MLS (2 taps).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { INTEGRATION_ERROR_MESSAGES } from './mls/messages.js';

const ADMINS = ['owner', 'admin'] as const;

export const SPARK_PAGE_PATH = '/admin/integrations/mls';

export const surface: SurfaceModule = {
  pages: [
    {
      path: SPARK_PAGE_PATH,
      title: 'Connect MLS (Spark)',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'listing', label: 'Connect MLS', order: 250, section: 'admin' },
      component: lazy(() => import('./mls/SparkPage.js')),
    },
  ],
  errorMessages: INTEGRATION_ERROR_MESSAGES,
};
