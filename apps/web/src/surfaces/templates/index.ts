// Templates surface (parity module 64): the template library and the email signature. The picker that
// inserts a template into the composer is exported for ComposeBox's one optional prop (module 37).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { TEMPLATE_ERROR_MESSAGES } from './api.js';

export { TemplatePicker, type InsertedTemplate, type TemplatePickerProps } from './TemplatePicker.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/templates',
      title: 'Templates',
      roles: 'all',
      nav: { phone: 'more', desktop: 'sidebar', icon: 'checklist', label: 'Templates', order: 115, section: 'work' },
      component: lazy(() => import('./TemplatesPage.js')),
    },
  ],
  errorMessages: TEMPLATE_ERROR_MESSAGES,
};
