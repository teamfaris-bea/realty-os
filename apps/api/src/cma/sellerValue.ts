// The seller update's 'value' section (module 71's AVM part, lane V2-B; R-CMA-7, R-CMA-10, R-SELL-2, R-SELL-4).
//
// Built in the API beside core's four sections (core's assembleSellerUpdate never words it), in the caller's
// transaction, in this order:
//   (a) platform:cma not cleared: 'unavailable', no lines, no claim, an agent-only statement; no MLS read, no engine
//       run. Every deployment as shipped.
//   (b) configuration, read before any sold data (so no count of comps reaches a seller while one fails): a live
//       connection, the agent gate, a connection recording automated_notes and client_cma (M1), its display pack and
//       valuation section reviewed, a statement for the home's state, every pack text renderable as written. Agent
//       only: no lines, the sentence as the statement.
//   (c) the value run (cma/pipeline.ts) on the listing, valued on the period's last local day (stable all week, E638),
//       then automatedGate('seller_range') with the comps it would show and the subject's own listings.
//   (d) a data reason: one seller line "Value range unavailable: …", the statement equal to it.
// With every gate holding: the R-AVM-1 sentence, the comps (each through clientView, or clientSoldView for a mirrored
// team sale: a closed sale with its sold price, date and listing brokerage), the state statement, attribution and
// disclaimer; one claim citing every comp. Never a list or adjusted price, a weight, a back-test figure or a context
// listing. No number in any other state, so a listing.view reader sees only client-ready figures. Email only: the
// SMS text leaves the section out (owner question 5). VERIFY WITH COUNSEL C2, C4; VERIFY WITH MLS M1, M2, M4.
import { formatPriceCents } from '@realty/core/assistant';
import { type Instant, localDateOf } from '@realty/core/foundation';
import type { DisplayListing } from '@realty/core/listings';
import type { ClaimSpec, Period, Section } from '@realty/core/marketing';
import { homeValueText } from '@realty/core/nurture';
import type { Tx } from '@realty/db';
import { literal } from '../nurture/decide.js';
import { AVAILABILITY_SENTENCES, GATE_SENTENCES, IN_HOUSE_PROVIDER, automatedGate, displayPackReviewed, longDate } from './avm.js';
import { type ListingRow, type MlsEligibility, clientSoldView, clientView, mlsEligibility, uspsCode, valuationStatement } from './deps.js';
import { type CompSale, CMA_PLATFORM_PACK, type ReadinessInput, agentGate, asOfSentence, liveNotLivingArea } from './gates.js';
import { LICENCE_SENTENCE, connectionsForUse, valueForSubjectInTx } from './pipeline.js';
import { listingRows, platformCleared } from './repos.js';
import { readinessInputOf } from './service.js';

export const VALUE_TITLE = 'Home value';
export const SELLER_VALUE_SENTENCES = {
  notCleared: 'Value ranges wait for counsel review of in-house values (platform:cma). Nothing is shown to the seller.',
  noConnection: AVAILABILITY_SENTENCES.noConnection,
  licence: `${LICENCE_SENTENCE} Seller value ranges also need client CMAs recorded until your MLS answers which use governs them.`,
  displayOff: 'Your MLS licence pack does not allow showing MLS data to clients yet (it needs counsel review, an attribution and a disclaimer), so no value range is shown to the seller.',
  valuationNotReviewed: 'The valuation part of your MLS licence pack has not been reviewed by counsel, so no value range is shown to the seller.',
  noStatement: (state: string | null) => (state === null ? 'The home’s state is not known, so no valuation statement applies and no value range is shown to the seller.' : `No valuation statement is recorded for ${state}, so no value range is shown to the seller.`),
  notRenderable: GATE_SENTENCES.STATEMENT_NOT_RENDERABLE,
} as const;

/** The data reasons a seller reads (owner question 6), each after "Value range unavailable: ". */
export const DATA_REASON = {
  FEED_STALE: 'the MLS data is out of date',
  SELLER_WITHHELD: 'the MLS listing of this home does not say automated valuations may be shown',
  POSSIBLE_LIVE_LISTING: 'another live MLS listing may be this home',
  COMPS_HIDDEN: 'some of the sales it rests on can’t be shown under the MLS licence',
  SUBJECT_ADDRESS_UNKNOWN: 'the home’s full address is not on record',
  SUBJECT: 'the home’s size or type is not on record',
  NO_COMPS: 'not enough comparable sales',
} as const;
const DATA_ORDER = ['FEED_STALE', 'SELLER_WITHHELD', 'POSSIBLE_LIVE_LISTING', 'COMPS_HIDDEN', 'SUBJECT_ADDRESS_UNKNOWN'] as const;
const SUBJECT_CODES: ReadonlySet<string> = new Set(['CMA_SUBJECT_INCOMPLETE', 'CMA_SUBJECT_TYPE_NOT_SUPPORTED', 'SUBJECT_INCOMPLETE', 'SUBJECT_TYPE_NOT_SUPPORTED']);

