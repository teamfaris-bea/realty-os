// Fixtures for the Lead sources component tests (imported by *.test.tsx only). Shapes follow
// apps/api/src/leads/sourcesSchemas.ts and the Google lead form API. The whole app is mounted on a scripted fetch with
// the agent, lead-admin, lead-email and lead-sources surfaces (lead-email/testing.tsx's table), so routes, re-auth and
// error sentences are the real ones.
import { FakeFetch } from '../../shell/testing/fakeApi.js';
import { member } from '../admin/lib/testing.js';
import type { PhoneNumber } from '../admin/lib/types.js';
import { leadEmailApp } from '../lead-email/testing.js';
import type { ImportLabelView } from './reviewWords.js';
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
    .on('GET /lead-sources/import-labels', { status: 200, body: { labels: [], canChange: false } })
    .on('GET /lead-sources', { status: 200, body: { sources: o.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, active: s.active, hasToken: s.paths.webhook.hasToken, createdAt: s.createdAt })) } });
  for (const s of o.sources) f.on(`GET /lead-sources/${s.id}/google-lead-form`, { status: 200, body: googleForm({ state: s.paths.googleLeadForm.state, sourceHasConsentText: s.hasConsentText }) });
  return f;
}

export const sourcesApp = leadEmailApp;
export { FakeFetch };
export { err } from '../../shell/testing/fakeApi.js';

// ---- the source review (R-LSRC-10): rows as the API sends them ----

const people = (n: number): string => (n === 1 ? '1 person' : `${n} people`);
const SETTING = 'No automated contact for leads from this source';

/**
 * The API's own sentence for a review row (apps/api/src/leads/importLabels.ts importLabelSentence and unlabeledSentence,
 * word for word), so the web tests hold the real contract. `where` is how a no-label row names its import.
 */
export function reviewSentence(r: Pick<ImportLabelView, 'label' | 'unlabeledImportId' | 'people' | 'state' | 'leadSourceName' | 'noAutomatedContact' | 'suggestion'>, where = 'this import'): string {
  if (r.unlabeledImportId) {
    const who = `No source label in ${where} (${people(r.people)})`;
    if (r.state !== 'mapped') return `${who}: not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.`;
    return r.noAutomatedContact ? `${who}: counted as ${r.leadSourceName}, which has "${SETTING}" on, so nothing automatic reaches them.` : `${who}: counted as ${r.leadSourceName}.`;
  }
  const who = `"${r.label}" (${people(r.people)})`;
  const inReview = 'Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.';
  if (r.state === 'mapped') return r.noAutomatedContact ? `${who}: mapped to ${r.leadSourceName}, which has "${SETTING}" on, so nothing automatic reaches them.` : `${who}: mapped to ${r.leadSourceName}.`;
  if (r.state === 'suggested' && r.suggestion) {
    const n = r.suggestion.leadSourceName;
    return `${who}: not reviewed yet. It reads the same as the lead source ${n}, or a label already mapped to it, apart from capital letters and spaces around it, so ${n} is suggested. Nothing is mapped until the Owner confirms it${r.suggestion.noAutomatedContact ? ` (${n} has "${SETTING}" on)` : ''}, and nothing automatic goes to the people imported with it until then.`;
  }
  if (r.state === 'ambiguous') return `${who}: not reviewed yet. It reads the same as more than one lead source, so none is suggested. ${inReview}`;
  return `${who}: not reviewed yet. ${inReview}`;
}

/** One review row with the API's sentence for its state. `mappedTo` and `suggest` name a lead source. */
export function labelRow(
  label: string,
  o: Partial<Omit<ImportLabelView, 'label' | 'sentence' | 'suggestion' | 'leadSourceId' | 'leadSourceName' | 'noAutomatedContact' | 'inReview'>> & {
    mappedTo?: { id: string; name: string; noAiCare?: boolean };
    suggest?: { id: string; name: string; noAiCare?: boolean };
    where?: string;
  } = {},
): ImportLabelView {
  const { mappedTo, suggest, where, ...rest } = o;
  const state: ImportLabelView['state'] = rest.state ?? (mappedTo ? 'mapped' : suggest ? 'suggested' : 'in_review');
  const row = {
    id: null,
    label,
    unlabeledImportId: null,
    people: 1,
    committedPeople: 0,
    firstSeen: null,
    changedBy: null,
    changedAt: null,
    ...rest,
    state,
    leadSourceId: mappedTo?.id ?? null,
    leadSourceName: mappedTo?.name ?? null,
    noAutomatedContact: mappedTo?.noAiCare === true,
    inReview: state !== 'mapped',
    suggestion: state === 'suggested' && suggest ? { leadSourceId: suggest.id, leadSourceName: suggest.name, noAutomatedContact: suggest.noAiCare === true } : null,
  };
  return { ...row, sentence: reviewSentence(row, where) };
}
