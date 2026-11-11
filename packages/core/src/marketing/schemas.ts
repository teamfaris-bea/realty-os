// Zod schemas of core/marketing (zod 4):
//
// - `PieceSchemas`: the prose shape of each piece kind (marketing_pieces.prose). Prose is the only
//   written text of a piece; bound facts never live in it (R-MKT-3). Unknown keys are refused, so a
//   writer cannot smuggle a "price" key past the renderer.
// - `AdvertisingPackSchema` / `advertisingPackFrom`: jurisdiction advertising rules as data. Every
//   missing or malformed value parses to the strictest one (fail closed). VERIFY WITH COUNSEL.
// - `GuardResultSchema`: the exact JSON the approval CHECK of marketing_pieces reads (R-MKT-1,
//   R-FH-1, R-GATE-12). `guardResult` (./guard.ts) is its only producer.
import { z } from 'zod';
import type { AdvertisingPack, GuardResult, PieceKind } from './types.js';
import { PIECE_KINDS } from './types.js';

const line = (max: number) => z.string().trim().min(1).max(max);
const text = (max: number) => z.string().trim().min(1).max(max);
const highlights = z.array(line(140)).max(12);
const hashtag = z.string().regex(/^#[\p{L}\p{N}_]{1,60}$/u, 'a hashtag is # followed by letters, digits or _');

export const PieceSchemas = {
  website_page: z.strictObject({ headline: line(120), body: text(6000), highlights }),
  social_post: z.strictObject({ caption: text(2000), hashtags: z.array(hashtag).max(30) }),
  open_house_invite: z.strictObject({ subject: line(150), body: text(6000) }),
  flyer: z.strictObject({ headline: line(90), body: text(1200), highlights: z.array(line(140)).max(8) }),
  marketplace_export: z.strictObject({ title: line(100), description: text(5000) }),
  gbp_post: z.strictObject({ body: text(1500) }),
} as const satisfies Record<PieceKind, z.ZodType>;

export const PieceKindSchema = z.enum(PIECE_KINDS);

// ---- advertising packs ----------------------------------------------------------------------------

/** The strictest advertising rules: what applies when no pack (or an empty one) is given. VERIFY WITH COUNSEL. */
export const STRICTEST_ADVERTISING_PACK: AdvertisingPack = Object.freeze({
  id: 'platform.default',
  brokerageNameAtLeastAsProminentAsTeam: true,
  requireLicenseNumber: true,
  requireBrokerageAddress: true,
  requireEqualHousingStatement: true,
  equalHousingStatement: 'Equal Housing Opportunity.',
  teamNameForbiddenTerms: Object.freeze([]) as readonly string[],
  reviewedByCounselAt: null,
});

/** jurisdiction_packs.rules.advertising as stored (snake_case). Every key optional; `.catch` = strictest. */
export const AdvertisingPackSchema = z.object({
  brokerage_name_at_least_as_prominent_as_team: z.boolean().catch(true).default(true),
  require_license_number: z.boolean().catch(true).default(true),
  require_brokerage_address: z.boolean().catch(true).default(true),
  require_equal_housing_statement: z.boolean().catch(true).default(true),
  equal_housing_statement: z.string().trim().min(1).max(200).catch(STRICTEST_ADVERTISING_PACK.equalHousingStatement).default(STRICTEST_ADVERTISING_PACK.equalHousingStatement),
  team_name_forbidden_terms: z.array(z.string().trim().min(1).max(60)).max(100).catch([]).default([]),
});

/**
 * Parse one pack's advertising rules. Anything that is not an object parses to the strictest pack
 * (under the given id). Never throws.
 */
export function advertisingPackFrom(id: string, json: unknown, reviewedByCounselAt: string | null = null): AdvertisingPack {
  const raw = typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {};
  const r = AdvertisingPackSchema.safeParse(raw);
  const v = r.success ? r.data : AdvertisingPackSchema.parse({});
  return Object.freeze({
    id,
    brokerageNameAtLeastAsProminentAsTeam: v.brokerage_name_at_least_as_prominent_as_team,
    requireLicenseNumber: v.require_license_number,
    requireBrokerageAddress: v.require_brokerage_address,
    requireEqualHousingStatement: v.require_equal_housing_statement,
    equalHousingStatement: v.equal_housing_statement,
    teamNameForbiddenTerms: Object.freeze([...v.team_name_forbidden_terms]),
    reviewedByCounselAt,
  });
}

// ---- guard result ------------------------------------------------------------------------------------

const termHit = z.strictObject({ term_id: z.string().min(1), text: z.string() });

/** marketing_pieces.guard_result. Strict: an unknown key is refused, so nothing else can pose as one. */
export const GuardResultSchema = z.strictObject({
  content_sha256: z.string(),
  brokerage_name_present: z.boolean(),
  hard_count: z.number().int().min(0),
  hard: z.array(termHit),
  soft: z.array(termHit),
  pack_rule_failures: z.array(z.strictObject({ rule_id: z.string().min(1), pack_id: z.string().min(1), reason: z.string().min(1) })),
  numeral_issues: z.array(
    z.strictObject({
      role: z.string().min(1),
      shape: z.enum(['price', 'date', 'time', 'year', 'number_words']),
      text: z.string(),
    }),
  ),
  lexicon_version: z.string().min(1),
  fair_housing_reviewed: z.boolean(),
}) satisfies z.ZodType<unknown>;

/** Parse a stored guard result (e.g. read back from the DB); null when it is not one. */
export function parseGuardResult(json: unknown): GuardResult | null {
  const r = GuardResultSchema.safeParse(json);
  return r.success ? (r.data as GuardResult) : null;
}
