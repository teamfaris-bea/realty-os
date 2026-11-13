// Documents surface (module 55, web/phase3-staff): a deal's, listing's or contact's documents (the section mounted on
// those pages) and one document's page. Module 42's API decides every state; the web shows its sentences.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';
import { DOC_MESSAGES } from './words.js';

/** Codes only this surface meets go to the registry; shared codes stay in the surface-local maps (words.ts). */
const OWN_CODES = Object.fromEntries(Object.entries(DOC_MESSAGES).filter(([code]) => /^(DOCUMENT_(?!RETAINED)|EXTRACTION_)/.test(code)));

export const surface: SurfaceModule = {
  pages: [
    { path: '/documents/:documentId', title: 'Document', roles: 'all', component: lazy(() => import('./DocumentPage.js')) },
    // module 55 item 7: the contract-date review, claim by claim (the only decision path for an extraction, R-STAFF-2)
    { path: '/documents/:documentId/dates', title: 'Contract dates', roles: 'all', component: lazy(() => import('./DatesPage.js')) },
  ],
  errorMessages: OWN_CODES,
  evidenceRoutes: { document: (ref) => `/documents/${ref.sourceId}` },
};
