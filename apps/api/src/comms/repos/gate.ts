// Reads that assemble a GateInput (ARCHITECTURE §9 "Inputs"), under the caller's RLS inside the dispatch
// transaction. Addresses are joined by HMAC; no plaintext address leaves these queries into the gate.
import type { ConsentStateRow, JurisdictionPackRow, LineType, NumberFacts, PointStatus, RegistrationStatus, SuppressionRow, TenantPolicyVersion } from '@realty/core/compliance';
import type { Instant, PhoneNumberId } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { type Tx, hmacBytes } from '@realty/db';
import { sql } from 'kysely';

export interface TenantFacts {
  suspended: boolean;
  brokerageLegalName: string;
  teamName: string | null;
  postalAddress: string | null;
  defaultTimezone: string;
  activePolicyId: string;
  operatingJurisdictions: string[];
  teamLeadRecordingAccess: boolean;
  tcRecordingAccess: boolean;
  agentConsentEntryAllowed: boolean;
  recordingRetentionDays: number;
}

export async function tenantFacts(tx: Tx): Promise<TenantFacts> {
  const r = await sql<{
    status: string;
    brokerage_legal_name: string;
    team_name: string | null;
    brokerage_postal_address: string | null;
    default_timezone: string;
    active_policy_id: string;
    operating_jurisdictions: string[];
    team_lead_recording_access: boolean;
    tc_recording_access: boolean;
    agent_consent_entry_allowed: boolean;
    recording_retention_days: number;
  }>`
    SELECT t.status, s.brokerage_legal_name, s.team_name, s.brokerage_postal_address, s.default_timezone, s.active_policy_id,
           s.operating_jurisdictions, s.team_lead_recording_access, s.tc_recording_access, s.agent_consent_entry_allowed,
           s.recording_retention_days
      FROM tenant_settings s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  if (!x) throw new Error('tenant settings not visible');
  return {
    suspended: x.status !== 'active',
    brokerageLegalName: x.brokerage_legal_name,
    teamName: x.team_name,
    postalAddress: x.brokerage_postal_address,
    defaultTimezone: x.default_timezone,
    activePolicyId: x.active_policy_id,
    operatingJurisdictions: x.operating_jurisdictions,
    teamLeadRecordingAccess: x.team_lead_recording_access,
    tcRecordingAccess: x.tc_recording_access,
    agentConsentEntryAllowed: x.agent_consent_entry_allowed,
    recordingRetentionDays: x.recording_retention_days,
  };
}

export async function policyRow(tx: Tx, id: string): Promise<TenantPolicyVersion> {
  const r = await sql<{
    id: string;
    autonomous_categories: string[];
    opt_out_confirmation_sender: 'provider' | 'platform';
    recording_enabled: boolean;
    recording_mode: 'announce_all' | 'one_party_where_permitted';
    loosening_attestation: string | null;
  }>`SELECT id, autonomous_categories, opt_out_confirmation_sender, recording_enabled, recording_mode, loosening_attestation
       FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const p = r.rows[0];
  if (!p) throw new Error('active compliance policy not visible');
  return {
    id: p.id,
    autonomousCategories: p.autonomous_categories,
    optOutConfirmationSender: p.opt_out_confirmation_sender,
    recordingEnabled: p.recording_enabled,
    recordingMode: p.recording_mode,
    looseningAttestation: p.loosening_attestation,
  };
}

/** Published packs for the tenant's operating jurisdictions (a state pack also pulls its country pack). */
export async function publishedPacks(tx: Tx, jurisdictions: readonly string[]): Promise<JurisdictionPackRow[]> {
  const keys = [...new Set(jurisdictions.flatMap((j) => (j.includes('-') ? [j, j.split('-')[0]!] : [j])))];
  const r = await sql<{ key: string; version: string; rules: unknown; reviewed_by_counsel_at: Date | null }>`
    SELECT key, version, rules, reviewed_by_counsel_at FROM jurisdiction_packs
     WHERE status = 'published' AND key = ANY (${keys}::text[]) ORDER BY key`.execute(tx);
  return r.rows.map((p) => ({ key: p.key, version: p.version, rules: p.rules, reviewedByCounselAt: p.reviewed_by_counsel_at ? instantFromDate(p.reviewed_by_counsel_at) : null }));
}

