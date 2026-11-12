// Fixtures for the Lead sources component tests (imported by *.test.tsx only). Shapes follow
// apps/api/src/leads/sourcesSchemas.ts and the Google lead form API. The whole app is mounted on a scripted fetch with
// the agent, lead-admin, lead-email and lead-sources surfaces (lead-email/testing.tsx's table), so routes, re-auth and
// error sentences are the real ones.
import { FakeFetch } from '../../shell/testing/fakeApi.js';
import { member } from '../admin/lib/testing.js';
import type { PhoneNumber } from '../admin/lib/types.js';
import { leadEmailApp } from '../lead-email/testing.js';
import type { GoogleLeadForm, OverviewResponse, SourceOverview } from './types.js';

export const S1 = '01900000-0000-7000-8000-00000000510a';
export const S2 = '01900000-0000-7000-8000-00000000510b';
export const ADDR = `leads+${'ab'.repeat(20)}@leads.realty-os.invalid`;
export const HOOK_URL = 'https://realty.example.test/api/webhooks/google-lead-form';
export const GKEY = 'gk_' + 'c'.repeat(40);

export function source(over: Omit<Partial<SourceOverview>, 'paths'> & { paths?: Partial<SourceOverview['paths']> } = {}): SourceOverview {
  const { paths, ...rest } = over;
  return {
    id: S1,
    name: 'Zillow',
    kind: 'portal',
    active: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    offSince: null,
    lastLeadAt: null,
    leadsLast30Days: 0,
    heldEmails: 0,
    forwardingConfirmations: 0,
    skippedWhileOffLast30Days: 0,
    hasConsentText: false,
    ...rest,
    paths: {
      email: { state: 'off', address: null, lastEmailAt: null },
      webhook: { hasToken: true, ownSecret: false, secretCreatedAt: null },
      googleLeadForm: { state: 'off', createdAt: null, inquiryType: null, citesSourceDisclosure: null, lastTestAt: null, lastUnreadableAt: null, unreadableCount: 0 },
      trackingNumbers: [],
      partnerFeeds: [],
      webChats: [],
      ...paths,
    },
  };
}

export function overview(sources: SourceOverview[], deployment: Partial<OverviewResponse['deployment']> = {}): OverviewResponse {
  return { sources, deployment: { inboundEmail: true, publicHttps: true, telephony: 'live', ...deployment } };
}

export function googleForm(over: Partial<GoogleLeadForm> = {}): GoogleLeadForm {
  return { state: 'off', webhookUrl: HOOK_URL, key: null, createdAt: null, inquiryType: null, citesSourceDisclosure: null, lastTestAt: null, lastLeadAt: null, lastUnreadableAt: null, unreadableCount: 0, sourceHasConsentText: false, ...over };
}

export function phone(over: Partial<PhoneNumber> = {}): PhoneNumber {
  return { id: 'n1', e164: '+14155550100', purpose: 'tracking', numberType: 'local', assignedUserId: null, registrationId: null, registrationStatus: null, smsCapable: true, voiceCapable: true, releasedAt: null, leadSourceId: null, ...over };
}

/** A fake with the overview and quiet defaults for the reads every source page makes. */
export function sourcesFake(o: OverviewResponse = overview([source()])): FakeFetch {
  const f = new FakeFetch()
    .on('GET /lead-sources/overview', { status: 200, body: o })
    .on('GET /numbers', { status: 200, body: { numbers: [] } })
    .on('GET /members', { status: 200, body: { members: [member()], invites: [] } })
    .on('GET /lead-sources', { status: 200, body: { sources: o.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, active: s.active, hasToken: s.paths.webhook.hasToken, createdAt: s.createdAt })) } });
  for (const s of o.sources) f.on(`GET /lead-sources/${s.id}/google-lead-form`, { status: 200, body: googleForm({ state: s.paths.googleLeadForm.state, sourceHasConsentText: s.hasConsentText }) });
  return f;
}

export const sourcesApp = leadEmailApp;
export { FakeFetch };
export { err } from '../../shell/testing/fakeApi.js';
