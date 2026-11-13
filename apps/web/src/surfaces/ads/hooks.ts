// The one read of the Google Ads page and the ad-shift approval card: GET /ads (ads.view, Owner/Admin only). Callers
// pass `enabled` from the person's role, so no other role ever requests it (R-STAFF-6, R-PERM-5).
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';
import { ADS_KEY, type OverviewResponse } from './types.js';

export function useAdsOverview(o: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery<OverviewResponse, ApiError>({
    queryKey: ADS_KEY,
    queryFn: ({ signal }) => api.get<OverviewResponse>('/ads', { signal }),
    enabled: o.enabled ?? true,
  });
}

/** Owner and Admin read ads (packages/core authz 'ads.view'); only the Owner sets the cap ('ads.cap_set'). */
export const ADS_ROLES = ['owner', 'admin'] as const;
export const mayReadAds = (role: string | null | undefined): boolean => role === 'owner' || role === 'admin';
