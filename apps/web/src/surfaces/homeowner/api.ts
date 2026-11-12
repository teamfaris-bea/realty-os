// Data of module 79 web/homeowner: GET /api/contacts/:id/homeowner (module 78). The response type is core's
// homeownerView output, which the API's strict schema mirrors (no score, estimate or owner name exists in it).
import type { HomeownerView } from '@realty/core/homeowner';
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';

export type { CheckState, HomeView, HomeownerView, ViewRow } from '@realty/core/homeowner';

export const homeownerKey = (contactId: string) => ['homeowner', contactId] as const;

export function useHomeowner(contactId: string) {
  const api = useApi();
  return useQuery<HomeownerView, ApiError>({ queryKey: homeownerKey(contactId), queryFn: ({ signal }) => api.get(`/contacts/${contactId}/homeowner`, { signal }) });
}
