// Owner view surface (PHASE2_3_PLAN module 40): dollars by source with costs and cost per closing, velocity, and the
// 90-day forecast with its method and exclusions. Owner/Admin only (the API answers 404 to everyone else). Desktop:
// a table in the Team section of the sidebar (1 click); phone: More → Owner view (2 taps), one card per source.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { OWNER_ERROR_MESSAGES } from './messages.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/owner',
      title: 'Owner view',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'deal', label: 'Owner view', order: 108, section: 'team' },
      component: lazy(() => import('./OwnerPage.js')),
    },
  ],
  errorMessages: OWNER_ERROR_MESSAGES,
};
