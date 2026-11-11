// Marketing surface (module 38, lane 2C marketing): a listing's marketing tab. Reached from the listing
// page ("Marketing") and the approvals inbox; no nav entry.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { MARKETING_ERROR_MESSAGES } from './lib.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/listings/:listingId/marketing',
      title: 'Marketing',
      roles: 'all',
      component: lazy(() => import('./MarketingPage.js')),
    },
  ],
  errorMessages: MARKETING_ERROR_MESSAGES,
};
