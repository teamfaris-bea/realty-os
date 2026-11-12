// Settings → Gmail (module 69, D2): every staff member connects their own Gmail (read-only), confirms which
// clients' addresses sync, and disconnects. Its own surface module so the settings surface (module 17c)
// is not edited. Phone: More → Gmail (2 taps); desktop: sidebar, Account section.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';
import { MAIL_ERROR_MESSAGES } from './words.js';

export const MAIL_SETTINGS_PATH = '/settings/mail';

export const surface: SurfaceModule = {
  pages: [
    {
      path: MAIL_SETTINGS_PATH,
      title: 'My Gmail',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'inbox', label: 'My Gmail', order: 9_000, section: 'account' },
      component: lazy(() => import('./MailSettingsPage.js')),
    },
  ],
  errorMessages: MAIL_ERROR_MESSAGES,
};
