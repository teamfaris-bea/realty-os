// The coaching settings (module 36 for module 41; R-COACH-1, R-COACH-3, R-INT-6; D-COACH; E283).
//
//   coachingSettingsView   Owner and Admins: whether counsel has reviewed the platform:coaching pack (the page
//                          says "not reviewed by counsel" while it has not), call scoring on/off, whether Team
//                          Leads see their team's call reviews and tips (default off, D-COACH), the rubric.
//   saveCoachingSettings   A request names only the settings it changes; the others stay as stored, so a page
//                          loaded before someone else's change cannot write that change back. It is decided on
//                          the tenant_settings row read FOR NO KEY UPDATE (a change in flight is waited for and
//                          seen): can() runs again there, so the Owner re-authenticates when the change widens
//                          (scoring on, Team Lead visibility on) against the row as it is, not as an earlier read
//                          saw it. An Admin may only turn call reviews off (owner decision 2026-11-11, the Gmail
//                          sync rule): a request naming anything else, or turning them on, is refused here, before
//                          the database, with OWNER_REQUIRED. Only what changes is written, under the caller's RLS.
//                          tenant_settings_p23_guard is the backstop: it refuses everyone else, and an Admin
//                          anything but "off" (OWNER_ONLY_SETTING → OWNER_REQUIRED), and refuses scoring on while
//                          the pack is not cleared (COACHING_NOT_CLEARED); the API checks the same first. Audited
//                          with values only (booleans and rubric keys: no PII), from the locked row.
// Turning scoring off closes every open coaching card at once, and the review job stops at its next run. VERIFY WITH COUNSEL: employee monitoring notice (counsel item C11).
import { RUBRIC_V1 } from '@realty/core/coaching';
import type { Instant, UserActor } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { audit, redactDiff } from '../audit.js';
import { AppError, isErrorCode } from '../errors.js';
import { closeFixCards, coachingSettings, updateCoachingSettings } from './repos/coaching.js';

export interface CoachingSettingsView {
  pack: { cleared: boolean; version: string | null; reviewedAt: string | null; sentence: string };
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  rubric: { key: string; label: string; good: string; enabled: boolean }[];
  /** what turning scoring on would do, or why it cannot be turned on yet */
  scoringSentence: string;
}

/** The settings a request changes; a field it leaves out stays as stored (SettingsBody: at least one). */
export interface CoachingSettingsInput {
  scoringEnabled?: boolean;
  tlSeesCallScores?: boolean;
  disabledKeys?: string[];
}

interface CallScoringSettings {
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  disabledKeys: readonly string[];
}

export interface SaveCoachingOptions {
  now: Instant;
  /** the session's last re-authentication and the clock it is judged by (can() runs again on the locked row) */
  reauth: { reauthenticatedAt: Instant | null; now: Instant };
}

const KEYS = RUBRIC_V1.items.map((i) => i.key);

export async function coachingSettingsView(tx: Tx, actor: UserActor): Promise<CoachingSettingsView> {
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
        : 'Call reviews stay off until counsel reviews them (employee monitoring and call-recording law).',
    },
    scoringEnabled: s.scoringEnabled,
    tlSeesCallScores: s.tlSeesCallScores,
    rubric: RUBRIC_V1.items.map((i) => ({ key: i.key, label: i.label, good: i.good, enabled: !disabled.has(i.key) })),
    scoringSentence: !s.packCleared
      ? s.scoringEnabled
        ? // the switch is the Owner's: an Admin reading it is told whose it is (an Admin can only turn it off)
          `Paused: ${actor.role === 'owner' ? 'your' : 'the Owner’s'} switch is on, but no call is reviewed and no tip is shown until counsel reviews call reviews.`
        : 'Call scoring cannot be turned on until counsel reviews it.'
      : s.scoringEnabled
        ? 'Calls a person handled, recorded with an announcement or under your one-party policy, are reviewed against the checklist. Each agent gets one tip a day.'
        : 'Call scoring is off. No call is reviewed and no tips are shown.',
  };
}

