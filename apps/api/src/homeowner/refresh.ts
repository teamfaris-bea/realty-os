// The homeowner.refresh pass (module 78; owner decision D10; R-HOME-1, R-HOME-2, R-HOME-3, R-HOME-6, R-HOME-9).
//
//   0. one system transaction: the tenant's local date and hour (the pass acts only in the night window), then the
//      bounded purge: expired profiles; contacts deleted, merged away, closed or do-not-contact; contacts no longer
//      recognised; mailing or interest addresses that are not K2's. Then stop if the provider is not configured: so
//      retention runs even when nothing is looked up (E574).
//   1. paged by contact: recognised, live contacts with an address in a connector ZIP; core subjectsFor picks the
//      subjects (non-subject profiles are deleted in the same transaction); a subject is due with no profile, when
//      next_refresh_at has passed, or when its address changed since the last check. The budget is the lookups made
//      on the local date plus this pass's. Names are read for memory only.
//   2. lookupHomeowner(address), outside any transaction: ONE postal address, nothing else (R-INT-1).
//   3. one system transaction per answer, fenced (E566, E567): written only while the address is unchanged, still the
//      same contact's, and the contact still recognised, live and not do-not-contact. Person-level data is stored
//      only when core attachPropertyRecord matches the exact address and a PERSON owner (entity owners dropped
//      first); otherwise the profile says why and keeps nothing (R-HOME-3). Nothing about other owners is stored,
//      hashed or logged.
// Nothing here sends, notifies, enqueues, makes a feed card, a task or an enrollment (R-HOME-8).
import { randomFillSync } from 'node:crypto';
import { type IdGenerator, type Instant, instant, uuidv7Generator } from '@realty/core/foundation';
import {
  canonicalRegion,
  completeAddress,
  connectorCountyOf,
  connectorZips,
  countyOf,
  personOwnerNames,
  reasonsFrom,
  subjectsFor,
  type CandidateAddress,
  type FailureCode,
  type HomeownerFacts,
  type HomeownerField,
  type HomeownerLookup,
  type RecognitionReason,
} from '@realty/core/homeowner';
import { attachPropertyRecord, type PostalAddress } from '@realty/core/predict';
import type { Tx } from '@realty/db';
import type { PublicRecordsProvider } from '../predict/provider.js';
import { ProviderError } from '../providers/types.js';
import type { AlertSink } from '../worker/observability.js';
import { type AnswerWrite, addressesOf, candidateContacts, deleteNonSubjects, fence, lookupsOnDate, purgeProfiles, tenantClock, updateLabels, writeAnswer, writeFailure } from './repos.js';
import { type HomeownerSettings, resolveHomeownerSettings } from './settings.js';

export type WithTx = <T>(fn: (tx: Tx, now: Instant) => Promise<T>) => Promise<T>;

export interface HomeownerDeps {
  publicRecords: PublicRecordsProvider;
  settings?: Partial<HomeownerSettings>;
  ids?: IdGenerator;
}

export interface RefreshReport {
  outcome: 'not_night' | 'not_configured' | 'done' | 'stopped_not_configured';
  localDate: string;
  purged: { expired: number; ineligible: number; nonSubjects: number };
  lookups: { made: number; matched: number; notMatched: number; notAvailable: number; ambiguous: number; failed: number; fenced: number; budgetLeft: number };
  pages: number;
}

const ms = (d: Date) => d.getTime();
const UUID_MIN = '00000000-0000-0000-0000-000000000000';

const COLUMN: Record<HomeownerField, AnswerWrite['facts'][number]['column']> = {
  last_transfer_date: 'date_value',
  last_transfer_price_cents: 'cents_value',
  county_market_value_cents: 'cents_value',
  assessed_value_cents: 'cents_value',
  annual_tax_cents: 'cents_value',
  tax_year: 'int_value',
  exemption_legal_residence: 'bool_value',
  exemption_homestead: 'bool_value',
  owner_mailing_address: 'text_value',
};

interface Due {
  contactId: string;
  addressId: string;
  address: PostalAddress;
  addressUpdatedAt: Date;
  reasons: RecognitionReason[];
}

