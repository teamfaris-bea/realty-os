// The display-rules version (docs/AI_ISA.md §6.1, §6.3; VERIFY item 7): defined nowhere before ISA-3 (0190's
// ai_isa_shared_facts.display_rules_version column, core market.ts CountSnapshot.displayRulesVersion). One sha256 per
// MLS connection over what decides how its rows reach a client: the display pack's counsel stamp, the attribution and
// disclaimer, the listing-brokerage rule and the client audience (fields and statuses). A change of any of them resets
// a watch snapshot silently and cancels a pending fact (FACT_CHANGED). Buyer facts may share it (reported to ISA-2).
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import type { MlsConnectionFacts } from './cmaSeam.js';

/** The competition rule's version: a change resets the snapshot silently. */
export const COMPETITION_RULE_VERSION = 'isa-seller-competition/1';

export function displayRulesVersion(c: Pick<MlsConnectionFacts, 'pack'>): string {
  const p = c.pack;
  return sha256Hex(
    canonicalJson({
      stamp: p.reviewedByCounselAt,
      attribution: p.attributionText,
      disclaimer: p.disclaimerText,
      brokerage: p.requireListingBrokerage,
      client: { fields: [...p.audiences.client.fields].sort(), statuses: [...p.audiences.client.statuses].sort() },
    }),
  );
}

/** Every connection's version, keyed by id (the watch's snapshot_versions.connections). */
export function versionsOf(conns: readonly Pick<MlsConnectionFacts, 'id' | 'pack'>[]): Record<string, string> {
  return Object.fromEntries([...conns].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => [c.id, displayRulesVersion(c)]));
}
