// Website chat surface (module 41, web/admin-p2): Owner/Admin create chat widgets, rotate a key (shown once),
// choose allowed websites, copy the embed code and disconnect. Desktop: sidebar, Admin section. Phone: More →
// Website chat (2 taps). The server authorizes every call regardless of `roles`.
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';
import { WEBCHAT_PATH } from './words.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: WEBCHAT_PATH,
      title: 'Website chat',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'message', label: 'Website chat', order: 245, section: 'admin' },
      component: lazy(() => import('./WebChatPage.js')),
    },
  ],
};
