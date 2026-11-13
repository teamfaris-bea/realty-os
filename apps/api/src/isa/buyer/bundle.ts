// The buyer listing bundle of one turn (ISA-2b item 10, D7a; R-ISA-17, R-ISA-20, R-ISA-9; E509, E520, E539). Built in
// TX-A from the database only, never by the model. The prompt gets HandleLabels (L1…L6: fact kind, status label, beds,
// baths, property type and a locality that passes a strict pattern) and nothing else: no price, address, brokerage,
// remark, attribute or URL. The bundle rides in Prepared to TX-B, where decideAction accepts only these handles
// (HANDLE_UNKNOWN otherwise) and the facts message re-runs every rule (buyer/facts.ts).
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
// R-GMAIL-14 (batch 13 audit ISA2B-03): a static import. This file is reached from isa/turn.ts only, which no path from
// mailSync/** reaches (the architecture test scans static and dynamic imports alike)
import { matchClientListingsInTx } from '../../assistant/searches.js';
import { mlsEligibility } from '../../mls/eligibility.js';
import { ISA_GROUNDING_DEFAULTS } from '../coreSeam.js';
import type { IsaContext } from '../effects.js';
import { initiatedTierPassesInTx } from '../send.js';
import { criteriaFromClaims } from './criteria.js';
import { recentlySharedListingIds, type ShareableFact, shareableFactInTx } from './search.js';

/** Q6: handles offered to the model per turn (at most 3 per message, buyer/facts.ts). VERIFY. */
export const BUNDLE_MAX_HANDLES = 6;
export const BUNDLE_CANDIDATES = 30;

export type BundleUnavailable = 'CAPABILITY_OFF' | 'CRITERIA_INCOMPLETE' | 'CONSENT_TIER_MISSING' | 'MLS_NOT_ELIGIBLE' | 'LEASE_UNCHECKED' | 'NO_MATCH';

export interface HandleLabelOut {
  handle: string;
  factKind: 'listing_active' | 'listing_coming_soon';
  statusLabel: string;
  beds: number | null;
  baths: number | null;
  propertyType: string | null;
  locality: string | null;
}

export interface BuyerBundle {
  handles: HandleLabelOut[];
  items: Record<string, ShareableFact>;
  unavailable: BundleUnavailable | null;
}

const LOCALITY = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
export const EMPTY_BUNDLE: BuyerBundle = { handles: [], items: {}, unavailable: 'CAPABILITY_OFF' };

/** The bundle, or an honest unavailable code (each with a panel sentence, isa/sentences.ts). */
export async function buildBuyerBundleInTx(tx: Tx, ctx: IsaContext, i: { shareAllowed: boolean; now: Instant }): Promise<BuyerBundle> {
  const a = ctx.a;
  const none = (code: BundleUnavailable): BuyerBundle => ({ handles: [], items: {}, unavailable: code });
  if (!i.shareAllowed || (a.side !== 'buyer' && a.side !== 'both')) return none('CAPABILITY_OFF');
  const c = criteriaFromClaims(a.machine.claims);
  if (c === null) return none('CRITERIA_INCOMPLETE');
  // facts are always initiated (0190 has_facts): the initiated tier must pass on a bound channel (E520)
  let tier = false;
  for (const ch of ctx.channels) if (await initiatedTierPassesInTx(tx, a, ch)) tier = true;
  if (!tier) return none('CONSENT_TIER_MISSING');
  const e = await mlsEligibility(tx, i.now);
  if (e.clientIds.length === 0) return none('MLS_NOT_ELIGIBLE');
  const rows = await matchClientListingsInTx(tx, c.criteria, BUNDLE_CANDIDATES, e);
  const recent = await recentlySharedListingIds(tx, a.contactId, ISA_GROUNDING_DEFAULTS.repeatListingDays);
  const handles: HandleLabelOut[] = [];
  const items: Record<string, ShareableFact> = {};
  let leaseUnchecked = 0;
  for (const r of rows) {
    if (handles.length >= BUNDLE_MAX_HANDLES) break;
    if (recent.has(r.id)) continue;
    const f = await shareableFactInTx(tx, e, r.id, ctx.who.teamName, i.now);
    if (!f.ok) {
      if (f.code === 'LEASE_UNCHECKED') leaseUnchecked += 1;
      continue;
    }
    const handle = `L${handles.length + 1}`;
    items[handle] = f.fact;
    const city = f.fact.label.city;
    handles.push({ handle, factKind: f.fact.factKind, statusLabel: f.fact.status === 'coming_soon' ? 'Coming soon' : 'Active', beds: f.fact.label.beds, baths: f.fact.label.baths,
      propertyType: f.fact.label.propertyType, locality: city !== null && LOCALITY.test(city) ? city : null });
  }
  if (handles.length === 0) return none(leaseUnchecked > 0 ? 'LEASE_UNCHECKED' : 'NO_MATCH');
  return { handles, items, unavailable: null };
}
