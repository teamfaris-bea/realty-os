// Source coverage (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11).
//
// A lead source can carry a named owner, a named backup, a "high intent" mark and a "covered" switch. Pure rules:
//   - COVERED is true only when the switch is on AND an owner and a backup are both named AND both are active
//     members. A suspended or deactivated owner or backup leaves the source flagged and not covered; the person
//     stays named: nothing is ever reassigned here.
//   - the warnings are computed, each a code and a sentence a person can act on. None of them changes a lead.
//   - sourceRouting: the routing rule a source's leads follow and the pond they fall back to, read from the same
//     rule facts the router matches on (R-OWN-10: enabled rules by position, the first match wins).
// What the minute-three backup alert and the auto-release do with this is decided where they run (decide.ts, and
// apps/api leads/backupAlert.ts); this file only describes the source.
import type { LeadSourceId, PondId, RuleId, UserId } from '../foundation/index.js';
import type { MembershipStatus, RuleFacts } from './types.js';

export const COVERAGE_WARNING_CODES = ['NO_OWNER', 'NO_BACKUP', 'OWNER_UNAVAILABLE', 'BACKUP_UNAVAILABLE', 'SAME_PERSON', 'BACKUP_IN_ROTATION', 'NO_ROUTING_RULE', 'SHARED_FALLBACK_POND'] as const;
export type CoverageWarningCode = (typeof COVERAGE_WARNING_CODES)[number];

export interface CoverageWarning {
  code: CoverageWarningCode;
  sentence: string;
}

export interface CoverageMember {
  userId: UserId;
  /** users.display_name (null: none on file) */
  name: string | null;
  status: MembershipStatus;
}

/** The rule a source's leads follow, and the pond they fall back to. */
export interface SourceRouting {
  /** an enabled routing rule names this source in its match */
  named: boolean;
  /** the id of the rule its leads follow (null: none) */
  ruleId: RuleId | null;
  /** the rule its leads follow: the first that names it, else the first that names no source; null: none (the default pond) */
  ruleName: string | null;
  /** where its leads go when nobody takes them: the rule's pond or fallback pond, else the default pond */
  pondId: PondId;
}

export interface SourceCoverageFacts {
  owner: CoverageMember | null;
  backup: CoverageMember | null;
  highIntent: boolean;
  /** the stored switch (lead_sources.covered) */
  coveredSetting: boolean;
  routing: SourceRouting;
  /** the name of `routing.pondId` */
  fallbackPondName: string;
  /** the names of the OTHER lead sources whose leads fall back to the same pond */
  sharedWith: readonly string[];
  /**
   * R-TEAMQ-24: the team's auto-release time for a lead with no first contact (tenant first_touch_release_seconds;
   * null: the team turned it off). Absent: 1800, the default.
   */
  releaseSeconds?: number | null;
  /**
   * R-TEAMQ-21: the members who receive this source's leads: the rotation of the rule its leads follow (its members,
   * or its one direct member). Absent or empty: nobody is offered them (a pond rule, or no rule).
   */
  rotation?: readonly UserId[];
}

export interface SourceCoverage {
  /** covered now: the switch is on and the owner and the backup are both active members */
  covered: boolean;
  /** the stored switch */
  setting: boolean;
  /** the state in words, never a colour alone: "Covered: …" or "Not covered: …" */
  sentence: string;
  warnings: CoverageWarning[];
  /**
   * R-TEAMQ-24: what happens to this source's leads NOW, in words, from coverageNow: first the minute-three alert
   * (who it goes to, or that none is sent), then the automatic return to the pond with the team's own time.
   */
  effects: string[];
}

/** What "covered now" means for a source, in one table (R-TEAMQ-24). */
export interface CoverageNow {
  /** the switch is on and the named owner and the named backup are both active members */
  covered: boolean;
  /**
   * the minute-three alert of this source's inquiries: `off` while the switch is off; while it is on the alert always
   * fires: to the named `backup` when they are an active member, else to the `fallback` (the team lead of whoever has
   * the lead, else the Owners and Admins: core priority backupAlertRecipients, owner decision 2)
   */
  alert: 'backup' | 'fallback' | 'off';
  /** the tenant's auto-release of an untouched lead: `waived` only while covered (and the lead's own owner is active) */
  autoRelease: 'waived' | 'on';
}

