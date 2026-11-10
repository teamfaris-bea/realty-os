// Surface / page registry (CONVENTIONS §3).
//
// SHARED REGISTRATION FILE, owned by web/shell. A surface adds ONE import line and ONE entry,
// above the marker, and never touches other lines:
//   import { surface as feedSurface } from '../surfaces/feed/index.js';
//   ...
//   feedSurface,
//
// `apps/web/src/surfaces/<surface>/index.ts` exports `surface: SurfaceModule` (types.ts): its
// pages (path, title, nav placement, roles, lazy component), optional `errorMessages` and optional
// `evidenceRoutes`. Order matters only for ties in nav `order` and for duplicate paths (the first
// wins; registry.test.ts fails on any duplicate). The server authorizes every call regardless of
// `roles`, which only decides what a role is shown.
import { shellSurface } from './shellSurface.js';
import type { SurfaceModule } from './types.js';

export type { NavSection, PageDef, PageNav, SurfaceModule } from './types.js';

export const surfaces: SurfaceModule[] = [
  shellSurface,
  // registry: add new entries above this line
];
