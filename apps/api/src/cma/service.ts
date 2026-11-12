// api/cma service (module 71; R-CMA-6, R-CMA-7, R-CMA-8; F4, F6, F10, F15; E365, E366, E369, E370, E371, E373).
//
//   prepareCma    POST /cma: gate, resolve the subject, run, store a draft.
//   oneTapCma     POST /contacts/:id/cma: the contact's property (else home) address; returns the caller's own open draft
//                 when its content is unchanged (refreshing only its MLS data date), else supersedes the caller's own
//                 draft and inserts a new one ON CONFLICT DO NOTHING on cma_reports_one_open_draft, then re-reads: a
//                 double tap yields one draft. Another person's draft is never touched (R-CMA-6).
//   getCmaView    GET /cma/:id: the stored CMA with readiness computed now.
//   patchCma      PATCH /cma/:id: drafts only (CMA_NOT_DRAFT); re-runs the engine; nearMatchDismissed is stored in the
//                 subject (so the content hash covers it) and audited with ids only.
//   listCmas      GET /contacts/:id/cmas: summaries for the contact and its merged-away records.
//   readinessOf   client readiness of a stored CMA now (R-CMA-7): the view, and V2-A's share, sweep and PDF.
// Every read and write runs as the caller under RLS. The share (V2-A) is share.ts; nothing here sends.
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type IanaZone, type Instant, type UserActor, ianaZone, localDateOf } from '@realty/core/foundation';
import { type CompetingRule, type ListingFacts, competingSet, dedupeMirrors, listingIdentity } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import {
  CMA_DEFAULTS,
  CmaCandidateSchema,
  type CmaCandidate,
  type CmaRef,
  type CmaResult,
  type CmaSubject,
  type CmaTier,
  ENGINE_TIER,
  EMPTY_VALUATION_FACTS,
  LISTING_COLS,
  type ListingRow,
  type SoldTier,
  type TierQuery,
  addMonths,
  cellsWithin,
  factsOfRow,
  postalKey,
  prepareCma as runEngine,
  saleOfRow,
  soldCandidates,
  subdivisionKey,
} from './deps.js';
import { type CmaConnections, type ReadinessInput, agentGate, asOfSentence, clientReadiness, mlsDataAsOf, nearMatches, readinessConnections } from './gates.js';
import { shareMessageSentence } from './report.js';
import {
  type CmaInspection,
  type CmaPurpose,
  type CmaRow,
  type CmaWrite,
  addressOf,
  cmasOfContacts,
  connectionSizeField,
  contactLive,
  defaultAddress,
  getCma,
  insertDraft,
  myOpenDraft,
  myOpenDrafts,
  personRecords,
  relinkAddress,
  shareMessage,
  supersede,
  supersedeMyDraftsForHome,
  survivorSeenByCaller,
  tenantZoneName,
  touchDataDate,
  updateDraft,
} from './repos.js';
import type { CmaSubjectFacts } from './schemas.js';
import { type ResolvedSubject, type SubjectInput, engineSubject, resolveSubject } from './subject.js';

export interface Disclosure {
  intendedUsers: string | null;
  agentInterest: string | null;
  conflicts: string | null;
  valueDefinition: string | null;
  limitingConditions: string | null;
}
const NO_DISCLOSURE: Disclosure = { intendedUsers: null, agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null };

/** What a CMA stores in `subject` (covered by the content hash). */
export interface StoredSubject {
  input: SubjectInput;
  include: string[];
  exclude: string[];
  nearMatchDismissed: string[];
  resolved: ResolvedSubject;
}

export interface ContextListing {
  listingId: string;
  sourceLabel: 'MLS' | 'Team';
  mlsNumber: string | null;
  listingBrokerageName: string | null;
  status: string;
  listPriceCents: number | null;
  beds: number | null;
  bathsX10: number | null;
  sqft: number | null;
  address: string;
  why: string[];
}

/** The listing behind one engine identity, as the agent view shows it (the engine's references carry no address). */
export interface RefListing {
  /** the MLS row that carries the sale (a mirrored team sale: the mirror; E366) */
  saleListingId: string;
  /** the team row of a mirrored team sale, else null */
  teamListingId: string | null;
  sourceLabel: 'MLS' | 'Team';
  mlsNumber: string | null;
  listingBrokerageName: string | null;
  address: { line1: string; line2: string | null; city: string; region: string; postalCode: string };
}

/** One tier read of V1-A's soldCandidates, under V1-B's tier name; `ran` false when the subject lacks the tier's fact. */
export interface TierReadView {
  tier: CmaTier | 'rate_pool';
  ran: boolean;
  rows: number;
  limitReached: boolean;
}

/** What a CMA stores in `result`: V1-B's result as returned, and what the API read to get it. */
export type StoredResult = CmaResult & {
  /** engine identity → its listing (every identity in comps, notUsed and subjectSales) */
  listings: Record<string, RefListing>;
  reads: TierReadView[];
  /** MLS records read but left out because V1-B's strict sale schema refuses their stored values */
  recordsLeftOut: number;
  context: ContextListing[];
  contextSentence: string;
  /** the MLS connections the run read */
  connectionIds: string[];
};

interface Inputs {
  subject: SubjectInput;
  contactId: string | null;
  purpose: CmaPurpose;
  inspection: CmaInspection;
  inspectedOn: string | null;
  notes: string | null;
  disclosure: Disclosure;
  include: string[];
  exclude: string[];
  nearMatchDismissed: string[];
}

async function zoneOf(tx: Tx): Promise<IanaZone> {
  return (ianaZone(await tenantZoneName(tx)) ?? ('UTC' as IanaZone)) as IanaZone;
}

