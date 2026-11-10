// Imports surface (web/lead-admin): Follow Up Boss and CSV imports with staged review lists.
// Owner/Admin only (import.run, with a password confirmation within 15 minutes). Desktop-first.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/imports',
      title: 'Imports',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'upload', order: 250, section: 'admin' },
      component: lazy(() => import('./ImportsPages.js').then((m) => ({ default: m.ImportsPage }))),
    },
    {
      path: '/imports/:importId',
      title: 'Import',
      roles: ADMINS,
      component: lazy(() => import('./ImportsPages.js').then((m) => ({ default: m.ImportPage }))),
    },
  ],
};
