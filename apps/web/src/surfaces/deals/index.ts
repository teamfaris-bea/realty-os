// Deals surface (web/agent): open deals, stage, the milestone timeline (module 39), attribution and commission;
// the TC board (module 39).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { MILESTONE_ERROR_MESSAGES } from './milestones.js';

export const surface: SurfaceModule = {
  pages: [
    { path: '/deals', title: 'Deals', roles: 'all', nav: { phone: 'more', desktop: 'sidebar', icon: 'deal', order: 50 }, component: lazy(() => import('./DealsPages.js').then((m) => ({ default: m.DealsPage }))) },
    { path: '/deals/:dealId', title: 'Deal', roles: 'all', component: lazy(() => import('./DealsPages.js').then((m) => ({ default: m.DealPage }))) },
    // module 39: the TC board (desktop sidebar; on a phone, More → Transactions, and each deal's own timeline)
    { path: '/transactions', title: 'Transactions', roles: 'all', nav: { phone: 'more', desktop: 'sidebar', icon: 'checklist', order: 51 }, component: lazy(() => import('./BoardPage.js')) },
  ],
  errorMessages: MILESTONE_ERROR_MESSAGES,
  evidenceRoutes: { deal: (ref) => `/deals/${ref.sourceId}` },
};
