// The CMA gates (module 71; R-CMA-6, R-CMA-7; R-MLS-2/3/4/5, R-INT-6, R-AVM-1; E369, E370, E371).
//
// Agent gate (R-CMA-6): an agent CMA reads the connections V1-A's valuationEligible(…, 'agent_cma') admits: live, with
// the licence pack's valuation.agent_cma. With no live connection it is refused in words (CMA_NO_MLS_CONNECTION), with
// live ones but none allowed likewise (CMA_VALUATION_NOT_ALLOWED, E371). A stale feed is not a block: "MLS data as of …"
// is shown (E369).
//
// Client readiness (R-CMA-7): computed on every view, never stored, and nothing is shared in V1 (D9): `sharingAvailable`
// is false and `sentence` says so on every view, and each blocker is worded as what would keep this CMA from being
// shown to a client, never as a step to share (batch 10 review api-ui/F4). `ready` only when no blocker holds (a
// subject with no address key is never ready: the E370 and F2 checks need it). Every blocker that
// holds is listed, each in one plain sentence, read from V1-A's parsed licence pack
// (LicensePack.valuation, valuationStatement), V1-A's connection eligibility and freshness, and V1-A's client renderings
// (clientView; clientSoldView for a mirrored team sale). V1-A's valuationEligible(…, 'client_cma') is the authority:
// whatever it refuses is always a blocker here, for every connection the stored CMA was built from (its run's reads,
// each comp's, the subject record's) as well as those the agent gate admits now, so readiness is never looser than the
// client gate. Readiness never needs the agent gate to pass (batch 10 review gates/F5, api-ui/F1): a feed disconnected
// or a valuation use withdrawn after the CMA was prepared is a blocker of its own (FEED_DISCONNECTED,
// VALUATION_USE_WITHDRAWN), beside every other one that holds. VERIFY WITH COUNSEL /
// MLS: every sentence and every condition. V2's share re-checks the same function inside the transaction that queues it.
import { type DisplayListing, SIZE_FIELDS_NEVER_USED } from '@realty/core/listings';
import { type IanaZone, type Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import {
  type ListingRow,
  type MlsConnectionFacts,
  type MlsEligibility,
  type ValuationRefusal,
  addressKey,
  clientSoldView,
  clientView,
  liveNearMatches,
  mlsEligibility,
  mlsRowsAtAddress,
  packReviewed,
  streetOfKey,
  valuationEligible,
  valuationStatement,
  VALUATION_USE_WHERE,
} from './deps.js';
import { listingRows, platformCleared } from './repos.js';

export const CMA_PLATFORM_PACK = 'platform:cma';
/** The R-AVM-1 sentence every client rendering carries (named in the readiness view). VERIFY WITH COUNSEL. */
export const ESTIMATE_SENTENCE = 'This is an estimate, not an appraisal.';
/** D9: sharing is V2. Said on every view, so readiness never reads as if a share existed. */
export const SHARING_SENTENCE = 'Sharing with clients is not available in this version, so nothing from this CMA reaches a client. Readiness lists what would also have to change before it could be shown to one.';

export const BLOCKER_CODES = [
  'PLATFORM_NOT_CLEARED',
  'FEED_DISCONNECTED',
  'VALUATION_USE_WITHDRAWN',
  'MLS_CLIENT_DISPLAY_OFF',
  'FEED_STALE',
  'CLIENT_USE_NOT_ALLOWED',
  'VALUATION_NOT_REVIEWED',
  'NO_VALUATION_STATEMENT',
  'COMPS_HIDDEN',
  'SUBJECT_ADDRESS_UNKNOWN',
  'SELLER_WITHHELD',
  'POSSIBLE_LIVE_LISTING',
  'SIZE_NOT_LIVING_AREA',
  'NO_VALUE',
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface Blocker {
  code: BlockerCode;
  sentence: string;
  count?: number;
  listingIds?: string[];
}
export interface ClientShare {
  /** every readiness check holds now; nothing is shared in V1 all the same */
  ready: boolean;
  /** false in V1 (D9: sharing is V2's, R-CMA-9) */
  sharingAvailable: false;
  sentence: string;
  blockers: Blocker[];
  estimateSentence: string;
}

export interface ConnectionUse {
  conn: MlsConnectionFacts;
  stale: boolean;
}

export interface CmaConnections {
  e: MlsEligibility;
  /** live connections whose pack records valuation use (the CMA's data) */
  used: ConnectionUse[];
}

/**
 * R-MLS-7: said, and a readiness blocker, for a stored CMA whose subject or comp sizes came from a field that is never
 * finished living area (core SIZE_FIELDS_NEVER_USED): one prepared before migration 0082 from a Spark sync that read
 * total building area. The stored record is not rewritten (R-CMA-8); the view says it does not hold.
 */
export const SIZE_NOT_LIVING_AREA_SENTENCE =
  'This CMA was prepared from a size that is not finished living area (total, unfinished or below-grade area), so its sizes, size adjustments and price per sq ft do not hold. Prepare a new CMA.';
const NEVER_SIZE = new Set(SIZE_FIELDS_NEVER_USED.map((f) => f.toLowerCase()));
/** Whether any of these stored size sources is a field that is never finished living area (any letter case). */
export function notLivingAreaSize(sources: readonly (string | null | undefined)[]): boolean {
  return sources.some((f) => typeof f === 'string' && NEVER_SIZE.has(f.toLowerCase()));
}

/** The live statuses of an MLS record of the subject (SELLER_WITHHELD; the same three V1-A's liveNearMatches reads). */
export const LIVE_STATUSES: readonly string[] = ['coming_soon', 'active', 'pending'];

export const SENTENCES = {
  noConnection: 'No MLS feed is connected, so there are no sold homes to compare.',
  notAllowed: `Your MLS licence pack does not say MLS sold data may be used for valuations. ${VALUATION_USE_WHERE}`,
} as const;

const NOT_LIVE: ReadonlySet<ValuationRefusal> = new Set(['NO_MLS_CONNECTION', 'MLS_NOT_LIVE']);

/** Every connection's agent verdict now (V1-A's valuationEligible(…, 'agent_cma')). */
async function agentVerdicts(tx: Tx, now: Instant) {
  const e = await mlsEligibility(tx, now);
  const verdicts = e.connections.map((conn) => ({ conn, v: valuationEligible(e, conn.id, 'agent_cma', null, now) }));
  const used = verdicts.filter((x) => x.v.ok).map(({ conn }) => ({ conn, stale: e.staleIds.includes(conn.id) }));
  return { e, verdicts, used };
}

/** The agent gate (R-CMA-6): throws in words, or returns the connections the CMA reads. */
export async function agentGate(tx: Tx, now: Instant): Promise<CmaConnections> {
  const { e, verdicts, used } = await agentVerdicts(tx, now);
  if (verdicts.every((x) => !x.v.ok && NOT_LIVE.has(x.v.code))) throw new AppError('CMA_NO_MLS_CONNECTION', { sentence: SENTENCES.noConnection });
  if (used.length === 0) throw new AppError('CMA_VALUATION_NOT_ALLOWED', { sentence: SENTENCES.notAllowed }); // E371
  return { e, used };
}

/**
 * The connections readiness reads: every MLS connection, and those the agent gate admits now (possibly none). Never
 * refused, so a stored CMA's view lists every blocker that holds after its feed is disconnected or its valuation use
 * withdrawn (gates/F5, api-ui/F1).
 */
export async function readinessConnections(tx: Tx, now: Instant): Promise<CmaConnections> {
  const { e, used } = await agentVerdicts(tx, now);
  return { e, used };
}

/**
 * "MLS data as of" (E369: the agent's stale-feed signal) = the OLDEST last sync among the connections the comps came
 * from (`compConnectionIds`), else among every connection the run read: with a fresh feed and a stale one, the date is
 * never the fresh one's (batch 10 review api-ui/F8). A connection that never synced makes it unknown (null).
 */
export function mlsDataAsOf(c: CmaConnections, compConnectionIds: readonly (string | null)[] = []): Date | null {
  const from = c.used.filter((u) => compConnectionIds.includes(u.conn.id));
  const times = (from.length > 0 ? from : c.used).map((u) => u.conn.lastSyncedAt);
  if (times.length === 0 || times.some((t) => t === null)) return null;
  return new Date(Math.min(...(times as Instant[])));
}

export function asOfSentence(at: Date | null, zone: IanaZone): string {
  if (at === null) return 'MLS data: not synced yet.';
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  return `MLS data as of ${f}.`;
}

/** One comp's sale as the readiness check sees it: the MLS row behind it and, for a mirrored team sale, the team row. */
export interface CompSale {
  saleListingId: string;
  teamListingId: string | null;
}

export interface ReadinessInput {
  conns: CmaConnections;
  now: Instant;
  state: string | null;
  addressKey: string | null;
  addressLine: string | null;
  /** the subject listing's MLS mirror, or an MLS subject listing itself */
  subjectMlsListingId: string | null;
  compSales: CompSale[];
  /**
   * The MLS connections the stored CMA was built from: those its run read (comps and rate pool), each comp's, and the
   * subject record's. Readiness checks each of them, besides the ones the agent gate admits now.
   */
  readConnectionIds: readonly string[];
  nearMatchDismissed: readonly string[];
  hasValue: boolean;
  /** R-MLS-7: the stored subject or comp sizes came from a field that is never finished living area (blocks under every use) */
  notLivingArea: boolean;
  /**
   * The client use readiness is judged for (ISA-3, flagged additive): 'client_cma' (the default; V1's output is
   * byte-identical) or 'ai_isa' (the AI ISA's comps email, R-ISA-18): platform:cma AND platform:ai_isa_seller_data
   * (never platform:avm), the licence's ai_isa_comps, SELLER_WITHHELD under either flag scope, and no dismissal of a
   * near match (R-CMA-7).
   */
  use?: ReadinessUse;
}

/** ISA-3: the client uses readiness is judged for (V2-B adds 'automated_notes' to this union and to useOf's switch). */
export type ReadinessUse = 'client_cma' | 'ai_isa';
/** The AI ISA's seller-data pack (docs/AI_ISA.md §6.3; 0084's 2026.11.1, lane number 0191). */
export const AI_ISA_SELLER_PACK = 'platform:ai_isa_seller_data';

interface UseRules {
  packs: readonly string[];
  platformSentence: string;
  licenceUse: 'client_cma' | 'ai_isa_comps';
  allowed: (v: MlsConnectionFacts['pack']['valuation']) => boolean;
  clientUseSentence: string;
  withheldEitherScope: boolean;
  honourDismissals: boolean;
  noValueSentence: string;
}

function useOf(use: ReadinessUse, state: string | null): UseRules {
  switch (use) {
    case 'client_cma':
      return {
        packs: [CMA_PLATFORM_PACK],
        platformSentence: 'Client CMAs and seller value ranges wait for counsel review of the in-house CMA wording (platform:cma), which is not recorded.',
        licenceUse: 'client_cma',
        allowed: (v) => v.clientCma,
        clientUseSentence: `Your MLS licence pack does not say sold data may be used in CMAs for clients. ${VALUATION_USE_WHERE}`,
        withheldEitherScope: false,
        honourDismissals: true,
        noValueSentence: 'There is no value: not enough comparable sales.',
      };
    case 'ai_isa':
      return {
        packs: [CMA_PLATFORM_PACK, AI_ISA_SELLER_PACK],
        platformSentence: 'Recent sales from the assistant wait for counsel review of the in-house CMA wording (platform:cma) and of the assistant’s seller-data wording (platform:ai_isa_seller_data); at least one is not recorded.',
        licenceUse: 'ai_isa_comps',
        allowed: (v) => v.aiIsaComps,
        clientUseSentence: `Your MLS licence pack does not say sold data may be emailed to seller leads by the assistant. ${VALUATION_USE_WHERE}`,
        withheldEitherScope: true,
        honourDismissals: false,
        noValueSentence: 'Not enough comparable recent sales to send.',
      };
    default: {
      const never: never = use;
      throw new Error(`unknown readiness use ${String(never)} (${state ?? ''})`);
    }
  }
}

export interface NearMatch {
  listingId: string;
  mlsNumber: string | null;
  address: string;
  status: string;
  listingBrokerageName: string | null;
  /** the seller's automated-valuation flag; null while the record has not been re-read since the flag was added */
  avmDisplayAllowed: boolean | null;
  dismissed: boolean;
}

const line = (r: ListingRow) => [r.address_line1, r.address_line2].filter(Boolean).join(' ') + `, ${r.city}`;

/**
 * A row's address key: the stored one, else V1-A's key of its address, as liveNearMatches computes it (gates/F4: a
 * record stored before 0061 that the 0068 backfill has not re-read yet, mls_normalize_version 1, has no stored key).
 */
const keyOfRow = (r: ListingRow): string | null => r.address_key ?? addressKey({ line1: r.address_line1, line2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code });

/**
 * Whether the row's automated-valuation flag was read from the feed. A version-1 row was stored before the flag
 * existed: avm_display_allowed holds the column default, so nothing is said about it and it is never taken as allowed.
 */
const flagRead = (r: ListingRow): boolean => r.mls_normalize_version >= 2;

/**
 * V1-A's live MLS rows on the key's street number, street name and 5-digit postal code, a stored ZIP+4 of it included
 * (none without a key): a record without a stored key (not re-read by the 0068 backfill yet) is found only here.
 */
async function liveOnStreet(tx: Tx, key: string | null): Promise<ListingRow[]> {
  const street = key === null ? null : streetOfKey(key);
  return street === null ? [] : liveNearMatches(tx, street);
}

/**
 * The live MLS listings that may be the subject although their key differs (F2): V1-A's liveNearMatches on the key's
 * street number, street name and postal code. A live record whose key (stored, or computed for a row not re-read yet)
 * is the subject's own is not a near match: it is the subject's own listing, which SELLER_WITHHELD reads and no
 * dismissal can set aside (gates/F4).
 */
export async function nearMatches(tx: Tx, key: string | null, dismissed: readonly string[], live?: readonly ListingRow[]): Promise<NearMatch[]> {
  const rows = (live ?? (await liveOnStreet(tx, key))).filter((r) => keyOfRow(r) !== key);
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ listingId: r.id, mlsNumber: r.mls_number, address: line(r), status: r.status, listingBrokerageName: r.listing_brokerage_name, avmDisplayAllowed: flagRead(r) ? r.avm_display_allowed : null, dismissed: dismissed.includes(r.id) }));
}

