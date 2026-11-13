// Owner enablement of AI answering and its read state (module 48 item 9; R-VOICE-9, R-VOICE-20, R-PERM-5; E150, E437).
//
//   GET  /voice/answering           settings.compliance (not loosening): the honest state, 'dark' | 'off' | 'on', and why
//   PUT  /voice/answering/settings  answer-after seconds and when; narrowing is Owner/Admin, widening is a loosening
//                                   (Owner, fresh re-auth, VOICE_ATTESTATION_TEXT). API-enforced only: the DB has no
//                                   voice_answer_* guard (O4). Audited settings.changed.
//   POST /voice/answering/enable    settings.compliance loosening: the Owner, re-authenticated, with the exact attestation;
//                                   prechecks, then a copy of the active policy version with voice on, activated. The DB
//                                   guards decide again (compliance_policy_voice_guard: Owner + cleared pack;
//                                   tenant_settings_p23_guard: only the Owner activates a voice-on version).
//   POST /voice/answering/disable   Owner or Admin: a copy with voice off, activated. Sessions in progress finish (E150).
//                                   An Admin's copy of an attested version is refused by the DB (0001: a non-Owner may not
//                                   insert or activate an attested version): OWNER_REQUIRED, said plainly (O14).
// The writes run as the user (RLS + the DB role guards), never as the system.
import type { UserActor } from '@realty/core/foundation';
import { platformVoiceCleared } from '@realty/core/voice';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { mapAdminDbError } from '../admin/common.js';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { teamVoicePlaybook, voicePack, voiceSettingsRow } from './facts.js';
import type { VoiceDeps } from './runtime.js';

/** The sentence the Owner confirms to turn AI answering on: owner question O11's default (missed and after-hours calls,
 *  as voice_answer_when allows). VERIFY WITH COUNSEL (C2). */
export const VOICE_ATTESTATION_TEXT =
  'I am the Owner. I reviewed the disclosure and turn on AI answering of missed and after-hours calls for this team.';

export const NO_HOT_RULE_SENTENCE = 'Nobody is transferred live: no hot-lead rule is set.';
export const OWNER_ONLY_DISABLE_SENTENCE = "Only the Owner can turn AI answering off under this team's policy. Turning AI off for the team also stops it.";

/** compliance_policy_versions columns a copy carries over unchanged (the drift test compares with the catalog). */
export const POLICY_COPY_COLUMNS = ['autonomous_categories', 'opt_out_confirmation_sender', 'recording_enabled', 'recording_mode', 'loosening_attestation'] as const;
/** Columns a copy writes fresh. */
export const POLICY_FRESH_COLUMNS = ['tenant_id', 'id', 'version_no', 'created_by_user_id', 'created_at', 'voice_answering_enabled', 'voice_answering_attestation'] as const;

export type AnsweringState = 'dark' | 'off' | 'on';
export interface Reason {
  code: string;
  sentence: string;
}

const REASON: Record<string, string> = {
  VOICE_NOT_CLEARED: 'AI answering waits for counsel review and a real voice vendor check (platform:voice is not cleared).',
  VOICE_VENDOR_NOT_CONFIGURED: 'No voice vendor is set up on this platform yet (N12). AI answering stays off.',
  VOICE_PLAYBOOK_NOT_APPROVED: 'The AI answering playbook is not approved yet.',
  AI_DISABLED: 'The assistant is turned off for this team.',
  VOICE_RECORDING_OFF: 'Call recording is off in the team policy; an AI call is always announced and recorded.',
  VOICE_ANSWERING_OFF: 'The Owner has not turned AI answering on.',
};
const reason = (code: string): Reason => ({ code, sentence: REASON[code] ?? code });

