// Reads that assemble a GateInput (ARCHITECTURE §9 "Inputs"), under the caller's RLS inside the dispatch
// transaction. Addresses are joined by HMAC; no plaintext address leaves these queries into the gate.
import type { ConsentStateRow, DncCheckRow, JurisdictionPackRow, LineType, NumberFacts, PointStatus, RegistrationStatus, SuppressionRow, TenantPolicyVersion } from '@realty/core/compliance';
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
    contact_window_start: string;
    contact_window_end: string;
    human_reply_window_minutes: number;
    email_quiet_hours: boolean;
    auto_sms_per_24h: number;
    auto_sms_per_7d: number;
    auto_email_per_24h: number;
    auto_email_per_7d: number;
    auto_cross_channel_per_24h: number;
    manual_sms_confirm_after_24h: number;
    call_attempts_per_24h: number;
    max_deferrals: number;
    autonomous_categories: string[];
    opt_out_confirmation_sender: 'provider' | 'platform';
    recording_enabled: boolean;
    recording_mode: 'announce_all' | 'one_party_where_permitted';
    loosening_attestation: string | null;
  }>`SELECT * FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const p = r.rows[0];
  if (!p) throw new Error('active compliance policy not visible');
  return {
    id: p.id,
    contactWindowStart: p.contact_window_start,
    contactWindowEnd: p.contact_window_end,
    humanReplyWindowMinutes: p.human_reply_window_minutes,
    emailQuietHours: p.email_quiet_hours,
    autoSmsPer24h: p.auto_sms_per_24h,
    autoSmsPer7d: p.auto_sms_per_7d,
    autoEmailPer24h: p.auto_email_per_24h,
    autoEmailPer7d: p.auto_email_per_7d,
    autoCrossChannelPer24h: p.auto_cross_channel_per_24h,
    manualSmsConfirmAfter24h: p.manual_sms_confirm_after_24h,
    callAttemptsPer24h: p.call_attempts_per_24h,
    maxDeferrals: p.max_deferrals,
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

export async function dncRows(tx: Tx, hmac: string): Promise<DncCheckRow[]> {
  const r = await sql<{ registry: string; listed: boolean; checked_at: Date; valid_until: Date }>`
    SELECT registry, listed, checked_at, valid_until FROM dnc_checks WHERE tenant_id = app.tenant_id() AND phone_hmac = ${hmacBytes(hmac)}
     ORDER BY checked_at DESC LIMIT 20`.execute(tx);
  return r.rows.map((d) => ({ registry: d.registry, listed: d.listed, checkedAt: instantFromDate(d.checked_at), validUntil: instantFromDate(d.valid_until) }));
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

/** The contact's points (removed ones excluded), primary first. */
export async function contactPoints(tx: Tx, contactId: string): Promise<PointRow[]> {
  const r = await sql<Parameters<typeof point>[0]>`
    SELECT id, contact_id, kind, address, address_hmac, status, line_type, timezone, is_primary FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND removed_at IS NULL
     ORDER BY is_primary DESC, created_at, id`.execute(tx);
  return r.rows.map(point);
}

export async function contactZone(tx: Tx, contactId: string): Promise<{ timezone: string | null; source: string | null } | null> {
  const r = await sql<{ timezone: string | null; timezone_source: string | null }>`
    SELECT timezone, timezone_source FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  return r.rows[0] ? { timezone: r.rows[0].timezone, source: r.rows[0].timezone_source } : null;
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

/** Automated (assistant/system) sends to the contact in the last 7 days that count toward caps (R-CONSENT-14). */
export async function recentAutomated(tx: Tx, contactId: string, pointId: string | null, now: Instant, excludeId: string | null): Promise<{ channel: 'sms' | 'email'; at: Instant; category: string; sameAddress: boolean }[]> {
  const r = await sql<{ channel: string; dispatched_at: Date; action_category: string; same: boolean }>`
    SELECT m.channel, m.dispatched_at, m.action_category,
           (m.to_address = (SELECT p.address FROM contact_points p WHERE p.tenant_id = m.tenant_id AND p.id = ${pointId})) IS TRUE AS same
      FROM messages m
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${contactId} AND m.direction = 'outbound'
       AND m.initiator IN ('assistant','system') AND NOT m.imported
       AND m.status IN ('dispatching','sent','delivered','dispatch_unknown')
       AND m.dispatched_at > ${toIso(now)}::timestamptz - interval '7 days'
       AND (${excludeId}::uuid IS NULL OR m.id <> ${excludeId}::uuid)`.execute(tx);
  return r.rows.map((x) => ({ channel: x.channel === 'email' ? 'email' : 'sms', at: instantFromDate(x.dispatched_at), category: x.action_category, sameAddress: x.same }));
}

export async function manualSms24h(tx: Tx, contactId: string, now: Instant, excludeId: string | null): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM messages m
     WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${contactId} AND m.direction = 'outbound' AND m.initiator = 'human'
       AND m.channel IN ('sms','mms') AND m.status IN ('dispatching','sent','delivered','dispatch_unknown')
       AND m.dispatched_at > ${toIso(now)}::timestamptz - interval '24 hours'
       AND (${excludeId}::uuid IS NULL OR m.id <> ${excludeId}::uuid)`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export async function callAttempts24h(tx: Tx, contactId: string, now: Instant): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM calls c
     WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${contactId} AND c.direction = 'outbound' AND NOT c.imported
       AND c.started_at > ${toIso(now)}::timestamptz - interval '24 hours'`.execute(tx);
  return r.rows[0]?.n ?? 0;
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