/**
 * R-TEAMQ-20, R-TEAMQ-24 (review fixes M1 and L3): the ONE definition of "covered now" and of what follows from it,
 * read by the coverage card (sourceCoverage below), the auto-release (autoReleaseWaivedNow) and the minute-three
 * alert (apps/api leads/backupAlert.ts). A source whose named owner or backup is unavailable is NOT covered: its
 * auto-release is back on. Its alert does not go quiet for that: while the switch is on it still tells someone.
 */
export function coverageNow(f: { setting: boolean; ownerStatus: MembershipStatus | null; backupStatus: MembershipStatus | null }): CoverageNow {
  const covered = f.setting && f.ownerStatus === 'active' && f.backupStatus === 'active';
  return { covered, alert: !f.setting ? 'off' : f.backupStatus === 'active' ? 'backup' : 'fallback', autoRelease: covered ? 'waived' : 'on' };
}

/** R-TEAMQ-20: covered now (coverageNow's first column). */
export function coveredNow(f: { setting: boolean; ownerStatus: MembershipStatus | null; backupStatus: MembershipStatus | null }): boolean {
  return coverageNow(f).covered;
}

/**
 * R-TEAMQ-13, R-TEAMQ-20 (review fix M1): whether a LEAD's auto-release is waived now: its source's auto-release is
 * waived (covered now) AND the lead's own owner is an active member. A lead held by a suspended or deactivating
 * member is released as on an uncovered source: the source's cover does not make up for nobody being there to make
 * the first touch.
 */
export function autoReleaseWaivedNow(f: { setting: boolean; ownerStatus: MembershipStatus | null; backupStatus: MembershipStatus | null; leadOwnerStatus: MembershipStatus | null }): boolean {
  return coverageNow(f).autoRelease === 'waived' && f.leadOwnerStatus === 'active';
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A rule with no condition at all: it matches every inquiry, so no later rule is ever reached. */
function unconditional(r: RuleFacts): boolean {
  const m = r.match;
  return (m.sources === undefined || m.sources.length === 0) && (m.leadTypes === undefined || m.leadTypes.length === 0) && (m.zips === undefined || m.zips.length === 0) && m.priceMin === undefined && m.priceMax === undefined;
}

/**
 * The rule a source's leads follow (R-OWN-10 order: enabled rules by position, ties by id; the first match wins):
 * the first rule whose match names the source, unless a rule with no condition at all comes before it (that rule
 * takes every lead, so the naming rule is never reached and the source is NOT named in effect); else the first rule
 * that names no source (it may have other conditions, so it is "not specific to it", never promised to match); else
 * none, and its leads go to the default pond.
 */
export function sourceRouting(rules: readonly RuleFacts[], sourceId: LeadSourceId, defaultPondId: PondId): SourceRouting {
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position || cmp(a.id, b.id));
  let naming: RuleFacts | null = null;
  for (const r of ordered) {
    if (r.match.sources?.includes(sourceId) === true) {
      naming = r;
      break;
    }
    if (unconditional(r)) break;
  }
  const rule = naming ?? ordered.find((r) => r.match.sources === undefined || r.match.sources.length === 0) ?? null;
  const pondId = rule === null ? defaultPondId : rule.strategy === 'pond' ? (rule.targetPondId ?? defaultPondId) : (rule.fallbackPondId ?? defaultPondId);
  return { named: naming !== null, ruleId: rule === null ? null : rule.id, ruleName: rule === null ? null : (rule.name ?? 'an unnamed rule'), pondId };
}

const nameOf = (m: CoverageMember): string => (m.name !== null && m.name.trim() !== '' ? m.name.trim() : 'a member with no name');

/** Why a named member cannot act, in words. */
function unavailableWords(status: MembershipStatus): string {
  if (status === 'suspended') return 'is suspended';
  if (status === 'invited') return 'has not joined the team yet';
  return 'is no longer on the team';
}

