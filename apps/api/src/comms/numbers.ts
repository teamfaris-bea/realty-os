// Sending identity administration (Owner/Admin): phone numbers, 10DLC / toll-free registrations,
// sending domains and email identities (R-TEN-8, R-CONSENT-17, R-CONSENT-18; E46, E55; R-AUDIT-5).
//
// - Numbers live in the tenant's own provider subaccount (created, and its secret field-encrypted, the
//   first time a number is acquired). A live e164 is globally unique and a released number is
//   quarantined for 90 days across tenants (DB index + trigger, R-TEN-8). Release is 🔒 (R-PERM-13).
// - A number sends SMS only while its registration is approved (the gate's SENDER_NOT_REGISTERED):
//   refreshing a registration that the carrier suspended blocks every send from its numbers (E46);
//   there is no fallback to another campaign's number.
// - A sending domain is verified only with SPF + DKIM + DMARC passing (DB CHECK).
import type { Instant, TenantId, UserActor } from '@realty/core/foundation';
import { DAY_MS, plusMs, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { storeTelephonyAccount, telephonyAccount } from './repos/credentials.js';
import { adminUserIds, notifyUser } from './repos/notify.js';
import { asUser } from './runtime.js';
import { SYSTEM_NOTICE, type CommsDeps } from './types.js';
import { TELEPHONY_LIVE_OFF } from '../providers/twilio/http.js';
import { clearSenderNotVerified } from './telephonySafeguards.js';

/** R-TWL-1: the kill switch refused the provider request: answered with its own sentence (TELEPHONY_LIVE_OFF). */
function liveOffOr(e: unknown, code: 'PROVIDER_UNAVAILABLE' | 'NUMBER_UNAVAILABLE'): AppError {
  return new AppError(e instanceof ProviderError && e.providerCode === TELEPHONY_LIVE_OFF ? 'TELEPHONY_LIVE_OFF' : code);
}

export interface NumberView {
  id: string;
  e164: string;
  purpose: string;
  numberType: string;
  assignedUserId: string | null;
  registrationId: string | null;
  registrationStatus: string | null;
  smsCapable: boolean;
  voiceCapable: boolean;
  releasedAt: string | null;
  leadSourceId: string | null;
  /** b9 review sends/F1 (R-TWL-9): the carrier reported this number unverified for texting; null when it may text */
  textingPausedDetail: string | null;
}

async function listNumbersTx(tx: Tx): Promise<NumberView[]> {
  const r = await sql<{ id: string; e164: string; purpose: string; number_type: string; assigned_user_id: string | null; registration_id: string | null; status: string | null; sms_capable: boolean; voice_capable: boolean; released_at: Date | null; lead_source_id: string | null; sender_not_verified_detail: string | null }>`
    SELECT n.id, n.e164, n.purpose, n.number_type, n.assigned_user_id, n.registration_id, r.status, n.sms_capable, n.voice_capable, n.released_at, n.lead_source_id, n.sender_not_verified_detail
      FROM phone_numbers n LEFT JOIN sender_registrations r ON r.tenant_id = n.tenant_id AND r.id = n.registration_id
     WHERE n.tenant_id = app.tenant_id() ORDER BY n.acquired_at, n.id`.execute(tx);
  return r.rows.map((n) => ({
    id: n.id,
    e164: n.e164,
    purpose: n.purpose,
    numberType: n.number_type,
    assignedUserId: n.assigned_user_id,
    registrationId: n.registration_id,
    registrationStatus: n.status,
    smsCapable: n.sms_capable,
    voiceCapable: n.voice_capable,
    releasedAt: n.released_at ? n.released_at.toISOString() : null,
    leadSourceId: n.lead_source_id,
    textingPausedDetail: n.sender_not_verified_detail,
  }));
}

export function listNumbers(actor: UserActor, deps: CommsDeps): Promise<NumberView[]> {
  return asUser(deps, actor, (tx) => listNumbersTx(tx));
}

/** module 22 (R-TRK-1): the lead source a tracking number may credit: this tenant's, and on. */
async function trackingSource(tx: Tx, leadSourceId: string, o: { forShare?: boolean } = {}): Promise<{ name: string; active: boolean } | null> {
  const r = o.forShare
    ? await sql<{ name: string; active: boolean }>`SELECT name, active FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${leadSourceId}::uuid FOR SHARE`.execute(tx)
    : await sql<{ name: string; active: boolean }>`SELECT name, active FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${leadSourceId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function acquireNumber(actor: UserActor, input: { purpose: 'team_main' | 'agent_direct' | 'pond' | 'tracking'; areaCode?: string | undefined; assignedUserId?: string | undefined; registrationId?: string | undefined; leadSourceId?: string | undefined }, deps: CommsDeps): Promise<NumberView & { notice?: string }> {
  if (input.purpose === 'agent_direct' && !input.assignedUserId) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/assignedUserId', code: 'required_for_agent_direct' }] });
  // module 22 (R-TRK-1): the source is checked BEFORE the purchase, so nothing fails after one (E352)
  if (input.leadSourceId !== undefined) {
    if (input.purpose !== 'tracking') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/leadSourceId', code: 'tracking_only' }] });
    const src = await asUser(deps, actor, (tx) => trackingSource(tx, input.leadSourceId!));
    if (!src) throw new AppError('NOT_FOUND');
    if (!src.active) throw new AppError('LEAD_SOURCE_OFF');
  }
  // the subaccount (once per tenant)
  let account = await asUser(deps, actor, (tx) => telephonyAccount(tx, deps.envelope, actor.tenantId));
  if (!account) {
    try {
      account = await deps.providers.telephony.createSubaccount(actor.tenantId, `tenant-${actor.tenantId.slice(0, 8)}`);
    } catch (e) {
      throw liveOffOr(e, 'PROVIDER_UNAVAILABLE');
    }
    const acc = account;
    await asUser(deps, actor, (tx) => storeTelephonyAccount(tx, deps.envelope, deps.ids, actor.tenantId, acc, actor.userId));
  }
  let bought: { e164: string; providerRef: string };
  try {
    bought = await deps.providers.telephony.purchaseNumber(account, input.areaCode ? { areaCode: input.areaCode } : {});
  } catch (e) {
    throw liveOffOr(e, e instanceof ProviderError && e.kind === 'rejected' ? 'NUMBER_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE');
  }
  const id = deps.ids.next<'PhoneNumberId'>();
  try {
    return await asUser(deps, actor, async (tx, now) => {
      // the source again, FOR SHARE: turned off since the check, the number is still saved, untied, and the answer says so
      const src = input.leadSourceId !== undefined ? await trackingSource(tx, input.leadSourceId, { forShare: true }) : null;
      const tie = src?.active ? input.leadSourceId! : null;
      await sql`
        INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, assigned_user_id, sms_capable, voice_capable,
          registration_id, acquired_at, lead_source_id)
        VALUES (app.tenant_id(), ${id}, ${bought.e164}, 'telephony', ${bought.providerRef}, ${/^\+18(00|33|44|55|66|77|88)/.test(bought.e164) ? 'toll_free' : 'local'}, ${input.purpose},
          ${input.assignedUserId ?? null}, true, true, ${input.registrationId ?? null}, ${toIso(now)}::timestamptz, ${tie}::uuid)`.execute(tx);
      await audit(tx, actor, { action: 'number.acquired', entity: { type: 'phone_number', id }, changes: redactSnapshot({ purpose: input.purpose, registrationId: input.registrationId ?? null, ...(tie ? { leadSourceId: tie } : {}) }, { entity: 'phone_number' }) });
      const view = (await listNumbersTx(tx)).find((n) => n.id === id)!;
      return src && !tie ? { ...view, notice: `Bought, but not tied to ${src.name}: that source was turned off.` } : view;
    });
  } catch (e) {
    const msg = (e as { message?: string }).message ?? '';
    if (msg.startsWith('NUMBER_QUARANTINED') || (e as { code?: string }).code === '23505') throw new AppError('NUMBER_UNAVAILABLE');
    throw e;
  }
}

/** 🔒 Release: the provider releases it; the row keeps a 90-day cross-tenant quarantine (R-TEN-8, E55). */
export async function releaseNumber(actor: UserActor, numberId: string, deps: CommsDeps): Promise<NumberView> {
  const row = await asUser(deps, actor, async (tx) => (await listNumbersTx(tx)).find((n) => n.id === numberId) ?? null);
  if (!row) throw new AppError('NOT_FOUND');
  if (row.releasedAt) return row;
  const account = await asUser(deps, actor, (tx) => telephonyAccount(tx, deps.envelope, actor.tenantId));
  const ref = await asUser(deps, actor, async (tx) => (await sql<{ provider_ref: string }>`SELECT provider_ref FROM phone_numbers WHERE tenant_id = app.tenant_id() AND id = ${numberId}`.execute(tx)).rows[0]?.provider_ref);
  if (account && ref) {
    try {
      await deps.providers.telephony.releaseNumber(account, ref);
    } catch (e) {
      throw liveOffOr(e, 'PROVIDER_UNAVAILABLE');
    }
  }
  return asUser(deps, actor, async (tx, now) => {
    await sql`
      UPDATE phone_numbers SET released_at = ${toIso(now)}::timestamptz, quarantine_until = ${toIso(plusMs(now, 90 * DAY_MS))}::timestamptz
       WHERE tenant_id = app.tenant_id() AND id = ${numberId} AND released_at IS NULL`.execute(tx);
    await audit(tx, actor, { action: 'number.released', entity: { type: 'phone_number', id: numberId } });
    return (await listNumbersTx(tx)).find((n) => n.id === numberId)!;
  });
}

export async function attachRegistration(actor: UserActor, numberId: string, registrationId: string | null, deps: CommsDeps): Promise<NumberView> {
  return asUser(deps, actor, async (tx) => {
    const r = await sql`UPDATE phone_numbers SET registration_id = ${registrationId} WHERE tenant_id = app.tenant_id() AND id = ${numberId} AND released_at IS NULL`.execute(tx);
    if (Number(r.numAffectedRows ?? 0n) !== 1) throw new AppError('NOT_FOUND');
    // b9 review sends/F1: a new registration is new facts; an unverified-sender flag is re-learned from the next error
    await clearSenderNotVerified(tx, { phoneNumberId: numberId });
    await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'phone_number', id: numberId }, changes: redactSnapshot({ registrationId }, { entity: 'phone_number' }), reason: 'NUMBER_REGISTRATION_ATTACHED' });
    return (await listNumbersTx(tx)).find((n) => n.id === numberId)!;
  });
}

/** module 22 (R-TRK-1): tie a live tracking number to an active lead source of this tenant, or untie it; audited. */
export async function setNumberLeadSource(actor: UserActor, numberId: string, leadSourceId: string | null, deps: CommsDeps): Promise<NumberView> {
  return asUser(deps, actor, async (tx) => {
    const r = await sql<{ purpose: string; released_at: Date | null; lead_source_id: string | null }>`
      SELECT purpose, released_at, lead_source_id FROM phone_numbers WHERE tenant_id = app.tenant_id() AND id = ${numberId}::uuid FOR UPDATE`.execute(tx);
    const n = r.rows[0];
    if (!n) throw new AppError('NOT_FOUND');
    if (n.purpose !== 'tracking' || n.released_at !== null) throw new AppError('NUMBER_NOT_TRACKING');
    if (leadSourceId !== null) {
      const src = await trackingSource(tx, leadSourceId, { forShare: true });
      if (!src) throw new AppError('NOT_FOUND');
      if (!src.active) throw new AppError('LEAD_SOURCE_OFF');
    }
    if (n.lead_source_id !== leadSourceId) {
      await sql`UPDATE phone_numbers SET lead_source_id = ${leadSourceId}::uuid, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${numberId}::uuid`.execute(tx);
      await audit(tx, actor, { action: 'number.lead_source_changed', entity: { type: 'phone_number', id: numberId }, changes: redactSnapshot({ from: n.lead_source_id, to: leadSourceId }, { entity: 'phone_number' }) });
    }
    return (await listNumbersTx(tx)).find((x) => x.id === numberId)!;
  });
}

export interface RegistrationView {
  id: string;
  kind: string;
  status: string;
  useCase: string;
  statusChangedAt: string;
}

export async function createRegistration(actor: UserActor, input: { kind: 'a2p_campaign' | 'toll_free_verification'; useCase: string; sampleMessages: string[]; optInDescription: string; providerCampaignRef?: string | undefined }, deps: CommsDeps): Promise<RegistrationView> {
  return asUser(deps, actor, async (tx) => {
    const id = deps.ids.next<'SenderRegistrationId'>();
    await sql`
      INSERT INTO sender_registrations (tenant_id, id, kind, provider, provider_campaign_ref, use_case, sample_messages, opt_in_description, status)
      VALUES (app.tenant_id(), ${id}, ${input.kind}, 'telephony', ${input.providerCampaignRef ?? id}, ${input.useCase}, ${JSON.stringify(input.sampleMessages)}::jsonb,
              ${input.optInDescription}, 'submitted')`.execute(tx);
    await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'sender_registration', id }, changes: redactSnapshot({ kind: input.kind, status: 'submitted' }, { entity: 'sender_registration' }), reason: 'REGISTRATION_SUBMITTED' });
    return registrationView(tx, id);
  });
}

async function registrationView(tx: Tx, id: string): Promise<RegistrationView> {
  const r = await sql<{ id: string; kind: string; status: string; use_case: string; status_changed_at: Date }>`
    SELECT id, kind, status, use_case, status_changed_at FROM sender_registrations WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const x = r.rows[0];
  if (!x) throw new AppError('NOT_FOUND');
  return { id: x.id, kind: x.kind, status: x.status, useCase: x.use_case, statusChangedAt: x.status_changed_at.toISOString() };
}

