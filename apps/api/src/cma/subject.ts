// Subject resolution for a CMA (module 71; F4, F15, E365, E366, E373; R-MLS-5, R-CMA-2, R-CMA-8).
//
//   listing          a team listing: identity and descriptive facts from the team row; size from its MLS mirror when one
//                    exists (the team figure shown beside it as "agent-entered size"); without a mirror the team size is
//                    labelled 'agent' with the connection's size field. Other valuation facts from the mirror; where both
//                    rows have a value the team row wins (R-MLS-5). An MLS listing: every fact from its row.
//   contact_address  the address key, then every MLS record at it: facts from the newest record; its closed records are
//                    the sale history (shown, never comps: E365).
// R-CMA-6 (batch 10 review gates/F3): facts, sizes and sale prices come only from records of the connections the agent
// gate admits (`connectionIds`); a record of any other connection gives none (the team row's or the agent's facts take
// its place). Every connection is still read for the strict checks: the home's own identities (never comps, E365), the
// seller's MLS flag and near matches (E370, F2).
//   entered          the agent's facts (CmaSubjectFactsSchema, strict), each labelled 'agent'. Only propertyType and sqft
//                    are required (CMA_SUBJECT_INCOMPLETE otherwise); without coordinates only the subdivision, postal-code
//                    and city tiers run (E373).
// A contact or entered address with a street but no address key (its city, state or ZIP missing or unreadable) is
// refused with CMA_SUBJECT_INCOMPLETE naming the part: without the key the home's own sales could become comps (E365)
// and the seller-flag and near-match checks could not run (E370, F2). An address with no street is valued on its area
// alone, and readiness says the checks could not run (SUBJECT_ADDRESS_UNKNOWN).
// Every fact carries its source: mls, team or agent. Agent-entered facts (`facts` on any kind) fill gaps or replace a
// fact, and say so. Reads run under the caller's RLS (every member may read listings; an address the caller cannot see
// is 404).
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { CMA_SUPPORTED_TYPES, CmaSubjectSchema, type CmaPropertyType, type CmaSubject, type ListingRow, addressKey, factsOfRow, mlsRowsAtAddress, uspsCode } from './deps.js';
import { type AddressRow, addressOf, listingRow, mirrorsOf } from './repos.js';
import type { CmaSubjectFacts } from './schemas.js';

export type FactSource = 'mls' | 'team' | 'agent';
export interface Fact<T> {
  value: T | null;
  source: FactSource | null;
}

export type SubjectInput =
  | { kind: 'listing'; listingId: string; facts?: CmaSubjectFacts | undefined }
  | { kind: 'contact_address'; contactAddressId: string; facts?: CmaSubjectFacts | undefined }
  | { kind: 'entered'; anchor: Anchor; facts: CmaSubjectFacts };

export interface Anchor {
  line1?: string | null | undefined;
  line2?: string | null | undefined;
  city?: string | null | undefined;
  region: string;
  postalCode: string;
}

export interface SubjectAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
}

export interface SubjectFacts {
  propertyType: Fact<CmaPropertyType>;
  sqft: Fact<number>;
  agentEnteredSqft: number | null;
  beds: Fact<number>;
  bathsX10: Fact<number>;
  yearBuilt: Fact<number>;
  lotSqft: Fact<number>;
  garageSpacesX10: Fact<number>;
  storiesX10: Fact<number>;
  poolPrivate: Fact<boolean>;
  subdivision: Fact<string>;
  latE6: Fact<number>;
  lonE6: Fact<number>;
}

export interface SaleHistoryEntry {
  listingId: string;
  mlsNumber: string | null;
  status: string;
  closeDate: string | null;
  closePriceCents: number | null;
  listingBrokerageName: string | null;
}

export interface ResolvedSubject {
  kind: SubjectInput['kind'];
  listingId: string | null;
  contactAddressId: string | null;
  address: SubjectAddress;
  addressKey: string | null;
  state: string | null;
  facts: SubjectFacts;
  sizeSource: string | null;
  sizeSentence: string;
  /** stored facts left out because they are outside what the valuation reads, each said in one sentence */
  factSentences: string[];
  saleHistory: SaleHistoryEntry[];
  /** listing ids and MLS numbers that are the subject itself (never comps): its listing and mirrors first, then records at its key */
  selfListingIds: string[];
  selfMlsNumbers: string[];
  /** the subject listing's MLS mirror, of any connection (SELLER_WITHHELD reads its AVM flag) */
  mirrorListingId: string | null;
  /**
   * the subject's own MLS record whatever its connection: an MLS listing subject itself, or the team listing's mirror
   * (SELLER_WITHHELD reads its AVM flag: a strict check). Absent on a CMA stored before batch 10's review.
   */
  mlsRecordId?: string | null;
  /** the MLS connection whose record gave the facts, if any (only a connection the agent gate admits) */
  connectionId: string | null;
}

