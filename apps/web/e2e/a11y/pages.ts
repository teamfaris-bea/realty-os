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
   * The surface is being changed by another lane (lane/optout-visibility owns contact, thread,
   * compose, approvals and feed). Violations there are reported, not fixed, in this lane.
   */
  foreignLane?: true;
}

const ALL = ROLES;
const ADMINS = ['owner', 'admin'] as const;
const NOT_TC = ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const;
const LEADS = ['owner', 'admin', 'team_lead'] as const;
const at = (u: string) => () => u;

export const SWEEP_PAGES: readonly SweepPage[] = [
  { path: '/', roles: ALL, url: at('/'), foreignLane: true },
  { path: '/account', roles: ALL, url: at('/account') },
  { path: '/more', roles: ALL, url: at('/more') },
  { path: '/approvals', roles: ALL, url: at('/approvals'), foreignLane: true },
  { path: '/search', roles: ALL, url: at('/search?q=jane') },
  { path: '/tasks', roles: ALL, url: at('/tasks') },
  { path: '/pond', roles: NOT_TC, url: at('/pond') },
  { path: '/deals', roles: ALL, url: at('/deals') },
  { path: '/deals/:dealId', roles: ALL, url: (i) => `/deals/${i.dealId}` },
  { path: '/listings', roles: ALL, url: at('/listings') },
  { path: '/listings/:listingId', roles: ALL, url: (i) => `/listings/${i.listingId}` },
  { path: '/contacts/:contactId', roles: ALL, url: (i) => `/contacts/${i.contactId}`, foreignLane: true },
  { path: '/contacts/:contactId/thread', roles: ALL, url: (i) => `/contacts/${i.contactId}/thread?compose=sms`, foreignLane: true },
  { path: '/team', roles: LEADS, url: at('/team') },
  { path: '/team/scoreboard', roles: NOT_TC, url: at('/team/scoreboard') },
  { path: '/admin/members', roles: ADMINS, url: at('/admin/members') },
  { path: '/admin/routing', roles: ADMINS, url: at('/admin/routing') },
  { path: '/admin/numbers', roles: ADMINS, url: at('/admin/numbers') },
  { path: '/settings/playbooks', roles: NOT_TC, url: at('/settings/playbooks') },
  { path: '/settings/playbooks/:playbookId', roles: NOT_TC, url: (i) => `/settings/playbooks/${i.playbookId}` },
  { path: '/settings/compliance', roles: ADMINS, url: at('/settings/compliance') },
  { path: '/settings/team', roles: ADMINS, url: at('/settings/team') },
  { path: '/imports', roles: ADMINS, url: at('/imports') },
  { path: '/imports/:importId', roles: ADMINS, url: (i) => `/imports/${i.importId}` },
];

/** Screens outside the app frame (signed out). */
export const SIGNED_OUT_PAGES: readonly { url: string; h1: string }[] = [
  { url: '/login', h1: 'Sign in' },
  { url: '/signup', h1: 'Create your team' },
  { url: '/forgot-password', h1: 'Reset your password' },
  { url: '/reset-password?token=x', h1: 'Choose a new password' },
  { url: '/invite/x', h1: 'Join your team' },
];
