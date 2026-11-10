// Team surface (web/lead-admin): the Team Lead exception queue, the scoreboard and deal momentum.
// Desktop-first (sidebar, Team section) and still usable on a phone (More → page: 2 taps).
// Exception evidence of two derived kinds opens here-owned routes: an ownership period opens the
// lead, a delivery status opens the conversation.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/team',
      title: 'Needs attention',
      roles: ['owner', 'admin', 'team_lead'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'alert', label: 'Needs attention', order: 100, section: 'team' },
      component: lazy(() => import('./TeamPage.js')),
    },
    {
      path: '/team/scoreboard',
      title: 'Scoreboard',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'team', order: 110, section: 'team' },
      component: lazy(() => import('./ScoreboardPage.js')),
    },
  ],
  evidenceRoutes: {
    ownership_period: (ref) => (ref.contactId ? `/contacts/${ref.contactId}` : null),
    message_status: (ref) => (ref.contactId ? `/contacts/${ref.contactId}/thread#${ref.sourceId}` : null),
  },
};