/** Owner question (g) default, held by the engine (core/valuation CMA_SUPPORTED_TYPES): land and 'other' are not valued in V1. */
export const SUPPORTED_TYPES: readonly CmaPropertyType[] = CMA_SUPPORTED_TYPES;

const none = <T>(): Fact<T> => ({ value: null, source: null });
const of = <T>(v: T | null | undefined, source: FactSource): Fact<T> => (v === null || v === undefined ? none<T>() : { value: v, source });
const pick = <T>(...xs: Fact<T>[]): Fact<T> => xs.find((x) => x.value !== null) ?? none<T>();

/** V1-B's strict subject schema, field by field: what the engine reads. */
const ENGINE_FIELD = CmaSubjectSchema.shape as unknown as Record<keyof CmaSubject, { safeParse(v: unknown): { success: boolean } }>;
const readable = (field: keyof CmaSubject, v: unknown) => ENGINE_FIELD[field].safeParse(v).success;

/** The stored facts the engine bounds (V1-A stores wider values: SMALLINT/INTEGER/bigint columns and unbounded text). */
const BOUNDED_FACTS: readonly { fact: 'sqft' | 'beds' | 'bathsX10' | 'yearBuilt' | 'lotSqft' | 'garageSpacesX10' | 'storiesX10' | 'subdivision'; field: keyof CmaSubject; words: string }[] = [
  { fact: 'sqft', field: 'sqft', words: 'size' },
  { fact: 'beds', field: 'beds', words: 'bedroom count' },
  { fact: 'bathsX10', field: 'bathsX10', words: 'bathroom count' },
  { fact: 'yearBuilt', field: 'yearBuilt', words: 'year built' },
  { fact: 'lotSqft', field: 'lotSqft', words: 'lot size' },
  { fact: 'garageSpacesX10', field: 'garageSpacesX10', words: 'garage spaces' },
  { fact: 'storiesX10', field: 'storiesX10', words: 'number of stories' },
  { fact: 'subdivision', field: 'subdivisionName', words: 'subdivision name' },
];
const WHOSE: Readonly<Record<FactSource, string>> = { mls: 'MLS record’s', team: 'team listing’s', agent: 'entered' };

/**
 * V1-B's strict subject bounds (R-CMA-2): a stored fact outside them would make the engine throw, so it is left out
 * and said, as a comp's record would be. The agent can enter a bounded value (CmaSubjectFactsSchema fits the engine).
 * A size left out leaves the subject without one: the caller asks for it (CMA_SUBJECT_INCOMPLETE). A subdivision name
 * is never shortened: a cut name would not match the subdivision's sales.
 */
function boundFacts(f: SubjectFacts): { facts: SubjectFacts; sentences: string[] } {
  const out: SubjectFacts = { ...f };
  const sentences: string[] = [];
  for (const b of BOUNDED_FACTS) {
    const cur = f[b.fact] as Fact<unknown>;
    if (cur.value === null || readable(b.field, cur.value)) continue;
    (out[b.fact] as Fact<unknown>) = none();
    sentences.push(`The ${WHOSE[cur.source ?? 'mls']} ${b.words} of this home is outside what the valuation reads, so it is not used. Enter it to use it.`);
  }
  if ((f.latE6.value !== null && !readable('latE6', f.latE6.value)) || (f.lonE6.value !== null && !readable('lonE6', f.lonE6.value))) {
    out.latE6 = none();
    out.lonE6 = none();
    sentences.push('The map location of this home is outside what the valuation reads, so the home is valued without it.');
  }
  return { facts: out, sentences };
}

const ADDRESS_WORDS: Readonly<Record<string, string>> = { city: 'city', region: 'state', postalCode: 'ZIP code', address: 'street address' };