export async function consentRows(tx: Tx, channel: string, hmacs: readonly string[]): Promise<ConsentStateRow[]> {
  if (hmacs.length === 0) return [];
  const r = await sql<{ channel: ConsentStateRow['channel']; purpose: ConsentStateRow['purpose']; address_hmac: Buffer; status: ConsentStateRow['status']; consent_level: ConsentStateRow['level']; basis_event_id: string | null; expires_at: Date | null; ledger_event_count: number }>`
    SELECT channel, purpose, address_hmac, status, consent_level, basis_event_id, expires_at, ledger_event_count
      FROM consent_state WHERE tenant_id = app.tenant_id() AND channel = ${channel}
       AND address_hmac = ANY (${hmacs.map(hmacBytes)}::bytea[])`.execute(tx);
  return r.rows.map((x) => ({
    channel: x.channel,
    purpose: x.purpose,
    addressHmac: x.address_hmac.toString('hex'),
    status: x.status,
    level: x.consent_level,
    basisEventId: x.basis_event_id,
    expiresAt: x.expires_at ? instantFromDate(x.expires_at) : null,
    ledgerEventCount: x.ledger_event_count,
  }));
}

export async function suppressionRows(tx: Tx, hmac: string): Promise<SuppressionRow[]> {
  const r = await sql<{ channel: SuppressionRow['channel']; reason: SuppressionRow['reason']; lifted_at: Date | null }>`
    SELECT channel, reason, lifted_at FROM suppressions WHERE tenant_id = app.tenant_id() AND address_hmac = ${hmacBytes(hmac)}`.execute(tx);
  return r.rows.map((s) => ({ channel: s.channel, reason: s.reason, liftedAt: s.lifted_at ? instantFromDate(s.lifted_at) : null }));
}

export interface PointRow {
  id: string;
  contactId: string;
  kind: 'phone' | 'email';
  address: string;
  hmac: string;
  status: PointStatus;
  lineType: LineType;
  timezone: string | null;
  isPrimary: boolean;
}

function point(x: { id: string; contact_id: string; kind: 'phone' | 'email'; address: string; address_hmac: Buffer; status: PointStatus; line_type: LineType; timezone: string | null; is_primary: boolean }): PointRow {
  return { id: x.id, contactId: x.contact_id, kind: x.kind, address: x.address, hmac: x.address_hmac.toString('hex'), status: x.status, lineType: x.line_type, timezone: x.timezone, isPrimary: x.is_primary };
}

