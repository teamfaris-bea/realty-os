// Goals and weekly plan surface (PHASE2_3_PLAN module 40). Goals: everyone sees their own (TL: their team; Owner and
// Admin: everyone) — phone More → Goals (2 taps), desktop sidebar (1 click). The weekly plan: the feed card "See the
// plan" opens /plan/:week (1 tap from Home); /plan is this week's, also in More and the sidebar.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { OWNER_ERROR_MESSAGES } from '../owner/messages.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/plan',
      title: 'Your plan this week',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'checklist', label: 'Weekly plan', order: 25 },
      component: lazy(() => import('./PlanPage.js')),
    },
    { path: '/plan/:week', title: 'Your weekly plan', roles: 'all', component: lazy(() => import('./PlanPage.js')) },
    {
      path: '/goals',
      title: 'Goals',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'clock', label: 'Goals', order: 26 },
      component: lazy(() => import('./GoalsPage.js')),
    },
  ],
  errorMessages: OWNER_ERROR_MESSAGES,
};
