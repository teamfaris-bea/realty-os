// Compliance policy versions (BUILD_PLAN module 10; R-PERM-1, R-PERM-3, R-PERM-13, R-AUDIT-5,
// R-AUDIT-7 (append-only versions), DATA_MODEL §3 "Compliance policy").
//
//   GET  /compliance-policies                 versions, the active one, defaults, counsel status  Owner/Admin
//   POST /compliance-policies                 a NEW append-only version (a delta on the active one)
//                                             stricter: Owner/Admin; looser: Owner + 🔒 + attestation
//   POST /compliance-policies/:id/activate    make a version the one every gate decision cites
//                                             looser than the active one: Owner + 🔒 + attestation
//
// "Looser" (loosening) is decided field by field against the ACTIVE version, and also counts
// anything beyond the shipped defaults that the DB only accepts with an Owner attestation (one-party
// recording mode). Direction per field: an added autonomous category, and recording turned on or
// one-party mode are looser. The opt-out confirmation sender (provider vs platform) is operational, not
// a legal loosening (open question Q7), so it counts neither way.
// core-compliance/2.0.0 (owner decision): the contact window / quiet hours, the human-reply window,
// email quiet hours, the frequency caps and the deferral limit are gone (0013 dropped their columns);
// versioning, append-only history and the Owner attestation stay.
// The attestation is the exact sentence ATTESTATION_TEXT, sent back by the client and stored verbatim
// in loosening_attestation (activation records it in the audit row). Its wording is product copy
// awaiting counsel: VERIFY WITH COUNSEL.
import type { Instant, PolicyVersionId, UserActor } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import type { IdGenerator } from '@realty/core/foundation';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError, isErrorCode } from '../errors.js';
import { authorize } from '../rbac.js';
import { actorOf, adminTx, iso, mapAdminDbError, platformOf } from './common.js';
import * as repo from './repos/policy.js';
import { getSettings, setActivePolicy } from './repos/settings.js';
import { AUTONOMOUS_CATEGORY_VALUES, PoliciesResponse, PolicyActivatedResponse, PolicyCreatedResponse } from './schemas.js';

/** The sentence an Owner confirms to adopt a looser policy. VERIFY WITH COUNSEL (wording). */
export const ATTESTATION_TEXT =
  'I am the Owner of this team. These compliance settings are looser than our current policy or the platform defaults, and I accept responsibility for using them.';

/** The policy fields a version carries (camelCase), with their columns. */
export const POLICY_FIELDS = {
  autonomousCategories: 'autonomous_categories',
  optOutConfirmationSender: 'opt_out_confirmation_sender',
  recordingEnabled: 'recording_enabled',
  recordingMode: 'recording_mode',
} as const;
export type PolicyField = keyof typeof POLICY_FIELDS;

export interface PolicyValues {
  autonomousCategories: string[];
  optOutConfirmationSender: 'provider' | 'platform';
  recordingEnabled: boolean;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
}

export type PolicyDraft = Partial<PolicyValues>;

/** The shipped defaults (compliance_policy_versions column defaults; the strict baseline). */
export const DEFAULT_POLICY: PolicyValues = Object.freeze({
  autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert'],
  optOutConfirmationSender: 'provider',
  recordingEnabled: true,
  recordingMode: 'announce_all',
}) as PolicyValues;

/** Fields of `next` that permit more contact than `base` (pure). */
export function looserFields(base: PolicyValues, next: PolicyValues): PolicyField[] {
  const out: PolicyField[] = [];
  const had = new Set(base.autonomousCategories);
  if (next.autonomousCategories.some((c) => !had.has(c))) out.push('autonomousCategories');
  if (!base.recordingEnabled && next.recordingEnabled) out.push('recordingEnabled');
  if (base.recordingMode === 'announce_all' && next.recordingMode !== 'announce_all') out.push('recordingMode');
  return out;
}

