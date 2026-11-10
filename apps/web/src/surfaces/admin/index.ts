// Admin surface (web/lead-admin): members and teams, lead routing (rules, ponds, lead timers), and
// phone numbers / email. Owner and Admin only; the server authorizes every call regardless.
// Desktop-first (sidebar, Admin section); on a phone each page is More → page (2 taps).
// The error sentences of every lead-admin surface (team, admin, imports, settings) are registered
// once, here.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { LEAD_ADMIN_ERROR_MESSAGES } from './lib/messages.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/admin/members',
      title: 'Members',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'people', order: 200, section: 'admin' },
      component: lazy(() => import('./MembersPage.js')),
    },
    {
      path: '/admin/routing',
      title: 'Lead routing',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'pond', label: 'Lead routing', order: 210, section: 'admin' },
      component: lazy(() => import('./RoutingPage.js')),
    },
    {
      path: '/admin/numbers',
      title: 'Phone and email',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'phone', order: 220, section: 'admin' },
      component: lazy(() => import('./NumbersPage.js')),
    },
    {
      path: '/admin/erasure',
      title: 'Erase a contact',
      roles: ADMINS,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'block', label: 'Erase a contact', order: 230, section: 'admin' },
      component: lazy(() => import('./ErasurePage.js')),
    },
  ],
  errorMessages: LEAD_ADMIN_ERROR_MESSAGES,
};
