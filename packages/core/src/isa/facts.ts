// Fact renderers (R-ISA-17, R-ISA-18; E534–E537; docs/AI_ISA.md §6). Server text only: a facts message has a fixed
// intro, the facts and the footer, and NO model text. Every fact is rendered from a `DisplayListing`
// (`applyDisplayRules(client)`), never from a raw row, and refused when its status or price-kind field is omitted
// for the audience. Each line carries its own as-of ("listed as Active in the MLS as of Nov 12"), the listing
// brokerage, the status label and the price kind; the pack's attribution and disclaimer once per message.
//
// Seller inputs are NARROW structural types (`IsaCompView`, `IsaCompResult`) that V1-B's CompView and prepareCma
// result must satisfy; ISA-3 adapts them. The comps email is the complete engine set or nothing: never padded,
// never partial, never a hidden count, never a value, range, adjusted price or weight. By email only (the SMS gets
// the pointer line). Pending is worded "Pending (not yet sold)" ("under contract" trips CONTRACT_TOPIC).
// VERIFY WITH COUNSEL / MLS (C-ISA-8, C-ISA-9): every sentence and every ceiling.
import { canonicalJson, sha256Hex } from '../compliance/index.js';
import type { Instant } from '../foundation/index.js';
import type { DisplayListing } from '../listings/index.js';
import { ISA_GROUNDING_DEFAULTS } from './constants.js';

export type FactRefusal =
  | 'STATUS_OMITTED'
  | 'PRICE_OMITTED'
  | 'BROKERAGE_MISSING'
  | 'ATTRIBUTION_MISSING'
  | 'STATUS_NOT_SHAREABLE'
  | 'ROW_STALE'
  | 'SOLD_NOT_CLEARED'
  | 'COMPS_TOO_FEW'
  | 'COMPS_CEILING'
  | 'COMPS_GATED'
  | 'SUBJECT_UNCONFIRMED'
  | 'NEARBY_REASON_NOT_ALLOWED'
  | 'ADDRESS_NOT_ALLOWED'
  | 'CLOSE_OMITTED';

export type Rendered = { ok: true; line: string } | { ok: false; refusal: FactRefusal };

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return `${MON[m - 1]} ${d}, ${y}`;
}
function asOfLabel(t: Instant): string {
  return dateLabel(new Date(t).toISOString().slice(0, 10));
}

