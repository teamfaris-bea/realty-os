// CMA surface (module 72, web/cma; D9 V2-A): the agent's CMA screen. Reached from the contact page's "Home value (CMA)"
// section (contact/sections.ts), never from the navigation. Roles: those with cma.prepare (Owner, Admin, Team Lead,
// Agent; ISA and TC have none). The server authorizes every call.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { CMA_ROLES } from './lib.js';
import { CMA_ERROR_MESSAGES } from './words.js';

export const surface: SurfaceModule = {
  pages: [{ path: '/cma/:cmaId', title: 'CMA', roles: CMA_ROLES, component: lazy(() => import('./CmaPage.js')) }],
  errorMessages: CMA_ERROR_MESSAGES,
};
