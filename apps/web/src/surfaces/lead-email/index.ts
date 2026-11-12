// Lead-email surface (module 22's lead-email slice): the Needs review queue of held lead emails
// (Owner/Admin/Team Lead), next to the other Team Lead queue (Needs attention) in the Team section;
// on a phone it is More → Needs review (2 taps). A lead source's email intake (address, portals, sender
// domains, new address) is EmailIntake.tsx (Owner/Admin), shown on that source's page under Lead sources
// (surfaces/lead-sources, /admin/lead-sources/:id); Lead routing only links there.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { LEAD_EMAIL_ERROR_MESSAGES } from './messages.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/team/lead-email',
      title: 'Needs review',
      roles: ['owner', 'admin', 'team_lead'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'inbox', label: 'Needs review', order: 105, section: 'team' },
      component: lazy(() => import('./NeedsReviewPage.js')),
    },
  ],
  errorMessages: LEAD_EMAIL_ERROR_MESSAGES,
};
