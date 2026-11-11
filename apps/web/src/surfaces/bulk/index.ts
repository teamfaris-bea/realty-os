// Bulk surface (parity module 64): the bulk sheet (exported for the People page bulk bar, module 61), the
// list of your bulk actions, one action's progress, and a selection link that opens the sheet.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { BULK_ERROR_MESSAGES } from './api.js';

export { BulkActionSheet, type BulkActionSheetProps, type BulkListSelection } from './BulkActionSheet.js';
export { mayBulkAssign, mayBulkEnroll } from './choices.js';

const RUNS = ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const;

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/bulk',
      title: 'Bulk actions',
      roles: RUNS,
      nav: { phone: 'more', desktop: 'none', icon: 'people', label: 'Bulk actions', order: 116, section: 'work' },
      component: lazy(() => import('./BulkPages.js').then((m) => ({ default: m.BulkListPage }))),
    },
    {
      path: '/bulk/new',
      title: 'Bulk action',
      roles: RUNS,
      component: lazy(() => import('./BulkPages.js').then((m) => ({ default: m.BulkNewPage }))),
    },
    {
      path: '/bulk/:bulkId',
      title: 'Bulk action',
      roles: RUNS,
      component: lazy(() => import('./BulkPages.js').then((m) => ({ default: m.BulkDetailPage }))),
    },
  ],
  errorMessages: BULK_ERROR_MESSAGES,
};