/** A comp's client rendering with its sold price and date, or null when they must not reach a client now (V1-A). */
function clientSale(e: MlsEligibility, sale: ListingRow | undefined, team: ListingRow | undefined): DisplayListing | null {
  if (sale === undefined) return null;
  if (team !== undefined) return clientSoldView(e, sale, team); // E366: a mirrored team sale
  const v = clientView(e, sale);
  return v !== null && v.closePriceCents !== undefined && v.closeDate !== undefined ? v : null;
}

/** The blockers read from the connections and the result (the rest carry ids). */
type PlainBlocker = Exclude<BlockerCode, 'COMPS_HIDDEN' | 'SELLER_WITHHELD' | 'POSSIBLE_LIVE_LISTING'>;

const REFUSAL_BLOCKER: Readonly<Record<ValuationRefusal, PlainBlocker>> = {
  NO_MLS_CONNECTION: 'FEED_DISCONNECTED',
  MLS_NOT_LIVE: 'FEED_DISCONNECTED',
  MLS_NOT_CLIENT_ELIGIBLE: 'MLS_CLIENT_DISPLAY_OFF',
  FEED_STALE: 'FEED_STALE',
  PACK_DOES_NOT_ALLOW: 'CLIENT_USE_NOT_ALLOWED',
  VALUATION_NOT_REVIEWED: 'VALUATION_NOT_REVIEWED',
  NO_VALUATION_STATEMENT: 'NO_VALUATION_STATEMENT',
};

