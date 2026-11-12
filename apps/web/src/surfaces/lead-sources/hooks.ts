// Queries shared by the Lead sources pages.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';
import type { MembersResponse } from '../admin/lib/types.js';
import { MEMBERS_KEY, OVERVIEW_KEY, type OverviewResponse } from './types.js';

export function useOverview() {
  const api = useApi();
  return useQuery<OverviewResponse, ApiError>({ queryKey: OVERVIEW_KEY, queryFn: ({ signal }) => api.get<OverviewResponse>('/lead-sources/overview', { signal }) });
}

export function useMembers(enabled = true) {
  const api = useApi();
  return useQuery<MembersResponse, ApiError>({ queryKey: MEMBERS_KEY, queryFn: ({ signal }) => api.get<MembersResponse>('/members', { signal }), enabled });
}

/**
 * The query keys a change to a source refreshes (this surface's and the admin pages' copies). ['admin', 'web-chat']
 * covers the Website chat page's widgets and its consent checks (b9 ui/F5); its lead-sources query sits under
 * ['admin', 'lead-sources'].
 */
export const SOURCE_KEYS = [[...OVERVIEW_KEY], ['admin', 'lead-sources'], ['admin', 'web-chat']];
