// Admin: milestone templates (module 41, the transactions part). Owner/Admin only; the server authorizes every call
// (milestone_template.manage). Desktop-first (sidebar, Admin section); on a phone, More → Milestone templates.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/admin/milestone-templates',
      title: 'Milestone templates',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'calendar', label: 'Milestone templates', order: 310, section: 'admin' },
      component: lazy(() => import('./MilestoneTemplatesPage.js')),
    },
  ],
  errorMessages: {
    MILESTONE_TEMPLATES_INVALID: 'Some templates have errors. Each one is listed below; nothing was saved.',
  },
};
