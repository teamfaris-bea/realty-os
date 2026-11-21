// Pipeline: the eight contact stages as a board.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { PEOPLE_ERROR_MESSAGES } from '../people-edit/api.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/pipeline',
      title: 'Pipeline',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'team', label: 'Pipeline', order: 31 },
      component: lazy(() => import('./PipelinePage.js')),
    },
  ],
  errorMessages: PEOPLE_ERROR_MESSAGES,
};