/** Pulls the carrier status; a suspension blocks every SMS from its numbers at send time (E46) and alerts Admins. */
export async function refreshRegistration(actor: UserActor, registrationId: string, deps: CommsDeps): Promise<RegistrationView> {
  const pre = await asUser(deps, actor, async (tx) => {
    const r = await sql<{ provider_campaign_ref: string | null; status: string }>`SELECT provider_campaign_ref, status FROM sender_registrations WHERE tenant_id = app.tenant_id() AND id = ${registrationId}`.execute(tx);
    return r.rows[0] ?? null;
  });
  if (!pre) throw new AppError('NOT_FOUND');
  const account = await asUser(deps, actor, (tx) => telephonyAccount(tx, deps.envelope, actor.tenantId));
  if (!account) throw new AppError('PROVIDER_UNAVAILABLE');
  let status: 'pending' | 'approved' | 'rejected' | 'suspended';
  try {
    status = await deps.providers.telephony.senderRegistrationStatus(account, pre.provider_campaign_ref ?? registrationId);
  } catch (e) {
    throw liveOffOr(e, 'PROVIDER_UNAVAILABLE');
  }
  const mapped = status === 'pending' ? 'submitted' : status;
  return asUser(deps, actor, async (tx, now) => {
    if (mapped !== pre.status) {
      // R-TWL-9: a fresh carrier status replaces the SENDER_NOT_VERIFIED detail an unverified-sender error left
      await sql`UPDATE sender_registrations SET status = ${mapped}, status_detail = NULL, status_changed_at = ${toIso(now)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${registrationId}`.execute(tx);
      await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'sender_registration', id: registrationId }, changes: redactSnapshot({ status: mapped }, { entity: 'sender_registration' }), reason: 'REGISTRATION_STATUS' });
      if (mapped === 'suspended' || mapped === 'rejected') await alertAdmins(tx, deps, registrationId, mapped, now);
    }
    // b9 review sends/F1 (R-TWL-9): the carrier reports the campaign approved: its numbers' unverified-sender flags clear
    if (mapped === 'approved') {
      for (const id of await clearSenderNotVerified(tx, { registrationId })) {
        await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'phone_number', id }, reason: 'SENDER_VERIFIED_AGAIN' });
      }
    }
    return registrationView(tx, registrationId);
  });
}

