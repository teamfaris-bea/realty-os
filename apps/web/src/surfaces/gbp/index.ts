// Google Business Profile surface (module 55 item 12; module 53's API). Every staff role reads the reviews (owner
// question 14); only an Owner or Admin replies (the API's gbp.reply grant). Phone More → Google reviews (2 taps),
// desktop sidebar (1 click). Its refusal sentences live in words.ts (GBP_ERROR_MESSAGES) and are passed to the page's
// own refusalWords, not registered here: CHANNEL_NOT_CONNECTED and PLATFORM_NOT_CLEARED already carry the marketing
// surface's sentences in the registry, and one code has one registry sentence.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/gbp',
      title: 'Google Business Profile',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'message', label: 'Google reviews', order: 62, section: 'work' },
      component: lazy(() => import('./GbpPage.js')),
    },
  ],
};
