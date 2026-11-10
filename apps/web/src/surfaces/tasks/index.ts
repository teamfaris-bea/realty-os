// Tasks surface (web/agent): open tasks, promises with evidence, appointments awaiting an outcome.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/tasks',
      title: 'Tasks',
      roles: 'all',
      nav: { phone: 'tab', desktop: 'sidebar', icon: 'checklist', order: 30 },
      component: lazy(() => import('./TasksPage.js')),
    },
  ],
  evidenceRoutes: {
    task: (ref) => `/tasks#task-${ref.sourceId}`,
    appointment: () => '/tasks',
  },
};
