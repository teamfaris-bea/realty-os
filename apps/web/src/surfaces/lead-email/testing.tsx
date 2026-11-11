// Fixtures for the lead-email component tests (imported by *.test.tsx only). Shapes follow the API
// response schemas (apps/api/src/leadEmail/routes.ts). The whole app is mounted on a scripted fetch with
// the agent, lead-admin and lead-email surfaces, so re-auth, routes and error sentences are the real ones.
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { AGENT_SURFACES } from '../feed/lib/testing.js';
import { LEAD_ADMIN_SURFACES, type TestRole } from '../admin/lib/testing.js';
import { surface as leadEmailSurface } from './index.js';
import type { Inbox, ReviewItem } from './types.js';

export const leadEmailTable = () => tableWith(...AGENT_SURFACES, ...LEAD_ADMIN_SURFACES, leadEmailSurface);

export const SRC = '01900000-0000-7000-8000-00000000500a';
export const KEY = 'ab'.repeat(20);
export const ADDRESS = `leads+${KEY}@leads.realty-os.invalid`;
/** What the API suggests (apps/api/src/leadEmail/trust.ts SUGGESTED_SENDER_DOMAINS): the portal's name only. */
export const SUGGESTED = [
  { domain: 'zillow.com', label: 'Zillow' },
  { domain: 'realtor.com', label: 'Realtor.com' },
];

export function inbox(over: Partial<Inbox> = {}): Inbox {
  return {
    leadSourceId: SRC,
    enabled: false,
    connectionId: null,
    status: null,
    address: null,
    addressCreatedAt: null,
    allowedSenderDomains: [],
    suggestedSenderDomains: SUGGESTED,
    inboundDomainConfigured: true,
    ...over,
  };
}

export function enabledInbox(over: Partial<Inbox> = {}): Inbox {
  return inbox({ enabled: true, connectionId: '01900000-0000-7000-8000-00000000c0aa', status: 'connected', address: ADDRESS, addressCreatedAt: '2026-11-10T17:00:00.000Z', allowedSenderDomains: ['zillow.com', 'realtor.com'], ...over });
}

const span = (start: number, end: number) => ({ start, end });

export function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: '01900000-0000-7000-8000-0000000e1001',
    receivedAt: '2026-11-11T15:00:00.000Z',
    leadSourceId: SRC,
    leadSourceName: 'Portal',
    status: 'needs_review',
    holdCode: 'DKIM_UNALIGNED',
    holdSentence: 'The email was signed by a different domain than the one it says it is from, so it may not really be from the portal.',
    senderDomain: 'zillow.com',
    dkimPassDomains: ['mailer.example.test'],
    parserKind: 'zillow',
    subject: 'New lead for 12 Elm St',
    text: 'You have a new lead.\n\nName: Dana Field\nEmail: dana@example.test\nPhone: (415) 555-0134\nProperty: 12 Elm St\nMessage: Can I tour Saturday?',
    fields: {
      name: { value: 'Dana Field', span: span(28, 38) },
      phones: [{ value: '(415) 555-0134', span: span(73, 87) }],
      emails: [{ value: 'dana@example.test', span: span(46, 63) }],
      message: { value: 'Can I tour Saturday?', span: span(119, 139) },
      property: { value: '12 Elm St', span: span(98, 107) },
      listingId: null,
      leadType: 'buy',
    },
    canAccept: true,
    contactId: null,
    decidedAt: null,
    ...over,
  };
}

export function leadEmailApp(fake: FakeFetch, path: string, role: TestRole = 'owner', o: { reauthenticatedAt?: string | null } = {}) {
  const s = sessionFixture({ reauthenticatedAt: o.reauthenticatedAt ?? null });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: leadEmailTable() });
}

export { FakeFetch };
export { err } from '../../shell/testing/fakeApi.js';
