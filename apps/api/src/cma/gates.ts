// The CMA gates (module 71; R-CMA-6, R-CMA-7; R-MLS-2/3/4/5, R-INT-6, R-AVM-1; E369, E370, E371).
//
// Agent gate (R-CMA-6): an agent CMA reads the connections V1-A's valuationEligible(…, 'agent_cma') admits: live, with
// the licence pack's valuation.agent_cma. With no live connection it is refused in words (CMA_NO_MLS_CONNECTION), with
// live ones but none allowed likewise (CMA_VALUATION_NOT_ALLOWED, E371). A stale feed is not a block: "MLS data as of …"
// is shown (E369).
//
// Client readiness (R-CMA-7): computed on every view, never stored, and nothing is shared in V1. `allowed` only when no
// blocker holds (a subject with no address key is never allowed: the E370 and F2 checks need it). Every blocker that
// holds is listed, each in one plain sentence, read from V1-A's parsed licence pack
// (LicensePack.valuation, valuationStatement), V1-A's connection eligibility and freshness, and V1-A's client renderings
// (clientView; clientSoldView for a mirrored team sale). V1-A's valuationEligible(…, 'client_cma') is the authority:
// whatever it refuses is always a blocker here, for every connection the stored CMA was built from (its run's reads,
// each comp's, the subject record's) as well as those the agent gate admits now, so readiness is never looser than the
// client gate. VERIFY WITH COUNSEL /
// MLS: every sentence and every condition. V2's share re-checks the same function inside the transaction that queues it.
import type { DisplayListing } from '@realty/core/listings';
import { type IanaZone, type Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import {
  type ListingRow,
  type MlsConnectionFacts,
  type MlsEligibility,
  type ValuationRefusal,
  clientSoldView,
  clientView,
  liveNearMatches,
  mlsEligibility,
  mlsRowsAtAddress,
  packReviewed,
  streetOfKey,
  valuationEligible,
  valuationStatement,
} from './deps.js';
import { listingRows, platformCleared } from './repos.js';

export const CMA_PLATFORM_PACK = 'platform:cma';
/** The R-AVM-1 sentence every client rendering carries (named in the readiness view). VERIFY WITH COUNSEL. */
export const ESTIMATE_SENTENCE = 'This is an estimate, not an appraisal.';

export const BLOCKER_CODES = [
  'PLATFORM_NOT_CLEARED',
  'MLS_CLIENT_DISPLAY_OFF',
  'FEED_STALE',
  'CLIENT_USE_NOT_ALLOWED',
  'VALUATION_NOT_REVIEWED',
  'NO_VALUATION_STATEMENT',
  'COMPS_HIDDEN',
  'SUBJECT_ADDRESS_UNKNOWN',
  'SELLER_WITHHELD',
  'POSSIBLE_LIVE_LISTING',
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
  allowed: boolean;
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

/** The live statuses of an MLS record of the subject (SELLER_WITHHELD; the same three V1-A's liveNearMatches reads). */
export const LIVE_STATUSES: readonly string[] = ['coming_soon', 'active', 'pending'];

export const SENTENCES = {
  noConnection: 'No MLS feed is connected, so there are no sold homes to compare.',
  notAllowed: 'Your MLS licence pack does not say MLS sold data may be used for valuations. An Owner or Admin records this from your MLS agreement.',
} as const;

const NOT_LIVE: ReadonlySet<ValuationRefusal> = new Set(['NO_MLS_CONNECTION', 'MLS_NOT_LIVE']);

/** The agent gate (R-CMA-6): throws in words, or returns the connections the CMA reads. */
export async function agentGate(tx: Tx, now: Instant): Promise<CmaConnections> {
  const e = await mlsEligibility(tx, now);
  const verdicts = e.connections.map((conn) => ({ conn, v: valuationEligible(e, conn.id, 'agent_cma', null, now) }));
  if (verdicts.every((x) => !x.v.ok && NOT_LIVE.has(x.v.code))) throw new AppError('CMA_NO_MLS_CONNECTION', { sentence: SENTENCES.noConnection });
  const used = verdicts.filter((x) => x.v.ok).map(({ conn }) => ({ conn, stale: e.staleIds.includes(conn.id) }));
  if (used.length === 0) throw new AppError('CMA_VALUATION_NOT_ALLOWED', { sentence: SENTENCES.notAllowed }); // E371
  return { e, used };
}

/** "MLS data as of" = the newest last sync of the connections used. */
export function mlsDataAsOf(c: CmaConnections): Date | null {
  const t = c.used.map((u) => u.conn.lastSyncedAt).reduce<Instant | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
  return t === null ? null : new Date(t);
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
}

export interface NearMatch {
  listingId: string;
  mlsNumber: string | null;
  address: string;
  status: string;
  listingBrokerageName: string | null;
  avmDisplayAllowed: boolean;
  dismissed: boolean;
}

const line = (r: ListingRow) => [r.address_line1, r.address_line2].filter(Boolean).join(' ') + `, ${r.city}`;

/**
 * The live MLS listings that may be the subject although their key differs (F2): V1-A's liveNearMatches on the key's
 * street number, street name and postal code. A live record at the subject's own key is not a near match (it is the
 * subject's own listing: SELLER_WITHHELD reads it).
 */
export async function nearMatches(tx: Tx, key: string | null, dismissed: readonly string[]): Promise<NearMatch[]> {
  const street = key === null ? null : streetOfKey(key);
  if (street === null) return [];
  const rows = (await liveNearMatches(tx, street)).filter((r) => r.address_key !== key);
  return rows
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ listingId: r.id, mlsNumber: r.mls_number, address: line(r), status: r.status, listingBrokerageName: r.listing_brokerage_name, avmDisplayAllowed: r.avm_display_allowed, dismissed: dismissed.includes(r.id) }));
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
  NO_MLS_CONNECTION: 'MLS_CLIENT_DISPLAY_OFF',
  MLS_NOT_LIVE: 'MLS_CLIENT_DISPLAY_OFF',
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
  const sentence: Record<PlainBlocker, string> = {
    PLATFORM_NOT_CLEARED: 'Client CMAs and seller value ranges wait for counsel review of the in-house CMA wording (platform:cma). Nothing is shown to clients until it is recorded.',
    MLS_CLIENT_DISPLAY_OFF: 'Your MLS licence pack does not allow showing MLS data to clients yet (it needs counsel review, an attribution and a disclaimer).',
    FEED_STALE: 'The MLS feed is out of date, so nothing from it can be shown to clients until it syncs again.',
    CLIENT_USE_NOT_ALLOWED: 'Your MLS licence pack does not say sold data may be used in CMAs for clients. An Owner or Admin records this from your MLS agreement.',
    VALUATION_NOT_REVIEWED: 'The valuation part of your MLS licence pack has not been reviewed by counsel.',
    NO_VALUATION_STATEMENT: i.state === null ? 'The home’s state is not known, so no valuation statement applies.' : `No valuation statement is recorded for ${i.state}.`,
    SUBJECT_ADDRESS_UNKNOWN: 'The home’s full address (street, city, state and ZIP code) is not known, so its own MLS listings and live listings that may be this home could not be checked. Add the full address to share.',
    NO_VALUE: 'There is no value to share: not enough comparable sales.',
  };
  const add = (code: PlainBlocker) => {
    if (!has(code)) blockers.push({ code, sentence: sentence[code] });
  };

  if (!(await platformCleared(tx, CMA_PLATFORM_PACK))) add('PLATFORM_NOT_CLEARED');
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
      // unreviewed pack. A connection that is gone or not live is refused by V1-A's gate below.
      if (!(packReviewed(conn.pack) && conn.pack.attributionText !== null && conn.pack.disclaimerText !== null)) add('MLS_CLIENT_DISPLAY_OFF');
      if (e.staleIds.includes(id)) add('FEED_STALE');
      if (!conn.pack.valuation.clientCma) add('CLIENT_USE_NOT_ALLOWED');
      if (conn.pack.valuation.reviewedByCounselAt === null) add('VALUATION_NOT_REVIEWED');
      if (valuationStatement(conn.pack, i.state) === null) add('NO_VALUATION_STATEMENT');
    }
    // V1-A's client gate is the authority: its refusal is always listed (a deleted connection: NO_MLS_CONNECTION)
    const v = valuationEligible(e, id, 'client_cma', i.state, i.now);
    if (!v.ok) add(REFUSAL_BLOCKER[v.code]);
  }
  // keep the canonical order of the codes so far (the order they were added may differ across connections)
  blockers.sort((a, b) => BLOCKER_CODES.indexOf(a.code) - BLOCKER_CODES.indexOf(b.code));

  // comps: each must reach a client with its sold price and date (a mirrored pair through clientSoldView)
  const hidden = i.compSales.filter((c) => clientSale(e, byId.get(c.saleListingId), c.teamListingId === null ? undefined : byId.get(c.teamListingId)) === null).map((c) => c.saleListingId);
  if (hidden.length > 0) {
    blockers.push({ code: 'COMPS_HIDDEN', count: hidden.length, listingIds: [...hidden].sort(), sentence: `${hidden.length} of these sales can’t be shown to clients under your MLS licence. Remove ${hidden.length === 1 ? 'it' : 'them'} to share.` });
  }

  // E370 and F2 need the subject's address key: without one, neither check can run, and that is said (never allowed)
  if (i.addressKey === null) add('SUBJECT_ADDRESS_UNKNOWN');

  // E370: a live MLS record of the subject that withholds automated valuations, under the pack's scope (V6)
  const atKey = i.addressKey ? await mlsRowsAtAddress(tx, i.addressKey) : [];
  const subjectRows = [...atKey, ...(i.subjectMlsListingId ? await listingRows(tx, [i.subjectMlsListingId]) : [])];
  const scopeOf = (r: ListingRow) => e.pack(r.mls_connection_id)?.valuation.avmFlagScope ?? 'all_client_outputs';
  const withheld = subjectRows.filter((r) => LIVE_STATUSES.includes(r.status) && !r.avm_display_allowed && scopeOf(r) === 'all_client_outputs');
  if (withheld.length > 0) {
    blockers.push({ code: 'SELLER_WITHHELD', listingIds: [...new Set(withheld.map((r) => r.id))].sort(), sentence: 'The seller’s MLS listing of this home asks that automated valuations not be shown, so this CMA can’t be shared with clients.' });
  }

  // F2: a live listing that may be this home, until the agent confirms it is a different one
  const matches = await nearMatches(tx, i.addressKey, i.nearMatchDismissed);
  for (const m of matches.filter((x) => !x.dismissed)) {
    blockers.push({
      code: 'POSSIBLE_LIVE_LISTING',
      listingIds: [m.listingId],
      sentence: `An MLS listing at ${m.address} may be this home. Confirm it is a different home before sharing.${m.avmDisplayAllowed ? '' : ' That listing asks that automated valuations not be shown.'}`,
    });
  }

  if (!i.hasValue) add('NO_VALUE');
  return { share: { allowed: blockers.length === 0, blockers, estimateSentence: ESTIMATE_SENTENCE }, nearMatches: matches };
}
