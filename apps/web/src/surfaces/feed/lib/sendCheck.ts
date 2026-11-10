// "Will this send?" before the agent taps Send (owner decision, core-compliance/2.0.0).
//
// The send-time check now blocks only for an opt-out (the contact texted STOP, unsubscribed, or asked
// not to be contacted), an active suppression (bounce, complaint, do-not-contact), and a few
// operational and identity rules (no sending number, a wrong number, the brokerage name missing on
// marketing, payment instructions). There is no consent prompt, no quiet hours and no "send anyway".
//
// The web asks the server's preview (POST /contacts/:id/messages/preview), which evaluates the same
// canContact as the send and stores nothing. The preview needs a message body; before the agent has
// typed anything, a neutral PROBE_BODY stands in. Everything that blocks a probe (opt-outs,
// suppressions, the sender, the brokerage identity) blocks every message on that channel, so a block
// shown for the probe is true for whatever the agent writes. Rules that depend on the words (payment
// instructions) are checked again with the real text as it is typed, and the send itself is always
// checked again at the moment it goes out: this hook never decides anything.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../../shell/index.js';
import type { DecisionView, PreviewResponse } from './types.js';

/** Stands in for the message before the agent has typed one. Contains nothing any rule looks for. */
export const PROBE_BODY = 'Hi';

export interface SendCheckInput {
  contactId: string;
  channel: 'sms' | 'email';
  /** the text typed so far; empty → the probe */
  body?: string;
  subject?: string;
  enabled?: boolean;
}

/** The preview decision for a send, or null while unknown (loading, no permission, no address). */
export function useSendCheck({ contactId, channel, body = '', subject = '', enabled = true }: SendCheckInput): { decision: DecisionView | null; body: string } {
  const api = useApi();
  const text = body.trim() || PROBE_BODY;
  const subj = channel === 'email' ? subject.trim() : '';
  const q = useQuery<PreviewResponse, ApiError>({
    queryKey: ['preview', contactId, channel, text, subj],
    queryFn: ({ signal }) => api.request<PreviewResponse>('POST', `/contacts/${contactId}/messages/preview`, { channel, body: text, ...(subj ? { subject: subj } : {}) }, { signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  return { decision: q.data?.decision ?? null, body: text };
}