/** The address parts the engine reads (city, state, ZIP code, address key) must fit its bounds; one that does not is refused, by name. */
function assertReadableAddress(a: SubjectAddress, region: string | null, key: string | null): void {
  const bad = [
    ...(a.city !== null && !readable('city', a.city) ? ['city'] : []),
    ...(region !== null && !readable('region', region) ? ['region'] : []),
    ...(a.postalCode !== null && !readable('postalCode', a.postalCode) ? ['postalCode'] : []),
    ...(key !== null && !readable('addressKey', key) ? ['address'] : []),
  ];
  if (bad.length === 0) return;
  throw new AppError('CMA_SUBJECT_INCOMPLETE', {
    missing: bad,
    sentence: `The home’s ${listed(bad.map((p) => ADDRESS_WORDS[p]!))} ${bad.length === 1 ? 'is' : 'are'} longer than the valuation reads. Correct the address to prepare a CMA.`,
  });
}

/** The subject facts of a listings row (V1-A factsOfRow: a team row carries no valuation facts, only the MLS sync writes them). */
function factsFromRow(r: ListingRow | null, src: FactSource): SubjectFacts {
  const f = r === null ? null : factsOfRow(r);
  const v = f?.valuation ?? null;
  return {
    propertyType: of(f?.propertyType, src),
    sqft: of(f?.sqft, src),
    agentEnteredSqft: null,
    beds: of(f?.beds, src),
    bathsX10: of(f?.bathsX10, src),
    yearBuilt: of(v?.yearBuilt, src),
    lotSqft: of(v?.lotSqft, src),
    garageSpacesX10: of(v?.garageSpacesX10, src),
    storiesX10: of(v?.storiesX10, src),
    poolPrivate: of(v?.poolPrivate, src),
    subdivision: of(v?.subdivisionName, src),
    latE6: of(v?.latitudeE6, src),
    lonE6: of(v?.longitudeE6, src),
  };
}

/** V1-A's address key of a subject address, or null when a part the key needs (street, city, state, ZIP) is missing. */
function keyOf(a: SubjectAddress): string | null {
  if (!a.line1 || !a.city || !a.region || !a.postalCode) return null;
  return addressKey({ line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postalCode });
}

const PART_WORDS: Readonly<Record<string, string>> = { city: 'city', region: 'state', postalCode: 'ZIP code' };
const listed = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * A street address the key cannot be built from is refused, naming what to add: without the key the home's own
 * earlier sales could be chosen as comps (E365) and the seller's MLS flag and near matches could not be checked (E370,
 * F2). The parts are only tested for presence here; V1-A's addressKey alone decides what a readable address is.
 */
function refuseUnkeyed(a: SubjectAddress): never {
  const parts = (['city', 'region', 'postalCode'] as const).filter((p) => !a[p]?.trim());
  throw new AppError('CMA_SUBJECT_INCOMPLETE', {
    missing: parts.length > 0 ? [...parts] : ['address'],
    sentence:
      parts.length > 0
        ? `Add the home’s ${listed(parts.map((p) => PART_WORDS[p]!))} to prepare a CMA: without it the address’s MLS history can’t be looked up.`
        : 'The home’s address could not be read as a street, city, state and 5-digit ZIP code, so its MLS history can’t be looked up. Correct the address to prepare a CMA.',
  });
}

/** Agent-entered facts replace the resolved ones they name (labelled 'agent'). */
function withAgentFacts(f: SubjectFacts, a: CmaSubjectFacts | undefined): SubjectFacts {
  if (!a) return f;
  const set = <T>(cur: Fact<T>, v: T | null | undefined): Fact<T> => (v === undefined ? cur : v === null ? none<T>() : { value: v, source: 'agent' });
  return {
    ...f,
    propertyType: set(f.propertyType, a.propertyType),
    sqft: set(f.sqft, a.sqft),
    agentEnteredSqft: a.sqft ?? f.agentEnteredSqft,
    beds: set(f.beds, a.beds),
    bathsX10: set(f.bathsX10, a.bathsX10),
    yearBuilt: set(f.yearBuilt, a.yearBuilt),
    lotSqft: set(f.lotSqft, a.lotSqft),
    garageSpacesX10: set(f.garageSpacesX10, a.garageSpacesX10),
    storiesX10: set(f.storiesX10, a.storiesX10),
    poolPrivate: set(f.poolPrivate, a.poolPrivate),
    subdivision: set(f.subdivision, a.subdivision),
  };
}