export async function runHomeownerRefresh(withTx: WithTx, deps: HomeownerDeps, o: { tenantId: string; alerts: AlertSink; nightOnly: boolean }): Promise<RefreshReport> {
  const s = resolveHomeownerSettings(deps.settings);
  const ids = deps.ids ?? uuidv7Generator({ now: () => instant(Date.now()) }, (k) => randomFillSync(new Uint8Array(k)));
  const report: RefreshReport = {
    outcome: 'done',
    localDate: '',
    purged: { expired: 0, ineligible: 0, nonSubjects: 0 },
    lookups: { made: 0, matched: 0, notMatched: 0, notAvailable: 0, ambiguous: 0, failed: 0, fenced: 0, budgetLeft: 0 },
    pages: 0,
  };

  // 0. clock, retention
  const ctx = await withTx(async (tx) => {
    const c = await tenantClock(tx);
    if (o.nightOnly && !(c.localHour >= s.nightStartHour && c.localHour < s.nightEndHour)) return { ...c, night: false, before: 0 };
    const p = await purgeProfiles(tx, s.homeownerTagKeys, s.purgeLimit);
    report.purged.expired = p.expired;
    report.purged.ineligible = p.ineligible;
    return { ...c, night: true, before: await lookupsOnDate(tx, c.tz, c.localDate) };
  });
  report.localDate = ctx.localDate;
  if (!ctx.night) return { ...report, outcome: 'not_night' };
  if (!deps.publicRecords.configured) return { ...report, outcome: 'not_configured' };

  const zips = connectorZips();
  let made = 0;
  let cursor = UUID_MIN;
  for (let page = 0; page < s.maxPages; page++) {
    const left = Math.max(0, s.lookupBudgetPerDay - ctx.before - made);
    report.lookups.budgetLeft = left;
    if (left <= 0) break;
    // 1. one page of contacts; their subjects; non-subject profiles deleted in the same transaction
    const step = await withTx(async (tx, now) => {
      const contacts = await candidateContacts(tx, { keys: s.homeownerTagKeys, zips, after: cursor, limit: s.pageSize });
      if (contacts.length === 0) return { last: null, due: [] as Due[] };
      const addresses = await addressesOf(tx, contacts.map((c) => c.id));
      const due: Due[] = [];
      for (const c of contacts) {
        const own = addresses.filter((a) => a.contact_id === c.id);
        const reasons = reasonsFrom({ sellerIntent: c.seller_intent, sellerInquiry: c.seller_inquiry, homeownerTag: c.homeowner_tag, pastBuyer: own.some((a) => a.k2) });
        const cands: CandidateAddress[] = own.map((a) => ({ id: a.id, kind: a.kind, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code, createdAt: a.created_at.toISOString() }));
        const subjects = subjectsFor(reasons, cands, own.filter((a) => a.k2).map((a) => a.id))
          .filter((x) => connectorCountyOf(countyOf({ region: x.region!, postalCode: x.postalCode! })) !== null);
        const keep = subjects.map((x) => x.id);
        report.purged.nonSubjects += await deleteNonSubjects(tx, c.id, keep);
        for (const x of subjects) {
          const a = own.find((r) => r.id === x.id)!;
          if (a.profile_id !== null) await updateLabels(tx, a.profile_id, reasons);
          const changed = a.address_updated_at !== null && ms(a.updated_at) > ms(a.address_updated_at) && (a.last_failure_at === null || ms(a.last_failure_at) < ms(a.updated_at));
          const isDue = a.profile_id === null || (a.next_refresh_at !== null && ms(a.next_refresh_at) <= now) || changed;
          if (isDue) due.push({ contactId: c.id, addressId: a.id, address: completeAddress(x)!, addressUpdatedAt: a.updated_at, reasons });
        }
      }
      return { last: contacts[contacts.length - 1]!.id, due };
    });
    report.pages += 1;
    if (step.last === null) break;
    cursor = step.last;

    for (const d of step.due) {
      if (s.lookupBudgetPerDay - ctx.before - made <= 0) break;
      // 2. one address, outside any transaction (no name, no contact id, no tenant)
      const address: PostalAddress = { line1: d.address.line1, line2: d.address.line2 ?? null, city: d.address.city, region: d.address.region, postalCode: d.address.postalCode };
      made += 1;
      report.lookups.made += 1;
      let answer: HomeownerLookup | null = null;
      let failure: FailureCode | null = null;
      let retryDays = s.failureRetryDays;
      try {
        answer = await deps.publicRecords.lookupHomeowner(address);
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        if (e.kind === 'not_configured') {
          report.lookups.made -= 1;
          finish(report, s, o);
          return { ...report, outcome: 'stopped_not_configured' };
        }
        failure = e.kind === 'rejected' ? (e.providerCode === 'ADDRESS_INVALID' ? 'address_invalid' : 'rejected') : e.kind;
        if (e.kind === 'rejected') retryDays = s.refreshAgeDays;
      }
      // 3. the fenced write
      const wrote = await withTx(async (tx) => {
        const f = await fence(tx, { addressId: d.addressId, contactId: d.contactId, keys: s.homeownerTagKeys });
        if (!f || ms(f.updated_at) !== ms(d.addressUpdatedAt)) return false;
        const countyKey = connectorCountyOf(countyOf(d.address))!;
        if (failure !== null) {
          await writeFailure(tx, { profileId: ids.next<'HomeownerProfileId'>(), contactId: d.contactId, addressId: d.addressId, countyKey, reasons: d.reasons, code: failure, retryDays, retentionDays: s.retentionDays, addressUpdatedAt: d.addressUpdatedAt });
          return true;
        }
        const names = [f.display_name, [f.first_name, f.last_name].filter((x) => x !== null && x.trim() !== '').join(' ')].filter((x) => x.trim() !== '');
        await writeAnswer(tx, answerWrite(answer!, { ...d, profileId: ids.next<'HomeownerProfileId'>(), countyKey, names, s }, report));
        return true;
      });
      if (!wrote) report.lookups.fenced += 1;
      else if (failure !== null) report.lookups.failed += 1;
    }
    if (report.lookups.budgetLeft <= 0) break;
  }
  finish(report, s, o);
  report.lookups.budgetLeft = Math.max(0, s.lookupBudgetPerDay - ctx.before - made);
  return report;
}

