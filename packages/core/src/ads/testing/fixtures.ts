// Synthetic fixtures for core/ads tests (the repository is public: no real names or accounts).
import { instant, type ListingId } from '../../foundation/index.js';
import type { Campaign, CampaignId, Cap, CapVersionId, MarketingPieceId, OutcomeCounts, Outcomes, Spend } from '../types.js';

export const uid = (n: number): string => `00000051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const cid = (n: number): CampaignId => uid(0x100 + n) as CampaignId;
export const lid = (n: number): ListingId => uid(0x200 + n) as ListingId;
export const pid = (n: number): MarketingPieceId => uid(0x300 + n) as MarketingPieceId;

/** An eligible Google Ads housing campaign with valid targeting and an approved creative of its own listing. */
export function campaign(n: number, over: Partial<Campaign> = {}): Campaign {
  return {
    id: cid(n), connectionKind: 'ads_google', connectionStatus: 'connected', status: 'active', specialCategory: 'housing',
    targeting: { geo: 'radius_of_listing', radiusMiles: 20 }, listingId: lid(n), creative: { pieceId: pid(n), status: 'approved', listingId: lid(n) },
    dailyBudgetCents: 10_000, latestEvent: { kind: 'applied', toDailyCents: 10_000 }, ...over,
  };
}

export const cap = (over: Partial<Cap> = {}): Cap => ({
  id: uid(0x900) as CapVersionId, versionNo: 3, monthlyCapCents: 3_000_000, dailyCeilingCents: 100_000, effectiveFrom: instant(Date.UTC(2026, 10, 1)), ...over,
});

export const spend = (n: number, cents: number, windowDays = 90): Spend => ({ campaignId: cid(n), spendCents: cents, windowDays });
export const out = (n: number, agreements: number, closings = 0): OutcomeCounts => ({ campaignId: cid(n), agreements, closings });
export const outcomes = (...rows: OutcomeCounts[]): Outcomes => ({ windowDays: 90, campaigns: rows });
