// Every page of the web page registry (apps/web/src/shell/registry.ts) and the roles that can see
// it, for the accessibility sweep. src/shell/a11yCoverage.test.ts fails when a registry page is
// missing here or its roles differ, so a new page cannot skip the sweep.
// Plain data: no imports from src (the Playwright runner does not load the React app).

export const ROLES = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const;
export type Role = (typeof ROLES)[number];

export interface SweepIds {
  contactId: string;
  dealId: string;
  listingId: string;
  playbookId: string;
  importId: string;
}

export interface SweepPage {
  /** the registry path pattern, exactly as registered */
  path: string;
  roles: readonly Role[];
  /** the concrete URL to open */
  url(ids: SweepIds): string;
  /**
   * The surface is being changed by another lane: violations there are reported (annotations and the
   * JSON report), not failed. No page is marked today; lane a11y-optout-surfaces took back feed,
   * approvals, contact and thread (with compose).
   */
  foreignLane?: true;
}

const ALL = ROLES;
const ADMINS = ['owner', 'admin'] as const;
const NOT_TC = ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const;
const LEADS = ['owner', 'admin', 'team_lead'] as const;
const at = (u: string) => () => u;

export const SWEEP_PAGES: readonly SweepPage[] = [
  { path: '/', roles: ALL, url: at('/') },
  { path: '/account', roles: ALL, url: at('/account') },
  { path: '/more', roles: ALL, url: at('/more') },
  { path: '/approvals', roles: ALL, url: at('/approvals') },
  { path: '/search', roles: ALL, url: at('/search?q=jane') },
  { path: '/tasks', roles: ALL, url: at('/tasks') },
  { path: '/pond', roles: NOT_TC, url: at('/pond') },
  { path: '/deals', roles: ALL, url: at('/deals') },
  { path: '/deals/:dealId', roles: ALL, url: (i) => `/deals/${i.dealId}` },
  { path: '/listings', roles: ALL, url: at('/listings') },
  { path: '/listings/:listingId', roles: ALL, url: (i) => `/listings/${i.listingId}` },
  { path: '/contacts/:contactId', roles: ALL, url: (i) => `/contacts/${i.contactId}` },
  { path: '/contacts/:contactId/thread', roles: ALL, url: (i) => `/contacts/${i.contactId}/thread?compose=sms` },
  { path: '/team', roles: LEADS, url: at('/team') },
  { path: '/team/scoreboard', roles: NOT_TC, url: at('/team/scoreboard') },
  { path: '/admin/members', roles: ADMINS, url: at('/admin/members') },
  { path: '/admin/routing', roles: ADMINS, url: at('/admin/routing') },
  { path: '/admin/numbers', roles: ADMINS, url: at('/admin/numbers') },
  { path: '/admin/erasure', roles: ADMINS, url: (ids) => `/admin/erasure?contact=${ids.contactId}` },
  { path: '/admin/system', roles: ADMINS, url: at('/admin/system') },
  { path: '/settings/playbooks', roles: NOT_TC, url: at('/settings/playbooks') },
  { path: '/settings/playbooks/:playbookId', roles: NOT_TC, url: (i) => `/settings/playbooks/${i.playbookId}` },
  { path: '/settings/compliance', roles: ADMINS, url: at('/settings/compliance') },
  { path: '/settings/team', roles: ADMINS, url: at('/settings/team') },
  { path: '/imports', roles: ADMINS, url: at('/imports') },
  { path: '/imports/:importId', roles: ADMINS, url: (i) => `/imports/${i.importId}` },
  // parity module 61 (lane par-lists)
  { path: '/people', roles: ALL, url: at('/people') },
  { path: '/people/work/:contactId', roles: ALL, url: (i) => `/people/work/${i.contactId}` },
  { path: '/admin/tags', roles: ADMINS, url: at('/admin/tags') },
  { path: '/admin/fields', roles: ADMINS, url: at('/admin/fields') },
  { path: '/admin/stage-labels', roles: ADMINS, url: at('/admin/stage-labels') },
];

/** Screens outside the app frame (signed out). */
export const SIGNED_OUT_PAGES: readonly { url: string; h1: string }[] = [
  { url: '/login', h1: 'Sign in' },
  { url: '/signup', h1: 'Create your team' },
  { url: '/forgot-password', h1: 'Reset your password' },
  { url: '/reset-password?token=x', h1: 'Choose a new password' },
  { url: '/invite/x', h1: 'Join your team' },
];
