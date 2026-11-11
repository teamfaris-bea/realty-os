// Coaching settings surface (module 41, its coaching part; module 36's API). Owner only: the database refuses
// these settings to anyone else. Its own surface module so the admin surface (module 17c) is not edited.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/admin/coaching',
      title: 'Coaching',
      roles: ['owner'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', label: 'Coaching', order: 237, section: 'admin' },
      component: lazy(() => import('./CoachingSettingsPage.js')),
    },
  ],
};
