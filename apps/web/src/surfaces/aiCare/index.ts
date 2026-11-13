// Module 76: AI care (docs/AI_ISA.md §10; D12 proposed). Pages: "Under AI care" (/ai-care), "My AI assistant"
// (/settings/ai-assistant) and the team's "AI assistant (ISA)" (/settings/ai-assistant/team). The panel, the person
// page strip, the thread banner and labels, the feed cards and the compose and dial warnings are flagged edits in their
// owners' files (each one import and one element). errorMessages hold module-75 codes only: never a shell code
// (OWNER_REQUIRED and ATTESTATION_REQUIRED stay the shell's; the team page uses its local variants through
// messageFor), never another surface's. The server authorizes every call regardless of `roles`.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { ISA_ERROR_MESSAGES } from './words.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/ai-care',
      title: 'Under AI care',
      roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'message', label: 'AI care', order: 45, section: 'work' },
      component: lazy(() => import('./ListPage.js')),
    },
    {
      path: '/settings/ai-assistant',
      title: 'My AI assistant',
      roles: ['owner', 'admin', 'team_lead', 'agent'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 330, section: 'account' },
      component: lazy(() => import('./MyAssistantPage.js')),
    },
    {
      path: '/settings/ai-assistant/team',
      title: 'AI assistant (ISA)',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 235, section: 'admin' },
      component: lazy(() => import('./TeamAssistantPage.js')),
    },
  ],
  errorMessages: ISA_ERROR_MESSAGES,
};

// Flagged edits import from the component files directly (Person.tsx, Thread.tsx, Feed.tsx, Compose.tsx, Policy.tsx),
// so the registry's eager import of this file stays small.
