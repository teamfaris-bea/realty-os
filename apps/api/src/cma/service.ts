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
// Every read and write runs as the caller under RLS. Nothing is sent in V1 (comms/** is not called).
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type IanaZone, type Instant, type UserActor, ianaZone, localDateOf } from '@realty/core/foundation';
import { type CompetingRule, type ListingFacts, competingSet, dedupeMirrors, listingIdentity } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { mergeTree } from '../admin/repos/erasure.js';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { LISTING_COLS, type ListingRow, factsOfRow, mlsCitySpellings } from '../mls/eligibility.js';
import {
  CMA_DEFAULTS,
  type CmaCandidate,
  type CmaRef,
  type CmaResult,
  type CmaSubjectFacts,
  type CmaTier,
  type TierRead,
  type ValuationRow,
  listingRows,
  monthsBefore,
  prepareCma as runEngine,
  saleOfRow,
  soldCandidates,
} from './deps.js';
import { type ClientShare, type CmaConnections, type NearMatch, agentGate, asOfSentence, clientReadiness, mlsDataAsOf, nearMatches } from './gates.js';
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
  supersede,
  tenantZoneName,
  touchDataDate,
  updateDraft,
} from './repos.js';
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

/** What a CMA stores in `result`: the engine's result, the MLS rows behind each comp, and the context listings. */
export interface StoredResult extends CmaResult {
  /** comp ref id → the MLS row that carries its sale (a mirrored pair: the mirror; E366) */
  saleListingIds: Record<string, string>;
  context: ContextListing[];
  contextSentence: string;
  /** the MLS connections the run read */
  connectionIds: string[];
}

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

/** The engine's reference for a listing row (the team row for a mirrored pair: F4/F10). */
function refOf(r: ValuationRow, mirror: ValuationRow | null): CmaRef {
  return {
    id: r.id,
    source: r.source,
    mlsNumber: r.mls_number ?? mirror?.mls_number ?? null,
    connectionId: (mirror ?? r).mls_connection_id,
    brokerage: r.listing_brokerage_name ?? mirror?.listing_brokerage_name ?? null,
    addressKey: (mirror ?? r).address_key,
    address: { line1: r.address_line1, line2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code },
  };
}

/** One run: every tier's sold sales in one read (F6), mirrors counted once (F4/F10), the engine, the context listings. */
async function run(tx: Tx, conns: CmaConnections, s: ResolvedSubject, valuationDate: string, include: readonly string[], exclude: readonly string[]): Promise<StoredResult> {
  const connectionIds = conns.used.map((u) => u.conn.id);
  const subject = engineSubject(s);
  const cities = s.address.city ? [...new Set([s.address.city, ...(await mlsCitySpellings(tx, [s.address.city]))])] : [];
  const reads = await soldCandidates(tx, {
    connectionIds,
    propertyType: subject.propertyType,
    valuationDate,
    fromDate: monthsBefore(valuationDate, CMA_DEFAULTS.lookbackMonths),
    limit: CMA_DEFAULTS.tierLimit,
    subdivisionMiles: CMA_DEFAULTS.subdivisionMiles,
    subject: { latE6: subject.latE6, lonE6: subject.lonE6, subdivision: subject.subdivision, postalCode: subject.postalCode, city: subject.city, region: subject.region, citySpellings: cities },
  });
  const tiersOf = new Map<string, CmaTier[]>();
  const rowById = new Map<string, ValuationRow>();
  for (const t of reads) for (const r of t.rows) {
    rowById.set(r.id, r);
    tiersOf.set(r.id, [...(tiersOf.get(r.id) ?? []), t.tier]);
  }
  // R-MLS-5: a mirrored team sale is one candidate: the team row's ref, the mirror's sale facts
  const mlsRows = [...rowById.values()];
  const teamIds = [...new Set(mlsRows.flatMap((r) => (r.team_listing_id ? [r.team_listing_id] : [])))];
  const teamRows = await listingRows(tx, teamIds);
  const teamById = new Map(teamRows.map((r) => [r.id, r]));
  const facts = [...teamRows, ...mlsRows].map((r) => ({ f: factsOfRow(r), r }));
  const kept = new Set(dedupeMirrors(facts.map((x) => x.f)).listings.map(listingIdentity));
  const candidates: CmaCandidate[] = [];
  const saleListingIds: Record<string, string> = {};
  for (const r of mlsRows) {
    const team = r.team_listing_id ? teamById.get(r.team_listing_id) : undefined;
    if (team) {
      if (saleListingIds[team.id] !== undefined && saleListingIds[team.id]! < r.id) continue; // one mirror per team listing
      saleListingIds[team.id] = r.id;
      const i = candidates.findIndex((c) => c.ref.id === team.id);
      const c = { ref: refOf(team, r), sale: saleOfRow(r), tiers: tiersOf.get(r.id)! };
      if (i >= 0) candidates[i] = c;
      else candidates.push(c);
      continue;
    }
    if (!kept.has(listingIdentity(factsOfRow(r)))) continue;
    saleListingIds[r.id] = r.id;
    candidates.push({ ref: refOf(r, null), sale: saleOfRow(r), tiers: tiersOf.get(r.id)! });
  }
  const tiers: TierRead[] = reads.map((t) => ({ tier: t.tier, ran: t.ran, count: t.rows.length, limit: CMA_DEFAULTS.tierLimit, limitReached: t.limitReached }));
  const result = runEngine({ subject, candidates, tiers, valuationDate, include, exclude });
  const used = new Set([...result.comps.map((c) => c.ref.id), ...result.notUsed.map((n) => n.ref.id)]);
  for (const k of Object.keys(saleListingIds)) if (!used.has(k)) delete saleListingIds[k];
  const context = await contextListings(tx, conns, s);
  return { ...result, saleListingIds, connectionIds, ...context };
}

