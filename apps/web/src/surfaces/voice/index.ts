// AI call answering (module 55 item 8): the Owner's and Admin's page for module 48's voice answering. Every other role
// is kept out by the shell ("Not available"), so the page never mounts and no /voice request is made for them.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { VOICE_PAGE_PATH } from './words.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: VOICE_PAGE_PATH,
      title: 'AI call answering',
      roles: ['owner', 'admin'],
      nav: { phone: 'more', desktop: 'sidebar', icon: 'phone', order: 221, section: 'admin' },
      component: lazy(() => import('./VoiceAnsweringPage.js')),
    },
  ],
};