async function alertAdmins(tx: Tx, deps: CommsDeps, registrationId: string, status: string, now: Instant): Promise<void> {
  for (const u of await adminUserIds(tx)) {
    await notifyUser(tx, deps.ids, { userId: u, kind: SYSTEM_NOTICE, priority: 'high', title: `Texting registration ${status}`, body: 'Texts from its numbers are blocked until it is approved again.', subjectType: 'sender_registration', subjectId: registrationId, dedupeKey: `registration:${registrationId}:${status}` }, now);
  }
}

// ---- email ----------------------------------------------------------------------------------------

export interface DomainView {
  id: string;
  domain: string;
  spf: string;
  dkim: string;
  dmarc: string;
  verifiedAt: string | null;
  records: { type: string; name: string; value: string }[];
}

export async function addDomain(actor: UserActor, domain: string, deps: CommsDeps): Promise<DomainView> {
  return asUser(deps, actor, async (tx) => {
    const id = deps.ids.next<'SendingDomainId'>();
    try {
      await sql`INSERT INTO sending_domains (tenant_id, id, domain) VALUES (app.tenant_id(), ${id}, ${domain.toLowerCase()})`.execute(tx);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VERSION_CONFLICT', { field: 'domain' });
      throw e;
    }
    await audit(tx, actor, { action: 'domain.changed', entity: { type: 'sending_domain', id }, reason: 'DOMAIN_ADDED' });
    return { id, domain: domain.toLowerCase(), spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', verifiedAt: null, records: [] };
  });
}

export async function verifyDomain(actor: UserActor, domainId: string, deps: CommsDeps): Promise<DomainView> {
  const d = await asUser(deps, actor, async (tx) => (await sql<{ domain: string }>`SELECT domain FROM sending_domains WHERE tenant_id = app.tenant_id() AND id = ${domainId}`.execute(tx)).rows[0]);
  if (!d) throw new AppError('NOT_FOUND');
  let v;
  try {
    v = await deps.providers.email.verifyDomain(d.domain);
  } catch {
    throw new AppError('PROVIDER_UNAVAILABLE');
  }
  const pass = (b: boolean) => (b ? 'pass' : 'fail');
  return asUser(deps, actor, async (tx, now) => {
    const all = v.spf && v.dkim && v.dmarc;
    await sql`
      UPDATE sending_domains SET spf_status = ${pass(v.spf)}, dkim_status = ${pass(v.dkim)}, dmarc_status = ${pass(v.dmarc)},
             last_checked_at = ${toIso(now)}::timestamptz, verified_at = ${all ? toIso(now) : null}::timestamptz
       WHERE tenant_id = app.tenant_id() AND id = ${domainId}`.execute(tx);
    await audit(tx, actor, { action: 'domain.changed', entity: { type: 'sending_domain', id: domainId }, changes: redactSnapshot({ verified: all }, { entity: 'sending_domain' }), reason: 'DOMAIN_VERIFIED' });
    return { id: domainId, domain: d.domain, spf: pass(v.spf), dkim: pass(v.dkim), dmarc: pass(v.dmarc), verifiedAt: all ? toIso(now) : null, records: v.records };
  });
}

export async function addEmailIdentity(actor: UserActor, input: { fromAddress: string; displayName: string; userId?: string | undefined; domainId?: string | undefined }, deps: CommsDeps): Promise<{ id: string; fromAddress: string; displayName: string; userId: string | null; domainId: string | null }> {
  return asUser(deps, actor, async (tx) => {
    const id = deps.ids.next<'EmailIdentityId'>();
    if (input.domainId) {
      const dom = await sql<{ domain: string }>`SELECT domain FROM sending_domains WHERE tenant_id = app.tenant_id() AND id = ${input.domainId}`.execute(tx);
      if (!dom.rows[0]) throw new AppError('NOT_FOUND');
      if (!input.fromAddress.toLowerCase().endsWith(`@${dom.rows[0].domain}`)) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/fromAddress', code: 'domain_mismatch' }] });
    }
    try {
      await sql`
        INSERT INTO email_identities (tenant_id, id, user_id, domain_id, from_address, display_name)
        VALUES (app.tenant_id(), ${id}, ${input.userId ?? null}, ${input.domainId ?? null}, ${input.fromAddress.toLowerCase()}, ${input.displayName})`.execute(tx);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VERSION_CONFLICT', { field: 'fromAddress' });
      if ((e as { code?: string }).code === '23503') throw new AppError('NOT_FOUND');
      throw e;
    }
    await audit(tx, actor, { action: 'domain.changed', entity: { type: 'email_identity', id }, reason: 'EMAIL_IDENTITY_ADDED' });
    return { id, fromAddress: input.fromAddress.toLowerCase(), displayName: input.displayName, userId: input.userId ?? null, domainId: input.domainId ?? null };
  });
}

export type { TenantId };
