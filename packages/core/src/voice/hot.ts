// The hot-lead rule (R-VOICE-6, R-AST-5, R-PRED-4, R-COACH-5; known gap (c)).
//
// HotRule is data over USABLE claims only (claimUsable: a needs-review claim never counts, nor does
// a rejected one), expressed in claim kinds and structured criteria only. It cannot name a contact
// attribute, a prediction band or a call score: the type has no such field, and parseHotRule
// rejects every key it does not know. No default criteria ship: which callers are hot is an Owner
// or product decision; until one is configured, nobody is transferred live.
import { CLAIM_KINDS, type ClaimKind, claimUsable } from '../assistant/index.js';
import type { HotCriterion, HotRule, VerifiedClaim } from './types.js';

function criterionMet(c: HotCriterion, usable: readonly VerifiedClaim[]): boolean {
  const n = usable.filter((claim) => {
    if (claim.kind !== c.claimKind) return false;
    if (c.criterionKey === undefined) return true;
    const crit = claim.structured?.criterion;
    if (crit === undefined || crit.key !== c.criterionKey) return false;
    return c.criterionValues === undefined || c.criterionValues.some((v) => v === crit.value);
  }).length;
  return n >= (c.atLeast ?? 1);
}

/** Whether the caller is hot under `rule`. Only claims claimUsable accepts are read. */
export function isHot(claims: readonly VerifiedClaim[], rule: HotRule): boolean {
  const usable = claims.filter((c) => claimUsable(c));
  return rule.anyOf.some((c) => criterionMet(c, usable));
}

export type HotRuleError = 'HOT_RULE_INVALID';

const CRITERION_KEYS = new Set(['claimKind', 'criterionKey', 'criterionValues', 'atLeast']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates a stored hot rule. Any unknown key (a band, a score, a stage, …) makes it invalid. */
export function parseHotRule(raw: unknown): { ok: true; rule: HotRule } | { ok: false; code: HotRuleError } {
  const bad = { ok: false as const, code: 'HOT_RULE_INVALID' as const };
  if (!isPlainObject(raw) || Object.keys(raw).some((k) => k !== 'anyOf') || !Array.isArray(raw.anyOf) || raw.anyOf.length > 20) return bad;
  const anyOf: HotCriterion[] = [];
  for (const c of raw.anyOf as unknown[]) {
    if (!isPlainObject(c) || Object.keys(c).some((k) => !CRITERION_KEYS.has(k))) return bad;
    if (typeof c.claimKind !== 'string' || !(CLAIM_KINDS as readonly string[]).includes(c.claimKind)) return bad;
    const out: HotCriterion = { claimKind: c.claimKind as ClaimKind };
    if (c.criterionKey !== undefined) {
      if (typeof c.criterionKey !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(c.criterionKey)) return bad;
      out.criterionKey = c.criterionKey;
    }
    if (c.criterionValues !== undefined) {
      if (out.criterionKey === undefined || !Array.isArray(c.criterionValues) || c.criterionValues.length === 0 || c.criterionValues.length > 20) return bad;
      if (!c.criterionValues.every((v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) return bad;
      out.criterionValues = c.criterionValues as (string | number | boolean)[];
    }
    if (c.atLeast !== undefined) {
      if (typeof c.atLeast !== 'number' || !Number.isInteger(c.atLeast) || c.atLeast < 1 || c.atLeast > 20) return bad;
      out.atLeast = c.atLeast;
    }
    anyOf.push(out);
  }
  return { ok: true, rule: { anyOf } };
}
