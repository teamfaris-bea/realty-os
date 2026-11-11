// Test fixtures for core/parity/bulk (used only by *.test.ts files).
import { type GateInput, PLATFORM_FLOOR, parseJurisdictionPack, resolvePolicy } from '../../compliance/index.js';
import { type Role, type TenantId, type UserActor, type UserId, instant } from '../../foundation/index.js';

export const H1 = '1'.repeat(64);
export const H2 = '2'.repeat(64);
export const NOW = instant(Date.parse('2026-11-10T15:00:00Z'));

const US = parseJurisdictionPack({
  key: 'US',
  version: '2026.11.0',
  reviewedByCounselAt: null,
  rules: {
    contact_window: { start: '08:00', end: '21:00' },
    restricted_days: [],
    recording_party_rule: 'unknown',
    inquiry_basis_days: 90,
    dnc_scrub_validity_days: 31,
    opt_out_keywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'],
    resubscribe_keywords: ['START', 'UNSTOP'],
    help_keywords: ['HELP', 'INFO'],
    ai_disclosure: { assistant_must_identify: true },
    advertising: { brokerage_name_required: true },
  },
});
if (!US.ok) throw new Error('US pack fixture invalid');
export const POLICY = resolvePolicy(PLATFORM_FLOOR, [US.pack], {
  id: '00000000-0000-7000-8000-0000000000aa',
  autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert'],
  optOutConfirmationSender: 'provider',
  recordingEnabled: true,
  recordingMode: 'announce_all',
  looseningAttestation: null,
});

/** A clean human MARKETING send (what a bulk item is) that the gate allows. */
export function bulkGate(channel: 'email' | 'sms', o: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    recipient: { kind: 'contact', addressHmac: H1, channel },
    purpose: 'marketing',
    initiator: 'human',
    category: 'none',
    consent: [],
    suppressions: [],
    contactPoint: { status: 'active', lineType: 'mobile' },
    automationPausedAt: null,
    sender: channel === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : { kind: 'phone', registration: 'ready' },
    tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: true },
    rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false },
    policy: POLICY,
    personDoNotContact: false,
    connection: null,
    ...o,
  };
}

export function user(role: Role, id = 'u-1'): UserActor {
  return { kind: 'user', userId: id as UserId, tenantId: 't-1' as TenantId, role, sessionId: 's' };
}

export const revoked = (channel: 'sms' | 'email' | 'voice', addressHmac: string, purpose: 'marketing' | 'informational' = 'marketing') => ({
  channel,
  purpose,
  addressHmac,
  status: 'revoked' as const,
  level: 'none' as const,
  basisEventId: 'e',
  expiresAt: null,
  ledgerEventCount: 1,
});
