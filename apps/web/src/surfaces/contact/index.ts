// Contact surface (web/agent): one contact's page (card or full view, R-PERM-6).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [{ path: '/contacts/:contactId', title: 'Contact', roles: 'all', component: lazy(() => import('./ContactPage.js')) }],
  evidenceRoutes: {
    note: (ref) => (ref.contactId ? `/contacts/${ref.contactId}` : null),
    behavior_event: (ref) => (ref.contactId ? `/contacts/${ref.contactId}` : null),
  },
};
