// Consent evidence for AI ISA messages (R-ISA-9; E519, E520; docs/AI_ISA.md §5.2). D12 proposed.
// D1 is unchanged and runs FIRST, for every path (gate checks 5, 6, 9). This adds evidence for AI ISA messages only.
//
// Every AI ISA message has purpose `marketing`; the message kind (./sendPolicy.ts `messageKind`) picks the tier:
//   reply      the person's own inbound on the same channel, from the bound point, within the reply window (24 h)
//              of now, after the last AI outbound on that channel, and (email) with a DKIM-aligned pass; and no
//              revoke of either purpose on any of the person's points of the channel. The inbound_first_contact grant
//              is never used (it does not exist on J1, E520).
//   initiated  (any fact, follow-up, first outreach, or a reply outside the window) a grant that meets ALL of:
//              (1) it cites the inquiry's OWN disclosure (never a lead source's configured fallback), or it is a
//                  signed_document grant with an evidence object;
//              (2) a tenant name is in the disclosure BODY (not the self-reported namesSeller);
//              (3) the disclosure states its scope, and the scope includes the channel and marketing;
//              (4) it was recorded on or after the D12 effective date (pack rules; null = not yet: nothing counts);
//              (5) it is not imported, not needs_review, not expired, and no later revoke, expire or import_revert of
//                  either purpose exists on any of the person's points of the channel;
//              SMS at express_written; email at ≥ inquiry; agent_entry never (Q-ISA-4);
//              (6) SMS only: a national DNC "not listed" result for the number within 31 days (C-ISA-4).
// The AI ISA never writes a grant. VERIFY WITH COUNSEL (C-ISA-1, -2, -4) every rule and every default.
import { type ConsentLevel, type ConsentSource, type ConsentStateRow, atLeast, disclosureNamesTenant } from '../compliance/index.js';
import { DAY_MS, HOUR_MS, type Instant } from '../foundation/index.js';
import { ISA_CONSENT_DEFAULTS } from './constants.js';
import type { IsaChannel } from './types.js';

export type ConsentTier = 'reply' | 'initiated';

/** The person's latest own inbound turn on a channel (from the bound point; ingestion checked it was a turn). */
export interface InboundEvidence {
  messageId: string;
  channel: IsaChannel;
  fromHmac: string;
  at: Instant;
  /** Email: the provider's DKIM verdict was an aligned pass for the From domain (stored at ingestion). */
  dkimAligned: boolean | null;
}

export interface DisclosureEvidence {
  id: string;
  /** The disclosure text the person saw. Core looks for a tenant name in it (condition 2). */
  body: string;
  /** `consent_disclosures.scope_stated` (NULL on rows written before the flagged edit ⇒ refused). */
  scopeStated: boolean | null;
  /** The channels and purposes the disclosure states ('all' covers both purposes). */
  channels: readonly string[];
  purposes: readonly string[];
  /** Where the grant's disclosure id came from: the inquiry's own, or a lead source's configured fallback. */
  origin: 'inquiry' | 'source_fallback';
}

export interface GrantEvidence {
  consentEventId: string;
  channel: IsaChannel;
  purpose: 'marketing' | 'informational' | 'all';
  level: ConsentLevel;
  source: ConsentSource;
  addressHmac: string;
  recordedAt: Instant;
  expiresAt: Instant | null;
  imported: boolean;
  needsReview: boolean;
  disclosure: DisclosureEvidence | null;
  /** signed_document grants: an evidence object is attached. */
  evidenceObject: boolean;
}

/** A revoke, expire or import_revert of either purpose on one of the person's points (any writer). */
export interface NegativeEvent {
  channel: IsaChannel;
  addressHmac: string;
  eventType: 'revoke' | 'expire' | 'import_revert';
  at: Instant;
}

export interface DncEvidence {
  checkId: string;
  addressHmac: string;
  result: 'not_listed' | 'listed' | 'unknown';
  checkedAt: Instant;
}

export interface ConsentBasisInput {
  now: Instant;
  channel: IsaChannel;
  tier: ConsentTier;
  /** The point bound for this channel at start (R-ISA-28). */
  boundHmac: string;
  /** Every HMAC of the person for this channel kind: every phone (removed ones too, unless wrong_number), or every email. */
  personHmacs: readonly string[];
  /** consent_state rows of `personHmacs` for this channel (either purpose). */
  consentState: readonly ConsentStateRow[];
  /** The person's latest own inbound turn on this channel, or null. */
  lastInbound: InboundEvidence | null;
  /** The last AI ISA outbound on this channel (counted statuses), or null. */
  lastAiOutboundAt: Instant | null;
  grants: readonly GrantEvidence[];
  negatives: readonly NegativeEvent[];
  dnc: readonly DncEvidence[];
  /** The tenant's names (brokerage legal name, team name) looked for in a disclosure body. */
  tenantNames: readonly (string | null | undefined)[];
  rules?: { replyWindowHours?: number; dncFreshnessDays?: number; d12EffectiveAt?: Instant | null };
}

