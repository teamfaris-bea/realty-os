// Listings surface (web/agent): team listings, price history, showings and feedback.
import { lazy } from 'react';
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = {
  pages: [
    { path: '/listings', title: 'Listings', roles: 'all', nav: { phone: 'more', desktop: 'sidebar', icon: 'listing', order: 60 }, component: lazy(() => import('./ListingsPages.js').then((m) => ({ default: m.ListingsPage }))) },
    { path: '/listings/:listingId', title: 'Listing', roles: 'all', component: lazy(() => import('./ListingsPages.js').then((m) => ({ default: m.ListingPage }))) },
  ],
  evidenceRoutes: { listing: (ref) => `/listings/${ref.sourceId}` },
};
