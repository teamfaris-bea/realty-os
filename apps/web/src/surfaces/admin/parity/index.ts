// Admin parity pages (PARITY_PLAN module 61): the tag catalog, custom fields and stage labels.
// Owner/Admin only (the server authorizes every call: tag.manage, custom_field.manage).
import { lazy } from 'react';
import type { SurfaceModule } from '../../../shell/index.js';
import { LISTS_ERROR_MESSAGES } from '../../people/messages.js';

const ADMINS = ['owner', 'admin'] as const;

export const surface: SurfaceModule = {
  pages: [
    { path: '/admin/tags', title: 'Tags', roles: ADMINS, nav: { phone: 'more', desktop: 'sidebar', icon: 'checklist', order: 75, section: 'admin' }, component: lazy(() => import('./TagsPage.js')) },
    { path: '/admin/fields', title: 'Custom fields', roles: ADMINS, nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 76, section: 'admin' }, component: lazy(() => import('./FieldsPage.js')) },
    { path: '/admin/stage-labels', title: 'Stage labels', roles: ADMINS, nav: { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 77, section: 'admin' }, component: lazy(() => import('./StageLabelsPage.js')) },
  ],
  errorMessages: LISTS_ERROR_MESSAGES,
};
