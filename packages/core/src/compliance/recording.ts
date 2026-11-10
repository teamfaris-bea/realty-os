// Call recording consent (R-CONSENT-16; E47, E48). VERIFY WITH COUNSEL: party rules per state,
// interstate calls, announcement wording.
//
// - `announce_all` (the default): every recorded call announces to all parties before recording.
// - `one_party_where_permitted` (needs an Owner attestation, enforced by resolvePolicy): still
//   announces unless the agent's jurisdiction AND every candidate client jurisdiction resolve to
//   `one_party`. Missing or `unknown` ⇒ announce.
// - Recording disabled by the tenant policy ⇒ `off`.
// - An announced recording may start only once the announcement has played (`recordingMayStart`);
//   a failed announcement means no recording.
// - Every new call leg re-evaluates with the new party's jurisdictions and re-announces.
import type { Instant } from '../foundation/index.js';
import type { JurisdictionPack } from './policy.js';
import type { PartyRule } from './types.js';

export type RecordingMode = 'announced_all_parties' | 'one_party_no_announcement' | 'off';

export interface RecordingDecision {
  mode: RecordingMode;
  announce: boolean;
  basis: string;
}

/**
 * The party rule for a jurisdiction key: only the pack for exactly that key decides. A subdivision
 * ('US-CA') never inherits its country pack's rule: a country-level `one_party` (e.g. a federal
 * rule) says nothing about a state that may require every party's consent, so a state without its
 * own pack or without a party rule in it is `unknown` and the call announces. VERIFY WITH COUNSEL.
 */
export function partyRuleFor(jurisdiction: string | undefined, packs: readonly JurisdictionPack[]): PartyRule {
  if (jurisdiction === undefined || jurisdiction.trim() === '') return 'unknown';
  const key = jurisdiction.trim().toUpperCase();
  return packs.find((p) => p.key === key)?.rules.recordingPartyRule ?? 'unknown';
}

export function decideRecording(i: {
  agentJurisdiction?: string;
  clientJurisdictions: string[];
  packs: JurisdictionPack[];
  mode: 'announce_all' | 'one_party_where_permitted';
  direction: 'inbound' | 'outbound';
  /** `ResolvedPolicy.recordingEnabled`; defaults to true. */
  enabled?: boolean;
}): RecordingDecision {
  if (i.enabled === false) return { mode: 'off', announce: false, basis: `recording_disabled:${i.direction}` };
  if (i.mode === 'one_party_where_permitted' && i.clientJurisdictions.length > 0) {
    const parties = [i.agentJurisdiction, ...i.clientJurisdictions];
    if (parties.every((j) => partyRuleFor(j, i.packs) === 'one_party')) {
      const keys = [...new Set(parties.map((j) => (j as string).trim().toUpperCase()))].sort();
      return { mode: 'one_party_no_announcement', announce: false, basis: `one_party:${keys.join(',')}:${i.direction}` };
    }
    return { mode: 'announced_all_parties', announce: true, basis: `party_rule_not_one_party:${i.direction}` };
  }
  return { mode: 'announced_all_parties', announce: true, basis: `${i.mode === 'announce_all' ? 'policy_announce_all' : 'party_rule_not_one_party'}:${i.direction}` };
}

/**
 * Whether the provider may start recording this leg: never when off; announced mode only after the
 * announcement played (E47, DB CHECK on calls.recording_announced_at).
 */
export function recordingMayStart(d: RecordingDecision, announcedAt: Instant | null): boolean {
  if (d.mode === 'off') return false;
  return !d.announce || announcedAt !== null;
}
