// Daily fix surface (module 40; module 36's API). Every role that takes calls opens it; the feed's coaching
// card links here. Team Leads, Admins and the Owner also see their team's tips (what a Team Lead reads is
// decided by the database: only while the Owner's setting is on).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/coaching',
      title: 'Coaching tip',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'info', label: 'Coaching tip', order: 47, section: 'work' },
      component: lazy(() => import('./CoachingPage.js')),
    },
  ],
  errorMessages: {
    COACHING_NOT_CLEARED: 'Call reviews wait for counsel review before they can be turned on.',
  },
};
