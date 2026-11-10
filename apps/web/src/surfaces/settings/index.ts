// Settings surface (web/lead-admin): compliance policy (Owner/Admin), brokerage and team settings
// (Owner/Admin; identity and recording are Owner-only inside the page), and playbooks (everyone who
// may approve their own; team playbooks by Owner/Admin). Desktop-first, still usable on a phone.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/settings/playbooks',
      title: 'Playbooks',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'checklist', order: 120, section: 'team' },
      component: lazy(() => import('./PlaybooksPage.js').then((m) => ({ default: m.PlaybooksPage }))),
    },
    {
      path: '/settings/playbooks/:playbookId',
      title: 'Playbook',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      component: lazy(() => import('./PlaybooksPage.js').then((m) => ({ default: m.PlaybookPage }))),
    },
    {
      path: '/settings/compliance',
      title: 'Compliance',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'block', order: 230, section: 'admin' },
      component: lazy(() => import('./CompliancePage.js')),
    },
    {
      path: '/settings/team',
      title: 'Brokerage and team',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', label: 'Brokerage and team', order: 240, section: 'admin' },
      component: lazy(() => import('./TeamSettingsPage.js')),
    },
  ],
};
