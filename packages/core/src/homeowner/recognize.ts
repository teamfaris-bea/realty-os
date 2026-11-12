// Recognition and subjects (R-HOME-1, R-HOME-2; E560). A contact is recognised as a seller or homeowner from data
// already on the record, by the system each night: seller intent (seller, buyer_seller), a sell or value inquiry, a
// homeowner tag (a configured tag key, never a protected-proxy tag), or a past buyer who now owns (module 26's K2:
// nurture/repos.ts avmQualifies). The subjects are the addresses a profile is built for: K2's address of any kind,
// then complete home and property addresses; never a mailing or interest address otherwise; at most three.
import { normalizeAddress } from '../predict/index.js';
import type { PostalAddress, RecognitionReason } from './types.js';

export interface RecognitionFacts {
  sellerIntent: boolean;
  sellerInquiry: boolean;
  homeownerTag: boolean;
  pastBuyer: boolean;
}

/** The reasons a contact is recognised, in a fixed order; [] means not recognised. */
export function reasonsFrom(f: RecognitionFacts): RecognitionReason[] {
  const out: RecognitionReason[] = [];
  if (f.sellerIntent) out.push('seller_intent');
  if (f.sellerInquiry) out.push('seller_inquiry');
  if (f.homeownerTag) out.push('homeowner_tag');
  if (f.pastBuyer) out.push('past_buyer');
  return out;
}

export const MAX_SUBJECTS = 3;

export interface CandidateAddress {
  id: string;
  kind: 'home' | 'mailing' | 'property' | 'interest';
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  /** ISO instant */
  createdAt: string;
}

/** The address as a PostalAddress when every required part is present and it normalizes, else null. */
export function completeAddress(a: Pick<CandidateAddress, 'line1' | 'line2' | 'city' | 'region' | 'postalCode'>): PostalAddress | null {
  if (!a.line1 || !a.city || !a.region || !a.postalCode) return null;
  const p: PostalAddress = { line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postalCode };
  return normalizeAddress(p) === null ? null : p;
}

const RANK = { home: 1, property: 2, mailing: 9, interest: 9 } as const;

/**
 * The subject addresses, ordered K2, home, property, then oldest first (id breaks ties). `k2Ids` are the
 * addresses K2 values (any kind); they count only when the contact is recognised as a past buyer.
 */
export function subjectsFor(reasons: readonly RecognitionReason[], addresses: readonly CandidateAddress[], k2Ids: Iterable<string>): CandidateAddress[] {
  if (reasons.length === 0) return [];
  const k2 = reasons.includes('past_buyer') ? new Set(k2Ids) : new Set<string>();
  const rank = (a: CandidateAddress) => (k2.has(a.id) ? 0 : RANK[a.kind]);
  return addresses
    .filter((a) => completeAddress(a) !== null && rank(a) < 9)
    .sort((x, y) => rank(x) - rank(y) || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
    .slice(0, MAX_SUBJECTS);
}
