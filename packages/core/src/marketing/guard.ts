// The marketing guard (R-MKT-1, R-MKT-3, R-FH-1, R-FH-2, R-GATE-12; E92, E93).
//
//   guardResult(rendered, identity, packs, fh, contentSha256) → GuardResult
//
// `guardResult` is the ONLY producer of `marketing_pieces.guard_result`. The approval CHECK reads:
//   content_sha256          echoed verbatim from the caller, who reads it from
//                           app.marketing_content_sha256 (the DB's own hash over prose, template,
//                           bound fields and ordered assets). Nothing here computes or rewrites it, so a
//                           result for other content can never match the row (`guardResultMatches`).
//   brokerage_name_present  the identity's legal name appears in the rendered text (R-MKT-1);
//   hard_count              hard fair-housing matches over the whole rendered text (R-FH-1, E93);
//   pack_rule_failures      every jurisdiction advertising rule that fails, with a human reason
//                           (E92), plus platform rules the DB cannot see otherwise: price/date
//                           numerals in copy (R-MKT-3), render refusals and render issues.
// Soft matches are listed (a person sees them, R-FH-2 "Check this") but never block approval.
// The DB compares brokerage_name_present and hard_count as text, so JSON `true` and `0` are emitted.
import { check, fairHousingReviewState, type FairHousingPack, type Match } from '../fairhousing/index.js';
import { numeralIssues } from './numerals.js';
import { resolveAdvertisingRules } from './packs.js';
import { foldName, renderPiece } from './render.js';
import { parseGuardResult } from './schemas.js';
import type { ListingFacts } from '../listings/index.js';
import type { Block, BrokerageIdentity, PieceVersion, GuardResult, GuardTermHit, NumeralIssue, PackRuleFailure, Packs, Prominence, Rendered } from './types.js';
import { PROMINENCE } from './types.js';

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const PROMINENCE_WORD: Readonly<Record<Prominence, string>> = {
  footnote: 'a footnote',
  small: 'small print',
  body: 'body text',
  heading: 'a heading',
  display: 'the largest text',
};

const rank = (p: Prominence): number => PROMINENCE.indexOf(p);

/** The most prominent block whose text contains `name` (folded), or -1. */
function maxRankOf(blocks: readonly Block[], name: string): number {
  const n = foldName(name);
  if (n === '') return -1;
  let best = -1;
  for (const b of blocks) if (foldName(b.text).includes(n)) best = Math.max(best, rank(b.prominence));
  return best;
}

/**
 * Extra readings of the copy for the fair-housing check, so wording cannot hide in layout:
 * - hashtags as words: "#PerfectForYoungFamilies" ⇒ "Perfect For Young Families", and spelled out
 *   letter by letter ("#adultsonly" ⇒ "a d u l t s o n l y", which the lexicon matches as one run);
 * - all prose blocks run together on one line, so a phrase split across a headline and the body
 *   ("Perfect for young" / "families …") is still read as one sentence;
 * - invisible characters also read as word breaks ("adults\u00ADonly" ⇒ "adults only").
 */
function extraReadings(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.role !== 'hashtags') continue;
    for (const tag of b.text.split(/\s+/u)) {
      const word = tag.replace(/^#/u, '');
      if (word === '') continue;
      out.push(word.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/_/g, ' '));
      out.push([...word.replace(/[_\p{N}]/gu, '')].join(' '));
    }
  }
  // invisible characters as word breaks ("adults\u00ADonly"): the lexicon drops them inside words
  for (const b of blocks) if (/\p{Default_Ignorable_Code_Point}/u.test(b.text)) out.push(b.text.replace(/\p{Default_Ignorable_Code_Point}+/gu, ' '));
  const prose = blocks.filter((b) => b.origin === 'prose').map((b) => b.text.replace(/\s+/gu, ' ').replace(/[.!?;:]+$/u, ''));
  if (prose.length > 1) out.push(prose.join(' '));
  return out;
}

function hits(ms: readonly Match[]): GuardTermHit[] {
  return ms.map((m) => ({ term_id: m.termId, text: m.text }));
}

