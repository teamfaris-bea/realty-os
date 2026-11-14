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
  duplicateId: string;
  /** module 72: one CMA draft of the agent's seller (Owner, Admin and Team Lead read it) */
  cmaId: string;
  /** module 55: a clean purchase contract on the deal, uploaded by the agent */
  documentId: string;
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
  { path: '/duplicates', roles: NOT_TC, url: at('/duplicates') },
  { path: '/duplicates/:duplicateId', roles: NOT_TC, url: (i) => `/duplicates/${i.duplicateId}` },
  { path: '/deals', roles: ALL, url: at('/deals') },
  { path: '/deals/:dealId', roles: ALL, url: (i) => `/deals/${i.dealId}` },
  { path: '/listings', roles: ALL, url: at('/listings') },
  { path: '/listings/:listingId', roles: ALL, url: (i) => `/listings/${i.listingId}` },
  // module 38 (lane 2C marketing)
  { path: '/listings/:listingId/marketing', roles: ALL, url: (i) => `/listings/${i.listingId}/marketing` },
  { path: '/contacts/:contactId', roles: ALL, url: (i) => `/contacts/${i.contactId}` },
  { path: '/people/new', roles: NOT_TC, url: at('/people/new') },
  { path: '/contacts/:contactId/thread', roles: ALL, url: (i) => `/contacts/${i.contactId}/thread?compose=sms` },
  { path: '/team', roles: LEADS, url: at('/team') },
  { path: '/team/scoreboard', roles: NOT_TC, url: at('/team/scoreboard') },
  { path: '/team/lead-email', roles: LEADS, url: at('/team/lead-email') },
  { path: '/admin/members', roles: ADMINS, url: at('/admin/members') },
  { path: '/admin/routing', roles: ADMINS, url: at('/admin/routing') },
  // module 22 Lead sources (lane lead-intake). The sweep's world has no source id in SweepIds, so the detail is opened
  // for an id that does not exist (its "doesn't exist" state); e2e/lead-sources/journey.spec.ts sweeps a real one.
  { path: '/admin/lead-sources', roles: ADMINS, url: at('/admin/lead-sources') },
  { path: '/admin/lead-sources/:sourceId', roles: ADMINS, url: at('/admin/lead-sources/00000000-0000-7000-8000-000000000000') },
  { path: '/admin/numbers', roles: ADMINS, url: at('/admin/numbers') },
  { path: '/admin/erasure', roles: ADMINS, url: (ids) => `/admin/erasure?contact=${ids.contactId}` },
  { path: '/admin/system', roles: ADMINS, url: at('/admin/system') },
  { path: '/admin/ai-answering', roles: ADMINS, url: at('/admin/ai-answering') },
  { path: '/admin/integrations/mls', roles: ADMINS, url: at('/admin/integrations/mls') },
  // module 41 (lane admin-pages)
  { path: '/admin/integrations', roles: ADMINS, url: at('/admin/integrations') },
  { path: '/admin/web-chat', roles: ADMINS, url: at('/admin/web-chat') },
  { path: '/settings/playbooks', roles: NOT_TC, url: at('/settings/playbooks') },
  { path: '/settings/playbooks/:playbookId', roles: NOT_TC, url: (i) => `/settings/playbooks/${i.playbookId}` },
  { path: '/settings/compliance', roles: ADMINS, url: at('/settings/compliance') },
  // parity module 64 (lane par-templates-bulk)
  { path: '/templates', roles: ALL, url: at('/templates') },
  { path: '/bulk', roles: NOT_TC, url: at('/bulk') },
  { path: '/bulk/new', roles: NOT_TC, url: (i) => `/bulk/new?kind=email&contacts=${i.contactId}` },
  { path: '/bulk/:bulkId', roles: NOT_TC, url: at('/bulk/00000000-0000-7000-8000-000000000000') },
  { path: '/settings/batch-text', roles: ADMINS, url: at('/settings/batch-text') },
  { path: '/settings/team', roles: ADMINS, url: at('/settings/team') },
  { path: '/imports', roles: ADMINS, url: at('/imports') },
  { path: '/imports/:importId', roles: ADMINS, url: (i) => `/imports/${i.importId}` },
  // parity module 61 (lane par-lists)
  { path: '/people', roles: ALL, url: at('/people') },
  { path: '/people/work/:contactId', roles: ALL, url: (i) => `/people/work/${i.contactId}` },
  { path: '/admin/tags', roles: ADMINS, url: at('/admin/tags') },
  { path: '/admin/fields', roles: ADMINS, url: at('/admin/fields') },
  { path: '/admin/stage-labels', roles: ADMINS, url: at('/admin/stage-labels') },
  // module 69 (web/mail-sync, D2)
  { path: '/settings/mail', roles: ALL, url: at('/settings/mail') },
  { path: '/admin/mail', roles: ADMINS, url: at('/admin/mail') },
  // module 41's calendar page (lane calendar)
  { path: '/settings/calendar', roles: ALL, url: at('/settings/calendar') },
  // module 40 (lane insights)
  { path: '/owner', roles: ADMINS, url: at('/owner') },
  { path: '/plan', roles: ALL, url: at('/plan') },
  { path: '/plan/:week', roles: ALL, url: at('/plan/2026-W46') },
  { path: '/goals', roles: ALL, url: at('/goals') },
  // module 40/41 (coaching): the daily fix page (every role that takes calls) and the coaching settings (the Owner's;
  // an Admin can only turn call reviews off, E283)
  { path: '/coaching', roles: NOT_TC, url: at('/coaching') },
  { path: '/admin/coaching', roles: ADMINS, url: at('/admin/coaching') },
  // module 39 (TC board) and module 41 (milestone templates)
  { path: '/transactions', roles: ALL, url: at('/transactions') },
  { path: '/admin/milestone-templates', roles: ADMINS, url: at('/admin/milestone-templates') },
  // module 76 (AI ISA web): Under AI care, My AI assistant (never TC or the human ISA role) and the team switch
  { path: '/ai-care', roles: NOT_TC, url: at('/ai-care') },
  { path: '/settings/ai-assistant', roles: ['owner', 'admin', 'team_lead', 'agent'], url: at('/settings/ai-assistant') },
  { path: '/settings/ai-assistant/team', roles: ADMINS, url: at('/settings/ai-assistant/team') },
  // module 72 (web/cma, lane V2-A): the roles with cma.prepare
  { path: '/cma/:cmaId', roles: ['owner', 'admin', 'team_lead', 'agent'], url: (i) => `/cma/${i.cmaId}` },
  // module 55 (lane phase3-staff): the document page (a TC or ISA off the deal sees its not-available state)
  { path: '/documents/:documentId', roles: ALL, url: (i) => `/documents/${i.documentId}` },
  { path: '/documents/:documentId/dates', roles: ALL, url: (i) => `/documents/${i.documentId}/dates` },
  // module 55 (lane phase3-staff): the Google Ads page (the sweep's tenant has platform:ads uncleared: its dark state)
  { path: '/ads', roles: ADMINS, url: at('/ads') },
  // module 55 item 12: Google Business Profile (every staff role reads reviews; the sweep's world has platform:gbp
  // uncleared, so it sweeps the honest dark state)
  { path: '/gbp', roles: ALL, url: at('/gbp') },
  // module 55 (phase3-staff): Likely to move (the sweep world has no approved model: the no_model sentence)
  { path: '/likely', roles: NOT_TC, url: at('/likely') },
  // module 55 (phase3-staff): Coaching trends (the sweep world shows whatever state its settings give: a state sentence or counts)
  { path: '/coaching/trends', roles: NOT_TC, url: at('/coaching/trends') },
  // module 46 (web/portal): What the client sees, for a grant that does not exist (its not-found state); the portal
  // e2e (e2e/portal/a11y.spec.ts) sweeps a real preview, visible and not
  { path: '/client-portal/:grantId', roles: ['owner', 'admin', 'team_lead', 'agent', 'tc'], url: at('/client-portal/00000000-0000-7000-8000-000000000000') },
];

