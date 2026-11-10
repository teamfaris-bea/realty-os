// GET /contacts/:id: the full contact, or only its card when the caller sees it as a pond or offer
// card (R-PERM-6). Shared by the contact, thread and pond surfaces.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';
import type { ContactView } from '../feed/lib/types.js';

export function useContact(contactId: string) {
  const api = useApi();
  return useQuery<{ contact: ContactView }, ApiError>({
    queryKey: ['contact', contactId],
    queryFn: ({ signal }) => api.get<{ contact: ContactView }>(`/contacts/${contactId}`, { signal }),
    enabled: contactId.length > 0,
    staleTime: 15_000,
  });
}
