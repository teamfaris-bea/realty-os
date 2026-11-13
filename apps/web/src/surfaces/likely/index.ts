// Likely to move (module 55 for module 50; R-PRED-3..6, R-STAFF-7, E677). The viewer's own open likely-to-move
// cards as a list, grouped by the approved model that flagged them, each model's platform back-test said once. The
// only action is opening the contact: no select-all, no text, call, enroll or CMA control. Phone More → Likely to
// move (2 taps), desktop sidebar (1 click). A TC owns no contacts, so the page is not theirs.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/likely',
      title: 'Likely to move',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'people', label: 'Likely to move', order: 46, section: 'work' },
      component: lazy(() => import('./LikelyPage.js')),
    },
  ],
};
