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
import { surface as feedSurface } from '../surfaces/feed/index.js';
import { surface as approvalsSurface } from '../surfaces/approvals/index.js';
import { surface as searchSurface } from '../surfaces/search/index.js';
import { surface as tasksSurface } from '../surfaces/tasks/index.js';
import { surface as pondSurface } from '../surfaces/pond/index.js';
import { surface as dealsSurface } from '../surfaces/deals/index.js';
import { surface as listingsSurface } from '../surfaces/listings/index.js';
import { surface as contactSurface } from '../surfaces/contact/index.js';
import { surface as threadSurface } from '../surfaces/thread/index.js';
import { surface as composeSurface } from '../surfaces/compose/index.js';
import { surface as teamSurface } from '../surfaces/team/index.js';
import { surface as adminSurface } from '../surfaces/admin/index.js';
import { surface as settingsSurface } from '../surfaces/settings/index.js';
import { surface as importsSurface } from '../surfaces/imports/index.js';
import { surface as integrationsSurface } from '../surfaces/integrations/index.js';
import { surface as peopleEditSurface } from '../surfaces/people-edit/index.js';
import { surface as duplicatesSurface } from '../surfaces/duplicates/index.js';
import { surface as peopleSurface } from '../surfaces/people/index.js';
import { surface as adminParitySurface } from '../surfaces/admin/parity/index.js';
import { surface as templatesSurface } from '../surfaces/templates/index.js';
import { surface as bulkSurface } from '../surfaces/bulk/index.js';
import { surface as batchTextSurface } from '../surfaces/settings/batch-text/index.js';
import { surface as leadEmailSurface } from '../surfaces/lead-email/index.js';
import { surface as mailSettingsSurface } from '../surfaces/settings/mail/index.js';
import { surface as adminMailSurface } from '../surfaces/admin/mail/index.js';
import { surface as marketingSurface } from '../surfaces/marketing/index.js';

export type { NavSection, PageDef, PageNav, SurfaceModule } from './types.js';

export const surfaces: SurfaceModule[] = [
  shellSurface,
  feedSurface,
  approvalsSurface,
  searchSurface,
  tasksSurface,
  pondSurface,
  dealsSurface,
  listingsSurface,
  contactSurface,
  threadSurface,
  composeSurface,
  teamSurface,
  adminSurface,
  settingsSurface,
  importsSurface,
  integrationsSurface,
  peopleEditSurface,
  duplicatesSurface,
  peopleSurface,
  adminParitySurface,
  templatesSurface,
  bulkSurface,
  batchTextSurface,
  leadEmailSurface,
  mailSettingsSurface,
  adminMailSurface,
  marketingSurface,
  // registry: add new entries above this line
];
