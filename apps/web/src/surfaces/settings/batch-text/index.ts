// Batch text settings surface (parity module 64; R-PAR-40): Owner and Admin open it, only the Owner turns
// batch text on. Its own surface module so the settings surface (module 17c) is not edited.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/settings/batch-text',
      title: 'Batch text',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'message', label: 'Batch text', order: 235, section: 'admin' },
      component: lazy(() => import('./BatchTextPage.js')),
    },
  ],
};