/** Client readiness (R-CMA-7). Reads live rows each time: nothing here is cached in the stored CMA. */
export async function clientReadiness(tx: Tx, i: ReadinessInput): Promise<{ share: ClientShare; nearMatches: NearMatch[] }> {
  const blockers: Blocker[] = [];
  const { e, used } = i.conns;
  const has = (code: BlockerCode) => blockers.some((b) => b.code === code);
  const u = useOf(i.use ?? 'client_cma', i.state);
  const sentence: Record<PlainBlocker, string> = {
    PLATFORM_NOT_CLEARED: u.platformSentence,
    FEED_DISCONNECTED: 'An MLS feed this CMA was built from is no longer connected, so nothing from it could be shown to a client.',
    VALUATION_USE_WITHDRAWN: `Your MLS licence pack no longer says this feed’s sold data may be used for valuations, so this CMA could not be shown to a client. ${VALUATION_USE_WHERE}`,
    MLS_CLIENT_DISPLAY_OFF: 'Your MLS licence pack does not allow showing MLS data to clients yet (it needs counsel review, an attribution and a disclaimer).',
    FEED_STALE: 'The MLS feed is out of date, so nothing from it could be shown to a client until it syncs again.',
    CLIENT_USE_NOT_ALLOWED: u.clientUseSentence,
    VALUATION_NOT_REVIEWED: 'The valuation part of your MLS licence pack has not been reviewed by counsel.',
    NO_VALUATION_STATEMENT: i.state === null ? 'The home’s state is not known, so no valuation statement applies.' : `No valuation statement is recorded for ${i.state}.`,
    SUBJECT_ADDRESS_UNKNOWN: 'The home’s full address (street, city, state and ZIP code) is not known, so its own MLS listings and live listings that may be this home could not be checked. To check them, prepare a new CMA with the home’s full address.',
    SIZE_NOT_LIVING_AREA: SIZE_NOT_LIVING_AREA_SENTENCE,
    NO_VALUE: u.noValueSentence,
  };
  const add = (code: PlainBlocker) => {
    if (!has(code)) blockers.push({ code, sentence: sentence[code] });
  };

  for (const key of u.packs) if (!(await platformCleared(tx, key))) add('PLATFORM_NOT_CLEARED');
  const rows = await listingRows(tx, [...new Set(i.compSales.flatMap((c) => (c.teamListingId === null ? [c.saleListingId] : [c.saleListingId, c.teamListingId])))]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Every connection the CMA's data came from, not only the ones the agent gate admits now: a connection whose valuation
  // use was withdrawn after the CMA was prepared still shaped its comps or its market rates, so its client gate holds.
  const ids = new Set<string>([
    ...used.map((u) => u.conn.id),
    ...i.readConnectionIds,
    ...i.compSales.flatMap((c) => byId.get(c.saleListingId)?.mls_connection_id ?? []),
  ]);
  for (const id of [...ids].sort()) {
    const conn = e.connections.find((x) => x.id === id);
    if (conn !== undefined) {
      // every condition that holds, so the agent reads all of them at once (V1-A's parsed pack and freshness). The
      // display pack is judged on its own terms: freshness is FEED_STALE's alone, so a stale feed never hides an
      // unreviewed pack. A connection that is gone or not live is refused by V1-A's gate below (FEED_DISCONNECTED).
      // Each of these connections gave the CMA data under the agent gate: one whose pack no longer records the agent
      // use had it withdrawn since.
      if (!conn.pack.valuation.agentCma) add('VALUATION_USE_WITHDRAWN');
      if (!(packReviewed(conn.pack) && conn.pack.attributionText !== null && conn.pack.disclaimerText !== null)) add('MLS_CLIENT_DISPLAY_OFF');
      if (e.staleIds.includes(id)) add('FEED_STALE');
      if (!u.allowed(conn.pack.valuation)) add('CLIENT_USE_NOT_ALLOWED');
      if (conn.pack.valuation.reviewedByCounselAt === null) add('VALUATION_NOT_REVIEWED');
      if (valuationStatement(conn.pack, i.state) === null) add('NO_VALUATION_STATEMENT');
    }
    // V1-A's client gate is the authority: its refusal is always listed (a deleted connection: NO_MLS_CONNECTION)
    const v = valuationEligible(e, id, u.licenceUse, i.state, i.now);
    if (!v.ok) add(REFUSAL_BLOCKER[v.code]);
  }
  // keep the canonical order of the codes so far (the order they were added may differ across connections)
  blockers.sort((a, b) => BLOCKER_CODES.indexOf(a.code) - BLOCKER_CODES.indexOf(b.code));

  // comps: each must reach a client with its sold price and date (a mirrored pair through clientSoldView)
  const hidden = i.compSales.filter((c) => clientSale(e, byId.get(c.saleListingId), c.teamListingId === null ? undefined : byId.get(c.teamListingId)) === null).map((c) => c.saleListingId);
  if (hidden.length > 0) {
    blockers.push({ code: 'COMPS_HIDDEN', count: hidden.length, listingIds: [...hidden].sort(), sentence: `${hidden.length} of these sales can’t be shown to clients under your MLS licence, so a CMA shown to a client could not include ${hidden.length === 1 ? 'it' : 'them'}.` });
  }

  // E370 and F2 need the subject's address key: without one, neither check can run, and that is said (never ready)
  if (i.addressKey === null) add('SUBJECT_ADDRESS_UNKNOWN');

  // E370: a live MLS record of the subject that withholds automated valuations, under the pack's scope (V6). The
  // subject's records are those at its stored key, its own MLS record, and the live ones whose key computed from
  // their address is its key (a record the backfill has not re-read has none stored: gates/F4). A record whose flag
  // was never read from the feed is not taken as allowing them, and its flag is not stated.
  const atKey = i.addressKey ? await mlsRowsAtAddress(tx, i.addressKey) : [];
  const live = await liveOnStreet(tx, i.addressKey);
  const subjectRows = [...atKey, ...(i.subjectMlsListingId ? await listingRows(tx, [i.subjectMlsListingId]) : []), ...live.filter((r) => keyOfRow(r) === i.addressKey)];
  const scopeOf = (r: ListingRow) => e.pack(r.mls_connection_id)?.valuation.avmFlagScope ?? 'all_client_outputs';
  const withheld = subjectRows.filter((r) => LIVE_STATUSES.includes(r.status) && (!flagRead(r) || !r.avm_display_allowed) && (u.withheldEitherScope || scopeOf(r) === 'all_client_outputs'));
  if (withheld.length > 0) {
    blockers.push({
      code: 'SELLER_WITHHELD',
      listingIds: [...new Set(withheld.map((r) => r.id))].sort(),
      sentence: withheld.some(flagRead)
        ? 'The seller’s MLS listing of this home asks that automated valuations not be shown, so this CMA could not be shown to a client.'
        : 'An MLS listing of this home has not been re-read since the feed’s automated-valuation flag was added, so whether the seller allows automated valuations is not known yet. Until it is, this CMA could not be shown to a client.',
    });
  }

  // F2: a live listing that may be this home, until the agent confirms it is a different one
  const matches = await nearMatches(tx, i.addressKey, u.honourDismissals ? i.nearMatchDismissed : [], live);
  for (const m of matches.filter((x) => !x.dismissed)) {
    blockers.push({
      code: 'POSSIBLE_LIVE_LISTING',
      listingIds: [m.listingId],
      sentence: `An MLS listing at ${m.address} may be this home. Confirm it is a different home, or this CMA could not be shown to a client.${m.avmDisplayAllowed === false ? ' That listing asks that automated valuations not be shown.' : ''}`,
    });
  }

  if (i.notLivingArea) add('SIZE_NOT_LIVING_AREA');
  if (!i.hasValue) add('NO_VALUE');
  return { share: { ready: blockers.length === 0, sharingAvailable: false, sentence: SHARING_SENTENCE, blockers, estimateSentence: ESTIMATE_SENTENCE }, nearMatches: matches };
}