export async function answeringView(actor: UserActor, deps: VoiceDeps) {
  return withTenantTx(actor, async (tx) => {
    const s = await voiceSettingsRow(tx);
    const pack = await voicePack(tx);
    const pb = await teamVoicePlaybook(tx);
    const p = await sql<{ id: string; approved: string | null; created_at: Date | null }>`
      SELECT p.id, (SELECT v.id FROM playbook_versions v WHERE v.tenant_id = p.tenant_id AND v.playbook_id = p.id AND v.status = 'approved' LIMIT 1) AS approved, NULL::timestamptz AS created_at
        FROM playbooks p WHERE p.tenant_id = app.tenant_id() AND p.kind = 'voice_answering' AND p.scope = 'team' AND p.status = 'active' ORDER BY p.created_at DESC LIMIT 1`.execute(tx);
    const enabledAt = s.answeringEnabled && s.activePolicyId
      ? (await sql<{ created_at: Date }>`SELECT created_at FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = ${s.activePolicyId}`.execute(tx)).rows[0]?.created_at ?? null
      : null;
    const cleared = platformVoiceCleared(pack.platform) && pack.maxTurnLatencyMs !== null;
    const reasons: Reason[] = [];
    if (!cleared) reasons.push(reason('VOICE_NOT_CLEARED'));
    if (!deps.voiceAgent.configured) reasons.push(reason('VOICE_VENDOR_NOT_CONFIGURED'));
    if (pb?.status !== 'approved') reasons.push(reason('VOICE_PLAYBOOK_NOT_APPROVED'));
    if (!s.aiEnabled) reasons.push(reason('AI_DISABLED'));
    if (!s.recordingEnabled) reasons.push(reason('VOICE_RECORDING_OFF'));
    if (!s.answeringEnabled) reasons.push(reason('VOICE_ANSWERING_OFF'));
    const dark = !cleared || !deps.voiceAgent.configured;
    const state: AnsweringState = dark ? 'dark' : reasons.length === 0 ? 'on' : 'off';
    return {
      state,
      reasons,
      pack: { version: pack.version, reviewedByCounselAt: pack.platform.reviewedByCounselAt === null ? null : new Date(pack.platform.reviewedByCounselAt).toISOString(), vendorReady: pack.platform.vendorReadyAt !== null, cleared },
      playbook: p.rows[0] ? { id: p.rows[0].id, approvedVersionId: p.rows[0].approved, state: pb?.status ?? 'draft' } : null,
      enabled: s.answeringEnabled ? { on: true, sentence: `Attested by the Owner on ${enabledAt ? enabledAt.toISOString().slice(0, 10) : 'an earlier date'}.` } : { on: false, sentence: 'AI answering is off.' },
      settings: { answerAfterSeconds: s.answerAfterSeconds, answerWhen: s.answerWhen, version: s.version },
      provider: { configured: deps.voiceAgent.configured, statusText: deps.voiceAgent.statusText },
      transfers: NO_HOT_RULE_SENTENCE,
      attestationText: VOICE_ATTESTATION_TEXT,
    };
  }, { db: deps.db });
}

/** Widening: answers sooner, or in more hours. */
export function settingsLoosening(cur: { answerAfterSeconds: number; answerWhen: string }, next: { answerAfterSeconds: number; answerWhen: string }): boolean {
  return next.answerAfterSeconds < cur.answerAfterSeconds || (cur.answerWhen === 'after_hours_only' && next.answerWhen === 'missed_and_after_hours');
}

export async function settingsFacts(actor: UserActor, deps: VoiceDeps, next: { answerAfterSeconds: number; answerWhen: string }, attestation: string | undefined) {
  const cur = await withTenantTx(actor, (tx) => voiceSettingsRow(tx), { db: deps.db });
  return { loosening: settingsLoosening(cur, next), attested: attestation === VOICE_ATTESTATION_TEXT };
}

export async function updateAnsweringSettings(actor: UserActor, deps: VoiceDeps, i: { answerAfterSeconds: number; answerWhen: 'missed_and_after_hours' | 'after_hours_only'; version: number }) {
  await withTenantTx(actor, async (tx) => {
    const cur = await voiceSettingsRow(tx);
    if (cur.version !== i.version) throw new AppError('VERSION_CONFLICT');
    const u = await sql`
      UPDATE tenant_settings SET voice_answer_after_seconds = ${i.answerAfterSeconds}, voice_answer_when = ${i.answerWhen}, version = version + 1
       WHERE tenant_id = app.tenant_id() AND version = ${i.version}`.execute(tx);
    if (Number(u.numAffectedRows ?? 0) === 0) throw new AppError('VERSION_CONFLICT');
    await audit(tx, actor, {
      action: 'settings.changed',
      entity: { type: 'tenant_settings', id: actor.tenantId },
      changes: redactDiff({ voice_answer_after_seconds: cur.answerAfterSeconds, voice_answer_when: cur.answerWhen }, { voice_answer_after_seconds: i.answerAfterSeconds, voice_answer_when: i.answerWhen }, { entity: 'tenant_settings' }),
    });
  }, { db: deps.db });
  return answeringView(actor, deps);
}