const addressText = (r: Pick<ListingRow, 'address_line1' | 'address_line2' | 'city'>) => [r.address_line1, r.address_line2].filter(Boolean).join(' ') + `, ${r.city}`;

/** Miles of a V1-B radius (metres), for V1-A's cellsWithin. */
const milesOf = (m: number) => m / 1609.344;

/** Every tier's read for this subject (F6): V1-A's TierQuery shapes over V1-B's areas and radii; limits are V1-A's (CMA_DEFAULTS). */
function tierQueries(subject: CmaSubject): TierQuery[] {
  const located = subject.latE6 !== null && subject.lonE6 !== null;
  const near = located ? cellsWithin(subject.latE6!, subject.lonE6!, milesOf(CMA_DEFAULTS.nearRadiusM)) : [];
  const far = located ? cellsWithin(subject.latE6!, subject.lonE6!, milesOf(CMA_DEFAULTS.farRadiusM)) : [];
  const zip = postalKey(subject.postalCode);
  const zips = zip === null ? [] : [zip];
  const sub = subdivisionKey(subject.subdivisionName) === null ? null : subject.subdivisionName;
  const q: TierQuery[] = [];
  if (sub !== null && (zips.length > 0 || located)) q.push({ tier: 'subdivision', names: [sub], postalCodes: zips, cells: far });
  if (located) q.push({ tier: 'cells_1mi', cells: near });
  if (zips.length > 0) q.push({ tier: 'postal_code', postalCodes: zips });
  if (located) q.push({ tier: 'cells_3mi', cells: far });
  if (subject.city !== null && subject.region !== null) q.push({ tier: 'city', cities: [subject.city], region: subject.region });
  if (located || zips.length > 0) q.push({ tier: 'rate_pool', cells: far, postalCodes: zips });
  return q;
}

const READ_ORDER: readonly SoldTier[] = ['subdivision', 'cells_1mi', 'postal_code', 'cells_3mi', 'city', 'rate_pool'];

function refListing(sale: ListingRow, team: ListingRow | null): RefListing {
  const shown = team ?? sale;
  return {
    saleListingId: sale.id,
    teamListingId: team?.id ?? null,
    sourceLabel: team ? 'Team' : 'MLS',
    mlsNumber: shown.mls_number ?? sale.mls_number,
    listingBrokerageName: shown.listing_brokerage_name ?? sale.listing_brokerage_name,
    address: { line1: shown.address_line1, line2: shown.address_line2, city: shown.city, region: shown.region, postalCode: shown.postal_code },
  };
}

/** The engine's reference for a sale (a mirrored team sale: the team row's identity, the mirror's connection; F4/F10). */
function refOf(sale: ListingRow, team: ListingRow | null): CmaRef {
  if (team) return { identity: listingIdentity(factsOfRow(team)), source: 'team', teamListingId: team.id, mlsNumber: team.mls_number ?? sale.mls_number, connectionId: sale.mls_connection_id };
  return { identity: listingIdentity(factsOfRow(sale)), source: 'mls', teamListingId: sale.team_listing_id, mlsNumber: sale.mls_number, connectionId: sale.mls_connection_id };
}

/**
 * V1-B's engine, which throws a ZodError on an input outside its strict schemas. Candidates are checked one by one
 * before (left out and counted) and resolveSubject keeps the subject's facts and address inside the bounds, so this is
 * a backstop: anything else outside them is a 422 naming the fields, never a 500.
 */
function engine(input: Parameters<typeof runEngine>[0]): CmaResult {
  try {
    return runEngine(input);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    const fields = [...new Set(e.issues.map((x) => String(x.path[0] ?? 'subject')))].sort();
    throw new AppError('CMA_SUBJECT_INCOMPLETE', { missing: fields, sentence: 'Part of this home’s record is outside what the valuation reads. Enter the home’s facts to prepare a CMA.' });
  }
}

/**
 * One run: every tier's sold sales in one soldCandidates call (F6), each mirrored team sale one candidate (R-MLS-5, E366:
 * the team row's identity and facts, the lowest-id mirror's close price, size and sale facts), V1-B's engine, the context
 * listings. A record whose stored values V1-B's strict schemas refuse (a price or count beyond the engine's bounds) is
 * left out and counted, so one bad record never stops a CMA. Also returns every identity offered to the engine: the ids
 * this run read under RLS (V1-B lists only the closest not-used sales, so its result does not name them all).
 */
