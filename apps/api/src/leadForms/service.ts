// Google Ads lead forms (module 22 scope 7; DATA_MODEL R-GADS-1..4, E313–E319, E338, E381–E383).
//
// receiveGoogleLead: one delivery whose key the guard resolved (leadForms/auth.ts), in ONE transaction as the system
// actor of the hook's tenant (R-TEN-3: the tenant comes only from the key):
//   - the source was turned off since the key resolved ⇒ 403 (the only 4XX once the key resolved; the delivery is
//     marked failed, so Google's retry is processed again once the source is on: R-LSRC-7)
//   - is_test ⇒ last_test_at only (no contact, inquiry or job; R-GADS-3 E314)
//   - no usable lead_id, or nothing intake could make a contact of (no name, no valid phone or email) ⇒
//     unreadable_count + 1 and last_unreadable_at (R-GADS-3 E317). Nothing of the content is stored, logged or
//     audited. Intake's own INQUIRY_EMPTY / VALIDATION_FAILED are rolled back to a savepoint and counted the same way.
//   - else the existing intake (ingestInquiryInTx: dedupe, routing, consent history, the default 60-second first
//     response). externalId gads:<lead_id> makes Google's re-post of one lead a duplicate (E313). The hook's
//     cites_source_disclosure false ⇒ disclosure 'none' (the form did not show the source's consent text).
// Hook writes only touch the CURRENT row (retired_at IS NULL): a delivery that raced a rotation still lands as a lead.
//
// Owner/Admin (getHook, enableHook, rotateHook, patchHook, disableHook): as the system actor after re-reading the
// role (leads/sources.ts asSystem); every write takes the source's credential lock first (lockCredentials), so two
// turn-ons give one 200 and one 409 (E383) and two rotations both succeed with only the later key current (E338).
// The key is 160 random bits as 40 lowercase hex characters (VERIFY: Google's key field accepts it; the help page
// describes the key as any string the advertiser chooses), envelope-encrypted (re-shown to Owner/Admin), routed only
// by sha256. No audit row carries the key.
import { randomBytes } from 'node:crypto';
import type { Instant, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { ingestInquiryInTx } from '../leads/intake.js';
import { type SourcesDeps, asSystem, lockCredentials, publicHttps } from '../leads/sources.js';
import { systemActor } from '../worker/systemActor.js';
import { type GoogleLeadHook, keyHash } from './auth.js';
import { type GoogleLead, type InquiryType, isReadable, toInquiry } from './google.js';

export type GoogleLeadDeps = Pick<SourcesDeps, 'db' | 'envelope' | 'ids' | 'publicBaseUrl'>;

export const WEBHOOK_PATH = '/api/webhooks/google-ads/lead-form';
export const webhookUrlOf = (publicBaseUrl: string): string => new URL(WEBHOOK_PATH, publicBaseUrl).toString();

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---- receiving -----------------------------------------------------------------------------------------

export type ReceiveOutcome = 'test' | 'unreadable' | 'new_contact' | 'attached' | 'reinquiry' | 'duplicate_ignored';

async function markUnreadable(tx: Tx, hookId: string): Promise<'unreadable'> {
  await sql`UPDATE google_lead_form_hooks SET unreadable_count = unreadable_count + 1, last_unreadable_at = clock_timestamp()
             WHERE tenant_id = app.tenant_id() AND id = ${hookId}::uuid AND retired_at IS NULL`.execute(tx);
  return 'unreadable';
}

const UNREADABLE_CODES = new Set(['INQUIRY_EMPTY', 'VALIDATION_FAILED']);
let sp = 0;

async function receiveInTx(tx: Tx, actor: SystemActor, deps: GoogleLeadDeps, hook: GoogleLeadHook, lead: GoogleLead, now: Instant): Promise<ReceiveOutcome> {
  const row = (
    await sql<{ active: boolean; inquiry_type: InquiryType; cites_source_disclosure: boolean }>`
      SELECT s.active, h.inquiry_type, h.cites_source_disclosure
        FROM google_lead_form_hooks h JOIN lead_sources s ON s.tenant_id = h.tenant_id AND s.id = h.lead_source_id
       WHERE h.tenant_id = app.tenant_id() AND h.id = ${hook.hookId}::uuid AND h.lead_source_id = ${hook.leadSourceId}::uuid`.execute(tx)
  ).rows[0];
  // turned off since the key resolved (the only 4XX after a resolved key)
  if (!row || !row.active) throw new AppError('WEBHOOK_SIGNATURE_INVALID');
  if (lead.isTest) {
    await sql`UPDATE google_lead_form_hooks SET last_test_at = clock_timestamp()
               WHERE tenant_id = app.tenant_id() AND id = ${hook.hookId}::uuid AND retired_at IS NULL`.execute(tx);
    return 'test';
  }
  if (lead.leadId === null) return markUnreadable(tx, hook.hookId);
  const inquiry = toInquiry(lead, { leadSourceId: hook.leadSourceId, inquiryType: row.inquiry_type });
  if (!isReadable(inquiry)) return markUnreadable(tx, hook.hookId);
  const name = sql.raw(`gads_sp_${(sp = (sp + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    const res = await ingestInquiryInTx(tx, actor, inquiry, now, { envelope: deps.envelope, ids: deps.ids }, row.cites_source_disclosure ? {} : { disclosure: 'none' });
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return res.outcome;
  } catch (e) {
    const unreadable = e instanceof ZodError || (e instanceof AppError && UNREADABLE_CODES.has(e.code));
    if (!unreadable) {
      if (e instanceof AppError && e.code === 'NOT_FOUND') throw new AppError('WEBHOOK_SIGNATURE_INVALID'); // source off in between
      throw e;
    }
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return markUnreadable(tx, hook.hookId);
  }
}

export async function receiveGoogleLead(deps: GoogleLeadDeps, hook: GoogleLeadHook, lead: GoogleLead): Promise<ReceiveOutcome> {
  const actor = systemActor(hook.tenantId, 'provider');
  return withTenantTx(actor, (tx, now) => receiveInTx(tx, actor, deps, hook, lead, now), { db: deps.db, retries: 3 });
}

// ---- Owner/Admin -----------------------------------------------------------------------------------------

export interface HookView {
  state: 'on' | 'off' | 'not_available';
  webhookUrl: string | null;
  key: string | null;
  createdAt: string | null;
  inquiryType: InquiryType | null;
  citesSourceDisclosure: boolean | null;
  lastTestAt: string | null;
  lastLeadAt: string | null;
  lastUnreadableAt: string | null;
  unreadableCount: number;
  sourceHasConsentText: boolean;
}

interface HookRow {
  id: string;
  key_enc: Buffer;
  created_at: Date;
  inquiry_type: InquiryType;
  cites_source_disclosure: boolean;
  last_test_at: Date | null;
  last_unreadable_at: Date | null;
  unreadable_count: number;
}

async function currentHook(tx: Tx, leadSourceId: string): Promise<HookRow | null> {
  const r = await sql<HookRow>`
    SELECT id, key_enc, created_at, inquiry_type, cites_source_disclosure, last_test_at, last_unreadable_at, unreadable_count
      FROM google_lead_form_hooks WHERE tenant_id = app.tenant_id() AND lead_source_id = ${leadSourceId}::uuid AND retired_at IS NULL`.execute(tx);
  return r.rows[0] ?? null;
}

const aad = (hookId: string) => ({ table: 'google_lead_form_hooks', column: 'key_enc', rowId: hookId });

async function view(tx: Tx, deps: GoogleLeadDeps, tenantId: TenantId, leadSourceId: string, o: { withKey: boolean }): Promise<HookView> {
  const s = (
    await sql<{ has_text: boolean; last_lead_at: Date | null }>`
      SELECT s.consent_disclosure_id IS NOT NULL AS has_text,
             (SELECT i.received_at FROM lead_inquiries i
               WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id AND i.source_detail->>'channel' = 'google_lead_form'
                 AND i.outcome IN ('new_contact','attached','reinquiry')
               ORDER BY i.received_at DESC LIMIT 1) AS last_lead_at
        FROM lead_sources s WHERE s.tenant_id = app.tenant_id() AND s.id = ${leadSourceId}::uuid`.execute(tx)
  ).rows[0];
  if (!s) throw new AppError('NOT_FOUND');
  const https = publicHttps(deps.publicBaseUrl);
  const hook = await currentHook(tx, leadSourceId);
  const on = https && hook !== null;
  const key = on && o.withKey ? Buffer.from(await deps.envelope.inTx(tx, tenantId).decrypt(tenantId, aad(hook.id), hook.key_enc)).toString('utf8') : null;
  return {
    state: !https ? 'not_available' : hook ? 'on' : 'off',
    webhookUrl: https ? webhookUrlOf(deps.publicBaseUrl) : null,
    key,
    createdAt: iso(hook?.created_at),
    inquiryType: hook?.inquiry_type ?? null,
    citesSourceDisclosure: hook ? hook.cites_source_disclosure : null,
    lastTestAt: iso(hook?.last_test_at),
    lastLeadAt: iso(s.last_lead_at),
    lastUnreadableAt: iso(hook?.last_unreadable_at),
    unreadableCount: hook?.unreadable_count ?? 0,
    sourceHasConsentText: s.has_text,
  };
}

export async function getHook(deps: GoogleLeadDeps, actor: UserActor, leadSourceId: string): Promise<HookView> {
  return asSystem(deps.db, actor, (tx, sys) => view(tx, deps, sys.tenantId, leadSourceId, { withKey: true }));
}

export interface KeyIssued {
  key: string;
  webhookUrl: string;
  createdAt: string;
}

async function insertHook(tx: Tx, deps: GoogleLeadDeps, sys: SystemActor, actor: UserActor, leadSourceId: string, settings: { inquiryType: InquiryType; cites: boolean }): Promise<{ id: string; key: string; createdAt: Date }> {
  const key = randomBytes(20).toString('hex');
  const id = deps.ids.next<'GoogleLeadFormHookId'>();
  const enc = await deps.envelope.inTx(tx, sys.tenantId).encrypt(sys.tenantId, aad(id), Buffer.from(key, 'utf8'));
  const r = await sql<{ created_at: Date }>`
    INSERT INTO google_lead_form_hooks (tenant_id, id, lead_source_id, key_hash, key_enc, inquiry_type, cites_source_disclosure, created_by_user_id, created_at)
    VALUES (app.tenant_id(), ${id}::uuid, ${leadSourceId}::uuid, ${keyHash(key)}, ${Buffer.from(enc)}, ${settings.inquiryType}, ${settings.cites}, ${actor.userId}::uuid, clock_timestamp())
    RETURNING created_at`.execute(tx);
  return { id, key, createdAt: r.rows[0]!.created_at };
}

async function retire(tx: Tx, hookId: string): Promise<void> {
  await sql`UPDATE google_lead_form_hooks SET retired_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${hookId}::uuid AND retired_at IS NULL`.execute(tx);
}

function requireHttps(deps: GoogleLeadDeps): void {
  if (!publicHttps(deps.publicBaseUrl)) throw new AppError('GOOGLE_LEAD_FORM_NOT_AVAILABLE');
}

export async function enableHook(deps: GoogleLeadDeps, actor: UserActor, leadSourceId: string, body: { inquiryType: InquiryType; citesSourceDisclosure?: boolean | undefined }): Promise<KeyIssued> {
  requireHttps(deps);
  return asSystem(deps.db, actor, async (tx, sys) => {
    const s = await lockCredentials(tx, leadSourceId);
    if (!s) throw new AppError('NOT_FOUND');
    if (!s.active) throw new AppError('LEAD_SOURCE_OFF');
    if (await currentHook(tx, leadSourceId)) throw new AppError('GOOGLE_LEAD_FORM_ALREADY_ON', { googleLeadForm: await view(tx, deps, sys.tenantId, leadSourceId, { withKey: false }) });
    const cites = body.citesSourceDisclosure ?? false;
    const h = await insertHook(tx, deps, sys, actor, leadSourceId, { inquiryType: body.inquiryType, cites });
    await audit(tx, sys, {
      action: 'google_lead_form.enabled',
      entity: { type: 'google_lead_form_hook', id: h.id },
      changes: redactSnapshot({ lead_source_id: leadSourceId, inquiry_type: body.inquiryType, cites_source_disclosure_enabled: cites, by_user_id: actor.userId }),
      reason: 'ENABLED',
    });
    return { key: h.key, webhookUrl: webhookUrlOf(deps.publicBaseUrl), createdAt: h.createdAt.toISOString() };
  });
}

export async function rotateHook(deps: GoogleLeadDeps, actor: UserActor, leadSourceId: string): Promise<KeyIssued> {
  requireHttps(deps);
  return asSystem(deps.db, actor, async (tx, sys) => {
    const s = await lockCredentials(tx, leadSourceId);
    if (!s) throw new AppError('NOT_FOUND');
    if (!s.active) throw new AppError('LEAD_SOURCE_OFF');
    const old = await currentHook(tx, leadSourceId);
    if (!old) throw new AppError('NOT_FOUND');
    await retire(tx, old.id);
    const h = await insertHook(tx, deps, sys, actor, leadSourceId, { inquiryType: old.inquiry_type, cites: old.cites_source_disclosure });
    await audit(tx, sys, {
      action: 'google_lead_form.key_rotated',
      entity: { type: 'google_lead_form_hook', id: h.id },
      changes: redactSnapshot({ lead_source_id: leadSourceId, retired_hook_id: old.id, by_user_id: actor.userId }),
      reason: 'ROTATED',
    });
    return { key: h.key, webhookUrl: webhookUrlOf(deps.publicBaseUrl), createdAt: h.createdAt.toISOString() };
  });
}

export async function patchHook(deps: GoogleLeadDeps, actor: UserActor, leadSourceId: string, body: { inquiryType?: InquiryType | undefined; citesSourceDisclosure?: boolean | undefined }): Promise<HookView> {
  return asSystem(deps.db, actor, async (tx, sys) => {
    const s = await lockCredentials(tx, leadSourceId);
    if (!s) throw new AppError('NOT_FOUND');
    const h = await currentHook(tx, leadSourceId);
    if (!h) throw new AppError('NOT_FOUND');
    const next = { inquiry_type: body.inquiryType ?? h.inquiry_type, cites_source_disclosure_enabled: body.citesSourceDisclosure ?? h.cites_source_disclosure };
    const before = { inquiry_type: h.inquiry_type, cites_source_disclosure_enabled: h.cites_source_disclosure };
    if (next.inquiry_type !== before.inquiry_type || next.cites_source_disclosure_enabled !== before.cites_source_disclosure_enabled) {
      await sql`UPDATE google_lead_form_hooks SET inquiry_type = ${next.inquiry_type}, cites_source_disclosure = ${next.cites_source_disclosure_enabled}
                 WHERE tenant_id = app.tenant_id() AND id = ${h.id}::uuid AND retired_at IS NULL`.execute(tx);
      await audit(tx, sys, { action: 'google_lead_form.changed', entity: { type: 'google_lead_form_hook', id: h.id }, changes: redactDiff(before, next), reason: 'CHANGED' });
    }
    return view(tx, deps, sys.tenantId, leadSourceId, { withKey: false });
  });
}

/** Turns the form off: the key is retired forever (turning it on again makes a new key). Idempotent. */
export async function disableHook(deps: GoogleLeadDeps, actor: UserActor, leadSourceId: string): Promise<HookView> {
  return asSystem(deps.db, actor, async (tx, sys) => {
    const s = await lockCredentials(tx, leadSourceId);
    if (!s) throw new AppError('NOT_FOUND');
    const h = await currentHook(tx, leadSourceId);
    if (h) {
      await retire(tx, h.id);
      await audit(tx, sys, { action: 'google_lead_form.disabled', entity: { type: 'google_lead_form_hook', id: h.id }, changes: redactSnapshot({ lead_source_id: leadSourceId, by_user_id: actor.userId }), reason: 'DISABLED' });
    }
    return view(tx, deps, sys.tenantId, leadSourceId, { withKey: false });
  });
}