/** Fields beyond the shipped defaults that the DB accepts only with an Owner attestation (pure). */
export function attestationRequiredFields(v: PolicyValues): PolicyField[] {
  const out: PolicyField[] = [];
  if (v.recordingMode !== 'announce_all') out.push('recordingMode');
  return out;
}

/** Loosening of `next` relative to the active `base` (pure): looser fields ∪ attestation-only fields. */
export function policyLoosening(base: PolicyValues, next: PolicyValues): { loosening: boolean; fields: PolicyField[] } {
  const fields = [...new Set([...looserFields(base, next), ...attestationRequiredFields(next)])].sort() as PolicyField[];
  return { loosening: fields.length > 0, fields };
}

export function valuesOf(r: repo.PolicyRow): PolicyValues {
  return {
    autonomousCategories: [...r.autonomous_categories].sort(),
    optOutConfirmationSender: r.opt_out_confirmation_sender,
    recordingEnabled: r.recording_enabled,
    recordingMode: r.recording_mode,
  };
}

function columnsOf(v: PolicyValues, attestation: string | null): repo.PolicyColumns {
  return {
    autonomous_categories: [...new Set(v.autonomousCategories)].sort(),
    opt_out_confirmation_sender: v.optOutConfirmationSender,
    recording_enabled: v.recordingEnabled,
    recording_mode: v.recordingMode,
    loosening_attestation: attestation,
  };
}

/** The audited, snake_case snapshot of a version's values (all non-PII). */
function auditShape(v: PolicyValues): Record<string, unknown> {
  const c = columnsOf(v, null) as unknown as Record<string, unknown>;
  delete c.loosening_attestation;
  return c;
}

/** The draft schema: values mirror the CHECKs. */
export const PolicyDraftSchema = z
  .object({
    autonomousCategories: z.array(z.enum(AUTONOMOUS_CATEGORY_VALUES)).max(6).optional(),
    optOutConfirmationSender: z.enum(['provider', 'platform']).optional(),
    recordingEnabled: z.boolean().optional(),
    recordingMode: z.enum(['announce_all', 'one_party_where_permitted']).optional(),
  })
  .strict();

export interface PolicyCallOptions {
  /** the session's last re-authentication and the clock it is judged by (R-PERM-13) */
  reauth: { reauthenticatedAt: Instant | null; now: Instant };
  /** the exact attestation sentence, when the Owner confirmed it */
  attestation?: string | null;
  /** activate the new version in the same transaction */
  activate?: boolean;
  db?: Database;
  ids: IdGenerator;
}

function authorizePolicy(actor: UserActor, loosening: boolean, attested: boolean, reauth: PolicyCallOptions['reauth'], fields: readonly string[]): void {
  const r = can(actor, 'settings.compliance', { loosening, attested, reauth });
  if (!r.ok) throw new AppError(isErrorCode(r.code) ? r.code : 'NOT_FOUND', r.code === 'NOT_FOUND' ? undefined : { loosenedFields: [...fields] });
}

async function activateInTx(tx: Tx, actor: UserActor, target: repo.PolicyRow, active: repo.PolicyRow, o: { loosening: boolean; fields: readonly string[] }): Promise<void> {
  await setActivePolicy(tx, target.id);
  await audit(tx, actor, {
    action: 'policy.activated',
    entity: { type: 'compliance_policy_version', id: target.id },
    changes: redactDiff(
      { active_policy_id: active.id, policy_version: active.version_no, loosened_field_codes: [] },
      { active_policy_id: target.id, policy_version: target.version_no, loosened_field_codes: [...o.fields] },
      { entity: 'compliance_policy_version' },
    ),
    ...(o.loosening ? { reason: 'LOOSENING_ATTESTED' } : {}),
  });
}

/**
 * Creates a new append-only policy version from `draft` (a delta on the active version). Looser than
 * the active version (or beyond the defaults) ⇒ Owner, re-authenticated within 15 minutes, with the
 * exact attestation sentence; otherwise Owner or Admin. Spec correction (reported): BUILD_PLAN shows
 * `(actor, draft)`; re-authentication state, the attestation and the id generator are inputs too.
 */
