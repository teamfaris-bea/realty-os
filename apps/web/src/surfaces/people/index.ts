// People surface (PARITY_PLAN module 61): the People tab (everyone the viewer can see and saved smart
// lists, multi-select and the bulk bar), and working a list with "Next person". The person's tag chips
// (ContactTags) are exported for the contact page's sections (module 58's sections.ts).
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';

export { ContactTags } from './ContactTags.js';

export const surface: SurfaceModule = {
  pages: [
    {
      path: '/people',
      title: 'People',
      roles: 'all',
      nav: { phone: 'tab', desktop: 'sidebar', icon: 'people', order: 5 },
      component: lazy(() => import('./PeoplePage.js')),
    },
    { path: '/people/work/:contactId', title: 'Person', roles: 'all', component: lazy(() => import('./WorkPage.js')) },
  ],
  errorMessages: LISTS_ERROR_MESSAGES,
};