function history(rows: readonly ListingRow[]): SaleHistoryEntry[] {
  return rows
    .filter((r) => r.status === 'sold')
    .map((r) => {
      const v = factsOfRow(r).valuation;
      return { listingId: r.id, mlsNumber: r.mls_number, status: r.status, closeDate: v.closeDate, closePriceCents: v.closePriceCents, listingBrokerageName: r.listing_brokerage_name };
    })
    .sort((a, b) => ((b.closeDate ?? '') < (a.closeDate ?? '') ? -1 : (b.closeDate ?? '') > (a.closeDate ?? '') ? 1 : a.listingId < b.listingId ? -1 : 1));
}

/**
 * The size field of an MLS record that gives the subject's size (V3: sizes are compared like with like). A record
 * stored before size_source existed and not yet re-read by the backfill (mls_normalize_version 1) has sqft but no
 * field: it is taken as the connection's size field (normalize read sqft from the mapping's size field then too), and
 * the sentence says so. `lead` begins the sentence; `tail` goes before its full stop.
 */
function mlsSize(row: ListingRow, sizeField: string | null, lead: string, tail = ''): { sizeSource: string | null; sizeSentence: string } {
  if (row.size_source !== null) return { sizeSource: row.size_source, sizeSentence: `${lead} (${row.size_source})${tail}.` };
  return { sizeSource: sizeField, sizeSentence: `${lead}, taken as ${sizeField ?? 'the MLS feed’s size field'} (the record does not say which field it came from)${tail}.` };
}

function newest(rows: readonly ListingRow[]): ListingRow | null {
  return [...rows].sort((a, b) => (b.mls_modified_at?.getTime() ?? 0) - (a.mls_modified_at?.getTime() ?? 0) || (a.id < b.id ? -1 : 1))[0] ?? null;
}

/**
 * Resolves the subject. `sizeField` is the connection's size field (the RESO field the feed's sizes come from), used for
 * an agent-entered or team size (V3: every size comparison is like with like). `connectionIds` are the connections the
 * agent gate admits: only their records give facts and sale history (R-CMA-6).
 */