function dedupe(xs: GuardTermHit[]): GuardTermHit[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.term_id}\u0000${x.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const wordIn = (hay: string, term: string): boolean => {
  const t = foldName(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t !== '' && new RegExp(`(?<![\\p{L}\\p{N}])${t}(?![\\p{L}\\p{N}])`, 'u').test(foldName(hay));
};

const quoteList = (xs: readonly string[]): string => xs.map((x) => `"${x}"`).join(', ');

/**
 * The guard result for one rendering. Total: a refusal yields a failing result (no brokerage name,
 * the refusal as a failure). `contentSha256` is echoed verbatim.
 */
export function guardResult(r: Rendered, identity: BrokerageIdentity, packs: Packs, fh: FairHousingPack, contentSha256: string): GuardResult {
  const failures: PackRuleFailure[] = [];
  const base = { content_sha256: contentSha256, lexicon_version: fh.lexiconVersion, fair_housing_reviewed: fairHousingReviewState(fh).reviewed };
  if (!SHA256_HEX_RE.test(contentSha256)) {
    failures.push({ rule_id: 'platform.content_hash', pack_id: 'platform', reason: 'The guard ran without the content hash of this version; run the check again.' });
  }
  if (!r.ok) {
    failures.push({ rule_id: r.code, pack_id: 'platform', reason: r.reason });
    return { ...base, brokerage_name_present: false, hard_count: 0, hard: [], soft: [], pack_rule_failures: failures, numeral_issues: [] };
  }

  // fair housing over everything a reader sees (R-FH-1), hashtags also as words
  const readings = [check(r.text, fh), ...extraReadings(r.blocks).map((t) => check(t, fh))];
  const hard = dedupe(readings.flatMap((x) => hits(x.hard)));
  const hardIds = new Set(hard.map((h) => `${h.term_id}\u0000${h.text.toLowerCase()}`));
  const soft = dedupe(readings.flatMap((x) => hits(x.soft))).filter((x) => !hardIds.has(`${x.term_id}\u0000${x.text.toLowerCase()}`));

  // R-MKT-1: the legal name is rendered
  const legal = foldName(identity.brokerageLegalName);
  const brokeragePresent = legal !== '' && foldName(r.text).includes(legal);

  // R-MKT-3: no price/date numerals in prose blocks
  const numerals: NumeralIssue[] = [];
  for (const b of r.blocks) {
    if (b.origin !== 'prose') continue;
    for (const h of numeralIssues(b.text)) numerals.push({ role: b.role, shape: h.shape, text: h.text });
  }
  if (numerals.length > 0) {
    failures.push({
      rule_id: 'R-MKT-3',
      pack_id: 'platform',
      reason: `Prices, dates and times come from the listing facts, not the copy. Remove ${quoteList(numerals.map((n) => n.text))} from the copy.`,
    });
  }

  for (const i of r.issues) failures.push({ rule_id: i.ruleId, pack_id: 'platform', reason: i.reason });

  // jurisdiction advertising rules (VERIFY WITH COUNSEL: every rule is pack data)
  const rules = resolveAdvertisingRules(packs);
  const packIds = (id: keyof typeof rules.requiredBy): string => rules.requiredBy[id].join(', ');
  const team = identity.teamName.trim();
  const teamDistinct = foldName(team) !== '' && foldName(team) !== legal;
  if (rules.brokerageNameAtLeastAsProminentAsTeam && teamDistinct) {
    const t = maxRankOf(r.blocks, team);
    const b = maxRankOf(r.blocks, identity.brokerageLegalName);
    if (t >= 0 && b < t) {
      const brokerageWhere = b < 0 ? 'missing' : `shown as ${PROMINENCE_WORD[PROMINENCE[b] as Prominence]}`;
      failures.push({
        rule_id: 'brokerage_name_prominence',
        pack_id: packIds('brokerage_name_prominence'),
        reason: `The brokerage name "${identity.brokerageLegalName.trim()}" must be at least as prominent as the team name "${team}". Here the team name is shown as ${PROMINENCE_WORD[PROMINENCE[t] as Prominence]} and the brokerage name is ${brokerageWhere}.`,
      });
    }
  }
  if (rules.requireLicenseNumber && !r.blocks.some((b) => b.role === 'license' && b.text !== '')) {
    failures.push({ rule_id: 'license_number', pack_id: packIds('license_number'), reason: "The brokerage licence number must appear on every piece, and it isn't set in your brokerage settings." });
  }
  if (rules.requireBrokerageAddress && !r.blocks.some((b) => b.role === 'brokerage_address' && b.text !== '')) {
    failures.push({ rule_id: 'brokerage_address', pack_id: packIds('brokerage_address'), reason: "The brokerage office address must appear on every piece, and it isn't set in your brokerage settings." });
  }
  if (rules.requireEqualHousingStatement && !foldName(r.text).includes(foldName(rules.equalHousingStatement))) {
    failures.push({ rule_id: 'equal_housing_statement', pack_id: packIds('equal_housing_statement'), reason: `The statement "${rules.equalHousingStatement}" must appear on every piece.` });
  }
  const badTerms = rules.teamNameForbiddenTerms.filter((term) => wordIn(team, term));
  if (badTerms.length > 0) {
    failures.push({
      rule_id: 'team_name_terms',
      pack_id: packIds('team_name_terms'),
      reason: `The team name "${team}" uses ${quoteList(badTerms)}, which advertising rules here do not allow in a team name.`,
    });
  }

  return {
    ...base,
    brokerage_name_present: brokeragePresent,
    hard_count: hard.length,
    hard,
    soft,
    pack_rule_failures: failures,
    numeral_issues: numerals,
  };
}

/** Whether a (stored) guard result was computed over this content hash. Anything that is not a guard result is false. */
export function guardResultMatches(gr: unknown, contentSha256: string): boolean {
  const g = parseGuardResult(gr);
  return g !== null && SHA256_HEX_RE.test(contentSha256) && g.content_sha256 === contentSha256;
}

/** Mirrors the marketing_pieces approval CHECK exactly: what the DB will accept for a row with this hash. */
export function guardPasses(gr: unknown, contentSha256: string): boolean {
  const g = parseGuardResult(gr);
  if (g === null || !guardResultMatches(g, contentSha256)) return false;
  return g.brokerage_name_present && g.hard_count === 0 && g.pack_rule_failures.length === 0;
}

/** Every reason approval is refused, as sentences for the person approving (empty ⇒ approvable). */
export function guardReasons(gr: GuardResult, contentSha256: string): string[] {
  const out: string[] = [];
  if (!guardResultMatches(gr, contentSha256)) out.push('This check was run on a different version of the copy. Run it again.');
  if (!gr.brokerage_name_present) out.push('The brokerage name must appear on every piece.');
  if (gr.hard_count > 0) out.push(`Fair-housing wording must be changed before approval: ${quoteList(gr.hard.map((h) => h.text))}.`);
  for (const f of gr.pack_rule_failures) out.push(f.reason);
  return out;
}

/** R-FH-2: any fair-housing match (hard or soft) flags the piece "Check this" for the approver. */
export function needsFairHousingCheck(gr: GuardResult): boolean {
  return gr.hard.length > 0 || gr.soft.length > 0;
}

/**
 * R-MKT-4: after a brokerage identity or pack change, re-render a live (approved/published) version
 * and re-run the guard over its unchanged content hash. A version that no longer passes is
 * unpublished from pages we control (within 1 h, module 29's job) and needs a new version; the
 * frozen guard_result of the old version is never rewritten.
 */
export function liveRecheck(
  p: PieceVersion,
  facts: ListingFacts,
  identity: BrokerageIdentity,
  packs: Packs,
  fh: FairHousingPack,
  contentSha256: string,
): { action: 'keep' | 'unpublish'; guard: GuardResult; reasons: string[] } {
  const g = guardResult(renderPiece(p, facts, identity, packs), identity, packs, fh, contentSha256);
  const reasons = guardReasons(g, contentSha256);
  return { action: reasons.length === 0 ? 'keep' : 'unpublish', guard: g, reasons };
}

/** R-AST-19: the assistant kind of a marketing draft; its autonomy is fixed by the DB CHECK. */
export const MARKETING_DRAFT_ACTION = Object.freeze({ kind: 'marketing_draft', autonomy: 'requires_approval' } as const);