function listed(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more ${more === 1 ? 'source' : 'sources'}`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** "30 minutes", "90 seconds", "2 hours": a duration a person set, in the largest unit that is exact. */
function durationWords(seconds: number): string {
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'}`;
  if (seconds % 3600 === 0) return n(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return n(seconds / 60, 'minute');
  return n(seconds, 'second');
}

/** R-TEAMQ-24: what happens to the source's leads now, in words (the alert, then the automatic return to the pond). */
function coverageEffects(now: CoverageNow, backup: CoverageMember | null, releaseSeconds: number | null): string[] {
  const alert =
    now.alert === 'off'
      ? 'No backup alert is sent for this source.'
      : now.alert === 'backup'
        ? `${now.covered ? 'A' : 'The backup alert still fires: a'} new lead nobody has called, texted or emailed after 3 minutes of staffed time alerts the backup, ${nameOf(backup as CoverageMember).replace(/\.$/, '')}.`
        : 'The backup alert still fires: after 3 minutes of staffed time it goes to the team lead of whoever has the lead, or to the Owners and Admins when there is no team lead.';
  let release: string;
  if (releaseSeconds === null) release = 'The team has the automatic return to the pond turned off, so an untouched lead stays with its owner.';
  else if (now.autoRelease === 'waived') release = `A lead with no first contact is not sent back to the pond after ${durationWords(releaseSeconds)} while its own owner is an active member.`;
  else if (now.alert === 'off') release = `A lead with no first contact goes back to the pond after ${durationWords(releaseSeconds)}, the team's setting.`;
  else release = `A lead with no first contact goes back to the pond after ${durationWords(releaseSeconds)} again, as on any source that is not covered.`;
  return [alert, release];
}

/** Whether a source is covered now, the sentence that says so, its warnings and what happens now (R-TEAMQ-10, R-TEAMQ-11, R-TEAMQ-24). */
export function sourceCoverage(f: SourceCoverageFacts): SourceCoverage {
  const { owner, backup } = f;
  const ownerOut = owner !== null && owner.status !== 'active';
  const backupOut = backup !== null && backup.status !== 'active';
  const now = coverageNow({ setting: f.coveredSetting, ownerStatus: owner?.status ?? null, backupStatus: backup?.status ?? null });
  const covered = now.covered;
  const warnings: CoverageWarning[] = [];
  if (owner === null) warnings.push({ code: 'NO_OWNER', sentence: 'No owner is named for this source.' });
  if (backup === null) warnings.push({ code: 'NO_BACKUP', sentence: 'No backup is named for this source.' });
  if (owner !== null && ownerOut) {
    warnings.push({ code: 'OWNER_UNAVAILABLE', sentence: `The owner, ${nameOf(owner)}, ${unavailableWords(owner.status)}. Nobody was put in their place: name another owner.` });
  }
  if (backup !== null && backupOut) {
    warnings.push({
      code: 'BACKUP_UNAVAILABLE',
      sentence: `The backup, ${nameOf(backup)}, ${unavailableWords(backup.status)}. Nobody was put in their place: until another backup is named, the backup alert goes to the team lead of whoever has the lead, or to the Owners and Admins when there is no team lead.`,
    });
  }
  if (owner !== null && backup !== null && owner.userId === backup.userId) {
    warnings.push({ code: 'SAME_PERSON', sentence: `The owner and the backup are the same person, ${nameOf(owner)}: nobody else is alerted when they do not respond.` });
  }
  if (backup !== null && (f.rotation ?? []).includes(backup.userId)) {
    // R-TEAMQ-21: a lead with the backup is never alerted to the backup themself
    warnings.push({ code: 'BACKUP_IN_ROTATION', sentence: 'The backup also receives these leads. When a lead is with them, their team lead is alerted instead.' });
  }
  if (!f.routing.named) {
    const where = f.routing.ruleName === null ? `its leads go straight to the pond "${f.fallbackPondName}"` : `its leads follow the rule "${f.routing.ruleName}", which is not specific to it`;
    warnings.push({ code: 'NO_ROUTING_RULE', sentence: `No routing rule names this source: ${where}.` });
  }
  if (f.sharedWith.length > 0) {
    warnings.push({ code: 'SHARED_FALLBACK_POND', sentence: `Its fallback pond, "${f.fallbackPondName}", is also the fallback pond of ${listed(f.sharedWith)}.` });
  }

  let sentence: string;
  if (covered) sentence = `Covered: ${nameOf(owner as CoverageMember)} owns this source and ${nameOf(backup as CoverageMember)} is the backup.`;
  else if (owner === null && backup === null) sentence = 'Not covered: no owner and no backup are named.';
  else if (owner === null) sentence = 'Not covered: no owner is named.';
  else if (backup === null) sentence = 'Not covered: no backup is named.';
  else if (ownerOut) sentence = `Not covered: the owner, ${nameOf(owner)}, ${unavailableWords(owner.status)}.`;
  else if (backupOut) sentence = `Not covered: the backup, ${nameOf(backup)}, ${unavailableWords(backup.status)}.`;
  else sentence = `Not covered: ${nameOf(owner)} and ${nameOf(backup)} are named, but coverage is turned off.`;
  return { covered, setting: f.coveredSetting, sentence, warnings, effects: coverageEffects(now, backup, f.releaseSeconds === undefined ? 1800 : f.releaseSeconds) };
}
