// Admin → Gmail sync (module 69, D2): the Owner's switch and backfill window, and the platform:gmail review
// state. Owner and Admin only (an Admin can only turn it off); the server authorizes every call regardless.
// It shows no per-agent mailbox, token or sync state. Its own surface module (admin/index.ts is not edited).
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';
import { MAIL_ERROR_MESSAGES } from '../../settings/mail/words.js';

export const ADMIN_MAIL_PATH = '/admin/mail';

export const surface: SurfaceModule = {
  pages: [
    {
      path: ADMIN_MAIL_PATH,
      title: 'Gmail sync (team)',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'inbox', label: 'Gmail sync (team)', order: 255, section: 'admin' },
      component: lazy(() => import('./AdminMailPage.js')),
    },
  ],
  errorMessages: MAIL_ERROR_MESSAGES,
};