export async function resolveSubject(tx: Tx, input: SubjectInput, o: { contactId: string | null; sizeField: string | null; connectionIds: readonly string[] }): Promise<ResolvedSubject> {
  const admitted = (r: ListingRow | null): boolean => r !== null && r.mls_connection_id !== null && o.connectionIds.includes(r.mls_connection_id);
  let address: SubjectAddress;
  let facts: SubjectFacts;
  let sizeSource: string | null;
  let sizeSentence: string;
  let key: string | null;
  let rowsAtKey: ListingRow[] = [];
  let listingId: string | null = null;
  let contactAddressId: string | null = null;
  let mirrorListingId: string | null = null;
  let mlsRecordId: string | null = null;
  let connectionId: string | null = null;
  const self = new Set<string>();
  const selfNumbers = new Set<string>();
  // R-MLS-7: with no size field for the connection's sales (Spark: none is confirmed) the agent's size is said as theirs only
  const agentSize = o.sizeField === null ? 'Size entered by the agent.' : `Size entered by the agent, taken as ${o.sizeField} (the size your MLS reports).`;

  if (input.kind === 'listing') {
    const row = await listingRow(tx, input.listingId);
    if (!row) throw new AppError('NOT_FOUND');
    listingId = row.id;
    self.add(row.id);
    if (row.mls_number) selfNumbers.add(row.mls_number);
    address = { line1: row.address_line1, line2: row.address_line2, city: row.city, region: row.region, postalCode: row.postal_code };
    if (row.source === 'team') {
      const mirrors = await mirrorsOf(tx, row.id);
      for (const m of mirrors) {
        self.add(m.id);
        if (m.mls_number) selfNumbers.add(m.mls_number);
      }
      // the facts come from the newest mirror the agent gate admits; the strict checks read the newest of any connection
      const anyMirror = mirrors[0] ?? null;
      const mirror = mirrors.find((m) => admitted(m)) ?? null;
      const team = factsFromRow(row, 'team');
      const mls = factsFromRow(mirror, 'mls');
      // R-MLS-5: the team row wins where both have a value; the size is the mirror's (F4)
      facts = {
        propertyType: pick(team.propertyType, mls.propertyType),
        sqft: mirror?.sqft != null ? mls.sqft : of(row.sqft, 'agent'),
        agentEnteredSqft: row.sqft,
        beds: pick(team.beds, mls.beds),
        bathsX10: pick(team.bathsX10, mls.bathsX10),
        yearBuilt: pick(team.yearBuilt, mls.yearBuilt),
        lotSqft: pick(team.lotSqft, mls.lotSqft),
        garageSpacesX10: pick(team.garageSpacesX10, mls.garageSpacesX10),
        storiesX10: pick(team.storiesX10, mls.storiesX10),
        poolPrivate: pick(team.poolPrivate, mls.poolPrivate),
        subdivision: pick(team.subdivision, mls.subdivision),
        latE6: pick(team.latE6, mls.latE6),
        lonE6: pick(team.lonE6, mls.lonE6),
      };
      if (mirror?.sqft != null) {
        ({ sizeSource, sizeSentence } = mlsSize(mirror, o.sizeField, 'Size from the MLS record', row.sqft !== null && row.sqft !== mirror.sqft ? `; agent-entered size ${row.sqft} sq ft` : ''));
      } else {
        sizeSource = o.sizeField;
        sizeSentence = agentSize;
      }
      mirrorListingId = anyMirror?.id ?? null;
      mlsRecordId = anyMirror?.id ?? null;
      connectionId = mirror?.mls_connection_id ?? null;
      key = anyMirror?.address_key ?? keyOf(address);
    } else if (admitted(row)) {
      facts = factsFromRow(row, 'mls');
      if (row.sqft !== null) ({ sizeSource, sizeSentence } = mlsSize(row, o.sizeField, 'Size from the MLS record'));
      else {
        sizeSource = row.size_source;
        sizeSentence = 'Size not available from the MLS.';
      }
      mlsRecordId = row.id;
      connectionId = row.mls_connection_id;
      key = row.address_key ?? keyOf(address);
    } else {
      // an MLS listing of a connection the agent gate does not admit: the home by its address only (R-CMA-6)
      facts = factsFromRow(null, 'agent');
      sizeSource = o.sizeField;
      sizeSentence = agentSize;
      mlsRecordId = row.id;
      key = row.address_key ?? keyOf(address);
    }
    if (key) rowsAtKey = await mlsRowsAtAddress(tx, key);
  } else if (input.kind === 'contact_address') {
    if (o.contactId === null) throw new AppError('VALIDATION_FAILED', { reason: 'CONTACT_REQUIRED' });
    const a: AddressRow | null = await addressOf(tx, o.contactId, input.contactAddressId);
    if (!a) throw new AppError('NOT_FOUND');
    contactAddressId = a.id;
    address = { line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code };
    key = keyOf(address);
    if (key === null && address.line1?.trim()) refuseUnkeyed(address);
    rowsAtKey = key ? await mlsRowsAtAddress(tx, key) : [];
    const n = newest(rowsAtKey.filter(admitted));
    facts = factsFromRow(n, 'mls');
    if (n?.sqft != null) ({ sizeSource, sizeSentence } = mlsSize(n, o.sizeField, 'Size from the newest MLS record of this address'));
    else {
      sizeSource = o.sizeField;
      sizeSentence = agentSize;
    }
    connectionId = n?.mls_connection_id ?? null;
  } else {
    const an = input.anchor;
    address = { line1: an.line1 ?? null, line2: an.line2 ?? null, city: an.city ?? null, region: an.region, postalCode: an.postalCode };
    key = keyOf(address);
    if (key === null && address.line1?.trim()) refuseUnkeyed(address);
    rowsAtKey = key ? await mlsRowsAtAddress(tx, key) : [];
    facts = factsFromRow(null, 'agent');
    sizeSource = o.sizeField;
    sizeSentence = agentSize;
  }

  // the subject listing and its mirrors first (sorted), then the other records at its address key (sorted)
  const own = [...self].sort();
  const ownNumbers = [...selfNumbers].sort();
  const atKey = new Set<string>();
  const atKeyNumbers = new Set<string>();
  for (const r of rowsAtKey) {
    if (!self.has(r.id)) atKey.add(r.id);
    if (r.mls_number && !selfNumbers.has(r.mls_number)) atKeyNumbers.add(r.mls_number);
  }
  const state = address.region === null ? null : uspsCode(address.region);
  assertReadableAddress(address, state ?? address.region, key);
  const hadSize = facts.sqft.value !== null;
  // R-MLS-7: an admitted MLS record gave the facts but no size (the MLS has no confirmed size field, or none for it)
  const mlsGaveNoSize = connectionId !== null && !hadSize;
  facts = withAgentFacts(facts, input.facts);
  if (input.facts?.sqft !== undefined && (input.kind !== 'entered' || hadSize)) {
    sizeSource = o.sizeField ?? sizeSource;
    sizeSentence = agentSize;
  }
  // V1-B's strict bounds, after the agent's facts (which always fit) and before the required-fact checks, so a stored
  // size outside them asks for the size as a missing one does
  const storedSize = facts.sqft;
  const bounded = boundFacts(facts);
  facts = bounded.facts;
  const sizeLeftOut = storedSize.value !== null && facts.sqft.value === null;

  const missing = [...(facts.propertyType.value === null ? ['propertyType'] : []), ...(facts.sqft.value === null ? ['sqft'] : [])];
  if (missing.length > 0) {
    throw new AppError('CMA_SUBJECT_INCOMPLETE', {
      missing,
      // "not in the MLS history" only when the history was looked up (a key was built)
      sentence: sizeLeftOut
        ? `The ${WHOSE[storedSize.source ?? 'mls']} size of this home is outside what the valuation reads. Enter ${missing.length > 1 ? 'the property type and size' : 'the size'} to prepare a CMA.`
        : mlsGaveNoSize && missing.includes('sqft')
          ? `Size not available from the MLS for this home. Enter ${missing.length > 1 ? 'the property type and size' : 'the size'} to prepare a CMA.`
        : key === null
          ? input.kind === 'listing'
            ? 'Enter the property type and size to prepare a CMA.'
            : 'The home’s street address is not known, so its MLS history was not looked up. Enter the property type and size to prepare a CMA.'
          : rowsAtKey.length === 0
            ? 'This address is not in the MLS history. Enter the property type and size to prepare a CMA.'
            : !rowsAtKey.some(admitted)
              ? 'This address’s MLS records come from a feed whose licence pack does not record valuation use. Enter the property type and size to prepare a CMA.'
              : 'Enter the property type and size to prepare a CMA.',
    });
  }
  if (!SUPPORTED_TYPES.includes(facts.propertyType.value!)) {
    throw new AppError('CMA_SUBJECT_TYPE_NOT_SUPPORTED', { propertyType: facts.propertyType.value, sentence: 'Land and other property types are not valued yet: CMAs cover homes only for now.' });
  }

  return {
    kind: input.kind,
    listingId,
    contactAddressId,
    address,
    addressKey: key,
    state,
    facts,
    sizeSource,
    sizeSentence,
    factSentences: bounded.sentences,
    saleHistory: history(rowsAtKey.filter(admitted)),
    selfListingIds: [...own, ...[...atKey].sort()],
    selfMlsNumbers: [...ownNumbers, ...[...atKeyNumbers].sort()],
    mirrorListingId,
    mlsRecordId,
    connectionId,
  };
}

