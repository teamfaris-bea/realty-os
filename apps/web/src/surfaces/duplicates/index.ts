// Duplicates surface (PARITY_PLAN module 66): review possible duplicate people and merge them through the
// ownership engine. Transaction coordinators never own or merge leads (R-PERM-15), so it is not shown to them.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { DUPLICATE_DECIDED_TEXT } from './lib.js';

const NOT_TC = ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/duplicates',
      title: 'Duplicates',
      roles: NOT_TC,
      nav: { phone: 'more', desktop: 'sidebar', icon: 'people', order: 45 },
      component: lazy(() => import('./DuplicatesPages.js').then((m) => ({ default: m.DuplicatesPage }))),
    },
    {
      path: '/duplicates/:duplicateId',
      title: 'Possible duplicate',
      roles: NOT_TC,
      component: lazy(() => import('./DuplicatesPages.js').then((m) => ({ default: m.DuplicatePage }))),
    },
  ],
  errorMessages: { DUPLICATE_ALREADY_DECIDED: DUPLICATE_DECIDED_TEXT },
};