/** Screens outside the app frame (signed out). */
export const SIGNED_OUT_PAGES: readonly { url: string; h1: string; widget?: 'closed' | 'open' }[] = [
  { url: '/login', h1: 'Sign in' },
  { url: '/signup', h1: 'Create your team' },
  { url: '/forgot-password', h1: 'Reset your password' },
  { url: '/reset-password?token=x', h1: 'Choose a new password' },
  { url: '/invite/x', h1: 'Join your team' },
  // module 37: the website chat widget (a separate bundle) on its stand-in brokerage page, closed and open, with the
  // seeded widget's key (signedOutUrl fills it in), talking to module 22's real public chat routes
  { url: '/src/widget/preview.html?key=:widgetKey', h1: 'Chat widget preview', widget: 'closed' },
  { url: '/src/widget/preview.html?key=:widgetKey#realty-chat-open', h1: 'Chat widget preview', widget: 'open' },
  // module 46: the client portal (a separate entry), signed out, with a team slug
  { url: '/portal.html?team=harbor', h1: 'Sign in to your client portal' },
];

/** A signed-out page's address, with the seeded widget key where it names one. */
export const signedOutUrl = (p: { url: string }, widgetKey: string): string => p.url.replace(':widgetKey', encodeURIComponent(widgetKey));
