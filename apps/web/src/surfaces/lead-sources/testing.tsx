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

/** How an import's own row counts its people, as the API does (leads/importLabels.ts InThisImport). */
export interface InThisImport {
  /** a Follow Up Boss account is "this import"; a CSV or an export is a file (default: a file) */
  kind?: 'csv' | 'fub_api' | 'fub_export';
  matchedOnly: number;
  /** the contacts are not imported yet: a row can still be attached to the person it matched */
  open: boolean;
}

/** E755: the API's sentence for an import's own row mapped to a marked source (leads/importLabels.ts inThisImportSentence, word for word). */
function inThisImportSentence(head: string, n: number, committed: number, f: InThisImport, because: string, thisMapping: string): string {
  const from = f.kind === 'fub_api' ? 'by this import' : 'from this file';
  const where = f.kind === 'fub_api' ? 'in this import' : 'in this file';
  const rest = Math.max(0, n - committed - f.matchedOnly);
  const out = [`${head}: ${people(n)} ${where}.`];
  if (committed > 0) out.push(`${committed} ${committed === 1 ? 'was' : 'were'} imported or attached and ${committed === 1 ? 'gets' : 'get'} no automated contact, because ${because}.`);
  else out.push(`${f.open ? `None has been imported ${from} yet` : `None is imported ${from}`}. ${because.charAt(0).toUpperCase()}${because.slice(1)}: that covers a person once their row is imported or attached, not before.`);
  if (f.matchedOnly > 0) out.push(`${f.matchedOnly} ${f.matchedOnly === 1 ? 'was' : 'were'} already in the CRM and ${f.matchedOnly === 1 ? 'is' : 'are'} not imported ${from}, so ${thisMapping} does not cover them${f.open ? ' unless their row is attached' : ': their row is not attached'}.`);
  if (rest > 0 && committed + f.matchedOnly > 0) out.push(`${rest} other${rest === 1 ? ' is' : 's are'} not imported ${f.open ? 'yet' : from}.`);
  return out.join(' ');
}

/**
 * The API's own sentence for a review row (apps/api/src/leads/importLabels.ts importLabelSentence and unlabeledSentence,
 * word for word), so the web tests hold the real contract. `where` is how a no-label row names its import. `file` is
 * given for an import's OWN row: mapped to a marked source, it says the numbers (E755) instead of "nothing automatic
 * reaches the people imported with it", which is the CRM-wide list's sentence about committed people.
 */
export function reviewSentence(
  r: Pick<ImportLabelView, 'label' | 'unlabeledImportId' | 'people' | 'state' | 'leadSourceName' | 'noAutomatedContact' | 'suggestion'> & { committedPeople?: number },
  where = 'this import',
  file: InThisImport | null = null,
): string {
  if (r.unlabeledImportId) {
    const who = `No source label in ${where} (${people(r.people)})`;
    if (r.state !== 'mapped') return `${who}: not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.`;
    if (r.noAutomatedContact && file) return inThisImportSentence('No source label', r.people, r.committedPeople ?? 0, file, `the people of this import with no source label are counted as ${r.leadSourceName}, which has "${SETTING}" on`, 'this');
    return r.noAutomatedContact ? `${who}: counted as ${r.leadSourceName}, which has "${SETTING}" on, so nothing automatic reaches the people imported without a label.` : `${who}: counted as ${r.leadSourceName}.`;
  }
  const who = `"${r.label}" (${people(r.people)})`;
  const inReview = 'Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.';
  if (r.state === 'mapped' && r.noAutomatedContact && file) return inThisImportSentence(`"${r.label}"`, r.people, r.committedPeople ?? 0, file, `the label is mapped to ${r.leadSourceName}, which has "${SETTING}" on`, 'this mapping');
  if (r.state === 'mapped') return r.noAutomatedContact ? `${who}: mapped to ${r.leadSourceName}, which has "${SETTING}" on, so nothing automatic reaches the people imported with it.` : `${who}: mapped to ${r.leadSourceName}.`;
  if (r.state === 'suggested' && r.suggestion) {
    const n = r.suggestion.leadSourceName;
    return `${who}: not reviewed yet. It reads the same as the lead source ${n}, or a label already mapped to it, apart from capital letters and spaces around it, so ${n} is suggested. Nothing is mapped until the Owner confirms it${r.suggestion.noAutomatedContact ? ` (${n} has "${SETTING}" on)` : ''}, and nothing automatic goes to the people imported with it until then.`;
  }
  if (r.state === 'ambiguous') return `${who}: not reviewed yet. It reads the same as more than one lead source, so none is suggested. ${inReview}`;
  return `${who}: not reviewed yet. ${inReview}`;
}

/**
 * One review row with the API's sentence for its state. `mappedTo` and `suggest` name a lead source. `file` makes it an
 * import's OWN row (E755): mapped to a marked source it carries `matchedOnlyPeople` and the sentence with the numbers.
 */
export function labelRow(
  label: string,
  o: Partial<Omit<ImportLabelView, 'label' | 'sentence' | 'suggestion' | 'leadSourceId' | 'leadSourceName' | 'noAutomatedContact' | 'inReview' | 'matchedOnlyPeople'>> & {
    mappedTo?: { id: string; name: string; noAiCare?: boolean };
    suggest?: { id: string; name: string; noAiCare?: boolean };
    where?: string;
    file?: InThisImport;
  } = {},
): ImportLabelView {
  const { mappedTo, suggest, where, file, ...rest } = o;
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
    matchedOnlyPeople: file && state === 'mapped' && mappedTo?.noAiCare === true ? file.matchedOnly : null,
    state,
    leadSourceId: mappedTo?.id ?? null,
    leadSourceName: mappedTo?.name ?? null,
    noAutomatedContact: mappedTo?.noAiCare === true,
    inReview: state !== 'mapped',
    suggestion: state === 'suggested' && suggest ? { leadSourceId: suggest.id, leadSourceName: suggest.name, noAutomatedContact: suggest.noAiCare === true } : null,
  };
  return { ...row, sentence: reviewSentence(row, where, file ?? null) };
}
