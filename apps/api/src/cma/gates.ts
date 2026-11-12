// The CMA gates (module 71; R-CMA-6, R-CMA-7; R-MLS-2/3/4/5, R-INT-6, R-AVM-1; E369, E370, E371).
//
// Agent gate (R-CMA-6): an agent CMA needs a live MLS connection whose licence pack records valuation use
// (valuation.agent_cma). Otherwise it is refused in words. A stale feed is not a block: "MLS data as of …" is shown.
//
// Client readiness (R-CMA-7): computed on every view, never stored, and nothing is shared in V1. `allowed` only when
// no blocker holds. Each blocker is one plain sentence. VERIFY WITH COUNSEL / MLS: every sentence and every condition.
// V2's share re-checks the same function inside the transaction that queues the share.
import { type IanaZone, type Instant } from '@realty/core/foundation';
import { feedStale, packReviewed } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { type MlsConnectionFacts, type MlsEligibility, mlsEligibility } from '../mls/eligibility.js';
import { type ValuationRow, type ValuationUse, clientSoldView, listingRows, liveNearMatches, LIVE_STATUSES, mlsRowsAtAddress, valuationUse } from './deps.js';
import { platformCleared, storedPacks } from './repos.js';

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
  use: ValuationUse;
  stale: boolean;
}

export interface CmaConnections {
  e: MlsEligibility;
  packs: Map<string, unknown>;
  /** live connections whose pack records valuation use (the CMA's data) */
  used: ConnectionUse[];
}

const LIVE = new Set(['connected', 'degraded']);

export const SENTENCES = {
  noConnection: 'No MLS feed is connected, so there are no sold homes to compare.',
  notAllowed: 'Your MLS licence pack does not say MLS sold data may be used for valuations. An Owner or Admin records this from your MLS agreement.',
} as const;

/** The agent gate (R-CMA-6): throws in words, or returns the connections the CMA reads. */
export async function agentGate(tx: Tx, now: Instant): Promise<CmaConnections> {
  const e = await mlsEligibility(tx, now);
  const packs = await storedPacks(tx);
  const live = e.connections.filter((c) => LIVE.has(c.status));
  if (live.length === 0) throw new AppError('CMA_NO_MLS_CONNECTION', { sentence: SENTENCES.noConnection });
  const used = live.map((conn) => ({ conn, use: valuationUse(packs.get(conn.id)), stale: feedStale(conn.lastSyncedAt, now, conn.pack) })).filter((u) => u.use.agentCma);
  if (used.length === 0) throw new AppError('CMA_VALUATION_NOT_ALLOWED', { sentence: SENTENCES.notAllowed }); // E371
  return { e, packs, used };
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

export interface ReadinessInput {
  conns: CmaConnections;
  now: Instant;
  state: string | null;
  addressKey: string | null;
  addressLine: string | null;
  /** the subject listing's MLS mirror, or an MLS subject listing itself */
  subjectMlsListingId: string | null;
  /** MLS row ids behind the comps shown (a mirrored pair: the mirror) */
  compSaleListingIds: string[];
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

const line = (r: ValuationRow) => [r.address_line1, r.address_line2].filter(Boolean).join(' ') + `, ${r.city}`;

/** The live MLS listings that may be the subject (F2), each with its own AVM flag. */
export async function nearMatches(tx: Tx, key: string | null, dismissed: readonly string[]): Promise<NearMatch[]> {
  if (key === null) return [];
  const rows = await liveNearMatches(tx, key);
  return rows.map((r) => ({ listingId: r.id, mlsNumber: r.mls_number, address: line(r), status: r.status, listingBrokerageName: r.listing_brokerage_name, avmDisplayAllowed: r.avm_display_allowed, dismissed: dismissed.includes(r.id) }));
}

/** Client readiness (R-CMA-7). Reads live rows each time: nothing here is cached in the stored CMA. */
export async function clientReadiness(tx: Tx, i: ReadinessInput): Promise<{ share: ClientShare; nearMatches: NearMatch[] }> {
  const blockers: Blocker[] = [];
  const used = i.conns.used;
  if (!(await platformCleared(tx, CMA_PLATFORM_PACK))) {
    blockers.push({ code: 'PLATFORM_NOT_CLEARED', sentence: 'Client CMAs and seller value ranges wait for counsel review of the in-house CMA wording (platform:cma). Nothing is shown to clients until it is recorded.' });
  }
  const displayOff = used.filter((u) => !(packReviewed(u.conn.pack) && u.conn.pack.attributionText !== null && u.conn.pack.disclaimerText !== null));
  if (displayOff.length > 0) blockers.push({ code: 'MLS_CLIENT_DISPLAY_OFF', sentence: 'Your MLS licence pack does not allow showing MLS data to clients yet (it needs counsel review, an attribution and a disclaimer).' });
  if (used.some((u) => u.stale)) blockers.push({ code: 'FEED_STALE', sentence: 'The MLS feed is out of date, so nothing from it can be shown to clients until it syncs again.' });
  if (used.some((u) => !u.use.clientCma)) blockers.push({ code: 'CLIENT_USE_NOT_ALLOWED', sentence: 'Your MLS licence pack does not say sold data may be used in CMAs for clients. An Owner or Admin records this from your MLS agreement.' });
  if (used.some((u) => u.use.reviewedByCounselAt === null)) blockers.push({ code: 'VALUATION_NOT_REVIEWED', sentence: 'The valuation part of your MLS licence pack has not been reviewed by counsel.' });
  if (i.state === null || used.some((u) => u.use.statements[i.state!] === undefined)) {
    blockers.push({ code: 'NO_VALUATION_STATEMENT', sentence: i.state === null ? 'The home’s state is not known, so no valuation statement applies.' : `No valuation statement is recorded for ${i.state}.` });
  }

  // comps: each must pass the client display rules with sold data allowed (a mirrored pair: through its mirror)
  const rows = await listingRows(tx, i.compSaleListingIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = i.compSaleListingIds.filter((id) => {
    const r = byId.get(id);
    return r === undefined || clientSoldView(i.conns.e, i.conns.packs, r) === null;
  });
  if (hidden.length > 0) {
    blockers.push({ code: 'COMPS_HIDDEN', count: hidden.length, listingIds: [...hidden].sort(), sentence: `${hidden.length} of these sales can’t be shown to clients under your MLS licence. Remove ${hidden.length === 1 ? 'it' : 'them'} to share.` });
  }

  // E370: a live MLS record of the subject that withholds automated valuations, under the pack's scope
  const atKey = i.addressKey ? await mlsRowsAtAddress(tx, i.addressKey) : [];
  const subjectRows = [...atKey, ...(i.subjectMlsListingId ? await listingRows(tx, [i.subjectMlsListingId]) : [])];
  const scopeOf = (r: ValuationRow) => valuationUse(i.conns.packs.get(r.mls_connection_id ?? '')).avmFlagScope;
  const withheld = subjectRows.filter((r) => (LIVE_STATUSES as readonly string[]).includes(r.status) && !r.avm_display_allowed && scopeOf(r) === 'all_client_outputs');
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

  if (!i.hasValue) blockers.push({ code: 'NO_VALUE', sentence: 'There is no value to share: not enough comparable sales.' });
  return { share: { allowed: blockers.length === 0, blockers, estimateSentence: ESTIMATE_SENTENCE }, nearMatches: matches };
}