async function run(tx: Tx, conns: CmaConnections, s: ResolvedSubject, valuationDate: string, include: readonly string[], exclude: readonly string[]): Promise<{ result: StoredResult; offered: ReadonlySet<string> }> {
  const connectionIds = conns.used.map((u) => u.conn.id);
  const subject = engineSubject(s);
  // V1-B's reach, composed as the engine composes it: the main run reads back max(extended look-back, rate pool) months
  // (24); the back-test fits its rates on that many months before its own window (backtestWindowMonths, 6) and values
  // each tested sale from its own date, so it reaches 30 months back. Sales older than the main reach are only too-old
  // not-used sales in the main result; the read stays bounded by each tier's limit (newest first).
  const since = addMonths(addMonths(valuationDate, -CMA_DEFAULTS.backtestWindowMonths), -Math.max(CMA_DEFAULTS.extendedLookbackMonths, CMA_DEFAULTS.ratePoolMonths));
  const read = await soldCandidates(tx, { connectionIds, propertyType: subject.propertyType, since, until: valuationDate, tiers: tierQueries(subject) });
  const teamById = new Map(read.rows.filter((r) => r.source === 'team').map((r) => [r.id, r]));
  const mirrorOf = new Map<string, ListingRow>();
  for (const r of read.rows) {
    if (r.source !== 'mls' || r.team_listing_id === null || !teamById.has(r.team_listing_id)) continue;
    const kept = mirrorOf.get(r.team_listing_id);
    if (kept === undefined || r.id < kept.id) mirrorOf.set(r.team_listing_id, r);
  }
  const candidates: CmaCandidate[] = [];
  const listings: Record<string, RefListing> = {};
  let recordsLeftOut = 0;
  const offer = (sale: ListingRow, team: ListingRow | null) => {
    const c = { ref: refOf(sale, team), sale: saleOfRow(sale, team) };
    if (!CmaCandidateSchema.safeParse(c).success) {
      recordsLeftOut += 1;
      return;
    }
    candidates.push(c);
    listings[c.ref.identity] = refListing(sale, team);
  };
  // R-MLS-5 / E81: core dedupeMirrors keeps the team row of a mirrored pair, and one mirror per team listing whose team
  // row was not read (then counted as the MLS sale it is)
  const kept = new Set(dedupeMirrors(read.rows.map(factsOfRow)).listings.map(listingIdentity));
  for (const r of read.rows) {
    if (!kept.has(listingIdentity(factsOfRow(r)))) continue;
    if (r.source === 'team') {
      const m = mirrorOf.get(r.id);
      if (m) offer(m, r);
    } else offer(r, null);
  }
  const tierReads = read.reads.map((x) => ({ tier: ENGINE_TIER[x.tier], limitReached: x.limitReached }));
  const result = engine({ subject, candidates, tierReads, valuationDate, include, exclude });
  const offered = new Set(candidates.map((c) => c.ref.identity));
  // the listing of every identity the result names, and of every one the agent included or excluded (so the view can
  // show what was chosen even when V1-B's not-used list leaves it out)
  const used = new Set([
    ...result.comps.map((c) => c.ref.identity),
    ...result.notUsed.map((n) => n.ref.identity),
    ...result.subjectSales.map((x) => x.ref.identity),
    ...[...include, ...exclude].filter((id) => offered.has(id)),
  ]);
  for (const k of Object.keys(listings)) if (!used.has(k)) delete listings[k];
  const reads = READ_ORDER.map((t) => {
    const x = read.reads.find((y) => y.tier === t);
    return { tier: ENGINE_TIER[t], ran: x !== undefined, rows: x?.rows ?? 0, limitReached: x?.limitReached ?? false };
  });
  const context = await contextListings(tx, conns, s);
  return { result: { ...result, listings, reads, recordsLeftOut, connectionIds, ...context }, offered };
}

