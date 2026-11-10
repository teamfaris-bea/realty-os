// Policy layering (ARCHITECTURE §9 "Policy layering"; R-CONSENT-13, R-CONSENT-14, R-CONSENT-15,
// R-CONSENT-16; DATA_MODEL §1.2 jurisdiction_packs / compliance_policy_versions).
//
//   resolved = platform floor ∧ every jurisdiction pack ∧ the tenant policy version
//
// `resolvePolicy` only ever tightens: every pack and the tenant can narrow the contact window,
// lower caps, shrink the autonomous categories, shorten the inquiry basis window and the DNC scrub
// validity, and add opt-out keywords. The single exception the design allows is the Owner widening
// the contact window from the 09:00–20:00 default towards the 08:00–21:00 floor, which needs a
// recorded attestation (DB CHECK + owner-only trigger); without one the default applies.
//
// Every legal value here is a conservative engineering placeholder. VERIFY WITH COUNSEL.
import { type Instant, type LocalTime, formatLocalTime, localTime } from '../foundation/index.js';
import { normalizeKeyword } from './inbound.js';
import {
  type ActionCategory,
  AUTONOMOUS_ELIGIBLE,
  type Caps,
  type Keywords,
  type PartyRule,
} from './types.js';

export interface LocalWindow {
  start: LocalTime;
  end: LocalTime;
}

/** Core constants (ARCHITECTURE §9). VERIFY WITH COUNSEL every value. */
export interface PlatformFloor {
  /** The window every tenant gets without an attestation (R-CONSENT-13). */
  defaultWindow: LocalWindow;
  /** The widest window an attested Owner may choose (the "floor"). */
  widestWindow: LocalWindow;
  maxHumanReplyWindowMin: number;
  maxCaps: Caps;
  autonomousEligible: ReadonlySet<ActionCategory>;
  keywords: Keywords;
  maxInquiryBasisDays: number;
  maxDncValidityDays: number;
}

export const PLATFORM_FLOOR: PlatformFloor = Object.freeze({
  defaultWindow: { start: localTime('09:00'), end: localTime('20:00') },
  widestWindow: { start: localTime('08:00'), end: localTime('21:00') },
  maxHumanReplyWindowMin: 30,
  maxCaps: Object.freeze({
    autoSmsPer24h: 1,
    autoSmsPer7d: 3,
    autoEmailPer24h: 1,
    autoEmailPer7d: 3,
    autoCrossChannelPer24h: 2,
    manualSmsConfirmAfter24h: 3,
    callAttemptsPer24h: 3,
    maxDeferrals: 5,
  }),
  autonomousEligible: AUTONOMOUS_ELIGIBLE,
  keywords: Object.freeze({
    optOut: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'],
    resubscribe: ['START', 'UNSTOP'],
    help: ['HELP', 'INFO'],
  }),
  maxInquiryBasisDays: 90,
  maxDncValidityDays: 31,
});

// ---- jurisdiction packs -------------------------------------------------------------------------

export interface PackRules {
  /** The widest contact window this jurisdiction permits. */
  contactWindow?: LocalWindow;
  recordingPartyRule?: PartyRule;
  inquiryBasisDays?: number;
  dncScrubValidityDays?: number;
  optOutKeywords?: readonly string[];
  resubscribeKeywords?: readonly string[];
  helpKeywords?: readonly string[];
}

export interface JurisdictionPack {
  key: string; // 'US', 'US-SC'
  version: string;
  reviewedByCounselAt: Instant | null;
  rules: PackRules;
}

export interface JurisdictionPackRow {
  key: string;
  version: string;
  rules: unknown;
  reviewedByCounselAt: Instant | null;
}

export type PackParseResult =
  | { ok: true; pack: JurisdictionPack; ignoredKeys: string[] }
  | { ok: false; code: 'PACK_INVALID'; issues: string[] };

const PACK_KEY_RE = /^[A-Z]{2}(-[A-Z]{2})?$/;
const KNOWN_PACK_KEYS = new Set([
  'contact_window',
  'restricted_days',
  'recording_party_rule',
  'inquiry_basis_days',
  'dnc_scrub_validity_days',
  'opt_out_keywords',
  'resubscribe_keywords',
  'help_keywords',
  'ai_disclosure',
  'advertising',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTime(v: unknown): LocalTime | null {
  if (typeof v !== 'string') return null;
  try {
    return localTime(v);
  } catch {
    return null;
  }
}

function parseStringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim() !== '')) return null;
  return v as string[];
}

function parsePositiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Validates a `jurisdiction_packs` row. Fails closed: a malformed known rule, or a rule core cannot
 * apply (non-empty `restricted_days`, or `ai_disclosure`/`advertising` switched off), makes the
 * whole pack invalid, and the caller must not resolve a policy (so nothing is sent) until the pack
 * is fixed. Unknown keys are reported in `ignoredKeys`.
 */
