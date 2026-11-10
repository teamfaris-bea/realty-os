// Routing (R-OWN-10): first enabled rule by ascending position whose match fields all hold; the
// strategies round_robin (stored cursor, stable user_id order), weighted (smooth WRR, ties to the
// lowest user_id), direct and pond. Selection is a pure function of (members, eligibility, cursor);
// the caller persists `cursorAfter` in the same transaction as the `offered` event. Routing runs
// only as the system actor (ARCHITECTURE §5), which is decide()'s concern, not this file's.
import { z } from 'zod';
import type { LeadSourceId, UserId } from '../foundation/index.js';
import { skipReason } from './eligibility.js';
import type {
  Candidate,
  ConsideredCandidate,
  InquiryFacts,
  InquiryType,
  OwnershipEvent,
  RotationCursor,
  RoutingMatch,
  RuleFacts,
} from './types.js';

// ---- match --------------------------------------------------------------------------------------

const INQUIRY_TYPES = ['buy', 'sell', 'rent', 'value', 'general'] as const;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** routing_rules.match as stored (snake_case jsonb). Unknown keys are rejected (fewer concepts, A1). */
export const routingMatchSchema = z
  .object({
    sources: z.array(uuid).max(200).optional(),
    lead_types: z.array(z.enum(INQUIRY_TYPES)).max(5).optional(),
    zips: z.array(z.string().regex(/^\d{5}(-\d{4})?$/)).max(2000).optional(),
    price_min: cents.optional(),
    price_max: cents.optional(),
  })
  .strict()
  .refine((m) => m.price_min === undefined || m.price_max === undefined || m.price_min <= m.price_max, {
    message: 'price_min must be <= price_max',
  });

export type RoutingMatchJson = z.infer<typeof routingMatchSchema>;

/** Validates stored/admin-entered match jsonb and converts it to RoutingMatch. */
export function parseRoutingMatch(json: unknown): { ok: true; match: RoutingMatch } | { ok: false; code: 'VALIDATION_FAILED'; issues: string[] } {
  const r = routingMatchSchema.safeParse(json);
  if (!r.success) return { ok: false, code: 'VALIDATION_FAILED', issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const m = r.data;
  const match: RoutingMatch = {};
  if (m.sources) match.sources = m.sources.map((s) => s.toLowerCase() as LeadSourceId);
  if (m.lead_types) match.leadTypes = [...m.lead_types];
  if (m.zips) match.zips = m.zips.map((zip) => zip.slice(0, 5));
  if (m.price_min !== undefined) match.priceMin = m.price_min;
  if (m.price_max !== undefined) match.priceMax = m.price_max;
  return { ok: true, match };
}

/** The 5-digit US ZIP of a postal code, or null. */
export function normalizeZip(postal: string | null | undefined): string | null {
  if (!postal) return null;
  const m = /^\s*(\d{5})(?:[-\s]?\d{4})?\s*$/.exec(postal);
  return m ? (m[1] as string) : null;
}

function priceMatches(match: RoutingMatch, i: InquiryFacts): boolean {
  if (match.priceMin === undefined && match.priceMax === undefined) return true;
  const lo = i.priceMinCents ?? i.priceMaxCents;
  const hi = i.priceMaxCents ?? i.priceMinCents;
  if (lo === null || hi === null) return false; // a price-band rule never matches an inquiry without a price
  const rMin = match.priceMin ?? 0;
  const rMax = match.priceMax ?? Number.MAX_SAFE_INTEGER;
  return lo <= rMax && hi >= rMin; // the bands overlap
}

/** Whether every match field of `match` holds for `inquiry` (absent / empty fields hold). */
export function ruleMatches(match: RoutingMatch, inquiry: InquiryFacts): boolean {
  if (match.sources && match.sources.length > 0) {
    if (inquiry.leadSourceId === null || !match.sources.includes(inquiry.leadSourceId.toLowerCase() as LeadSourceId)) return false;
  }
  if (match.leadTypes && match.leadTypes.length > 0) {
    if (inquiry.inquiryType === null || !match.leadTypes.includes(inquiry.inquiryType as InquiryType)) return false;
  }
  if (match.zips && match.zips.length > 0) {
    const zip = normalizeZip(inquiry.postalCode);
    if (zip === null || !match.zips.includes(zip)) return false;
  }
  return priceMatches(match, inquiry);
}

/** R-OWN-10: enabled rules by ascending position (ties by id); the first match wins; null ⇒ default pond. */
export function matchRule(rules: RuleFacts[], inquiry: InquiryFacts): RuleFacts | null {
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position || cmp(a.id, b.id));
  return ordered.find((r) => ruleMatches(r.match, inquiry)) ?? null;
}

