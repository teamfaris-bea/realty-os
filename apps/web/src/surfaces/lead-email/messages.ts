// Error code → sentence for the lead-email surfaces (CONVENTIONS §7: the web never shows a raw code).
// Registered on this surface's `errorMessages`; the components look codes up in LEAD_EMAIL_MESSAGES,
// which adds the lead-admin and agent sentences (REAUTH_REQUIRED, NOT_FOUND, ... come from the shell).
import { messageFor } from '../../shell/index.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';

export const LEAD_EMAIL_ERROR_MESSAGES: Record<string, string> = {
  LEAD_EMAIL_NOT_PENDING: 'Someone already decided this email. The list below is up to date.',
  LEAD_EMAIL_NO_CONTACT_POINT: 'A lead needs a phone number or an email address. Type one in, then accept again.',
  LEAD_EMAIL_DOMAIN_INVALID: "One of those sender domains can't be used. Enter the portal's own domain, like zillow.com: no wildcards, no web addresses, and not a bare ending like com or co.uk.",
  LEAD_EMAIL_NOT_CONFIGURED: "Lead email isn't set up on this server yet, so no address can be made. Ask whoever runs Realty OS for your team to set up the inbound email domain.",
};

export const LEAD_EMAIL_MESSAGES: Record<string, string> = { ...ADMIN_MESSAGES, ...LEAD_EMAIL_ERROR_MESSAGES };

/** The sentence for a failure (never the code). */
export function sentenceFor(e: { code: string; details?: Record<string, unknown> | null } | string): string {
  return messageFor(e, LEAD_EMAIL_MESSAGES);
}