export async function proposePolicyVersion(
  actor: UserActor,
  draft: PolicyDraft,
  opts: PolicyCallOptions,
): Promise<{ id: PolicyVersionId; versionNo: number; loosening: boolean; loosenedFields: PolicyField[]; active: boolean }> {
  try {
    return await withTenantTx(
      actor,
      async (tx) => {
        const cur = await repo.activeVersionLocked(tx);
        if (!cur) throw new AppError('NOT_FOUND');
        const base = valuesOf(cur.policy);
        const next: PolicyValues = { ...base, ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } as PolicyValues;
        next.autonomousCategories = [...new Set(next.autonomousCategories)].sort();
        const { loosening, fields } = policyLoosening(base, next);
        const attested = opts.attestation === ATTESTATION_TEXT;
        authorizePolicy(actor, loosening, attested, opts.reauth, fields);
        const id = opts.ids.next<'PolicyVersionId'>();
        const versionNo = await repo.nextVersionNo(tx);
        // an attestation is stored only when the version needs one (looser), as the exact sentence
        await repo.insertVersion(tx, id, versionNo, columnsOf(next, loosening ? ATTESTATION_TEXT : null));
        await audit(tx, actor, {
          action: 'policy.version_created',
          entity: { type: 'compliance_policy_version', id },
          changes: redactSnapshot({ policy_version: versionNo, ...auditShape(next), loosened_field_codes: fields }, { entity: 'compliance_policy_version' }),
          ...(loosening ? { reason: 'LOOSENING_ATTESTED' } : {}),
        });
        if (opts.activate) {
          const row = await repo.getVersion(tx, id);
          if (!row) throw new AppError('NOT_FOUND');
          await activateInTx(tx, actor, row, cur.policy, { loosening, fields });
        }
        return { id, versionNo, loosening, loosenedFields: fields, active: opts.activate === true };
      },
      { db: opts.db, retries: 2 },
    );
  } catch (e) {
    throw mapAdminDbError(e) ?? e;
  }
}

/**
 * Makes `policyId` the active version. Looser than the active one (or an attested version) ⇒ Owner +
 * 🔒 + the attestation sentence (the activation's audit row records it). Re-activating the active
 * version is a no-op.
 */
export async function activatePolicyVersion(
  actor: UserActor,
  policyId: string,
  opts: Omit<PolicyCallOptions, 'activate' | 'ids'>,
): Promise<{ activePolicyId: string; loosening: boolean; changed: boolean }> {
  try {
    return await withTenantTx(
      actor,
      async (tx) => {
        const cur = await repo.activeVersionLocked(tx);
        if (!cur) throw new AppError('NOT_FOUND');
        const target = await repo.getVersion(tx, policyId);
        if (!target) throw new AppError('NOT_FOUND');
        const { loosening, fields } = policyLoosening(valuesOf(cur.policy), valuesOf(target));
        const looser = loosening || target.loosening_attestation !== null;
        authorizePolicy(actor, looser, opts.attestation === ATTESTATION_TEXT, opts.reauth, fields);
        if (target.id === cur.policy.id) return { activePolicyId: target.id, loosening: false, changed: false };
        await activateInTx(tx, actor, target, cur.policy, { loosening: looser, fields });
        return { activePolicyId: target.id, loosening: looser, changed: true };
      },
      { db: opts.db, retries: 2 },
    );
  } catch (e) {
    throw mapAdminDbError(e) ?? e;
  }
}

