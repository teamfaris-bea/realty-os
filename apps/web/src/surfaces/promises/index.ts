// Promises: open promise tasks, grouped by when they are due.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/promises',
      title: 'Promises',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'clock', label: 'Promises', order: 32 },
      component: lazy(() => import('./PromisesPage.js')),
    },
  ],
};
