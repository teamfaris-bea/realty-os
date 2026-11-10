// Policy layering (ARCHITECTURE §9 "Policy layering"; R-CONSENT-7, R-CONSENT-16; DATA_MODEL §1.2
// jurisdiction_packs / compliance_policy_versions).
//
//   resolved = platform floor ∧ every jurisdiction pack ∧ the tenant policy version
//
// `resolvePolicy` only ever tightens: every pack and the tenant can shrink the autonomous categories,
// shorten the inquiry basis window (consent-ledger history) and add opt-out keywords. The Owner may
// choose one-party recording only with a recorded attestation (DB CHECK + owner-only trigger).
//
// core-compliance/2.0.0 (owner decision): the contact window / quiet hours, frequency caps and the
// DNC-registry rule are gone, so pack keys `contact_window`, `restricted_days` and
// `dnc_scrub_validity_days` are no longer applied (they are reported in `ignoredKeys`).
//
// Every legal value here is a conservative engineering placeholder. VERIFY WITH COUNSEL.
import type { Instant } from '../foundation/index.js';
import { normalizeKeyword } from './inbound.js';
import { type ActionCategory, AUTONOMOUS_ELIGIBLE, type Keywords, type PartyRule } from './types.js';

/** Core constants (ARCHITECTURE §9). VERIFY WITH COUNSEL every value. */
export interface PlatformFloor {
  autonomousEligible: ReadonlySet<ActionCategory>;
  keywords: Keywords;
  maxInquiryBasisDays: number;
}

export const PLATFORM_FLOOR: PlatformFloor = Object.freeze({
  autonomousEligible: AUTONOMOUS_ELIGIBLE,
  keywords: Object.freeze({
    optOut: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'],
    resubscribe: ['START', 'UNSTOP'],
    help: ['HELP', 'INFO'],
  }),
  maxInquiryBasisDays: 90,
});

// ---- jurisdiction packs -------------------------------------------------------------------------

export interface PackRules {
  recordingPartyRule?: PartyRule;
  inquiryBasisDays?: number;
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
  'recording_party_rule',
  'inquiry_basis_days',
  'opt_out_keywords',
  'resubscribe_keywords',
  'help_keywords',
  'ai_disclosure',
  'advertising',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
 * apply (`ai_disclosure`/`advertising` switched off), makes the whole pack invalid, and the caller
 * must not resolve a policy (so nothing is sent) until the pack is fixed. Unknown keys, and the
 * retired contact-window / DNC keys, are reported in `ignoredKeys`.
 */
export function parseJurisdictionPack(row: JurisdictionPackRow): PackParseResult {
  const issues: string[] = [];
  if (!PACK_KEY_RE.test(row.key)) issues.push('key: expected CC or CC-SS');
  if (typeof row.version !== 'string' || row.version.trim() === '') issues.push('version: required');
  if (!isRecord(row.rules)) return { ok: false, code: 'PACK_INVALID', issues: [...issues, 'rules: expected an object'] };
  const r = row.rules;
  const rules: PackRules = {};

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

/** One `compliance_policy_versions` row (camel-cased). */
export interface TenantPolicyVersion {
  id: string;
  autonomousCategories: readonly string[];
  optOutConfirmationSender: 'provider' | 'platform';
  recordingEnabled: boolean;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
  looseningAttestation: string | null;
}

export interface ResolvedPolicy {
  version: { policyId: string; packs: Record<string, string> };
  autonomous: ReadonlySet<ActionCategory>;
  recordingMode: 'announce_all' | 'one_party_where_permitted';
  keywords: Keywords;
  /** Expiry of an `inquiry` grant in the consent ledger (history; no send reads it). */
  inquiryBasisDays: number;
  recordingEnabled: boolean;
  optOutConfirmationSender: 'provider' | 'platform';
  /** Pack keys without `reviewed_by_counsel_at`: the UI must say so plainly. */
  unreviewedPacks: string[];
}

function upperUnique(lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>();
  for (const l of lists) for (const k of l) {
    const n = normalizeKeyword(k);
    if (n !== '') out.add(n);
  }
  return [...out].sort();
}

export function resolvePolicy(floor: PlatformFloor, packs: readonly JurisdictionPack[], tenant: TenantPolicyVersion): ResolvedPolicy {
  const attested = typeof tenant.looseningAttestation === 'string' && tenant.looseningAttestation.trim() !== '';

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
  for (const p of packs) {
    if (p.rules.inquiryBasisDays !== undefined) inquiryBasisDays = Math.min(inquiryBasisDays, p.rules.inquiryBasisDays);
  }

  const packVersions: Record<string, string> = {};
  for (const p of [...packs].sort((a, b) => (a.key < b.key ? -1 : 1))) packVersions[p.key] = p.version; // keys are unique

  return {
    version: { policyId: tenant.id, packs: packVersions },
    autonomous,
    recordingMode: tenant.recordingMode === 'one_party_where_permitted' && attested ? 'one_party_where_permitted' : 'announce_all',
    keywords,
    inquiryBasisDays,
    recordingEnabled: tenant.recordingEnabled === true,
    optOutConfirmationSender: tenant.optOutConfirmationSender === 'platform' ? 'platform' : 'provider',
    unreviewedPacks: packs.filter((p) => p.reviewedByCounselAt === null).map((p) => p.key).sort(),
  };
}
