// Thread surface (web/agent): texts, emails and calls with one contact, and the compose box.
// Evidence quoting a text, an email or a call opens the conversation at that item (the thread row's
// id is the source id). Recording playback at the quoted offset needs a call → recording lookup the
// Phase 1 API does not expose to the web (reported); the call row is shown instead.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

const at = (ref: { contactId?: string | null; sourceId: string }) => (ref.contactId ? `/contacts/${ref.contactId}/thread#${ref.sourceId}` : null);

export const surface: SurfaceModule = {
  pages: [{ path: '/contacts/:contactId/thread', title: 'Conversation', roles: 'all', component: lazy(() => import('./ThreadPage.js')) }],
  evidenceRoutes: { message: at, email: at, call: at },
};
