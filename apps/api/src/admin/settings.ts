// Tenant settings and brokerage identity (BUILD_PLAN module 10; R-PERM-3, R-OWN-15, R-GATE-12,
// R-AUDIT-5 settings changes, R-PERM-13).
//
//   GET   /settings            lead timers, routing hours, recording, notification detail, ai, identity   Owner/Admin
//   PATCH /settings            { version, ...fields }                                                    Owner/Admin
//                              recording retention / Team Lead access / TC access: Owner 🔒 (R-PERM-3)
//   PATCH /settings/identity   { version, brokerageLegalName?, teamName?, brokerageLicenseNumber?,
//                                brokeragePostalAddress? }                                               Owner 🔒
//
// R-OWN-15: changing hours, timezone or any timer setting writes tenant_settings only. Deadlines
// already stored on contacts (offer expiry, first-touch due/release, inactivity warn/release) are
// never recomputed: they were computed once at their transition with the settings then in force, and
// the sweeper reads only those stored instants. New transitions use the new values.
// R-GATE-12: the brokerage legal name is NOT NULL and non-blank (DB) and cannot be cleared here; the
// postal address is reported as missing until set, because marketing email is denied without it.
// Every change writes `settings.changed` with a {from, to} diff in the same transaction.
import { ianaZone } from '@realty/core/foundation';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { adminTx, hhmm, recheck, timeSeconds } from './common.js';
import * as repo from './repos/settings.js';
import { SettingsResponse, TimeOfDay } from './schemas.js';

export { type BrokerageIdentity, loadBrokerageIdentity } from './repos/settings.js';

/** camelCase body field → tenant_settings column. */
const SETTINGS_FIELDS = {
  defaultTimezone: 'default_timezone',
  routingHoursStart: 'routing_hours_start',
  routingHoursEnd: 'routing_hours_end',
  offerWindowSeconds: 'offer_window_seconds',
  maxOffers: 'max_offers',
  firstTouchSlaSeconds: 'first_touch_sla_seconds',
  firstTouchReleaseSeconds: 'first_touch_release_seconds',
  reinquirySlaAfterDays: 'reinquiry_sla_after_days',
  inactivityReleaseDays: 'inactivity_release_days',
  inactivityWarningHours: 'inactivity_warning_hours',
  autoPauseAfterMisses: 'auto_pause_after_misses',
  uncontactedCapacityCap: 'uncontacted_capacity_cap',
  isaAccessAfterHandoffDays: 'isa_access_after_handoff_days',
  recordingRetentionDays: 'recording_retention_days',
  teamLeadRecordingAccess: 'team_lead_recording_access',
  tcRecordingAccess: 'tc_recording_access',
  notificationDetail: 'notification_detail',
  aiEnabled: 'ai_enabled',
} as const satisfies Record<string, repo.WritableColumn>;

/** R-PERM-3: recording retention and access are Owner-only (and 🔒 like brokerage identity). */
export const OWNER_ONLY_SETTINGS = new Set<keyof typeof SETTINGS_FIELDS>(['recordingRetentionDays', 'teamLeadRecordingAccess', 'tcRecordingAccess']);

const IDENTITY_FIELDS = {
  brokerageLegalName: 'brokerage_legal_name',
  teamName: 'team_name',
  brokerageLicenseNumber: 'brokerage_license_number',
  brokeragePostalAddress: 'brokerage_postal_address',
} as const satisfies Record<string, repo.WritableColumn>;

