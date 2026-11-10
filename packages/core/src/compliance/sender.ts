// Sender identity (R-CONSENT-17, R-CONSENT-18; E46).
//
// SMS goes only from a number whose registration is `approved` (A2P 10DLC campaign) or verified
// (toll-free). `chooseSender` picks by conversation continuity, never by registration: the sticky
// number first, then the contact owner's direct number, then the team main number (the 60-second
// first response skips the owner's number). A chosen number that is not registered is still
// returned, so the gate blocks the send with SENDER_NOT_REGISTERED and it surfaces as a failed
// send. There is no automatic fallback to another campaign's number. Only a number that cannot
// serve the thread at all (released, or not SMS-capable) is skipped.
import type { PhoneNumberId } from '../foundation/index.js';

/** Registration status of the number's sender_registrations row, or 'none' when it has none. */
export type RegistrationStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended' | 'none';

export interface NumberFacts {
  id: PhoneNumberId;
  numberType: 'local' | 'toll_free';
  smsCapable: boolean;
  voiceCapable: boolean;
  released: boolean;
  /** For toll-free numbers, `approved` means the toll-free verification is approved. */
  registrationStatus: RegistrationStatus;
}

export function chooseSender(i: { stickyNumber?: NumberFacts; ownerDirect?: NumberFacts; teamMain?: NumberFacts; firstResponse: boolean }): NumberFacts | null {
  const order = i.firstResponse ? [i.stickyNumber, i.teamMain] : [i.stickyNumber, i.ownerDirect, i.teamMain];
  for (const n of order) {
    if (n && !n.released && n.smsCapable) return n;
  }
  return null;
}

export type SenderRegistration = 'ready' | 'pending' | 'blocked';

/** The gate's view of a registration: approved ⇒ ready; draft/submitted ⇒ pending; else blocked. */
export function registrationOf(status: RegistrationStatus): SenderRegistration {
  if (status === 'approved') return 'ready';
  if (status === 'draft' || status === 'submitted') return 'pending';
  return 'blocked';
}

/** `GateInput.sender` for a phone number (SMS or voice). Released numbers are blocked. */
export function phoneSenderFacts(n: NumberFacts | null): { kind: 'phone'; registration: SenderRegistration } | null {
  if (n === null) return null;
  return { kind: 'phone', registration: n.released ? 'blocked' : registrationOf(n.registrationStatus) };
}

export interface EmailIdentityFacts {
  status: 'active' | 'disabled';
  /** The identity's own domain; null = the platform's shared authenticated domain. */
  domain: { verifiedAt: unknown | null } | null;
}

/**
 * `GateInput.sender` for an email identity. One-to-one email may use the platform's shared
 * authenticated domain (R-CONSENT-18), but marketing email needs the tenant's own verified domain
 * (SPF + DKIM + DMARC; DB CHECK on sending_domains.verified_at), so the shared domain reports
 * `domainVerified: false`.
 */
export function emailSenderFacts(e: EmailIdentityFacts | null): { kind: 'email'; registration: SenderRegistration; domainVerified: boolean } | null {
  if (e === null) return null;
  return {
    kind: 'email',
    registration: e.status === 'active' ? 'ready' : 'blocked',
    domainVerified: e.domain !== null && e.domain.verifiedAt !== null && e.domain.verifiedAt !== undefined,
  };
}
