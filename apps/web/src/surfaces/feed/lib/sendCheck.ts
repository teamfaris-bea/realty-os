// The content-dependent half of "will this send?", checked against the real text as the agent types or
// before they approve a draft (POST /contacts/:id/messages/preview: the same canContact as the send,
// nothing stored).
//
// Whether a channel is blocked at all (they texted STOP, unsubscribed, asked not to be contacted, a
// suppression, a wrong number) comes from the reachability summary (reasons/useReachability), never
// from a stand-in message: there is no probe text. This hook runs only when there is real text, for the
// rules that depend on the words (payment instructions, the brokerage name on marketing). The send itself
// is always checked again at the moment it goes out: this hook never decides anything.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../../shell/index.js';
import type { DecisionView, PreviewResponse } from './types.js';

export interface SendCheckInput {
  contactId: string;
  channel: 'sms' | 'email';
  /** the real text (typed, or the assistant's draft); empty → nothing is checked */
  body?: string;
  subject?: string;
  enabled?: boolean;
}

/** The preview decision for this text, or null while unknown (no text yet, loading, no permission). */
export function useSendCheck({ contactId, channel, body = '', subject = '', enabled = true }: SendCheckInput): { decision: DecisionView | null; body: string } {
  const api = useApi();
  const text = body.trim();
  const subj = channel === 'email' ? subject.trim() : '';
  const q = useQuery<PreviewResponse, ApiError>({
    queryKey: ['preview', contactId, channel, text, subj],
    queryFn: ({ signal }) => api.request<PreviewResponse>('POST', `/contacts/${contactId}/messages/preview`, { channel, body: text, ...(subj ? { subject: subj } : {}) }, { signal }),
    enabled: enabled && text.length > 0 && contactId.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  return { decision: text.length > 0 ? (q.data?.decision ?? null) : null, body: text };
}