// Ranges mirror the tenant_settings CHECKs so a bad value is a 422 with a field path, not a 500.
const SettingsPatch = z
  .object({
    version: z.number().int().min(1),
    defaultTimezone: z.string().min(1).max(64).optional(),
    routingHoursStart: TimeOfDay.optional(),
    routingHoursEnd: TimeOfDay.optional(),
    offerWindowSeconds: z.number().int().min(30).max(86_400).optional(),
    maxOffers: z.number().int().min(1).max(10).optional(),
    firstTouchSlaSeconds: z.number().int().min(60).max(86_400).optional(),
    firstTouchReleaseSeconds: z.number().int().min(61).max(7 * 86_400).nullable().optional(),
    reinquirySlaAfterDays: z.number().int().min(1).max(90).optional(),
    inactivityReleaseDays: z.number().int().min(7).max(365).nullable().optional(),
    inactivityWarningHours: z.number().int().min(1).max(336).optional(),
    autoPauseAfterMisses: z.number().int().min(1).max(10).optional(),
    uncontactedCapacityCap: z.number().int().min(1).max(50).optional(),
    isaAccessAfterHandoffDays: z.number().int().min(0).max(90).optional(),
    recordingRetentionDays: z.number().int().min(30).max(3650).optional(),
    teamLeadRecordingAccess: z.boolean().optional(),
    tcRecordingAccess: z.boolean().optional(),
    notificationDetail: z.enum(['none', 'first_name_initial']).optional(),
    aiEnabled: z.boolean().optional(),
  })
  .strict();

const OptionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const IdentityPatch = z
  .object({
    version: z.number().int().min(1),
    brokerageLegalName: z.string().trim().min(1).max(200).optional(),
    teamName: OptionalText(120),
    brokerageLicenseNumber: OptionalText(60),
    brokeragePostalAddress: OptionalText(300),
  })
  .strict();

export function settingsView(s: repo.SettingsRow) {
  return {
    version: s.version,
    defaultTimezone: s.default_timezone,
    routingHoursStart: hhmm(s.routing_hours_start),
    routingHoursEnd: hhmm(s.routing_hours_end),
    offerWindowSeconds: s.offer_window_seconds,
    maxOffers: s.max_offers,
    firstTouchSlaSeconds: s.first_touch_sla_seconds,
    firstTouchReleaseSeconds: s.first_touch_release_seconds,
    reinquirySlaAfterDays: s.reinquiry_sla_after_days,
    inactivityReleaseDays: s.inactivity_release_days,
    inactivityWarningHours: s.inactivity_warning_hours,
    autoPauseAfterMisses: s.auto_pause_after_misses,
    uncontactedCapacityCap: s.uncontacted_capacity_cap,
    isaAccessAfterHandoffDays: s.isa_access_after_handoff_days,
    recordingRetentionDays: s.recording_retention_days,
    teamLeadRecordingAccess: s.team_lead_recording_access,
    tcRecordingAccess: s.tc_recording_access,
    notificationDetail: s.notification_detail,
    aiEnabled: s.ai_enabled,
    activePolicyId: s.active_policy_id,
    identity: {
      brokerageLegalName: s.brokerage_legal_name,
      teamName: s.team_name,
      brokerageLicenseNumber: s.brokerage_license_number,
      brokeragePostalAddress: s.brokerage_postal_address,
      missing: s.brokerage_postal_address ? [] : (['brokerage_postal_address'] as const).slice(),
    },
  };
}

function issue(path: string, code: string): AppError {
  return new AppError('VALIDATION_FAILED', { issues: [{ path, code }] });
}

/** Cross-field rules of the merged row (the CHECKs that span columns), as 422s with paths. */
function validateMerged(m: repo.SettingsRow): void {
  if (timeSeconds(m.routing_hours_start) >= timeSeconds(m.routing_hours_end)) throw issue('/routingHoursEnd', 'must_be_after_start');
  if (m.first_touch_release_seconds !== null && m.first_touch_release_seconds <= m.first_touch_sla_seconds) {
    throw issue('/firstTouchReleaseSeconds', 'must_exceed_first_touch_sla');
  }
}

function normalizeTime(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

/** Applies a camelCase patch onto the row; returns the merged row and the changed columns. */
function applyPatch(cur: repo.SettingsRow, patch: Record<string, unknown>, fields: Record<string, repo.WritableColumn>) {
  const merged = { ...cur } as repo.SettingsRow & Record<string, unknown>;
  const changes: Partial<Record<repo.WritableColumn, unknown>> = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = fields[k];
    if (!col || v === undefined) continue;
    const value = col === 'routing_hours_start' || col === 'routing_hours_end' ? normalizeTime(v as string) : v;
    if ((merged as Record<string, unknown>)[col] === value) continue;
    (merged as Record<string, unknown>)[col] = value;
    changes[col] = value;
  }
  return { merged: merged as repo.SettingsRow, changes };
}

