// The Owner's coaching settings (module 36 for module 41; R-COACH-1, R-COACH-3, R-INT-6; D-COACH).
//
//   coachingSettingsView   Owner: whether counsel has reviewed the platform:coaching pack (the page says
//                          "not reviewed by counsel" while it has not), call scoring on/off, whether Team
//                          Leads see their team's call reviews and tips (default off, D-COACH), the rubric.
//   saveCoachingSettings   Owner 🔒 when widening (scoring on, Team Lead visibility on): written under the
//                          Owner's RLS. tenant_settings_p23_guard refuses anyone but the Owner
//                          (OWNER_ONLY_SETTING → OWNER_REQUIRED) and refuses scoring on while the pack is not
//                          cleared (COACHING_NOT_CLEARED); the API checks the same first. Audited with values
//                          only (booleans and rubric keys: no PII).
// Turning scoring off closes every open coaching card at once, and the review job stops at its next run. VERIFY WITH COUNSEL: employee monitoring notice (counsel item C11).
import { RUBRIC_V1 } from '@realty/core/coaching';
import type { Instant, UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { closeFixCards, coachingSettings, updateCoachingSettings } from './repos/coaching.js';

export interface CoachingSettingsView {
  pack: { cleared: boolean; version: string | null; reviewedAt: string | null; sentence: string };
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  rubric: { key: string; label: string; good: string; enabled: boolean }[];
  /** what turning scoring on would do, or why it cannot be turned on yet */
  scoringSentence: string;
}

export interface CoachingSettingsInput {
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  disabledKeys: string[];
}

const KEYS = RUBRIC_V1.items.map((i) => i.key);

export async function coachingSettingsView(tx: Tx): Promise<CoachingSettingsView> {
  const s = await coachingSettings(tx);
  if (!s) throw new AppError('NOT_FOUND');
  const disabled = new Set(s.disabledKeys);
  return {
    pack: {
      cleared: s.packCleared,
      version: s.packVersion,
      reviewedAt: s.packCleared ? s.packReviewedAt : null,
      sentence: s.packCleared
        ? 'Counsel has reviewed call reviews for this platform. Check your own state’s rules on recording and employee monitoring before you turn them on.'
        : 'Not reviewed by counsel. Call reviews stay off until counsel reviews them (employee monitoring and call-recording law).',
    },
    scoringEnabled: s.scoringEnabled,
    tlSeesCallScores: s.tlSeesCallScores,
    rubric: RUBRIC_V1.items.map((i) => ({ key: i.key, label: i.label, good: i.good, enabled: !disabled.has(i.key) })),
    scoringSentence: !s.packCleared
      ? 'Call scoring cannot be turned on until counsel reviews it.'
      : s.scoringEnabled
        ? 'Calls a person handled, recorded with an announcement or under your one-party policy, are reviewed against the checklist. Each agent gets one tip a day.'
        : 'Call scoring is off. No call is reviewed and no tips are shown.',
  };
}

/** Whether the change widens who sees what or turns a gated capability on (needs re-auth). */
export function isWidening(before: { scoringEnabled: boolean; tlSeesCallScores: boolean }, after: { scoringEnabled: boolean; tlSeesCallScores: boolean }): boolean {
  return (after.scoringEnabled && !before.scoringEnabled) || (after.tlSeesCallScores && !before.tlSeesCallScores);
}

export async function saveCoachingSettings(tx: Tx, actor: UserActor, input: CoachingSettingsInput, now: Instant): Promise<CoachingSettingsView> {
  if (actor.role !== 'owner') throw new AppError('OWNER_REQUIRED');
  const unknown = input.disabledKeys.filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/disabledKeys', code: 'unknown_item' }] });
  const before = await coachingSettings(tx);
  if (!before) throw new AppError('NOT_FOUND');
  if (input.scoringEnabled && !before.scoringEnabled && !before.packCleared) throw new AppError('COACHING_NOT_CLEARED');
  const disabledKeys = KEYS.filter((k) => input.disabledKeys.includes(k));
  if (disabledKeys.length === KEYS.length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/disabledKeys', code: 'at_least_one_item' }] });
  await updateCoachingSettings(tx, { scoringEnabled: input.scoringEnabled, tlSeesCallScores: input.tlSeesCallScores, disabledKeys });
  // off is off at once: every open coaching card closes now (the Owner is tenant-wide), not at the next pass
  if (before.scoringEnabled && !input.scoringEnabled) await closeFixCards(tx, { now });
  const prev = KEYS.filter((k) => before.disabledKeys.includes(k));
  const changes = redactDiff(
    { call_scoring_enabled: before.scoringEnabled, tl_sees_call_scores: before.tlSeesCallScores, coaching_rubric_disabled: prev },
    { call_scoring_enabled: input.scoringEnabled, tl_sees_call_scores: input.tlSeesCallScores, coaching_rubric_disabled: disabledKeys },
    { entity: 'tenant_settings' },
  );
  if (Object.keys(changes).length > 0) {
    await audit(tx, actor, { action: 'coaching.settings_changed', entity: { type: 'tenant_settings', id: actor.tenantId }, changes });
  }
  return coachingSettingsView(tx);
}
