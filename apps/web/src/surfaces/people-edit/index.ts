// People edit surface (PARITY_PLAN module 58): the Add person page. The person-page sections (stage, notes,
// log, details, plan) are rendered through contact/sections.ts.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { PEOPLE_ERROR_MESSAGES } from './api.js';

export const surface: SurfaceModule = {
  pages: [{ path: '/people/new', title: 'Add person', roles: ['owner', 'admin', 'team_lead', 'agent', 'isa'], component: lazy(() => import('./AddPersonPage.js')) }],
  errorMessages: PEOPLE_ERROR_MESSAGES,
};