/** What the send re-checks before queueing (R-CMA-7): the gate's inputs, without the engine. */
export interface SellerValue {
  connectionIds: string[];
  state: string | null;
  addressKey: string | null;
  subjectMlsListingId: string | null;
  selfListingIds: string[];
  compSales: CompSale[];
  valuationDate: string;
}

export interface SellerValueSection {
  section: Section;
  /** ordinals from 0 (assembly offsets them after core's claims) */
  claims: ClaimSpec[];
  /** set only when the section shows a value */
  value: SellerValue | null;
}

const agentOnly = (statement: string): SellerValueSection => ({ section: { kind: 'value', title: VALUE_TITLE, state: 'unavailable', statement, lines: [], claimOrdinals: [] }, claims: [], value: null });
const dataReason = (reason: string): SellerValueSection => {
  const line = `Value range unavailable: ${reason}.`;
  return { section: { kind: 'value', title: VALUE_TITLE, state: 'unavailable', statement: line, lines: [{ text: line }], claimOrdinals: [] }, claims: [], value: null };
};

/** A comp's client rendering with its sold price and date (gates.ts's clientSale), or null. */
function clientSale(e: MlsEligibility, sale: ListingRow | undefined, team: ListingRow | undefined): DisplayListing | null {
  if (sale === undefined) return null;
  if (team !== undefined) return clientSoldView(e, sale, team);
  const v = clientView(e, sale);
  return v !== null && v.closePriceCents !== undefined && v.closePriceCents !== null && v.closeDate !== undefined && v.closeDate !== null ? v : null;
}

/** One comp's seller line from its client rendering only. */
function compLine(d: DisplayListing): string | null {
  if (d.closePriceCents === null || d.closePriceCents === undefined || !d.closeDate) return null;
  const where = d.address ? `${d.address.line1}${d.locality ? `, ${d.locality.city}` : ''}` : d.locality ? `A home in ${d.locality.city}` : 'A home';
  const broker = d.listingBrokerageName ? `, listed by ${d.listingBrokerageName}` : '';
  return literal(`${where}: sold ${longDate(d.closeDate)} for ${formatPriceCents(d.closePriceCents)}${broker}`);
}

/** Configuration, before any sold data is read (step b): an agent sentence, or null when it all holds. */
async function configuration(tx: Tx, now: Instant, state: string | null): Promise<string | null> {
  let gate;
  try {
    gate = await agentGate(tx, now);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === 'CMA_NO_MLS_CONNECTION' ? SELLER_VALUE_SENTENCES.noConnection : SELLER_VALUE_SENTENCES.licence;
  }
  const conns = connectionsForUse(gate, { sellerRange: true });
  if (conns.used.length === 0) return SELLER_VALUE_SENTENCES.licence;
  for (const { conn } of conns.used) {
    if (!displayPackReviewed(conn.pack)) return SELLER_VALUE_SENTENCES.displayOff;
    if (conn.pack.valuation.reviewedByCounselAt === null) return SELLER_VALUE_SENTENCES.valuationNotReviewed;
    const st = valuationStatement(conn.pack, state)?.text ?? null;
    if (st === null) return SELLER_VALUE_SENTENCES.noStatement(state);
    for (const t of [st, conn.pack.attributionText!, conn.pack.disclaimerText!]) if (literal(t) !== t) return SELLER_VALUE_SENTENCES.notRenderable;
  }
  return null;
}

/** The blockers that are configuration (agent only); the rest are data reasons the seller reads. */
const DATA_BLOCKERS: ReadonlySet<string> = new Set(DATA_ORDER);

