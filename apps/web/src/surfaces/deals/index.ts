// Deals surface (web/agent): open deals, stage, dates, attribution and commission.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    { path: '/deals', title: 'Deals', roles: 'all', nav: { phone: 'more', desktop: 'sidebar', icon: 'deal', order: 50 }, component: lazy(() => import('./DealsPages.js').then((m) => ({ default: m.DealsPage }))) },
    { path: '/deals/:dealId', title: 'Deal', roles: 'all', component: lazy(() => import('./DealsPages.js').then((m) => ({ default: m.DealPage }))) },
  ],
  evidenceRoutes: { deal: (ref) => `/deals/${ref.sourceId}` },
};