export async function pointById(tx: Tx, id: string): Promise<PointRow | null> {
  const r = await sql<Parameters<typeof point>[0]>`
    SELECT id, contact_id, kind, address, address_hmac, status, line_type, timezone, is_primary FROM contact_points
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? point(r.rows[0]) : null;
}

/**
 * The contact's points (removed ones excluded), primary first: the numbers and addresses a send may go
 * to or a call may dial. Not the opt-out fan-out: that also reads removed phones (optOutFanoutPhoneHmacs).
 */
export async function contactPoints(tx: Tx, contactId: string): Promise<PointRow[]> {
  const r = await sql<Parameters<typeof point>[0]>`
    SELECT id, contact_id, kind, address, address_hmac, status, line_type, timezone, is_primary FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND removed_at IS NULL
     ORDER BY is_primary DESC, created_at, id`.execute(tx);
  return r.rows.map(point);
}

/**
 * The phones whose opt-out blocks texting or calling the contact (R-CONSENT-7, outbound-3, R-PAR-12):
 * every phone of the contact, live or removed, except one removed as a confirmed wrong number. The WHERE
 * clause is the `others` set of app.messages_dispatch_guard and app.calls_dispatch_guard (migration 0021),
 *   kind = 'phone' AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM 'wrong_number')
 * so canContact sees every opt-out the guards see and refuses the send first, with its reason. Only the
 * fan-out reads removed phones: what a send goes to or a call dials still comes from contactPoints.
 */
export async function optOutFanoutPhoneHmacs(tx: Tx, contactId: string): Promise<string[]> {
  const r = await sql<{ h: Buffer }>`
    SELECT DISTINCT address_hmac AS h FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'phone'
       AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM 'wrong_number')
     ORDER BY address_hmac`.execute(tx);
  return r.rows.map((x) => Buffer.from(x.h).toString('hex'));
}

/**
 * The removed half of optOutFanoutPhoneHmacs, with each address for the hint: the contact's phones removed
 * other than as a confirmed wrong number,
 *   kind = 'phone' AND removed_at IS NOT NULL AND removed_reason IS DISTINCT FROM 'wrong_number'
 * They still block texting the person (R-PAR-12), so a START must be able to lift the keyword revoke its
 * own STOP left on one of them (R-CONSENT-10, outbound-4; see keywordRevokedBy), or the person could never
 * be texted again after a remove or replace. Only the START lift reads these: never a send target.
 */
export async function removedFanoutPhones(tx: Tx, contactId: string): Promise<{ hmac: string; address: string }[]> {
  const r = await sql<{ h: Buffer; address: string }>`
    SELECT DISTINCT ON (address_hmac) address_hmac AS h, address FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'phone'
       AND removed_at IS NOT NULL AND removed_reason IS DISTINCT FROM 'wrong_number'
     ORDER BY address_hmac, id`.execute(tx);
  return r.rows.map((x) => ({ hmac: Buffer.from(x.h).toString('hex'), address: x.address }));
}

export interface ConversationRow {
  id: string;
  contactId: string;
  pausedAt: Instant | null;
  pauseReason: string | null;
  lastInboundAt: Instant | null;
  inboundSeq: number;
  stickyPhoneNumberId: string | null;
}

/**
 * R-CONSENT-7 (outbound-1): HMACs of the phones that texted a STOP/HELP keyword into this conversation in
 * the last 24 hours (the only numbers the system's keyword reply may reach after an opt-out). Mirrors the
 * exemption in app.messages_dispatch_guard (migration 0014).
 */
/**
 * R-CONSENT-10 (outbound-4): of these phones, the ones whose every SMS keyword revoke since their last
 * resubscribe came from a STOP texted by `fromAddress` (the revoke's evidence message). Only those may be
 * lifted by that number's START; a phone's own STOP (or another number's) stays.
 */
export async function keywordRevokedBy(tx: Tx, hmacs: readonly string[], fromAddress: string): Promise<Set<string>> {
  if (hmacs.length === 0) return new Set();
  const r = await sql<{ h: Buffer }>`
    SELECT e.address_hmac AS h
      FROM consent_events e LEFT JOIN messages im ON im.tenant_id = e.tenant_id AND im.id = e.evidence_message_id
     WHERE e.tenant_id = app.tenant_id() AND e.channel = 'sms' AND e.event_type = 'revoke' AND e.source = 'inbound_keyword'
       AND e.address_hmac IN (SELECT decode(x, 'hex') FROM unnest(${[...hmacs]}::text[]) AS x)
       AND e.occurred_at >= COALESCE((SELECT max(rs.occurred_at) FROM consent_events rs
                                       WHERE rs.tenant_id = e.tenant_id AND rs.address_hmac = e.address_hmac AND rs.channel = 'sms'
                                         AND rs.event_type = 'resubscribe'), '-infinity'::timestamptz)
     GROUP BY e.address_hmac
    HAVING bool_and(im.from_address IS NOT DISTINCT FROM ${fromAddress})`.execute(tx);
  return new Set(r.rows.map((x) => Buffer.from(x.h).toString('hex')));
}

export async function keywordSenderHmacs(tx: Tx, conversationId: string, now: Instant): Promise<string[]> {
  const r = await sql<{ h: Buffer }>`
    SELECT DISTINCT p.address_hmac AS h
      FROM messages im JOIN contact_points p ON p.tenant_id = im.tenant_id AND p.kind = 'phone' AND p.address = im.from_address
     WHERE im.tenant_id = app.tenant_id() AND im.conversation_id = ${conversationId} AND im.direction = 'inbound' AND im.channel = 'sms'
       AND im.opt_out_keyword IS NOT NULL AND im.created_at >= ${toIso(now)}::timestamptz - interval '24 hours'`.execute(tx);
  return r.rows.map((x) => Buffer.from(x.h).toString('hex'));
}

/**
 * core-compliance/3.0.0 (R-CHAN-2): whether the contact, or a duplicate merged into it, carries the
 * person-level do-not-contact. Read under the caller's RLS; the DB guard re-checks as a definer.
 */
export async function personDoNotContact(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ dnc: boolean }>`
    SELECT EXISTS (SELECT 1 FROM contacts c
                    WHERE c.tenant_id = app.tenant_id() AND c.do_not_contact_at IS NOT NULL
                      AND (c.id = ${contactId} OR c.merged_into_contact_id = ${contactId})) AS dnc`.execute(tx);
  return r.rows[0]?.dnc === true;
}

export async function conversationOf(tx: Tx, contactId: string): Promise<ConversationRow | null> {
  const r = await sql<{ id: string; contact_id: string; automation_paused_at: Date | null; automation_pause_reason: string | null; last_inbound_at: Date | null; inbound_seq: string; sticky_phone_number_id: string | null }>`
    SELECT id, contact_id, automation_paused_at, automation_pause_reason, last_inbound_at, inbound_seq, sticky_phone_number_id
      FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  const c = r.rows[0];
  if (!c) return null;
  return {
    id: c.id,
    contactId: c.contact_id,
    pausedAt: c.automation_paused_at ? instantFromDate(c.automation_paused_at) : null,
    pauseReason: c.automation_pause_reason,
    lastInboundAt: c.last_inbound_at ? instantFromDate(c.last_inbound_at) : null,
    inboundSeq: Number(c.inbound_seq),
    stickyPhoneNumberId: c.sticky_phone_number_id,
  };
}

