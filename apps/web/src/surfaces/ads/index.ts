// Google Ads surface (PHASE2_3_PLAN module 55 item 10; module 52's API). Owner/Admin only ('ads.view'; the API answers
// 404 to everyone else, R-PERM-5). Desktop: the Team section of the sidebar (1 click); phone: More → Google Ads (2 taps).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { ADS_ERROR_MESSAGES } from './words.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/ads',
      title: 'Google Ads',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'deal', label: 'Google Ads', order: 109, section: 'team' },
      component: lazy(() => import('./AdsPage.js')),
    },
  ],
  errorMessages: ADS_ERROR_MESSAGES,
};
