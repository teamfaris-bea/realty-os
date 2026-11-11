// Jurisdiction advertising rules: platform floor ∧ every pack (R-MKT-1, R-MKT-4; E92).
//
// The combined rules are the strictest of every pack that governs the listing: a rule any pack
// requires is required, the forbidden team-name terms are the union, and no pack at all means the
// strictest default (STRICTEST_ADVERTISING_PACK). A pack can never relax another pack or the
// platform rules (brokerage legal name on every piece, no hard fair-housing term, no price/date
// numerals in copy). Every rule is pack data: **VERIFY WITH COUNSEL** (brokerage-name prominence,
// licence number, office address, equal-housing statement and team-name wording differ by state).
import { STRICTEST_ADVERTISING_PACK } from './schemas.js';
import type { AdvertisingPack, AdvertisingRuleId, AdvertisingRules, Packs } from './types.js';

export function resolveAdvertisingRules(packs: Packs): AdvertisingRules {
  const list: readonly AdvertisingPack[] = packs.advertising.length > 0 ? packs.advertising : [STRICTEST_ADVERTISING_PACK];
  const by = (pred: (p: AdvertisingPack) => boolean): string[] => list.filter(pred).map((p) => p.id);
  const prominence = by((p) => p.brokerageNameAtLeastAsProminentAsTeam);
  const license = by((p) => p.requireLicenseNumber);
  const address = by((p) => p.requireBrokerageAddress);
  const eho = by((p) => p.requireEqualHousingStatement);
  const terms = by((p) => p.teamNameForbiddenTerms.length > 0);
  const firstEho = list.find((p) => p.requireEqualHousingStatement);
  const forbidden = [...new Set(list.flatMap((p) => p.teamNameForbiddenTerms.map((t) => t.trim()).filter((t) => t.length > 0)))];
  const requiredBy: Record<AdvertisingRuleId, readonly string[]> = {
    brokerage_name_prominence: prominence,
    license_number: license,
    brokerage_address: address,
    equal_housing_statement: eho,
    team_name_terms: terms,
  };
  return {
    brokerageNameAtLeastAsProminentAsTeam: prominence.length > 0,
    requireLicenseNumber: license.length > 0,
    requireBrokerageAddress: address.length > 0,
    requireEqualHousingStatement: eho.length > 0,
    equalHousingStatement: (firstEho ?? STRICTEST_ADVERTISING_PACK).equalHousingStatement,
    teamNameForbiddenTerms: forbidden,
    requiredBy,
  };
}
