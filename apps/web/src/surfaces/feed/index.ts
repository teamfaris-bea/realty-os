// Priority Feed surface (web/agent). Registered in shell/registry.ts. '/' is the app's home: opening
// the app shows what's due (ARCHITECTURE §1, 0 taps). The page title stays "Home" (the shell's own
// home placeholder used it, and its e2e specs look for it); the bands inside say "Due now" / "Next up".
// The error sentences of every agent surface are registered once, here.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { AGENT_ERROR_MESSAGES } from './lib/messages.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/',
      title: 'Home',
      roles: 'all',
      nav: { phone: 'tab', desktop: 'sidebar', icon: 'home', label: 'Home', order: 0 },
      component: lazy(() => import('./FeedPage.js')),
    },
  ],
  errorMessages: AGENT_ERROR_MESSAGES,
};