/** Why a basis failed, as codes (shown on the panel, never content). */
export type ConsentBasisCode =
  | 'CHANNEL_REVOKED'
  | 'NO_INBOUND'
  | 'INBOUND_WRONG_CHANNEL'
  | 'INBOUND_UNBOUND'
  | 'INBOUND_OUTSIDE_WINDOW'
  | 'INBOUND_BEFORE_LAST_AI'
  | 'DKIM_NOT_ALIGNED'
  | 'NO_GRANT'
  | 'GRANT_WRONG_ADDRESS'
  | 'GRANT_PURPOSE'
  | 'GRANT_LEVEL'
  | 'GRANT_AGENT_ENTRY'
  | 'DISCLOSURE_MISSING'
  | 'DISCLOSURE_FALLBACK'
  | 'DISCLOSURE_NOT_NAMING_TEAM'
  | 'SCOPE_NOT_STATED'
  | 'SCOPE_EXCLUDES'
  | 'D12_NOT_EFFECTIVE'
  | 'BEFORE_D12'
  | 'IMPORTED'
  | 'NEEDS_REVIEW'
  | 'EXPIRED'
  | 'REVOKED_AFTER'
  | 'DNC_MISSING'
  | 'DNC_STALE'
  | 'DNC_LISTED';

export type ConsentBasis =
  | { ok: true; tier: ConsentTier; basis: { kind: 'own_inbound'; messageId: string } | { kind: 'grant'; consentEventId: string; dncCheckId: string | null } }
  | { ok: false; tier: ConsentTier; missing: ('evidence' | 'reply_window' | 'dnc')[]; codes: ConsentBasisCode[] };

function channelRevoked(i: ConsentBasisInput): boolean {
  const mine = new Set(i.personHmacs);
  return i.consentState.some((r) => r.status === 'revoked' && r.channel === i.channel && mine.has(r.addressHmac));
}

/** The issues of one grant for the initiated tier (empty = it counts). */
export function grantIssues(g: GrantEvidence, i: ConsentBasisInput): ConsentBasisCode[] {
  const out: ConsentBasisCode[] = [];
  const d12 = i.rules?.d12EffectiveAt !== undefined ? i.rules.d12EffectiveAt : ISA_CONSENT_DEFAULTS.d12EffectiveAt;
  if (g.channel !== i.channel || g.addressHmac !== i.boundHmac) out.push('GRANT_WRONG_ADDRESS');
  if (g.purpose !== 'marketing' && g.purpose !== 'all') out.push('GRANT_PURPOSE');
  if (g.source === 'agent_entry') out.push('GRANT_AGENT_ENTRY');
  if (!atLeast(g.level, i.channel === 'sms' ? 'express_written' : 'inquiry')) out.push('GRANT_LEVEL');
  const signed = g.source === 'signed_document' && g.evidenceObject;
  if (!signed) {
    const d = g.disclosure;
    if (d === null) out.push('DISCLOSURE_MISSING');
    else {
      if (d.origin !== 'inquiry') out.push('DISCLOSURE_FALLBACK');
      if (!disclosureNamesTenant(d.body, i.tenantNames)) out.push('DISCLOSURE_NOT_NAMING_TEAM');
      if (d.scopeStated !== true) out.push('SCOPE_NOT_STATED');
      else if (!d.channels.includes(i.channel) || !(d.purposes.includes('marketing') || d.purposes.includes('all'))) out.push('SCOPE_EXCLUDES');
    }
    if (d12 === null) out.push('D12_NOT_EFFECTIVE');
    else if (g.recordedAt < d12) out.push('BEFORE_D12');
  }
  if (g.imported) out.push('IMPORTED');
  if (g.needsReview) out.push('NEEDS_REVIEW');
  if (g.expiresAt !== null && g.expiresAt <= i.now) out.push('EXPIRED');
  const mine = new Set(i.personHmacs);
  if (i.negatives.some((n) => n.channel === i.channel && mine.has(n.addressHmac) && n.at >= g.recordedAt)) out.push('REVOKED_AFTER');
  return out;
}