/** The settings once `input` is applied: each field it names replaces the stored one, the others stay. */
export function applySettings(before: CallScoringSettings, input: CoachingSettingsInput): CallScoringSettings {
  return {
    scoringEnabled: input.scoringEnabled ?? before.scoringEnabled,
    tlSeesCallScores: input.tlSeesCallScores ?? before.tlSeesCallScores,
    disabledKeys: KEYS.filter((k) => (input.disabledKeys ?? before.disabledKeys).includes(k)),
  };
}

/** Whether the change widens who sees what or turns a gated capability on (needs re-auth). */
export function isWidening(before: { scoringEnabled: boolean; tlSeesCallScores: boolean }, after: { scoringEnabled: boolean; tlSeesCallScores: boolean }): boolean {
  return (after.scoringEnabled && !before.scoringEnabled) || (after.tlSeesCallScores && !before.tlSeesCallScores);
}

/**
 * An Admin's only request (E283): call reviews off, naming nothing else. Turning them on, and any request that names
 * Team Lead visibility or the checklist (even as stored), is the Owner's.
 */
function isAdminOff(input: CoachingSettingsInput): boolean {
  return input.scoringEnabled === false && input.tlSeesCallScores === undefined && input.disabledKeys === undefined;
}

export async function saveCoachingSettings(tx: Tx, actor: UserActor, input: CoachingSettingsInput, o: SaveCoachingOptions): Promise<CoachingSettingsView> {
  if (actor.role !== 'owner' && actor.role !== 'admin') throw new AppError('OWNER_REQUIRED');
  // an Admin turns call reviews off and nothing else: refused here, before the database (whose guard refuses it too)
  if (actor.role !== 'owner' && !isAdminOff(input)) throw new AppError('OWNER_REQUIRED');
  const unknown = (input.disabledKeys ?? []).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/disabledKeys', code: 'unknown_item' }] });
  // the row as it is now, held until this commits: an Admin's "off" in flight is waited for and decided on
  const before = await coachingSettings(tx, { forUpdate: true });
  if (!before) throw new AppError('NOT_FOUND');
  const after = applySettings(before, input);
  // can() again, on the locked row (authorize() judged an earlier read): widening needs the Owner's fresh re-auth
  const allowed = can(actor, 'coaching.settings', { loosening: isWidening(before, after), reauth: o.reauth });
  if (!allowed.ok) throw new AppError(isErrorCode(allowed.code) ? allowed.code : 'NOT_FOUND');
  if (after.scoringEnabled && !before.scoringEnabled && !before.packCleared) throw new AppError('COACHING_NOT_CLEARED');
  if (input.disabledKeys !== undefined && after.disabledKeys.length === KEYS.length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/disabledKeys', code: 'at_least_one_item' }] });
  const prev = KEYS.filter((k) => before.disabledKeys.includes(k));
  const rubricChanged = prev.join(',') !== after.disabledKeys.join(',');
  // only what changes is written: an Admin's "off" writes the switch alone, so the guard admits it
  await updateCoachingSettings(tx, {
    ...(after.scoringEnabled !== before.scoringEnabled ? { scoringEnabled: after.scoringEnabled } : {}),
    ...(after.tlSeesCallScores !== before.tlSeesCallScores ? { tlSeesCallScores: after.tlSeesCallScores } : {}),
    ...(rubricChanged ? { disabledKeys: after.disabledKeys } : {}),
  });
  // off is off at once: every open coaching card closes now (the Owner and Admins are tenant-wide), not at the next pass
  if (before.scoringEnabled && !after.scoringEnabled) await closeFixCards(tx, { now: o.now });
  const changes = redactDiff(
    { call_scoring_enabled: before.scoringEnabled, tl_sees_call_scores: before.tlSeesCallScores, coaching_rubric_disabled: prev },
    { call_scoring_enabled: after.scoringEnabled, tl_sees_call_scores: after.tlSeesCallScores, coaching_rubric_disabled: [...after.disabledKeys] },
    { entity: 'tenant_settings' },
  );
  if (Object.keys(changes).length > 0) {
    await audit(tx, actor, { action: 'coaching.settings_changed', entity: { type: 'tenant_settings', id: actor.tenantId }, changes });
  }
  return coachingSettingsView(tx, actor);
}