function answerWrite(answer: HomeownerLookup, x: Due & { profileId: string; countyKey: string; names: string[]; s: HomeownerSettings }, report: RefreshReport): AnswerWrite {
  const base = { profileId: x.profileId, contactId: x.contactId, addressId: x.addressId, countyKey: x.countyKey, reasons: x.reasons, addressUpdatedAt: x.addressUpdatedAt, refreshAgeDays: x.s.refreshAgeDays, retentionDays: x.s.retentionDays };
  const empty = { matchDetail: null, parcelRef: null, source: null, recordAsOf: null, facts: [] };
  if (answer.status === 'not_available') {
    if (answer.detail === 'ambiguous') report.lookups.ambiguous += 1;
    else report.lookups.notAvailable += 1;
    return { ...base, ...empty, status: answer.detail === 'ambiguous' ? 'ambiguous' : 'not_available' };
  }
  const r = answer.record;
  const decision = attachPropertyRecord({ address: canonicalRegion(r.address), ownerNames: personOwnerNames(r.ownerNames) }, { address: canonicalRegion(x.address), names: x.names });
  if (!decision.attach) {
    report.lookups.notMatched += 1;
    return { ...base, ...empty, status: 'not_matched', matchDetail: decision.detail };
  }
  report.lookups.matched += 1;
  return { ...base, status: 'matched', matchDetail: null, parcelRef: r.providerRef, source: r.source, recordAsOf: r.recordAsOf, facts: factRows(r.facts) };
}

function factRows(facts: HomeownerFacts): AnswerWrite['facts'] {
  return (Object.keys(facts) as HomeownerField[]).map((field) => {
    const f = facts[field]!;
    return { field, column: COLUMN[field], value: f.value, source: f.source, asOf: f.asOf };
  });
}

function finish(report: RefreshReport, s: HomeownerSettings, o: { tenantId: string; alerts: AlertSink }): void {
  const successes = report.lookups.matched + report.lookups.notMatched + report.lookups.notAvailable + report.lookups.ambiguous;
  if (report.lookups.failed >= s.failureAlertThreshold && successes === 0) {
    o.alerts.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: o.tenantId, details: { reason: 'PUBLIC_RECORDS_SOURCE_FAILING', failures: report.lookups.failed, localDate: report.localDate } });
  }
}