export function parseJurisdictionPack(row: JurisdictionPackRow): PackParseResult {
  const issues: string[] = [];
  if (!PACK_KEY_RE.test(row.key)) issues.push('key: expected CC or CC-SS');
  if (typeof row.version !== 'string' || row.version.trim() === '') issues.push('version: required');
  if (!isRecord(row.rules)) return { ok: false, code: 'PACK_INVALID', issues: [...issues, 'rules: expected an object'] };
  const r = row.rules;
  const rules: PackRules = {};

  if (r.contact_window !== undefined) {
    const w = r.contact_window;
    const start = isRecord(w) ? parseTime(w.start) : null;
    const end = isRecord(w) ? parseTime(w.end) : null;
    if (start === null || end === null || start >= end) issues.push('contact_window: expected {start, end} with start < end');
    else rules.contactWindow = { start, end };
  }
  if (r.restricted_days !== undefined && !(Array.isArray(r.restricted_days) && r.restricted_days.length === 0)) {
    issues.push('restricted_days: not supported by this core version (fail closed)');
  }
  if (r.recording_party_rule !== undefined) {
    const v = r.recording_party_rule;
    if (v === 'one_party' || v === 'all_party' || v === 'unknown') rules.recordingPartyRule = v;
    else issues.push('recording_party_rule: expected one_party | all_party | unknown');
  }
  if (r.inquiry_basis_days !== undefined) {
    const v = parsePositiveInt(r.inquiry_basis_days);
    if (v === null) issues.push('inquiry_basis_days: expected a positive integer');
    else rules.inquiryBasisDays = v;
  }
  if (r.dnc_scrub_validity_days !== undefined) {
    const v = parsePositiveInt(r.dnc_scrub_validity_days);
    if (v === null) issues.push('dnc_scrub_validity_days: expected a positive integer');
    else rules.dncScrubValidityDays = v;
  }
  const lists = [
    ['opt_out_keywords', 'optOutKeywords'],
    ['resubscribe_keywords', 'resubscribeKeywords'],
    ['help_keywords', 'helpKeywords'],
  ] as const;
  for (const [raw, field] of lists) {
    if (r[raw] === undefined) continue;
    const v = parseStringList(r[raw]);
    if (v === null) issues.push(`${raw}: expected a list of non-empty strings`);
    else rules[field] = v;
  }
  if (r.ai_disclosure !== undefined) {
    if (!isRecord(r.ai_disclosure) || r.ai_disclosure.assistant_must_identify !== true) {
      issues.push('ai_disclosure.assistant_must_identify: core always identifies the assistant; only true is accepted');
    }
  }
  if (r.advertising !== undefined) {
    if (!isRecord(r.advertising) || r.advertising.brokerage_name_required !== true) {
      issues.push('advertising.brokerage_name_required: always required (R-GATE-12); only true is accepted');
    }
  }
  if (issues.length > 0) return { ok: false, code: 'PACK_INVALID', issues };
  const ignoredKeys = Object.keys(r).filter((k) => !KNOWN_PACK_KEYS.has(k)).sort();
  return { ok: true, pack: { key: row.key, version: row.version, reviewedByCounselAt: row.reviewedByCounselAt, rules }, ignoredKeys };
}

// ---- tenant policy versions ---------------------------------------------------------------------

/** One `compliance_policy_versions` row (camel-cased). Times accept 'HH:MM[:SS]' as Postgres returns them. */
export interface TenantPolicyVersion {
  id: string;
  contactWindowStart: LocalTime | string;
  contactWindowEnd: LocalTime | string;
  humanReplyWindowMinutes: number;
  emailQuietHours: boolean;
  autoSmsPer24h: number;
  autoSmsPer7d: number;
  autoEmailPer24h: number;
  autoEmailPer7d: number;
  autoCrossChannelPer24h: number;
  manualSmsConfirmAfter24h: number;
  callAttemptsPer24h: number;
  maxDeferrals: number;
  autonomousCategories: readonly string[];
  optOutConfirmationSender: 'provider' | 'platform';
  recordingEnabled: boolean;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
  looseningAttestation: string | null;
}

export interface ResolvedPolicy {
  version: { policyId: string; packs: Record<string, string> };
  /** Recipient-local contact window. `start >= end` means no instant is contactable. */
  window: LocalWindow;
  humanReplyWindowMin: number;
  caps: Caps;
  autonomous: ReadonlySet<ActionCategory>;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
  keywords: Keywords;
  inquiryBasisDays: number;
  dncValidityDays: number;
  emailQuietHours: boolean;
  // Additive fields (reported as spec corrections): needed by callers of the resolved policy.
  recordingEnabled: boolean;
  optOutConfirmationSender: 'provider' | 'platform';
  /** Pack keys without `reviewed_by_counsel_at`: the UI must say so plainly. */
  unreviewedPacks: string[];
}

function toLocal(t: LocalTime | string): LocalTime {
  return typeof t === 'string' ? localTime(t) : t;
}

function intersect(a: LocalWindow, b: LocalWindow): LocalWindow {
  return { start: (a.start > b.start ? a.start : b.start) as LocalTime, end: (a.end < b.end ? a.end : b.end) as LocalTime };
}