/** Facts for authorize(): loosening of the draft against the active version (read in its own tx). */
async function draftFacts(db: Database, actor: UserActor, draft: PolicyDraft, attestation: string | null | undefined) {
  return withTenantTx(
    actor,
    async (tx) => {
      const vs = await repo.listVersions(tx);
      const settings = await getSettings(tx);
      const active = vs.find((v) => v.id === settings?.active_policy_id);
      if (!active) return null;
      const base = valuesOf(active);
      const next = { ...base, ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } as PolicyValues;
      return { loosening: policyLoosening(base, next).loosening, attested: attestation === ATTESTATION_TEXT };
    },
    { db },
  );
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/compliance-policies',
    {
      config: { auth: 'settings.compliance' },
      // reading changes nothing: judged as a non-loosening request (Owner/Admin, no re-auth)
      preHandler: authorize('settings.compliance', () => ({ loosening: false })),
      schema: { response: { 200: PoliciesResponse } },
    },
    async (req) =>
      adminTx(req, async (tx) => {
        const settings = await getSettings(tx);
        if (!settings) throw new AppError('NOT_FOUND');
        const versions = await repo.listVersions(tx);
        const packs = await repo.packsInForce(tx);
        return {
          activePolicyId: settings.active_policy_id,
          versions: versions.map((v) => ({
            ...valuesOf(v),
            autonomousCategories: valuesOf(v).autonomousCategories as (typeof AUTONOMOUS_CATEGORY_VALUES)[number][],
            id: v.id,
            versionNo: v.version_no,
            attested: v.loosening_attestation !== null,
            createdByUserId: v.created_by_user_id,
            createdAt: iso(v.created_at)!,
            active: v.id === settings.active_policy_id,
          })),
          defaults: { ...DEFAULT_POLICY, autonomousCategories: DEFAULT_POLICY.autonomousCategories as (typeof AUTONOMOUS_CATEGORY_VALUES)[number][] },
          attestationText: ATTESTATION_TEXT,
          counsel: {
            allReviewed: packs.length > 0 && packs.every((p) => p.reviewed_by_counsel_at !== null),
            packs: packs.map((p) => ({ key: p.key, version: p.version, reviewedByCounselAt: iso(p.reviewed_by_counsel_at) })),
          },
        };
      }),
  );

  r.post(
    '/compliance-policies',
    {
      config: { auth: 'settings.compliance' },
      schema: {
        body: PolicyDraftSchema.extend({ attestation: z.string().max(500).optional(), activate: z.boolean().optional() }).strict(),
        response: { 201: PolicyCreatedResponse },
      },
      preHandler: authorize('settings.compliance', (req) => {
        const { attestation, activate: _a, ...draft } = req.body as PolicyDraft & { attestation?: string; activate?: boolean };
        return draftFacts(platformOf(req).db, actorOf(req), draft, attestation);
      }),
    },
    async (req, reply) => {
      const p = platformOf(req);
      const { attestation, activate, ...draft } = req.body;
      const state = req.authState!;
      const out = await proposePolicyVersion(actorOf(req), draft, {
        reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now },
        attestation: attestation ?? null,
        activate: activate === true,
        db: p.db,
        ids: p.ids,
      });
      reply.status(201);
      return out;
    },
  );

  r.post(
    '/compliance-policies/:id/activate',
    {
      config: { auth: 'settings.compliance' },
      schema: { params: z.object({ id: z.uuid() }), body: z.object({ attestation: z.string().max(500).optional() }).strict(), response: { 200: PolicyActivatedResponse } },
      preHandler: authorize('settings.compliance', async (req) => {
        const id = (req.params as { id: string }).id;
        const attestation = (req.body as { attestation?: string } | undefined)?.attestation;
        return withTenantTx(
          actorOf(req),
          async (tx) => {
            const target = await repo.getVersion(tx, id);
            if (!target) return null;
            const s = await getSettings(tx);
            const active = s ? await repo.getVersion(tx, s.active_policy_id) : null;
            if (!active) return null;
            const loosening = policyLoosening(valuesOf(active), valuesOf(target)).loosening || target.loosening_attestation !== null;
            return { loosening, attested: attestation === ATTESTATION_TEXT };
          },
          { db: platformOf(req).db },
        );
      }),
    },
    async (req) => {
      const state = req.authState!;
      return activatePolicyVersion(actorOf(req), req.params.id, {
        reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now },
        attestation: req.body?.attestation ?? null,
        db: platformOf(req).db,
      });
    },
  );
}

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  await register(app);
}
