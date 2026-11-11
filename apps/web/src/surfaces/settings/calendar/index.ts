// Calendar settings surface (module 41's calendar page; module 34 api/calendar). Every role connects their own
// calendar; its own surface module so the settings surface (module 17c) is not edited.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/settings/calendar',
      title: 'Calendar',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'calendar', label: 'Calendar', order: 310, section: 'account' },
      component: lazy(() => import('./CalendarSettingsPage.js')),
    },
  ],
};