/** "$450,000" from cents (whole dollars). */
export function dollars(cents: number): string {
  return `$${String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export const STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({ active: 'Active', coming_soon: 'Coming soon', pending: 'Pending (not yet sold)', sold: 'Sold' });

export interface FactSource {
  /** The MLS's display name from the licence pack (server data), or the team for a team listing. */
  mlsName: string;
  teamName: string;
  /** The row's own as-of: its last_seen_in_feed_at, or its connection's lastSyncedAt if earlier (§6.1). */
  asOf: Instant;
  /** The row is within the pack's max_staleness_hours (§6.1 row freshness). */
  fresh: boolean;
}

/** A size the line may state (R-MLS-7): a positive number; null, omitted or 0 is no size, never "0 sq ft". */
function hasSize(v: number | null | undefined): v is number {
  return typeof v === 'number' && v > 0;
}

function structural(d: DisplayListing): string {
  const parts: string[] = [];
  if (d.beds !== undefined && d.beds !== null) parts.push(`${d.beds} bd`);
  if (d.bathsX10 !== undefined && d.bathsX10 !== null) parts.push(`${d.bathsX10 / 10} ba`);
  if (hasSize(d.sqft)) parts.push(`${String(d.sqft).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sq ft`);
  if (d.locality !== undefined) parts.push(d.locality.city);
  const head = parts.join(' · ');
  return d.address !== undefined && !d.addressHidden ? `${d.address.line1}, ${head}` : head;
}

function common(d: DisplayListing, src: FactSource, statuses: readonly string[]): FactRefusal | null {
  if (!src.fresh) return 'ROW_STALE';
  if (d.omittedFields.includes('status') || d.status === undefined) return 'STATUS_OMITTED';
  if (!statuses.includes(d.status)) return 'STATUS_NOT_SHAREABLE';
  if (d.omittedFields.includes('listPrice') || d.listPriceCents === undefined || d.listPriceCents === null) return 'PRICE_OMITTED';
  if (!d.isTeamListing && (d.listingBrokerageName === null || d.listingBrokerageName.trim() === '')) return 'BROKERAGE_MISSING';
  if (!d.isTeamListing && (d.attribution === null || d.disclaimer === null)) return 'ATTRIBUTION_MISSING';
  return null;
}

function sourceTail(d: DisplayListing, src: FactSource): string {
  const by = d.listingBrokerageName ?? src.teamName;
  const status = STATUS_LABEL[d.status as string] ?? (d.status as string);
  return `Listed by ${by} · listed as ${status} in the MLS as of ${asOfLabel(src.asOf)} · Source: ${d.isTeamListing ? src.teamName : `${src.mlsName} via ${src.teamName}`}`;
}

/** A buyer listing line (§6.2): active or coming soon, its asking price labelled as such. */
export function renderBuyerListing(d: DisplayListing, src: FactSource): Rendered {
  const bad = common(d, src, ['active', 'coming_soon']);
  if (bad !== null) return { ok: false, refusal: bad };
  return { ok: true, line: `${structural(d)} — listed at ${dollars(d.listPriceCents as number)} (asking price) · ${STATUS_LABEL[d.status as string]} · ${sourceTail(d, src)}` };
}

export type CompetitorEvent = 'new_competitor' | 'competitor_pending' | 'competitor_back_on_market' | 'competitor_price_change' | 'competitor_sold' | 'competitor_off_market';

/**
 * A competing-listing line (§6.3). `competitor_sold` is never rendered here (it reaches a seller only through the
 * sold path, after the packs clear); `competitor_off_market` is not a client fact.
 */
export function renderCompetitor(d: DisplayListing, src: FactSource, event: CompetitorEvent): Rendered {
  if (event === 'competitor_sold') return { ok: false, refusal: 'SOLD_NOT_CLEARED' };
  if (event === 'competitor_off_market') return { ok: false, refusal: 'STATUS_NOT_SHAREABLE' };
  if (event === 'competitor_pending') {
    const bad = common(d, src, ['pending']);
    if (bad !== null) return { ok: false, refusal: bad };
    return { ok: true, line: `Now pending (not yet sold): ${structural(d)} — last asking price ${dollars(d.listPriceCents as number)} · ${sourceTail(d, src)}` };
  }
  const bad = common(d, src, ['active', 'coming_soon']);
  if (bad !== null) return { ok: false, refusal: bad };
  const head = event === 'competitor_price_change' ? 'Price change near you' : event === 'competitor_back_on_market' ? 'Back on the market near you' : 'New listing near you';
  return { ok: true, line: `${head}: ${structural(d)} — listed at ${dollars(d.listPriceCents as number)} (asking price, not a sale price) · ${STATUS_LABEL[d.status as string]} · ${sourceTail(d, src)}` };
}

/** The intro and footer of a facts message: fixed server text, the attribution and disclaimer once. */
export function factsMessage(i: { intro: string; lines: readonly string[]; attribution: string | null; disclaimer: string | null; channel: 'sms' | 'email' }): string {
  const sep = i.channel === 'email' ? '\n\n' : '\n';
  const foot = [i.attribution, i.disclaimer].filter((x): x is string => x !== null && x.trim() !== '');
  return [i.intro, ...i.lines, ...foot].join(sep);
}

export const FACT_INTROS = Object.freeze({
  listings: 'Here are homes that match what you told me:',
  competition: 'Here is what changed near your home:',
  comps: 'Here are the recent sales I found near your home:',
});

/** SMS facts only when they fit three segments with attribution (§6.1); otherwise the email pointer line. */
export function fitsSms(body: string, segments: number = ISA_GROUNDING_DEFAULTS.smsFactSegments): boolean {
  // GSM-7 multipart segments are 153 characters; anything outside GSM-7 (UCS-2) is 67
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€·—–]*$/u.test(body);
  const per = gsm ? 153 : 67;
  return body.length <= (segments === 1 ? (gsm ? 160 : 70) : per * segments);
}

// ---- sold comps (seller) --------------------------------------------------------------------------------------

/** The tiers a comp may come from in v1 (ISA ceiling, E536). VERIFY. */
export const ISA_COMP_TIERS = ['subdivision', 'within_1mi', 'postal_code', 'within_3mi'] as const;

/** The narrow view of one engine comp that ISA renders. V1-B's CompView must satisfy it (ISA-3 adapts). */
export interface IsaCompView {
  identity: string;
  closePriceCents: number | null;
  /** YYYY-MM-DD */
  closeDate: string | null;
  beds: number | null;
  sqft: number | null;
  tier: string;
  /** Shown only when address display and the subdivision field allow it (C-ISA-8). */
  locationLabel: string | null;
  listingBrokerageName: string | null;
  /** The engine's own "why" for this comp. */
  why: string;
}

/** The narrow engine result ISA renders: `result.comps` exactly, in engine order. */
export interface IsaCompResult {
  methodVersion: string;
  comps: readonly IsaCompView[];
  areaLookbackMonths: number;
  sizeFilterApplied: boolean;
  bedsFilterApplied: boolean;
  /** The engine's own sentences (area.sentences, result.sentences); never ISA-authored statistics. */
  sentences: readonly string[];
}

export interface CompGates {
  /** V1-C clientReadiness(use: 'ai_isa') blockers, as codes (empty = none). */
  blockers: readonly string[];
  /** platform:cma, platform:ai_isa_seller_data and the licence's valuation.ai_isa_comps. */
  packsCleared: boolean;
  subjectConfirmed: boolean;
}

export interface SubjectFacts {
  recordDate: string;
  beds: number | null;
  sqft: number | null;
}

/** The counsel-entered seller-data lines of `platform:ai_isa_seller_data` (engineering placeholders, VERIFY WITH COUNSEL). */
export const SELLER_DATA_LINES: readonly string[] = Object.freeze([
  'These are sales records, not an appraisal or a price for your home.',
  "Condition and updates aren't in the MLS record.",
  'Prices are as recorded in the MLS and may include seller concessions.',
  'Only sales the MLS allows us to show are included.',
]);

/**
 * "Compared using your home's MLS record from {date}: {beds} bd, {sqft} sq ft. Tell me if that's changed." Only the
 * facts the record has are named: an unknown size (R-MLS-7) is left out, and with neither fact there is no list.
 */
export function subjectLine(s: SubjectFacts): string {
  const parts = [s.beds !== null ? `${s.beds} bd` : null, hasSize(s.sqft) ? `${String(s.sqft).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sq ft` : null].filter((x) => x !== null);
  return `Compared using your home's MLS record from ${dateLabel(s.recordDate)}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}. Tell me if that's changed.`;
}

/** The comp-set hash (dedupe and refresh, §6.3): method version, ordered identities, close prices. */
export function compSetHash(r: IsaCompResult): string {
  return sha256Hex(canonicalJson({ method: r.methodVersion, comps: r.comps.map((c) => [c.identity, c.closePriceCents]) }));
}

export type CompsEmail = { ok: true; body: string; compIdentities: string[]; hash: string } | { ok: false; refusal: FactRefusal };

/**
 * The ONE comps email (§6.3): exactly `result.comps`, all of them, in engine order, or nothing. The model never
 * selects comps: this takes the whole result. Refused when any gate, pack, subject or ceiling fails.
 */
export function renderCompsEmail(i: { result: IsaCompResult; gates: CompGates; subject: SubjectFacts; mlsName: string; teamName: string; asOf: Instant; stateStatement: string | null; attribution: string | null; minComps?: number; updated?: boolean }): CompsEmail {
  const r = i.result;
  if (!i.gates.packsCleared) return { ok: false, refusal: 'SOLD_NOT_CLEARED' };
  if (!i.gates.subjectConfirmed) return { ok: false, refusal: 'SUBJECT_UNCONFIRMED' };
  if (i.gates.blockers.length > 0) return { ok: false, refusal: 'COMPS_GATED' };
  if (r.comps.length < (i.minComps ?? ISA_GROUNDING_DEFAULTS.minComps)) return { ok: false, refusal: 'COMPS_TOO_FEW' };
  if (r.areaLookbackMonths !== 12 || !r.sizeFilterApplied || !r.bedsFilterApplied || r.comps.some((c) => !(ISA_COMP_TIERS as readonly string[]).includes(c.tier))) return { ok: false, refusal: 'COMPS_CEILING' };
  if (r.comps.some((c) => c.closePriceCents === null || c.closeDate === null)) return { ok: false, refusal: 'CLOSE_OMITTED' };
  if (r.comps.some((c) => c.listingBrokerageName === null || c.listingBrokerageName.trim() === '')) return { ok: false, refusal: 'BROKERAGE_MISSING' };
  const lines = r.comps.map((c, k) => {
    const facts = [c.beds !== null ? `${c.beds} bd` : null, hasSize(c.sqft) ? `${String(c.sqft).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sq ft` : null, c.locationLabel].filter((x) => x !== null).join(' · ');
    return `${k + 1}. Sold for ${dollars(c.closePriceCents as number)} on ${dateLabel(c.closeDate as string)} (sale price) · ${facts} · Listed by ${c.listingBrokerageName} · ${c.why}`;
  });
  const body = [
    i.updated === true ? `${FACT_INTROS.comps} (Updated ${asOfLabel(i.asOf)})` : FACT_INTROS.comps,
    subjectLine(i.subject),
    ...lines,
    ...r.sentences,
    ...SELLER_DATA_LINES,
    ...(i.stateStatement !== null ? [i.stateStatement] : []),
    `Source: ${i.mlsName} via ${i.teamName}, as of ${asOfLabel(i.asOf)}.`,
    ...(i.attribution !== null ? [i.attribution] : []),
  ].join('\n\n');
  return { ok: true, body, compIdentities: r.comps.map((c) => c.identity), hash: compSetHash(r) };
}

/** The SMS pointer to the comps email (§6.3): sold-derived facts never go by SMS. */
export function compsSmsPointer(n: number): string {
  return `I've emailed you the ${n} recent sales I found.`;
}

/** The engine's not-used reasons a merely nearby sale may be described with (§6.3 whitelist). */
export const NEARBY_REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  size_not_similar: 'its size is different from yours',
  beds_not_similar: 'its bedroom count is different from yours',
  year_built_not_similar: 'it was built in a different era',
  other_property_type: "it's a different type of home",
});

/** A merely nearby sale the seller asked about (by email, same gates); any other reason ⇒ data_unavailable. */
export function nearbySaleLine(i: { reason: string; comp: IsaCompView; addressDisplayAllowed: boolean; gates: CompGates }): Rendered {
  if (!i.gates.packsCleared) return { ok: false, refusal: 'SOLD_NOT_CLEARED' };
  if (i.gates.blockers.length > 0) return { ok: false, refusal: 'COMPS_GATED' };
  if (!i.addressDisplayAllowed) return { ok: false, refusal: 'ADDRESS_NOT_ALLOWED' };
  const words = NEARBY_REASON_WORDS[i.reason];
  if (words === undefined) return { ok: false, refusal: 'NEARBY_REASON_NOT_ALLOWED' };
  const c = i.comp;
  if (c.closePriceCents === null || c.closeDate === null) return { ok: false, refusal: 'CLOSE_OMITTED' };
  if (c.listingBrokerageName === null) return { ok: false, refusal: 'BROKERAGE_MISSING' };
  return { ok: true, line: `Nearby sale, not comparable to your home: ${words}. Sold for ${dollars(c.closePriceCents)} on ${dateLabel(c.closeDate)} (sale price) · Listed by ${c.listingBrokerageName}` };
}