/** Actives and pendings near the subject: support only, never comps (core competingSet with no price band). */
async function contextListings(tx: Tx, conns: CmaConnections, s: ResolvedSubject): Promise<{ context: ContextListing[]; contextSentence: string }> {
  const live = conns.used.filter((u) => !u.stale).map((u) => u.conn.id);
  const zip = (s.address.postalCode ?? '').trim().slice(0, 5);
  if (zip === '' && !s.address.city) return { context: [], contextSentence: 'No active or pending listings were looked up: the area is not known.' };
  const zips = [...new Set([(s.address.postalCode ?? '').trim(), zip])].filter((z) => z !== '');
  const area = sql`(l.postal_code = ANY (${zips}::text[]) OR (l.city = ${s.address.city ?? ''} AND l.region = ${s.address.region ?? ''}))`;
  const rows = (
    // never a lease (E360, b10 review ownership-data/F5): its list price is a rent; team rows carry is_lease false
    await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.status = ANY (${['active', 'pending']}::text[]) AND ${area}
      AND NOT l.is_lease AND (l.source = 'team' OR l.mls_connection_id = ANY (${live}::uuid[])) ORDER BY l.id LIMIT 500`.execute(tx)
  ).rows;
  const subjectFacts: ListingFacts = {
    id: (s.listingId ?? null) as ListingFacts['id'],
    source: 'team',
    listingKey: null,
    mlsNumber: s.selfMlsNumbers[0] ?? null,
    status: 'active',
    addressLine1: s.address.line1 ?? '',
    addressLine2: s.address.line2,
    city: s.address.city ?? '',
    region: s.address.region ?? '',
    postalCode: s.address.postalCode ?? '',
    listPriceCents: null,
    beds: s.facts.beds.value,
    bathsX10: s.facts.bathsX10.value,
    sqft: s.facts.sqft.value,
    propertyType: s.facts.propertyType.value as ListingFacts['propertyType'],
    description: null,
    listDate: null,
    mlsConnectionId: null,
    mlsModifiedAt: null,
    listingBrokerageName: null,
    displayAllowed: true,
    addressDisplayAllowed: true,
    photoUrls: [],
    photosCount: null,
    teamListingId: null,
    lastSeenInFeedAt: null,
    offMarketAt: null,
    valuation: EMPTY_VALUATION_FACTS,
  };
  const self = new Set(s.selfListingIds);
  const candidates = rows.filter((r) => !self.has(r.id)).map(factsOfRow);
  const rule: CompetingRule = { area: 'city_or_postal_code', priceBandPct: null, bedsDelta: null, samePropertyType: true, statuses: ['active', 'pending'], maxCount: 10, onlyDisplayAllowed: false, mlsFeedStale: false };
  const { listings, why } = competingSet(subjectFacts, candidates, rule);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const context = listings.map((l) => {
    const r = byId.get(l.id!)!;
    return {
      listingId: r.id,
      sourceLabel: r.source === 'team' ? ('Team' as const) : ('MLS' as const),
      mlsNumber: r.mls_number,
      listingBrokerageName: r.listing_brokerage_name,
      status: r.status,
      listPriceCents: r.list_price_cents === null ? null : Number(r.list_price_cents),
      beds: r.beds,
      bathsX10: r.baths_x10,
      sqft: r.sqft,
      address: addressText(r),
      why: why.filter((w) => w.listing === listingIdentity(l)).map((w) => w.detail),
    };
  });
  return { context, contextSentence: context.length === 0 ? 'No active or pending listings like this home nearby.' : `${context.length} active or pending listings nearby, shown for the market only: they are not sales and are not used in the value.` };
}

function contentOf(s: StoredSubject, r: StoredResult, i: Pick<Inputs, 'notes' | 'purpose' | 'inspection' | 'inspectedOn' | 'disclosure'>): string {
  // a JSON round trip first, so the hash is of exactly what is stored
  const plain = JSON.parse(JSON.stringify({ subject: s, result: r, notes: i.notes, purpose: i.purpose, inspection: i.inspection, inspectedOn: i.inspectedOn, disclosure: i.disclosure })) as unknown;
  return sha256Hex(canonicalJson(plain));
}

async function compute(tx: Tx, now: Instant, i: Inputs): Promise<{ write: CmaWrite; conns: CmaConnections; zone: IanaZone }> {
  const conns = await agentGate(tx, now);
  const zone = await zoneOf(tx);
  const connectionIds = conns.used.map((u) => u.conn.id);
  const sizeField = await connectionSizeField(tx, connectionIds);
  const resolved = await resolveSubject(tx, i.subject, { contactId: i.contactId, sizeField, connectionIds });
  const valuationDate = localDateOf(now, zone) as string;
  const { result, offered } = await run(tx, conns, resolved, valuationDate, i.include, i.exclude);
  // only listings that are near matches now may be dismissed (others are ignored; with nothing to dismiss, nothing is read)
  const near = new Set(i.nearMatchDismissed.length === 0 ? [] : (await nearMatches(tx, resolved.addressKey, [])).map((m) => m.listingId));
  // include/exclude keep only ids this run offered to the engine: sold, non-lease MLS sales of this tenant read under
  // RLS inside the window (a lease, a future sale or another tenant's id is never stored). Every offered id counts, not
  // only those V1-B lists: its not-used list is the closest 50, and an exclusion further out must not be lost. The
  // subject's own sales are not candidates for either (choosing them changes nothing).
  const own = new Set(result.subjectSales.map((x) => x.ref.identity));
  const seen = new Set([...offered].filter((id) => !own.has(id)));
  const known = (xs: readonly string[]) => [...new Set(xs)].filter((id) => seen.has(id)).sort();
  const subject: StoredSubject = { input: i.subject, include: known(i.include), exclude: known(i.exclude), nearMatchDismissed: [...new Set(i.nearMatchDismissed)].filter((id) => near.has(id)).sort(), resolved };
  return {
    conns,
    zone,
    write: {
      contactId: i.contactId,
      contactAddressId: resolved.contactAddressId,
      listingId: resolved.listingId,
      purpose: i.purpose,
      inspection: i.inspection,
      inspectedOn: i.inspection === 'none' ? null : i.inspectedOn,
      disclosure: i.disclosure,
      methodVersion: result.methodVersion,
      valuationDate,
      mlsDataAsOf: mlsDataAsOf(conns, result.comps.map((c) => c.ref.connectionId)),
      subject,
      result,
      valueCents: result.available ? result.valueCents : null,
      lowCents: result.available ? result.lowCents : null,
      highCents: result.available ? result.highCents : null,
      notes: i.notes,
      contentSha256: contentOf(subject, result, { ...i, inspectedOn: i.inspection === 'none' ? null : i.inspectedOn }),
    },
  };
}

/**
 * A contact a CMA is prepared or edited for must be live. A merged-away record is 409 CONTACT_MERGED, naming the
 * survivor only to a caller who sees it (R-PERM-5), also when contacts RLS hides the record itself from the caller
 * (its former agent opening their own CMA of it: db-public/F1, F2); any other contact the caller cannot see is 404.
 */
async function assertContact(tx: Tx, contactId: string): Promise<void> {
  const c = await contactLive(tx, contactId);
  if (c !== null && c.live) return;
  const survivor = c === null || c.mergedInto !== null ? await survivorSeenByCaller(tx, contactId) : null;
  if (c === null && survivor === null) throw new AppError('NOT_FOUND');
  throw new AppError('CONTACT_MERGED', survivor ? { mergedInto: survivor } : undefined);
}

/**
 * F15 across a merge (ownership-data/F4): once the caller stores or keeps a draft for a home on `contactId`, their open
 * drafts for the same home (address key) on records merged into it are superseded (a merged-away record's draft takes
 * no edit any more, and the person keeps one open draft per creator and home). In the caller's transaction, as far as
 * their RLS traces the person; routes.ts then completes it past a closed middle record as the system (cma/merge.ts
 * supersedeCreatorsDraftsAcrossPerson; re-review ownership-data/F4).
 */
async function supersedeMergedAwayDrafts(tx: Tx, contactId: string, w: CmaWrite): Promise<void> {
  const key = (w.subject as StoredSubject).resolved.addressKey;
  if (key === null) return;
  await supersedeMyDraftsForHome(tx, (await personRecords(tx, contactId)).filter((id) => id !== contactId), key);
}

/** The earliest inspection date accepted (E607). */
export const EARLIEST_INSPECTION = '1900-01-01';

/**
 * The inspection date rules (E607, R-CMA-8): a date sent with an inspection of 'none' is refused, never dropped
 * silently; a date must fall between 1900-01-01 and the valuation date (today in the tenant's zone). Paths only.
 */
async function checkInspectedOn(tx: Tx, now: Instant, inspection: CmaInspection, sent: string | null | undefined): Promise<void> {
  if (sent === undefined || sent === null) return;
  if (inspection === 'none') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/inspectedOn', code: 'no_inspection' }] });
  const today = localDateOf(now, await zoneOf(tx)) as string;
  if (sent < EARLIEST_INSPECTION || sent > today) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/inspectedOn', code: 'out_of_range' }] });
}

export interface PrepareBody {
  subject: SubjectInput;
  contactId?: string | undefined;
  purpose: CmaPurpose;
  inspection?: CmaInspection | undefined;
  inspectedOn?: string | null | undefined;
}

export async function prepare(tx: Tx, actor: UserActor, now: Instant, b: PrepareBody): Promise<CmaView> {
  const contactId = b.contactId ?? null;
  if (contactId !== null) await assertContact(tx, contactId);
  if (b.subject.kind === 'contact_address' && contactId === null) throw new AppError('VALIDATION_FAILED', { reason: 'CONTACT_REQUIRED' });
  await checkInspectedOn(tx, now, b.inspection ?? 'none', b.inspectedOn);
  const { write } = await compute(tx, now, { subject: b.subject, contactId, purpose: b.purpose, inspection: b.inspection ?? 'none', inspectedOn: b.inspectedOn ?? null, notes: null, disclosure: NO_DISCLOSURE, include: [], exclude: [], nearMatchDismissed: [] });
  // an explicit prepare supersedes the caller's open drafts for this contact and address, a draft whose address was
  // deleted and put back included (F15: one open draft per home)
  if (contactId !== null) {
    for (const d of await myOpenDrafts(tx, contactId, write.contactAddressId)) await supersede(tx, d.id);
    await supersedeMergedAwayDrafts(tx, contactId, write);
  }
  const id = randomUUID();
  let stored = await insertDraft(tx, id, write);
  if (stored === null) {
    // the caller already holds an open draft for this contact and address: it is superseded by this explicit prepare
    const open = await myOpenDraft(tx, contactId!, write.contactAddressId);
    if (open) await supersede(tx, open.id);
    stored = await insertDraft(tx, id, write);
  }
  return (await viewOf(tx, actor, now, (await getCma(tx, stored ?? id))!)) as CmaView;
}

export interface OneTapBody {
  contactAddressId?: string | undefined;
  facts?: CmaSubjectFacts | undefined;
}

export async function oneTap(tx: Tx, actor: UserActor, now: Instant, contactId: string, b: OneTapBody): Promise<{ created: boolean; view: CmaView }> {
  await assertContact(tx, contactId);
  const addr = b.contactAddressId ? await addressOf(tx, contactId, b.contactAddressId) : await defaultAddress(tx, contactId);
  if (!addr) {
    if (b.contactAddressId) throw new AppError('NOT_FOUND');
    throw new AppError('CMA_SUBJECT_INCOMPLETE', { missing: ['address'], sentence: 'Add the home’s address (a property or home address) to prepare a CMA.' });
  }
  // the caller's open draft for this address; a draft whose address was deleted and put back (its Undo) is the same
  // home's: it is picked up, and any other is superseded, so one open draft remains (F15, ownership-data/F3)
  const [open, ...others] = await myOpenDrafts(tx, contactId, addr.id);
  for (const d of others) await supersede(tx, d.id);
  const stored = open ? (open.subject as unknown as StoredSubject) : null;
  const facts = { ...(stored?.input.kind === 'contact_address' ? stored.input.facts : undefined), ...b.facts };
  const inputs: Inputs = {
    subject: { kind: 'contact_address', contactAddressId: addr.id, ...(Object.keys(facts).length > 0 ? { facts } : {}) },
    contactId,
    purpose: open?.purpose ?? 'listing_price',
    inspection: open?.inspection ?? 'none',
    inspectedOn: open?.inspected_on ?? null,
    notes: open?.agent_notes ?? null,
    disclosure: open ? disclosureOf(open) : NO_DISCLOSURE,
    include: stored?.include ?? [],
    exclude: stored?.exclude ?? [],
    nearMatchDismissed: stored?.nearMatchDismissed ?? [],
  };
  const { write } = await compute(tx, now, inputs);
  await supersedeMergedAwayDrafts(tx, contactId, write);
  if (open && open.content_sha256 === write.contentSha256) {
    if (open.contact_address_id === null) await relinkAddress(tx, open.id, addr.id);
    if ((open.mls_data_as_of?.getTime() ?? null) !== (write.mlsDataAsOf?.getTime() ?? null)) await touchDataDate(tx, open.id, write.mlsDataAsOf);
    return { created: false, view: await viewOf(tx, actor, now, (await getCma(tx, open.id))!) };
  }
  if (open) await supersede(tx, open.id);
  const id = randomUUID();
  const inserted = await insertDraft(tx, id, write);
  // a concurrent tap stored the open draft first: return it (one draft per double tap)
  const row = inserted ? await getCma(tx, inserted) : await myOpenDraft(tx, contactId, addr.id);
  return { created: inserted !== null, view: await viewOf(tx, actor, now, row!) };
}

function disclosureOf(r: CmaRow): Disclosure {
  return { intendedUsers: r.intended_users, agentInterest: r.agent_interest, conflicts: r.conflicts, valueDefinition: r.value_definition, limitingConditions: r.limiting_conditions };
}

export interface PatchBody {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  subjectFacts?: CmaSubjectFacts | undefined;
  purpose?: CmaPurpose | undefined;
  inspection?: CmaInspection | undefined;
  inspectedOn?: string | null | undefined;
  notes?: string | null | undefined;
  disclosure?: Partial<Disclosure> | undefined;
  nearMatchDismissed?: string[] | undefined;
}

/**
 * The address a draft S0 kept open after its contact address was deleted still names (F15: contact_address_id became
 * NULL; the stored subject keeps the id), else null. An Undo of the delete puts the address back under that id.
 */
function deletedAddressOf(row: CmaRow): string | null {
  const s = row.subject as unknown as StoredSubject;
  return row.contact_id !== null && row.contact_address_id === null && s.input.kind === 'contact_address' ? s.input.contactAddressId : null;
}

/** Whether a draft's address was deleted and is still gone: it cannot be re-run (db-public/F3, ownership-data/F3). */
async function addressGone(tx: Tx, row: CmaRow): Promise<boolean> {
  const a = deletedAddressOf(row);
  return a !== null && (await addressOf(tx, row.contact_id!, a)) === null;
}

export async function patch(tx: Tx, actor: UserActor, now: Instant, id: string, b: PatchBody): Promise<CmaView> {
  const row = await getCma(tx, id, { lock: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status !== 'draft') throw new AppError('CMA_NOT_DRAFT', { status: row.status });
  // a merged-away record's draft takes no edit (CONTACT_MERGED), as prepare and the one-tap refuse it (db-public/F2)
  if (row.contact_id !== null) await assertContact(tx, row.contact_id);
  if (await addressGone(tx, row)) {
    throw new AppError('CMA_SUBJECT_ADDRESS_GONE', { sentence: 'The home’s address was deleted from this contact, so this CMA can’t be re-run. Prepare a new CMA for the home.' });
  }
  const s = row.subject as unknown as StoredSubject;
  const input: SubjectInput = b.subjectFacts === undefined ? s.input : ({ ...s.input, facts: { ...s.input.facts, ...b.subjectFacts } } as SubjectInput);
  const inspection = b.inspection ?? row.inspection;
  await checkInspectedOn(tx, now, inspection, b.inspectedOn);
  const inputs: Inputs = {
    subject: input,
    contactId: row.contact_id,
    purpose: b.purpose ?? row.purpose,
    inspection,
    inspectedOn: inspection === 'none' ? null : b.inspectedOn !== undefined ? b.inspectedOn : row.inspected_on,
    notes: b.notes !== undefined ? b.notes : row.agent_notes,
    disclosure: { ...disclosureOf(row), ...Object.fromEntries(Object.entries(b.disclosure ?? {}).filter(([, v]) => v !== undefined)) },
    include: b.include ?? s.include,
    exclude: b.exclude ?? s.exclude,
    nearMatchDismissed: b.nearMatchDismissed ?? s.nearMatchDismissed,
  };
  const { write } = await compute(tx, now, inputs);
  if (!(await updateDraft(tx, id, write))) throw new AppError('NOT_FOUND'); // a Team Lead's edit of an agent's draft: RLS keeps it the creator's (R-CMA-8)
  const before = s.nearMatchDismissed;
  const after = (write.subject as StoredSubject).nearMatchDismissed;
  if (b.nearMatchDismissed !== undefined && canonicalJson(before) !== canonicalJson(after)) {
    await audit(tx, actor, { action: 'cma.near_match_dismissed', entity: { type: 'cma_report', id }, changes: redactDiff({ dismissed_listing_ids: before }, { dismissed_listing_ids: after }) });
  }
  return viewOf(tx, actor, now, (await getCma(tx, id))!);
}

export async function getView(tx: Tx, actor: UserActor, now: Instant, id: string): Promise<CmaView> {
  const row = await getCma(tx, id);
  if (!row) throw new AppError('NOT_FOUND');
  return viewOf(tx, actor, now, row);
}

export interface CmaSummary {
  id: string;
  contactId: string | null;
  status: string;
  purpose: string;
  valuationDate: string;
  mlsDataAsOf: string | null;
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  address: string | null;
  createdByUserId: string;
  mine: boolean;
  fromMergedRecord: boolean;
  /** what PATCH would accept now: the caller's own draft of a live record whose address is still there */
  canEdit: boolean;
  createdAt: string;
}

/** Whether the caller may edit the draft now (the view's canEdit): never an edit that must fail. */
async function editable(tx: Tx, actor: UserActor, row: CmaRow, contactLiveNow: boolean | null): Promise<boolean> {
  if (row.status !== 'draft' || row.created_by_user_id !== actor.userId) return false;
  if (row.contact_id !== null && !(contactLiveNow ?? (await contactLive(tx, row.contact_id))?.live === true)) return false; // merged away, or not seen
  return !(await addressGone(tx, row));
}

export async function listForContact(tx: Tx, actor: UserActor, contactId: string): Promise<CmaSummary[]> {
  // the contact and every record merged into it (a merge moves no CMA), also those contacts RLS hides from the caller:
  // their CMAs the caller may read are listed here (R-CMA-8, db-public/F1)
  const ids = await personRecords(tx, contactId);
  const rows = await cmasOfContacts(tx, ids);
  const live = (await contactLive(tx, contactId))?.live === true;
  const out: CmaSummary[] = [];
  for (const r of rows) out.push({ ...summaryOf(actor, contactId, r), canEdit: await editable(tx, actor, r, r.contact_id === contactId ? live : false) });
  return out;
}

function summaryOf(actor: UserActor, contactId: string, r: CmaRow): Omit<CmaSummary, 'canEdit'> {
  const s = r.subject as unknown as StoredSubject;
  const a = s.resolved?.address;
  return {
    id: r.id,
    contactId: r.contact_id,
    status: r.status,
    purpose: r.purpose,
    valuationDate: r.valuation_date,
    mlsDataAsOf: r.mls_data_as_of?.toISOString() ?? null,
    valueCents: r.value_cents === null ? null : Number(r.value_cents),
    lowCents: r.low_cents === null ? null : Number(r.low_cents),
    highCents: r.high_cents === null ? null : Number(r.high_cents),
    address: a?.line1 ? [a.line1, a.line2].filter(Boolean).join(' ') + (a.city ? `, ${a.city}` : '') : null,
    createdByUserId: r.created_by_user_id,
    mine: r.created_by_user_id === actor.userId,
    fromMergedRecord: r.contact_id !== contactId,
    createdAt: r.created_at.toISOString(),
  };
}

/** The readiness of a stored CMA and what it was judged on (V2-A reuses both: the report and the stale checks). */
export interface Readiness extends Awaited<ReturnType<typeof clientReadiness>> {
  input: ReadinessInput;
}

/**
 * Client readiness of a stored CMA now (R-CMA-7), as every view computes it: from the stored subject and comps and the
 * live rows. Readiness never needs the agent gate to pass: a feed disconnected or a valuation use withdrawn after the
 * CMA was prepared is its own blocker beside every other one that holds, and the stored CMA stays readable (gates/F5,
 * api-ui/F1). `conns` lets a caller judging many CMAs (the sweep) read the connections once per pass.
 */
export async function readinessOf(tx: Tx, now: Instant, row: CmaRow, conns?: CmaConnections): Promise<Readiness> {
  const s = row.subject as unknown as StoredSubject;
  const r = row.result as unknown as StoredResult;
  const input: ReadinessInput = {
    conns: conns ?? (await readinessConnections(tx, now)),
    now,
    state: s.resolved.state,
    addressKey: s.resolved.addressKey,
    addressLine: s.resolved.address.line1,
    subjectMlsListingId: s.resolved.mlsRecordId ?? s.resolved.mirrorListingId ?? (s.resolved.connectionId && s.resolved.listingId ? s.resolved.listingId : null),
    compSales: r.comps.map((c) => {
      const l = listingOf(r, c.ref.identity);
      return { saleListingId: l.saleListingId, teamListingId: l.teamListingId };
    }),
    readConnectionIds: [...(r.connectionIds ?? []), ...r.comps.flatMap((c) => c.ref.connectionId ?? []), ...(s.resolved.connectionId ? [s.resolved.connectionId] : [])],
    nearMatchDismissed: s.nearMatchDismissed,
    hasValue: row.value_cents !== null,
  };
  return { ...(await clientReadiness(tx, input)), input };
}

/** The listing behind one engine identity (the engine's references carry no address). */
export function listingOf(r: StoredResult, identity: string): RefListing {
  return r.listings[identity] ?? { saleListingId: identity, teamListingId: null, sourceLabel: 'MLS', mlsNumber: null, listingBrokerageName: null, address: { line1: '', line2: null, city: '', region: '', postalCode: '' } };
}

const SOP_KEYS = ['intendedUsers', 'agentInterest', 'conflicts', 'valueDefinition', 'limitingConditions'] as const;
export type DisclosureField = (typeof SOP_KEYS)[number] | 'inspectedOn';

/** What CMA_DISCLOSURE_INCOMPLETE names (E606): SoP 11-1 items for purpose 'other', and an inspection's date. */
export function disclosureMissing(row: Pick<CmaRow, 'purpose' | 'inspection' | 'inspected_on'> & { disclosure: Disclosure }): DisclosureField[] {
  const out: DisclosureField[] = [];
  if (row.purpose === 'other') for (const k of SOP_KEYS) if (row.disclosure[k] === null || row.disclosure[k]!.trim() === '') out.push(k);
  if (row.inspection !== 'none' && row.inspected_on === null) out.push('inspectedOn');
  return out;
}

/** The share as the viewer may read it (null: never shared). */
async function shareView(tx: Tx, row: CmaRow) {
  if (row.shared_by_user_id === null) return null;
  const m = row.shared_message_id === null ? null : await shareMessage(tx, row.shared_message_id);
  return { sharedByUserId: row.shared_by_user_id, message: m === null ? null : { id: m.id, status: m.status, statusReason: m.status_reason, sentence: shareMessageSentence(m) } };
}

// ---- the view ----------------------------------------------------------------------------------

export type CmaView = Awaited<ReturnType<typeof viewOf>>;

async function viewOf(tx: Tx, actor: UserActor, now: Instant, row: CmaRow) {
  const s = row.subject as unknown as StoredSubject;
  const r = row.result as unknown as StoredResult;
  const zone = await zoneOf(tx);
  const listing = (identity: string): RefListing => listingOf(r, identity);
  const { share, nearMatches: matches } = await readinessOf(tx, now, row);
  const facts = s.resolved.facts;
  const comp = (c: StoredResult['comps'][number]) => {
    const l = listing(c.ref.identity);
    return {
      listingId: c.ref.identity,
      saleListingId: l.saleListingId,
      sourceLabel: l.sourceLabel,
      mlsNumber: l.mlsNumber,
      listingBrokerageName: l.listingBrokerageName,
      address: l.address,
      closePriceCents: c.sale.closePriceCents,
      closeDate: c.sale.closeDate,
      contractDate: c.sale.contractDate,
      distanceM: c.distanceM,
      tier: c.tier,
      facts: { propertyType: c.sale.propertyType, sqft: c.sale.sqft, sizeSource: c.sale.sizeSource, beds: c.sale.beds, bathsX10: c.sale.bathsX10, yearBuilt: c.sale.yearBuilt, lotSqft: c.sale.lotSqft, daysOnMarket: c.sale.daysOnMarket, concessionsCents: c.sale.concessionsCents },
      adjustments: c.adjustments.map((a) => ({ feature: a.feature, subjectValue: a.subjectValue, compValue: a.compValue, rate: a.rate, amountCents: a.amountCents, support: a.support, sentence: a.sentence })),
      adjustedPriceCents: c.adjustedPriceCents,
      grossAdjustmentBps: c.grossAdjustmentBps,
      weightBasisBps: c.weightBasisBps,
      weightBps: c.weightBps,
      why: [...c.why],
      labels: [...c.labels],
      saleConditions: [...c.sale.saleConditions],
      includedByAgent: c.includedByAgent,
    };
  };
  const text = (a: RefListing['address']) => [a.line1, a.line2].filter(Boolean).join(' ') + `, ${a.city}`;
  return {
    id: row.id,
    contactId: row.contact_id,
    status: row.status,
    purpose: row.purpose,
    inspection: row.inspection,
    inspectedOn: row.inspected_on,
    disclosure: disclosureOf(row),
    notes: row.agent_notes,
    createdByUserId: row.created_by_user_id,
    mine: row.created_by_user_id === actor.userId,
    // never an edit that must fail: not a merged-away record's draft, nor one whose address was deleted (F15)
    canEdit: await editable(tx, actor, row, null),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sharedAt: row.shared_at?.toISOString() ?? null,
    valuationDate: row.valuation_date,
    mlsDataAsOf: row.mls_data_as_of?.toISOString() ?? null,
    mlsDataAsOfSentence: asOfSentence(row.mls_data_as_of, zone),
    methodVersion: row.method_version,
    subject: {
      kind: s.resolved.kind,
      listingId: s.resolved.listingId,
      contactAddressId: row.contact_address_id,
      address: s.resolved.address,
      state: s.resolved.state,
      sizeSentence: s.resolved.sizeSentence,
      factSentences: s.resolved.factSentences ?? [],
      facts: {
        propertyType: facts.propertyType,
        sqft: facts.sqft,
        agentEnteredSqft: facts.agentEnteredSqft,
        beds: facts.beds,
        bathsX10: facts.bathsX10,
        yearBuilt: facts.yearBuilt,
        lotSqft: facts.lotSqft,
        garageSpacesX10: facts.garageSpacesX10,
        storiesX10: facts.storiesX10,
        poolPrivate: facts.poolPrivate,
        subdivision: facts.subdivision,
        mapLocation: { known: facts.latE6.value !== null && facts.lonE6.value !== null, source: facts.latE6.source },
      },
      saleHistory: s.resolved.saleHistory,
      include: s.include,
      exclude: s.exclude,
      nearMatchDismissed: s.nearMatchDismissed,
    },
    result: {
      available: r.available,
      reason: r.available ? null : r.reason,
      sentence: r.sentences[0] ?? '',
      sentences: [...r.sentences],
      valueCents: r.available ? r.valueCents : null,
      lowCents: r.available ? r.lowCents : null,
      highCents: r.available ? r.highCents : null,
      closeDateSpan: r.available ? r.closeDateSpan : null,
      distanceSpanM: r.available ? r.distanceSpanM : null,
    },
    comps: r.comps.map(comp),
    notUsed: r.notUsed.map((n) => {
      const l = listing(n.ref.identity);
      return { listingId: n.ref.identity, mlsNumber: l.mlsNumber, address: text(l.address), reason: n.reason, conditions: [...n.conditions], distanceM: n.distanceM, sentence: n.sentence, includable: n.includable };
    }),
    notUsedTotal: r.notUsedTotal,
    subjectSales: r.subjectSales.map((x) => ({ listingId: x.ref.identity, closeDate: x.closeDate, closePriceCents: x.closePriceCents, status: x.status })),
    context: r.context,
    contextSentence: r.contextSentence,
    area: {
      tier: r.area.tier,
      lookbackMonths: r.area.lookbackMonths,
      tiersSkipped: [...r.area.tiersSkipped],
      reads: r.reads,
      recordsLeftOut: r.recordsLeftOut,
      sentences: [...r.area.sentences, ...(r.recordsLeftOut > 0 ? [recordsLeftOutSentence(r.recordsLeftOut)] : [])],
    },
    market: {
      poolTier: r.market.poolTier,
      poolMonths: r.market.poolMonths,
      poolSales: r.market.poolSales,
      rates: r.market.rates.map((x) => ({ feature: x.feature, applied: x.applied, rate: x.rate, support: x.support, sentence: x.sentence })),
      sentences: [...r.market.sentences],
    },
    backtest: r.backtest,
    nearMatches: matches,
    contentSha256: row.content_sha256,
    disclosureMissing: disclosureMissing({ ...row, disclosure: disclosureOf(row) }),
    share: await shareView(tx, row),
    pdfAvailable: row.status === 'shared' && share.ready,
    clientShare: share,
  };
}

/** The sentence for MLS records the engine could not take (their stored values are outside its bounds). */
export function recordsLeftOutSentence(n: number): string {
  return `${n} MLS ${n === 1 ? 'record was' : 'records were'} left out because ${n === 1 ? 'its' : 'their'} stored values are outside what the valuation reads (for example a price above $1 billion).`;
}