/** INSERT…SELECT of the active version with the voice columns set; then activation. Returns the new version id. */
async function copyActive(tx: Tx, deps: VoiceDeps, on: boolean, attestation: string | null): Promise<string> {
  const id = deps.ids.next<'CompliancePolicyVersionId'>();
  const cols = sql.raw(POLICY_COPY_COLUMNS.join(', '));
  const r = await sql`
    INSERT INTO compliance_policy_versions (tenant_id, id, version_no, created_by_user_id, voice_answering_enabled, voice_answering_attestation, ${cols})
    SELECT app.tenant_id(), ${id}::uuid, (SELECT COALESCE(max(version_no), 0) + 1 FROM compliance_policy_versions WHERE tenant_id = app.tenant_id()),
           app.user_id(), ${on}, ${attestation}, ${cols}
      FROM compliance_policy_versions WHERE tenant_id = app.tenant_id() AND id = (SELECT active_policy_id FROM tenant_settings WHERE tenant_id = app.tenant_id())`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('NOT_FOUND');
  await sql`UPDATE tenant_settings SET active_policy_id = ${id}::uuid, version = version + 1 WHERE tenant_id = app.tenant_id()`.execute(tx);
  return id;
}

export async function enableAnswering(actor: UserActor, deps: VoiceDeps) {
  try {
    await withTenantTx(actor, async (tx) => {
      const s = await voiceSettingsRow(tx);
      const pack = await voicePack(tx);
      const pb = await teamVoicePlaybook(tx);
      if (!s.aiEnabled) throw new AppError('AI_DISABLED');
      if (!s.recordingEnabled) throw new AppError('VOICE_RECORDING_OFF');
      if (pb?.status !== 'approved') throw new AppError('VOICE_PLAYBOOK_NOT_APPROVED');
      if (!deps.voiceAgent.configured) throw new AppError('VOICE_VENDOR_NOT_CONFIGURED');
      if (!platformVoiceCleared(pack.platform) || pack.maxTurnLatencyMs === null) throw new AppError('VOICE_NOT_CLEARED');
      if (s.answeringEnabled) return;
      const id = await copyActive(tx, deps, true, VOICE_ATTESTATION_TEXT);
      await audit(tx, actor, { action: 'policy.version_created', entity: { type: 'compliance_policy_version', id } });
      await audit(tx, actor, { action: 'policy.activated', entity: { type: 'compliance_policy_version', id } });
      await audit(tx, actor, { action: 'voice.answering_changed', entity: { type: 'compliance_policy_version', id }, reason: 'ON' });
    }, { db: deps.db });
  } catch (e) {
    throw dbError(e);
  }
  return answeringView(actor, deps);
}

function dbError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const msg = String((e as { message?: string })?.message ?? '');
  if (msg.startsWith('VOICE_NOT_CLEARED')) return new AppError('VOICE_NOT_CLEARED');
  return mapAdminDbError(e) ?? e;
}

export async function disableAnswering(actor: UserActor, deps: VoiceDeps) {
  try {
    await withTenantTx(actor, async (tx) => {
      const s = await voiceSettingsRow(tx);
      if (!s.answeringEnabled) return;
      const id = await copyActive(tx, deps, false, null);
      await audit(tx, actor, { action: 'policy.version_created', entity: { type: 'compliance_policy_version', id } });
      await audit(tx, actor, { action: 'policy.activated', entity: { type: 'compliance_policy_version', id } });
      await audit(tx, actor, { action: 'voice.answering_changed', entity: { type: 'compliance_policy_version', id }, reason: 'OFF' });
    }, { db: deps.db });
  } catch (e) {
    const err = dbError(e);
    if (err instanceof AppError && err.code === 'OWNER_REQUIRED') throw new AppError('OWNER_REQUIRED', { sentence: OWNER_ONLY_DISABLE_SENTENCE });
    throw err;
  }
  return answeringView(actor, deps);
}