/** The 'value' section of one seller update (see the header). `subj` is the update's listing row. */
export async function sellerValueSection(tx: Tx, subj: ListingRow, period: Period, now: Instant): Promise<SellerValueSection> {
  if (!(await platformCleared(tx, CMA_PLATFORM_PACK))) return agentOnly(SELLER_VALUE_SENTENCES.notCleared);
  const config = await configuration(tx, now, uspsCode(subj.region));
  if (config !== null) return agentOnly(config);
  const valuationDate = localDateOf((period.end - 1) as Instant, period.zone) as string;
  const v = await valueForSubjectInTx(tx, now, { kind: 'listing', listingId: subj.id }, { contactId: null, use: 'automated_notes', sellerRange: true, valuationDate });
  if (!v.ok) return SUBJECT_CODES.has(v.code) ? dataReason(DATA_REASON.SUBJECT) : agentOnly(v.code === 'CMA_NO_MLS_CONNECTION' ? SELLER_VALUE_SENTENCES.noConnection : SELLER_VALUE_SENTENCES.licence);
  if (!v.result.available) return dataReason(SUBJECT_CODES.has(v.result.reason) ? DATA_REASON.SUBJECT : DATA_REASON.NO_COMPS);
  const input: ReadinessInput = readinessInputOf(v.resolved, v.result, v.conns, now, { nearMatchDismissed: [], hasValue: true, use: 'automated_notes', selfListingIds: v.resolved.selfListingIds });
  const gate = await automatedGate(tx, now, input, { output: 'seller_range' });
  if (!gate.ok) {
    const config = gate.blockers.find((b) => !DATA_BLOCKERS.has(b.code));
    if (config) return agentOnly(config.sentence);
    const first = DATA_ORDER.find((c) => gate.blockers.some((b) => b.code === c))!;
    return dataReason(DATA_REASON[first]);
  }
  // every comp through its client rendering (the gate's COMPS_HIDDEN already held for each)
  const rows = await listingRows(tx, [...new Set(input.compSales.flatMap((c) => (c.teamListingId === null ? [c.saleListingId] : [c.saleListingId, c.teamListingId])))]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const comps = v.result.comps.map((c, i) => ({ c, d: clientSale(v.conns.e, byId.get(input.compSales[i]!.saleListingId), input.compSales[i]!.teamListingId === null ? undefined : byId.get(input.compSales[i]!.teamListingId!)) }));
  const compLines = comps.map((x) => (x.d === null ? null : compLine(x.d)));
  if (compLines.some((l) => l === null)) return dataReason(DATA_REASON.COMPS_HIDDEN);
  const estimate = homeValueText({ status: 'ok', valueCents: v.result.valueCents, lowCents: v.result.lowCents, highCents: v.result.highCents, asOf: v.valuationDate, displayAllowed: true, provider: IN_HOUSE_PROVIDER })!;
  const lines = [estimate, 'Comparable closed sales:', ...(compLines as string[]), ...gate.lines].map((text) => ({ text }));
  const claim: ClaimSpec = {
    ordinal: 0,
    kind: 'fact',
    section: 'value',
    text: `A value range from ${comps.length} comparable closed MLS ${comps.length === 1 ? 'sale' : 'sales'}`,
    count: comps.length,
    evidence: comps.map(({ c }) => ({ sourceType: 'listing', sourceId: c.ref.identity, locator: { kind: 'field', name: 'close_price' }, snippet: String(c.sale.closePriceCents) })),
  };
  return {
    section: { kind: 'value', title: VALUE_TITLE, state: 'has_data', statement: `An estimate from comparable recent MLS sales, not an appraisal. ${asOfSentence(v.mlsDataAsOf, v.zone)}`, lines, claimOrdinals: [0] },
    claims: [claim],
    value: { connectionIds: [...new Set(input.readConnectionIds)].sort(), state: input.state, addressKey: input.addressKey, subjectMlsListingId: input.subjectMlsListingId, selfListingIds: [...v.resolved.selfListingIds], compSales: input.compSales, valuationDate: v.valuationDate },
  };
}

/** The send's re-check (R-CMA-7, E632): automatedGate('seller_range') from what was shown, without the engine. */
export async function sellerRangeGate(tx: Tx, now: Instant, value: SellerValue): Promise<{ ok: true } | { ok: false; sentence: string }> {
  const e = await mlsEligibility(tx, now);
  const g = await automatedGate(
    tx,
    now,
    {
      conns: { e, used: [] }, now, state: value.state, addressKey: value.addressKey, addressLine: null, subjectMlsListingId: value.subjectMlsListingId, compSales: value.compSales, readConnectionIds: value.connectionIds, nearMatchDismissed: [], hasValue: true, selfListingIds: value.selfListingIds,
      // R-MLS-7 (batch 13): the stored range keeps listing ids, not size sources; the comps' and subject's rows are judged now
      notLivingArea: await liveNotLivingArea(tx, value),
    },
    { output: 'seller_range' },
  );
  return g.ok ? { ok: true } : { ok: false, sentence: g.sentence };
}