function pick(row: repo.SettingsRow, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = (row as unknown as Record<string, unknown>)[c];
  return out;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/settings',
    { config: { auth: 'settings.routing' }, preHandler: authorize('settings.routing', () => ({})), schema: { response: { 200: SettingsResponse } } },
    async (req) =>
      adminTx(req, async (tx) => {
        const s = await repo.getSettings(tx);
        if (!s) throw new AppError('NOT_FOUND');
        return { settings: settingsView(s) };
      }),
  );

  r.patch(
    '/settings',
    {
      config: { auth: 'settings.routing' },
      preHandler: authorize('settings.routing', () => ({})),
      schema: { body: SettingsPatch, response: { 200: SettingsResponse } },
    },
    async (req) => {
      const { version, ...patch } = req.body;
      if (patch.defaultTimezone !== undefined && ianaZone(patch.defaultTimezone) === null) throw new AppError('TIMEZONE_INVALID');
      const s = await adminTx(req, async (tx, _now, actor) => {
        const cur = await repo.getSettings(tx, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        const { merged, changes } = applyPatch(cur, patch, SETTINGS_FIELDS);
        // Owner-only fields need the identity permission (Owner + 🔒), checked only when they change
        const ownerOnly = Object.entries(SETTINGS_FIELDS).filter(([k, col]) => OWNER_ONLY_SETTINGS.has(k as never) && col in changes);
        if (ownerOnly.length > 0) {
          // the Admin demonstrably sees these settings, so the honest answer is "Owner only", not 404
          const fields = ownerOnly.map(([k]) => k);
          if (actor.role !== 'owner') throw new AppError('OWNER_REQUIRED', { fields });
          recheck(req, 'settings.identity', {}, { fields });
        }
        if (cur.version !== version) throw new AppError('VERSION_CONFLICT', { settings: settingsView(cur) });
        if (Object.keys(changes).length === 0) return cur;
        validateMerged(merged);
        await repo.updateSettings(tx, changes);
        await audit(tx, actor, {
          action: 'settings.changed',
          entity: { type: 'tenant_settings', id: actor.tenantId },
          changes: redactDiff(pick(cur, Object.keys(changes)), pick(merged, Object.keys(changes)), { entity: 'tenant_settings' }),
        });
        const fresh = await repo.getSettings(tx);
        if (!fresh) throw new AppError('NOT_FOUND');
        return fresh;
      });
      return { settings: settingsView(s) };
    },
  );

  r.patch(
    '/settings/identity',
    {
      config: { auth: 'settings.identity' },
      preHandler: authorize('settings.identity', () => ({})),
      schema: { body: IdentityPatch, response: { 200: SettingsResponse } },
    },
    async (req) => {
      const { version, ...patch } = req.body;
      const s = await adminTx(req, async (tx, _now, actor) => {
        recheck(req, 'settings.identity', {});
        const cur = await repo.getSettings(tx, { forUpdate: true });
        if (!cur) throw new AppError('NOT_FOUND');
        if (cur.version !== version) throw new AppError('VERSION_CONFLICT', { settings: settingsView(cur) });
        const { merged, changes } = applyPatch(cur, patch, IDENTITY_FIELDS);
        if (Object.keys(changes).length === 0) return cur;
        await repo.updateSettings(tx, changes);
        await audit(tx, actor, {
          action: 'settings.changed',
          entity: { type: 'tenant_settings', id: actor.tenantId },
          changes: redactDiff(pick(cur, Object.keys(changes)), pick(merged, Object.keys(changes)), { entity: 'tenant_settings' }),
          reason: 'BROKERAGE_IDENTITY',
        });
        const fresh = await repo.getSettings(tx);
        if (!fresh) throw new AppError('NOT_FOUND');
        return fresh;
      });
      return { settings: settingsView(s) };
    },
  );
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
