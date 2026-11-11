// Coaching settings surface (module 41, its coaching part; module 36's API). The Owner and Admins open it: the Owner
// changes the settings, and an Admin can only turn call reviews off (owner decision 2026-11-11, the Gmail sync rule;
// the API and the database refuse an Admin anything else). Its own surface module so the admin surface (module 17c)
// is not edited.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/admin/coaching',
      title: 'Coaching',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', label: 'Coaching', order: 237, section: 'admin' },
      component: lazy(() => import('./CoachingSettingsPage.js')),
    },
  ],
};
