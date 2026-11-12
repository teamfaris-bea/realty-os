// The VERIFY items of module 29 (PHASE2_3_PLAN §5.4 #29), as configuration with the strictest reasonable defaults.
// None of these is known until Meta's content-publishing API is reviewed (N2, Meta App Review); change them only on a
// verified answer. Read once per process from the environment:
//   MARKETING_INSTAGRAM_REQUIRES_IMAGE   'true' (default): VERIFY whether Instagram has text-only posts; while true a
//                                        piece without an image is export-only for Instagram
//   MARKETING_IMAGE_URL_TTL_MINUTES      60 (default, 5..1440): VERIFY how long Meta needs to fetch a post's images
//   MARKETING_UNKNOWN_GIVE_UP_HOURS      24 (default, 1..720): an 'unknown' publication the lookup does not find after
//                                        this long is recorded as failed (VERIFY that a timed-out post appears by then)
// Lookup without a post id and deletion support (VERIFY per provider, incl. Instagram) are adapter behaviour: the
// SocialPublisher answers `unsupported`, and the product then says "Check your Page/Instagram" / raises the
// "remove it yourself" card.
import { DEFAULT_ASSUMPTIONS, type ProviderAssumptions } from './decide.js';

export interface MarketingAssumptions extends ProviderAssumptions {
  imageUrlTtlMs: number;
  unknownGiveUpMs: number;
}

const num = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = v === undefined || v.trim() === '' ? def : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

export function assumptionsFrom(env: Record<string, string | undefined>): MarketingAssumptions {
  return Object.freeze({
    instagramRequiresImage: env['MARKETING_INSTAGRAM_REQUIRES_IMAGE'] === undefined ? DEFAULT_ASSUMPTIONS.instagramRequiresImage : env['MARKETING_INSTAGRAM_REQUIRES_IMAGE'] !== 'false',
    imageUrlTtlMs: num(env['MARKETING_IMAGE_URL_TTL_MINUTES'], 60, 5, 1440) * 60_000,
    unknownGiveUpMs: num(env['MARKETING_UNKNOWN_GIVE_UP_HOURS'], 24, 1, 720) * 3_600_000,
  });
}

let cached: MarketingAssumptions | null = null;
export function marketingAssumptions(): MarketingAssumptions {
  cached ??= assumptionsFrom(process.env);
  return cached;
}