// ---- selection ----------------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface Selection {
  pick: UserId | null;
  cursorAfter: RotationCursor;
  considered: ConsideredCandidate[];
}

function consider(c: Candidate, cap: number): ConsideredCandidate {
  const reason = skipReason(c, cap);
  return reason === null ? { userId: c.userId, eligible: true } : { userId: c.userId, eligible: false, skipReason: reason };
}

/**
 * Picks the next candidate for `rule`. `members` are the rule's routing_rule_members joined with
 * their eligibility inputs; `capacityCap` is tenant_settings.uncontacted_capacity_cap (R-OWN-11.7).
 * `considered` lists every evaluated member in evaluation order with its skip reason.
 */
export function selectCandidate(rule: RuleFacts, members: Candidate[], cursor: RotationCursor, opts: { capacityCap: number } = { capacityCap: 5 }): Selection {
  const cap = opts.capacityCap;
  const sorted = dedupeMembers(members).sort((a, b) => cmp(a.userId, b.userId));
  switch (rule.strategy) {
    case 'pond':
      return { pick: null, cursorAfter: cursor, considered: [] };
    case 'direct': {
      const c = sorted.find((m) => m.userId === rule.directUserId);
      if (!c) return { pick: null, cursorAfter: cursor, considered: [] };
      const considered = [consider(c, cap)];
      return { pick: considered[0]?.eligible ? c.userId : null, cursorAfter: cursor, considered };
    }
    case 'round_robin': {
      const last = cursor.lastUserId ?? null;
      const start = last === null ? 0 : sorted.findIndex((m) => m.userId > last);
      const from = start < 0 ? 0 : start;
      const order = [...sorted.slice(from), ...sorted.slice(0, from)];
      const considered = order.map((c) => consider(c, cap));
      const pick = considered.find((c) => c.eligible)?.userId ?? null;
      return { pick, cursorAfter: pick === null ? cursor : { lastUserId: pick }, considered };
    }
    case 'weighted': {
      const considered = sorted.map((c) => consider(c, cap));
      const prev = cursor.current ?? {};
      const current: Record<string, number> = {};
      for (const m of sorted) current[m.userId] = finiteOr0(prev[m.userId]); // members removed from the rule drop out
      let total = 0;
      let pick: Candidate | null = null;
      sorted.forEach((m, i) => {
        if (!considered[i]?.eligible) return;
        const w = Math.max(1, Math.trunc(m.weight));
        total += w;
        current[m.userId] = (current[m.userId] as number) + w;
        if (pick === null || (current[m.userId] as number) > (current[pick.userId] as number)) pick = m; // ties keep the lower user_id
      });
      if (pick === null) return { pick: null, cursorAfter: cursor, considered };
      const chosen: Candidate = pick;
      current[chosen.userId] = (current[chosen.userId] as number) - total;
      return { pick: chosen.userId, cursorAfter: { current }, considered };
    }
  }
}

function finiteOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function dedupeMembers(members: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return members.filter((m) => (seen.has(m.userId) ? false : (seen.add(m.userId), true)));
}

/**
 * Users offered this lead in the current routing sequence, from the ledger: the offerees of the
 * `offered` events since the sequence began (the last event that left `offered`/`unassigned`
 * for owned, in_pond or closed, or created the contact). Feeds R-OWN-11 step 5.
 */
export function offeredInCurrentSequence(events: readonly OwnershipEvent[]): UserId[] {
  const out: UserId[] = [];
  for (const e of events) {
    if (e.toState === 'owned' || e.toState === 'in_pond' || e.toState === 'closed' || e.fromState === null) out.length = 0;
    if (e.type === 'offered' && e.offeredToUserId !== null && !out.includes(e.offeredToUserId)) out.push(e.offeredToUserId);
  }
  return out;
}