export async function numberFacts(tx: Tx, id: string): Promise<(NumberFacts & { e164: string; purpose: string; assignedUserId: string | null }) | null> {
  const r = await sql<{ id: string; e164: string; number_type: 'local' | 'toll_free'; sms_capable: boolean; voice_capable: boolean; released_at: Date | null; reg_status: string | null; purpose: string; assigned_user_id: string | null }>`
    SELECT n.id, n.e164, n.number_type, n.sms_capable, n.voice_capable, n.released_at, r.status AS reg_status, n.purpose, n.assigned_user_id
      FROM phone_numbers n LEFT JOIN sender_registrations r ON r.tenant_id = n.tenant_id AND r.id = n.registration_id
     WHERE n.tenant_id = app.tenant_id() AND n.id = ${id}`.execute(tx);
  const n = r.rows[0];
  if (!n) return null;
  return {
    id: n.id as PhoneNumberId,
    e164: n.e164,
    numberType: n.number_type,
    smsCapable: n.sms_capable,
    voiceCapable: n.voice_capable,
    released: n.released_at !== null,
    registrationStatus: (n.reg_status ?? 'none') as RegistrationStatus,
    purpose: n.purpose,
    assignedUserId: n.assigned_user_id,
  };
}

/** Live numbers: the user's direct numbers and the team main numbers (sender choice, R-CONSENT-17). */
export async function candidateNumbers(tx: Tx, userId: string | null): Promise<{ direct: string | null; teamMain: string | null }> {
  const r = await sql<{ id: string; purpose: string; assigned_user_id: string | null }>`
    SELECT id, purpose, assigned_user_id FROM phone_numbers
     WHERE tenant_id = app.tenant_id() AND released_at IS NULL AND sms_capable
       AND (purpose = 'team_main' OR (purpose = 'agent_direct' AND assigned_user_id = ${userId}))
     ORDER BY acquired_at, id`.execute(tx);
  return {
    direct: r.rows.find((n) => n.purpose === 'agent_direct')?.id ?? null,
    teamMain: r.rows.find((n) => n.purpose === 'team_main')?.id ?? null,
  };
}

export async function emailIdentityFacts(tx: Tx, id: string): Promise<{ id: string; fromAddress: string; displayName: string; status: 'active' | 'disabled'; domain: { verifiedAt: Date | null } | null } | null> {
  const r = await sql<{ id: string; from_address: string; display_name: string; status: 'active' | 'disabled'; domain_id: string | null; verified_at: Date | null }>`
    SELECT i.id, i.from_address, i.display_name, i.status, i.domain_id, d.verified_at
      FROM email_identities i LEFT JOIN sending_domains d ON d.tenant_id = i.tenant_id AND d.id = i.domain_id
     WHERE i.tenant_id = app.tenant_id() AND i.id = ${id}`.execute(tx);
  const e = r.rows[0];
  if (!e) return null;
  return { id: e.id, fromAddress: e.from_address, displayName: e.display_name, status: e.status, domain: e.domain_id === null ? null : { verifiedAt: e.verified_at } };
}

/** The sender's own active identity, else the team identity (user_id NULL). */
export async function chooseEmailIdentity(tx: Tx, userId: string | null): Promise<string | null> {
  const r = await sql<{ id: string }>`
    SELECT id FROM email_identities WHERE tenant_id = app.tenant_id() AND status = 'active'
       AND (user_id = ${userId} OR user_id IS NULL)
     ORDER BY (user_id IS NULL), created_at, id LIMIT 1`.execute(tx);
  return r.rows[0]?.id ?? null;
}
