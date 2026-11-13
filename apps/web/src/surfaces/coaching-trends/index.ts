// Coaching trends (module 55 for module 54; R-COACH-7, R-COACH-8, R-STAFF-3, R-STAFF-6, E679). Each person's weekly
// improving/slipping per checklist item, in counts with their n; an Owner, Admin or Team Lead also has a Team tab (what
// a Team Lead reads is decided by the database: only while the Owner's switch is on). Phone More → Coaching trends
// (2 taps), desktop sidebar (1 click). A TC takes no calls, so the page is not theirs.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { TRENDS_MESSAGES } from './messages.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/coaching/trends',
      title: 'Coaching trends',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'clock', label: 'Coaching trends', order: 48, section: 'work' },
      component: lazy(() => import('./TrendsPage.js')),
    },
  ],
  errorMessages: TRENDS_MESSAGES,
};
