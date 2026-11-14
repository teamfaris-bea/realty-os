// module 46 (R-PORTALWEB-10): the staff side of the client portal: the deal section (ClientPortalSection, mounted on
// the deal page) and "What {name} sees" (/client-portal/:grantId). Staff routes only; the client's view components
// come from src/portal/view, the one part of src/portal staff code may import.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
export { ClientPortalSection } from './ClientPortalSection.js';

export const surface: SurfaceModule = {
  pages: [{ path: '/client-portal/:grantId', title: 'What the client sees', roles: ['owner', 'admin', 'team_lead', 'agent', 'tc'], component: lazy(() => import('./PreviewPage.js')) }],
};