/** Clamp to [0, max]; NaN and non-numbers become 0 (strictest). Fractions round down. */
function capAtMost(v: number, max: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(Math.floor(v), max));
}

function upperUnique(lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>();
  for (const l of lists) for (const k of l) {
    const n = normalizeKeyword(k);
    if (n !== '') out.add(n);
  }
  return [...out].sort();
}

export function windowIsEmpty(w: LocalWindow): boolean {
  return w.start >= w.end;
}

export function formatWindow(w: LocalWindow): string {
  return `${formatLocalTime(w.start)}–${formatLocalTime(w.end)}`;
}

export function resolvePolicy(floor: PlatformFloor, packs: readonly JurisdictionPack[], tenant: TenantPolicyVersion): ResolvedPolicy {
  const attested = typeof tenant.looseningAttestation === 'string' && tenant.looseningAttestation.trim() !== '';

  // Window: the widest bound is the floor narrowed by every pack; the default is 09–20 within it.
  let bound = floor.widestWindow;
  for (const p of packs) if (p.rules.contactWindow) bound = intersect(bound, p.rules.contactWindow);
  const strictDefault = intersect(floor.defaultWindow, bound);
  const tenantWindow: LocalWindow = { start: toLocal(tenant.contactWindowStart), end: toLocal(tenant.contactWindowEnd) };
  const widens = tenantWindow.start < floor.defaultWindow.start || tenantWindow.end > floor.defaultWindow.end;
  const window = intersect(tenantWindow, widens && attested ? bound : strictDefault);

  const m = floor.maxCaps;
  const caps: Caps = {
    autoSmsPer24h: capAtMost(tenant.autoSmsPer24h, m.autoSmsPer24h),
    autoSmsPer7d: capAtMost(tenant.autoSmsPer7d, m.autoSmsPer7d),
    autoEmailPer24h: capAtMost(tenant.autoEmailPer24h, m.autoEmailPer24h),
    autoEmailPer7d: capAtMost(tenant.autoEmailPer7d, m.autoEmailPer7d),
    autoCrossChannelPer24h: capAtMost(tenant.autoCrossChannelPer24h, m.autoCrossChannelPer24h),
    manualSmsConfirmAfter24h: capAtMost(tenant.manualSmsConfirmAfter24h, m.manualSmsConfirmAfter24h),
    callAttemptsPer24h: capAtMost(tenant.callAttemptsPer24h, m.callAttemptsPer24h),
    maxDeferrals: Math.max(1, capAtMost(tenant.maxDeferrals, m.maxDeferrals)),
  };

  const autonomous = new Set<ActionCategory>();
  for (const c of tenant.autonomousCategories) {
    if (floor.autonomousEligible.has(c as ActionCategory)) autonomous.add(c as ActionCategory);
  }

  // Keywords: more opt-out and help words only add protection; a resubscribe word must be accepted
  // by the floor AND every pack that lists resubscribe words.
  let resubscribe = upperUnique([floor.keywords.resubscribe]);
  for (const p of packs) {
    if (p.rules.resubscribeKeywords) {
      const allowed = new Set(upperUnique([p.rules.resubscribeKeywords]));
      resubscribe = resubscribe.filter((k) => allowed.has(k));
    }
  }
  const keywords: Keywords = {
    optOut: upperUnique([floor.keywords.optOut, ...packs.map((p) => p.rules.optOutKeywords ?? [])]),
    resubscribe,
    help: upperUnique([floor.keywords.help, ...packs.map((p) => p.rules.helpKeywords ?? [])]),
  };

  let inquiryBasisDays = floor.maxInquiryBasisDays;
  let dncValidityDays = floor.maxDncValidityDays;
  for (const p of packs) {
    if (p.rules.inquiryBasisDays !== undefined) inquiryBasisDays = Math.min(inquiryBasisDays, p.rules.inquiryBasisDays);
    if (p.rules.dncScrubValidityDays !== undefined) dncValidityDays = Math.min(dncValidityDays, p.rules.dncScrubValidityDays);
  }

  const packVersions: Record<string, string> = {};
  for (const p of [...packs].sort((a, b) => (a.key < b.key ? -1 : 1))) packVersions[p.key] = p.version; // keys are unique

  return {
    version: { policyId: tenant.id, packs: packVersions },
    window,
    humanReplyWindowMin: capAtMost(tenant.humanReplyWindowMinutes, floor.maxHumanReplyWindowMin),
    caps,
    autonomous,
    recordingMode: tenant.recordingMode === 'one_party_where_permitted' && attested ? 'one_party_where_permitted' : 'announce_all',
    keywords,
    inquiryBasisDays,
    dncValidityDays,
    emailQuietHours: tenant.emailQuietHours === true,
    recordingEnabled: tenant.recordingEnabled === true,
    optOutConfirmationSender: tenant.optOutConfirmationSender === 'platform' ? 'platform' : 'provider',
    unreviewedPacks: packs.filter((p) => p.reviewedByCounselAt === null).map((p) => p.key).sort(),
  };
}