/**
 * R-ISA-9: whether this AI ISA message has the consent evidence its tier needs. The guard re-derives the same
 * from the database (§5.4); this is core's and TX1's reading.
 */
export function aiIsaConsentBasis(i: ConsentBasisInput): ConsentBasis {
  const fail = (missing: ('evidence' | 'reply_window' | 'dnc')[], codes: ConsentBasisCode[]): ConsentBasis => ({ ok: false, tier: i.tier, missing: [...new Set(missing)], codes: [...new Set(codes)] });
  if (channelRevoked(i)) return fail(['evidence'], ['CHANNEL_REVOKED']);
  if (i.tier === 'reply') {
    const r = i.lastInbound;
    const windowMs = (i.rules?.replyWindowHours ?? ISA_CONSENT_DEFAULTS.replyWindowHours) * HOUR_MS;
    if (r === null) return fail(['evidence'], ['NO_INBOUND']);
    if (r.channel !== i.channel) return fail(['evidence'], ['INBOUND_WRONG_CHANNEL']);
    if (r.fromHmac !== i.boundHmac) return fail(['evidence'], ['INBOUND_UNBOUND']);
    if (i.channel === 'email' && r.dkimAligned !== true) return fail(['evidence'], ['DKIM_NOT_ALIGNED']);
    if (i.lastAiOutboundAt !== null && i.lastAiOutboundAt >= r.at) return fail(['reply_window'], ['INBOUND_BEFORE_LAST_AI']);
    if (i.now - r.at > windowMs || r.at > i.now) return fail(['reply_window'], ['INBOUND_OUTSIDE_WINDOW']);
    return { ok: true, tier: 'reply', basis: { kind: 'own_inbound', messageId: r.messageId } };
  }
  // initiated
  const all: ConsentBasisCode[] = [];
  let grant: GrantEvidence | null = null;
  for (const g of [...i.grants].sort((a, b) => b.recordedAt - a.recordedAt || (a.consentEventId < b.consentEventId ? -1 : 1))) {
    const issues = grantIssues(g, i);
    if (issues.length === 0) {
      grant = g;
      break;
    }
    all.push(...issues);
  }
  if (grant === null) return fail(['evidence'], i.grants.length === 0 ? ['NO_GRANT'] : all);
  if (i.channel === 'sms') {
    const fresh = (i.rules?.dncFreshnessDays ?? ISA_CONSENT_DEFAULTS.dncFreshnessDays) * DAY_MS;
    const checks = i.dnc.filter((c) => c.addressHmac === i.boundHmac).sort((a, b) => b.checkedAt - a.checkedAt);
    const latest = checks[0];
    if (latest === undefined) return fail(['dnc'], ['DNC_MISSING']);
    if (latest.result !== 'not_listed') return fail(['dnc'], [latest.result === 'listed' ? 'DNC_LISTED' : 'DNC_MISSING']);
    if (i.now - latest.checkedAt > fresh || latest.checkedAt > i.now) return fail(['dnc'], ['DNC_STALE']);
    return { ok: true, tier: 'initiated', basis: { kind: 'grant', consentEventId: grant.consentEventId, dncCheckId: latest.checkId } };
  }
  return { ok: true, tier: 'initiated', basis: { kind: 'grant', consentEventId: grant.consentEventId, dncCheckId: null } };
}

/** The panel sentence for a channel's basis (honest and plain; §5.2 last bullet). */
export function consentBasisSentence(channel: IsaChannel, b: ConsentBasis): string {
  const noun = channel === 'sms' ? 'Texts' : 'Email';
  if (b.ok) return b.tier === 'reply' ? `${noun}: OK for replies within 24 h of their own message.` : `${noun}: OK, written consent on file${channel === 'sms' ? ' and a recent Do Not Call check' : ''}.`;
  if (b.codes.includes('CHANNEL_REVOKED')) return `${noun}: they opted out.`;
  if (b.tier === 'reply') return `${noun}: replies need their own recent message on this channel. None in the last 24 h.`;
  if (b.missing.includes('dnc')) return `${noun}: AI-initiated texts need a Do Not Call check from the last 31 days. Not on file.`;
  return channel === 'sms'
    ? 'Texts: OK for replies within 24 h of their text. Listings and follow-ups need written consent naming the team, from their own form, plus a fresh Do Not Call check. Not on file.'
    : 'Email: OK for replies within 24 h of their email. Listings and follow-ups need consent from their own form. Not on file.';
}