/** V1-B's subject schema holds at most this many own identities and MLS numbers. */
const MAX_OWN = 100;

/**
 * The engine's view of the subject (property and location facts only; V1-B CmaSubject). The region is the USPS code
 * when known, as V1-A stores an MLS row's StateOrProvince (upper case), so the city tier compares like with like. The
 * subject's own listing and its mirrors come first in ownIdentities; records found only at the address key follow
 * (the engine also knows them by the address key, so the cap never lets one become a comp).
 */
export function engineSubject(s: ResolvedSubject): CmaSubject {
  const located = s.facts.latE6.value !== null && s.facts.lonE6.value !== null;
  return {
    propertyType: s.facts.propertyType.value,
    sqft: s.facts.sqft.value,
    sizeSource: s.sizeSource,
    beds: s.facts.beds.value,
    bathsX10: s.facts.bathsX10.value,
    yearBuilt: s.facts.yearBuilt.value,
    lotSqft: s.facts.lotSqft.value,
    garageSpacesX10: s.facts.garageSpacesX10.value,
    poolPrivate: s.facts.poolPrivate.value,
    storiesX10: s.facts.storiesX10.value,
    latE6: located ? s.facts.latE6.value : null,
    lonE6: located ? s.facts.lonE6.value : null,
    postalCode: s.address.postalCode,
    city: s.address.city,
    region: s.state ?? s.address.region,
    subdivisionName: s.facts.subdivision.value,
    addressKey: s.addressKey,
    ownIdentities: s.selfListingIds.slice(0, MAX_OWN),
    // an MLS number longer than the engine reads cannot name a candidate either (CmaRef has the same bound)
    ownMlsNumbers: s.selfMlsNumbers.filter((n) => readable('ownMlsNumbers', [n])).slice(0, MAX_OWN),
  };
}
