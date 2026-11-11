// Test fixtures for core/compliance (used only by *.test.ts; excluded from coverage).
import { type IanaZone, type Instant, at, zone } from '../../foundation/index.js';
import type { ConsentEvent, ConsentEventSpec } from '../consent.js';
import type { GateInput } from '../gate.js';
import {
  type JurisdictionPack,
  PLATFORM_FLOOR,
  type ResolvedPolicy,
  type TenantPolicyVersion,
  parseJurisdictionPack,
  resolvePolicy,
} from '../policy.js';
import type { ConsentStateRow } from '../types.js';

export const H1 = '1'.repeat(64);
export const H2 = '2'.repeat(64);
export const H3 = '3'.repeat(64);

export const NY = zone('America/New_York');
export const LA = zone('America/Los_Angeles');
export const CHI = zone('America/Chicago');

/** The seeded US placeholder pack of 0001_init.sql §21. */
export const US_PACK_ROW = {
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
};

export function usPack(): JurisdictionPack {
  const r = parseJurisdictionPack(US_PACK_ROW);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.pack;
}

/** compliance_policy_versions column defaults. */
export function tenantPolicy(o: Partial<TenantPolicyVersion> = {}): TenantPolicyVersion {
  return {
    id: '00000000-0000-7000-8000-0000000000aa',
    autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert'],
    optOutConfirmationSender: 'provider',
    recordingEnabled: true,
    recordingMode: 'announce_all',
    looseningAttestation: null,
    ...o,
  };
}

export function policy(o: Partial<TenantPolicyVersion> = {}, packs: JurisdictionPack[] = [usPack()]): ResolvedPolicy {
  return resolvePolicy(PLATFORM_FLOOR, packs, tenantPolicy(o));
}

/** Tuesday 2026-11-10 10:00 EST (15:00Z). */
export const NOW: Instant = at('2026-11-10T15:00:00Z');

export function grantRow(o: Partial<ConsentStateRow> = {}): ConsentStateRow {
  return {
    channel: 'sms',
    purpose: 'informational',
    addressHmac: H1,
    status: 'granted',
    level: 'express',
    basisEventId: 'e-basis',
    expiresAt: null,
    ledgerEventCount: 1,
    ...o,
  };
}

/** A clean human, informational, one-to-one SMS that the gate allows. */
export function gateInput(o: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    recipient: { kind: 'contact', addressHmac: H1, channel: 'sms' },
    purpose: 'informational',
    initiator: 'human',
    category: 'none',
    consent: [grantRow()],
    suppressions: [],
    contactPoint: { status: 'active', lineType: 'mobile' },
    automationPausedAt: null,
    sender: { kind: 'phone', registration: 'ready' },
    tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: true },
    rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false },
    policy: policy(),
    personDoNotContact: false,
    connection: null,
    ...o,
  };
}

/** The same input as an assistant nurture step (autonomous category). */
export function assistantInput(o: Partial<GateInput> = {}): GateInput {
  return gateInput({ initiator: 'assistant', category: 'nurture_step', ...o });
}

let seq = 0;
export function ev(o: Partial<ConsentEvent> & Pick<ConsentEvent, 'eventType'>): ConsentEvent {
  seq += 1;
  return {
    id: `e-${String(seq).padStart(6, '0')}`,
    channel: 'sms',
    purpose: 'all',
    addressHmac: H1,
    level: o.eventType === 'grant' ? 'express' : 'none',
    source: o.eventType === 'grant' ? 'web_form' : o.eventType === 'resubscribe' ? 'inbound_keyword' : 'agent_revoke',
    occurredAt: NOW,
    imported: false,
    actorKind: 'system',
    disclosureId: null,
    evidenceObjectId: null,
    revertsEventId: null,
    expiresAt: null,
    ...o,
  };
}

export function spec(o: Partial<ConsentEventSpec> = {}): ConsentEventSpec {
  seq += 1;
  return {
    id: `s-${String(seq).padStart(6, '0')}`,
    addressKind: 'phone',
    addressHmac: H1,
    addressHint: '•••-•••-4821',
    channel: 'sms',
    purpose: 'all',
    eventType: 'grant',
    level: 'express',
    source: 'web_form',
    occurredAt: NOW,
    contactId: 'c-1',
    actor: { kind: 'system' },
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: null,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: {},
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview: false,
    ...o,
  };
}

/** A revoked consent_state row (an opt-out). */
export function revokedRow(o: Partial<ConsentStateRow> = {}): ConsentStateRow {
  return { ...grantRow(), status: 'revoked', level: 'none', basisEventId: null, ...o };
}

export const minutes = (n: number): number => n * 60_000;
export const hours = (n: number): number => n * 3_600_000;
export const days = (n: number): number => n * 86_400_000;

export function zonesOf(...z: IanaZone[]): { zones: IanaZone[]; source: 'explicit' } {
  return { zones: z, source: 'explicit' };
}

/** A clean human informational website-chat reply through a connected widget. */
export function dmInput(channel: 'web_chat' = 'web_chat', o: Partial<GateInput> = {}): GateInput {
  return gateInput({
    recipient: { kind: 'contact', addressHmac: H1, channel },
    consent: [],
    sender: null,
    connection: { status: 'connected' },
    ...o,
  });
}