/** Actives and pendings near the subject: support only, never comps (core competingSet with no price band). */
async function contextListings(tx: Tx, conns: CmaConnections, s: ResolvedSubject): Promise<{ context: ContextListing[]; contextSentence: string }> {
  const live = conns.used.filter((u) => !u.stale).map((u) => u.conn.id);
  const zip = (s.address.postalCode ?? '').trim().slice(0, 5);
  if (zip === '' && !s.address.city) return { context: [], contextSentence: 'No active or pending listings were looked up: the area is not known.' };
  const zips = [...new Set([(s.address.postalCode ?? '').trim(), zip])].filter((z) => z !== '');
  const area = sql`(l.postal_code = ANY (${zips}::text[]) OR (l.city = ${s.address.city ?? ''} AND l.region = ${s.address.region ?? ''}))`;
  const rows = (
    await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.status = ANY (${['active', 'pending']}::text[]) AND ${area}
      AND (l.source = 'team' OR l.mls_connection_id = ANY (${live}::uuid[])) ORDER BY l.id LIMIT 500`.execute(tx)
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
  const sizeField = await connectionSizeField(tx, conns.used.map((u) => u.conn.id));
  const resolved = await resolveSubject(tx, i.subject, { contactId: i.contactId, sizeField });
  const valuationDate = localDateOf(now, zone) as string;
  const result = await run(tx, conns, resolved, valuationDate, i.include, i.exclude);
  // only listings that are near matches now may be dismissed (others are ignored)
  const near = new Set((await nearMatches(tx, resolved.addressKey, [])).map((m) => m.listingId));
  // include/exclude keep only ids this run read (a lease, a future sale or another tenant's id is never stored)
  const seen = new Set([...result.comps.map((c) => c.ref.id), ...result.notUsed.map((n) => n.ref.id)]);
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
      mlsDataAsOf: mlsDataAsOf(conns),
      subject,
      result,
      valueCents: result.valueCents,
      lowCents: result.lowCents,
      highCents: result.highCents,
      notes: i.notes,
      contentSha256: contentOf(subject, result, { ...i, inspectedOn: i.inspection === 'none' ? null : i.inspectedOn }),
    },
  };
}

async function assertContact(tx: Tx, contactId: string): Promise<void> {
  const c = await contactLive(tx, contactId);
  if (c === null) throw new AppError('NOT_FOUND');
  if (!c.live) throw new AppError('CONTACT_MERGED', c.mergedInto ? { mergedInto: c.mergedInto } : undefined);
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
  const { write } = await compute(tx, now, { subject: b.subject, contactId, purpose: b.purpose, inspection: b.inspection ?? 'none', inspectedOn: b.inspectedOn ?? null, notes: null, disclosure: NO_DISCLOSURE, include: [], exclude: [], nearMatchDismissed: [] });
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
  const open = await myOpenDraft(tx, contactId, addr.id);
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
  if (open && open.content_sha256 === write.contentSha256) {
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

export async function patch(tx: Tx, actor: UserActor, now: Instant, id: string, b: PatchBody): Promise<CmaView> {
  const row = await getCma(tx, id, { lock: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status !== 'draft') throw new AppError('CMA_NOT_DRAFT', { status: row.status });
  const s = row.subject as unknown as StoredSubject;
  const input: SubjectInput = b.subjectFacts === undefined ? s.input : ({ ...s.input, facts: { ...s.input.facts, ...b.subjectFacts } } as SubjectInput);
  const inspection = b.inspection ?? row.inspection;
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
  createdAt: string;
}

export async function listForContact(tx: Tx, actor: UserActor, contactId: string): Promise<CmaSummary[]> {
  const ids = await mergeTree(tx, contactId); // the contact and every record merged into it (merge moves no CMA)
  const rows = await cmasOfContacts(tx, ids);
  return rows.map((r) => {
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
  });
}

// ---- the view ----------------------------------------------------------------------------------

export type CmaView = Awaited<ReturnType<typeof viewOf>>;

async function viewOf(tx: Tx, actor: UserActor, now: Instant, row: CmaRow) {
  const s = row.subject as unknown as StoredSubject;
  const r = row.result as unknown as StoredResult;
  const zone = await zoneOf(tx);
  let share: ClientShare;
  let matches: NearMatch[];
  try {
    const conns = await agentGate(tx, now);
    const x = await clientReadiness(tx, {
      conns,
      now,
      state: s.resolved.state,
      addressKey: s.resolved.addressKey,
      addressLine: s.resolved.address.line1,
      subjectMlsListingId: s.resolved.mirrorListingId ?? (s.resolved.connectionId && s.resolved.listingId ? s.resolved.listingId : null),
      compSaleListingIds: r.comps.map((c) => r.saleListingIds[c.ref.id] ?? c.ref.id),
      nearMatchDismissed: s.nearMatchDismissed,
      hasValue: row.value_cents !== null,
    });
    share = x.share;
    matches = x.nearMatches;
  } catch (e) {
    // the feed was disconnected or its valuation use withdrawn after the CMA was prepared: the stored CMA stays readable,
    // and nothing may reach a client
    if (!(e instanceof AppError) || (e.code !== 'CMA_NO_MLS_CONNECTION' && e.code !== 'CMA_VALUATION_NOT_ALLOWED')) throw e;
    share = { allowed: false, blockers: [{ code: 'MLS_CLIENT_DISPLAY_OFF', sentence: String(e.details?.['sentence'] ?? '') }], estimateSentence: 'This is an estimate, not an appraisal.' };
    matches = [];
  }
  const facts = s.resolved.facts;
  const comp = (c: StoredResult['comps'][number]) => ({
    listingId: c.ref.id,
    saleListingId: r.saleListingIds[c.ref.id] ?? c.ref.id,
    sourceLabel: c.ref.source === 'team' ? ('Team' as const) : ('MLS' as const),
    mlsNumber: c.ref.mlsNumber,
    listingBrokerageName: c.ref.brokerage,
    address: { line1: c.ref.address.line1, line2: c.ref.address.line2, city: c.ref.address.city, region: c.ref.address.region, postalCode: c.ref.address.postalCode },
    closePriceCents: c.sale.closePriceCents,
    closeDate: c.sale.closeDate,
    contractDate: c.sale.contractDate,
    distanceMiles: c.distanceMiles,
    distanceSentence: c.distanceSentence,
    tier: c.tier,
    facts: { propertyType: c.sale.propertyType, sqft: c.sale.sqft, sizeSource: c.sale.sizeSource, beds: c.sale.beds, bathsX10: c.sale.bathsX10, yearBuilt: c.sale.yearBuilt, lotSqft: c.sale.lotSqft, daysOnMarket: c.sale.daysOnMarket, concessionsCents: c.sale.concessionsCents },
    adjustments: c.adjustments.map((a) => ({ feature: a.feature, amountCents: a.amountCents, sentence: a.sentence })),
    adjustedPriceCents: c.adjustedPriceCents,
    weightBps: c.weightBps,
    why: c.why,
    saleConditions: c.sale.saleConditions,
    includedByAgent: c.includedByAgent,
  });
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
    canEdit: row.status === 'draft' && row.created_by_user_id === actor.userId,
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
    result: { available: r.available, reason: r.reason, sentence: r.sentence, valueCents: r.valueCents, lowCents: r.lowCents, highCents: r.highCents },
    comps: r.comps.map(comp),
    notUsed: r.notUsed.map((n) => ({ listingId: n.ref.id, mlsNumber: n.ref.mlsNumber, address: [n.ref.address.line1, n.ref.address.line2].filter(Boolean).join(' ') + `, ${n.ref.address.city}`, reason: n.reason, sentence: n.sentence, includable: n.includable })),
    adjustmentRates: r.rates.map((x) => ({ feature: x.feature, adjusted: x.adjusted, centsPerUnit: x.centsPerUnit, unit: x.unit, support: x.support, sentence: x.sentence })),
    context: r.context,
    contextSentence: r.contextSentence,
    area: { tierUsed: r.area.tierUsed, tiers: r.area.tiers.map((t) => ({ tier: t.tier, ran: t.ran, count: t.count, limit: t.limit, limitReached: t.limitReached, sentence: t.sentence })) },
    market: r.market,
    backtest: r.backtest,
    nearMatches: matches,
    clientShare: share,
  };
}
