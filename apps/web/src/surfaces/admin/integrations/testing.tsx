// Mounting and fixtures for the module 41 admin page tests (Integrations, MLS, Website chat; imported by
// *.test.tsx only). The whole app is mounted (shell providers, nav, the role gate, the re-auth prompt) on a
// scripted fetch, with only the admin surfaces in the page table.
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { ApiClient, App, buildRoutes, createQueryClient } from '../../../shell/index.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { surface as mlsSurface } from '../../integrations/index.js';
import { surface as adminSurface } from '../index.js';
import { surface as webChatSurface } from '../webchat/index.js';
import { surface as integrationsSurface } from './index.js';

export type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
export const NOT_ADMINS = ['team_lead', 'agent', 'isa', 'tc'] as const;

export function mount(fake: FakeFetch, path: string, role: Role = 'owner') {
  const s = sessionFixture({ reauthenticatedAt: new Date().toISOString() });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  const table = tableWith(adminSurface, integrationsSurface, webChatSurface, mlsSurface);
  const api = new ApiClient({ fetch: fake.fetch });
  const router = createMemoryRouter(buildRoutes(table), { initialEntries: [path] });
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false, staleTime: Infinity } });
  render(
    <StrictMode>
      <App api={api} table={table} router={router} queryClient={qc} />
    </StrictMode>,
  );
  return { router, qc };
}

/** The shell's password prompt answers yes. */
export const reauthOk = { status: 200, body: { session: sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, reauthenticatedAt: new Date().toISOString() }) } };

export async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

export const ID = {
  fb: '01900000-0000-7000-8000-00000000f001',
  gbp: '01900000-0000-7000-8000-00000000f002',
  messenger: '01900000-0000-7000-8000-00000000f003',
  mls: '01900000-0000-7000-8000-00000000f004',
  widget: '01900000-0000-7000-8000-00000000f005',
  widget2: '01900000-0000-7000-8000-00000000f006',
  source: '01900000-0000-7000-8000-00000000f007',
  source2: '01900000-0000-7000-8000-00000000f008',
  disclosure: '01900000-0000-7000-8000-00000000f009',
} as const;

const conn = (over: Record<string, unknown>) => ({
  id: ID.fb,
  kind: 'facebook_page',
  displayName: 'Harbor Facebook Page',
  status: 'connected',
  statusSentence: 'Connected.',
  externalAccountId: 'page-1',
  leadSourceId: null,
  capabilities: [],
  lastErrorCode: null,
  connectedAt: '2026-11-01T10:00:00.000Z',
  disconnectedAt: null,
  ...over,
});

/** GET /admin/integrations as the API answers on the test adapters (every service in the API catalog). */
export function integrations(o: { messengerRow?: 'live' | 'disconnected' | null; packsReviewed?: boolean; mode?: 'fake' | 'unconfigured' | 'real'; fbCapability?: { available: boolean; reason: string | null } } = {}) {
  const svc = (kind: string, name: string, connect: string, sentence: string, connections: unknown[] = []) => ({ kind, name, connect, canConnect: connect === 'oauth', sentence, connections });
  const notOffered = 'Not offered: the owner has taken this out of scope.';
  return {
    adapterMode: o.mode ?? 'fake',
    services: [
      svc('facebook_page', 'Facebook Page (publishing)', 'oauth', 'Test adapter: connects to a simulated account only.', [
        conn({ capabilities: [{ name: 'publish_posts', ...(o.fbCapability ?? { available: false, reason: 'Waits for counsel review of platform:fair_housing.' }) }] }),
      ]),
      svc('instagram_business', 'Instagram business account (publishing)', 'oauth', 'Test adapter: connects to a simulated account only.'),
      svc('web_chat_widget', 'Website chat', 'keyed', 'Set up from the inbox settings; it has no outside account to connect.'),
      svc('lead_email', 'Lead email inbox', 'keyed', 'Set up from the inbox settings; it has no outside account to connect.'),
      svc('zillow_feed', 'Zillow lead feed', 'partner', 'Needs partner access: Zillow lead feed has not granted this platform API access yet. Leads still arrive by email forwarding where the service offers it.'),
      svc('realtor_feed', 'realtor.com lead feed', 'partner', 'Needs partner access: realtor.com lead feed has not granted this platform API access yet. Leads still arrive by email forwarding where the service offers it.'),
      svc('mls_feed', 'MLS listings (Spark, read-only)', 'api_key', 'Demo data only (test adapter); no real MLS account is connected.'),
      svc('showing_service', 'Showing service', 'partner', 'Demo data only (test adapter); no real partner account is connected.'),
      svc('ads_google', 'Google Ads account', 'later', 'Arrives with ads (Phase 3); it cannot be connected yet.'),
      svc('gbp_location', 'Google Business Profile', 'oauth', 'Test adapter: connects to a simulated account only.', [
        conn({ id: ID.gbp, kind: 'gbp_location', displayName: 'Harbor GBP', status: 'degraded', statusSentence: 'Connected with problems (PROVIDER_ERRORS). Some messages may be delayed.' }),
      ]),
      svc(
        'messenger_page',
        'Facebook Messenger',
        'out_of_scope',
        notOffered,
        o.messengerRow ? [conn({ id: ID.messenger, kind: 'messenger_page', displayName: 'Old Messenger page', status: o.messengerRow === 'live' ? 'connected' : 'disconnected', statusSentence: 'Connected.' })] : [],
      ),
      svc('instagram_account', 'Instagram direct messages', 'out_of_scope', notOffered),
      svc('meta_lead_ads', 'Meta Lead Ads', 'out_of_scope', notOffered),
      svc('ads_meta', 'Meta ads account', 'out_of_scope', notOffered),
    ],
    platformPacks: [
      { key: 'platform:meta', version: 'v1', reviewed: false, sentence: 'Meta messaging: not offered (owner decision D2); nothing waits on this pack and it is never cleared (pack v1).' },
      { key: 'platform:fair_housing', version: 'v1', reviewed: o.packsReviewed ?? false, sentence: o.packsReviewed ? 'Publishing marketing: cleared by counsel on 2026-11-01 (pack v1).' : 'Publishing marketing stays off: awaiting counsel review (pack v1, not yet reviewed).' },
      { key: 'platform:gmail', version: 'v1', reviewed: o.packsReviewed ?? false, sentence: o.packsReviewed ? 'Gmail inbox sync stays off: counsel reviewed it on 2026-11-01; it also waits for the vendor check (pack v1).' : 'Gmail inbox sync stays off: awaiting counsel review and the vendor check (pack v1, not yet reviewed).' },
    ],
    perUser: [{ key: 'google_calendar', name: 'Google Calendar', sentence: 'Each person connects their own calendar from their settings.' }],
  };
}

export { FakeFetch, err };
