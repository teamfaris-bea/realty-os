// Subject resolution for a CMA (module 71; F4, F15, E365, E366, E373; R-MLS-5, R-CMA-2, R-CMA-8).
//
//   listing          a team listing: identity and descriptive facts from the team row; size from its MLS mirror when one
//                    exists (the team figure shown beside it as "agent-entered size"); without a mirror the team size is
//                    labelled 'agent' with the connection's size field. Other valuation facts from the mirror; where both
//                    rows have a value the team row wins (R-MLS-5). An MLS listing: every fact from its row.
//   contact_address  the address key, then every MLS record at it: facts from the newest record; its closed records are
//                    the sale history (shown, never comps: E365).
//   entered          the agent's facts (CmaSubjectFactsSchema, strict), each labelled 'agent'. Only propertyType and sqft
//                    are required (CMA_SUBJECT_INCOMPLETE otherwise); without coordinates only the subdivision, postal-code
//                    and city tiers run (E373).
// Every fact carries its source: mls, team or agent. Agent-entered facts (`facts` on any kind) fill gaps or replace a
// fact, and say so. Reads run under the caller's RLS (every member may read listings; an address the caller cannot see
// is 404).
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { type CmaPropertyType, type CmaSubject, type CmaSubjectFacts, type ValuationRow, addressKey, listingRow, mirrorsOf, mlsRowsAtAddress, uspsState } from './deps.js';
import { type AddressRow, addressOf } from './repos.js';

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
  saleHistory: SaleHistoryEntry[];
  /** listing ids and MLS numbers that are the subject itself (never comps) */
  selfListingIds: string[];
  selfMlsNumbers: string[];
  /** the subject listing's MLS mirror (SELLER_WITHHELD reads its AVM flag) */
  mirrorListingId: string | null;
  /** the MLS connection whose record gave the facts, if any */
  connectionId: string | null;
}

/** Owner question (g) default: land is not valued in V1. One branch: */
export const UNSUPPORTED_TYPES: readonly CmaPropertyType[] = ['land'];

const none = <T>(): Fact<T> => ({ value: null, source: null });
const of = <T>(v: T | null | undefined, source: FactSource): Fact<T> => (v === null || v === undefined ? none<T>() : { value: v, source });
const pick = <T>(...xs: Fact<T>[]): Fact<T> => xs.find((x) => x.value !== null) ?? none<T>();
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const day = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

function factsFromRow(r: ValuationRow | null, src: FactSource): SubjectFacts {
  return {
    propertyType: of(r?.property_type as CmaPropertyType | null, src),
    sqft: of(r?.sqft, src),
    agentEnteredSqft: null,
    beds: of(r?.beds, src),
    bathsX10: of(r?.baths_x10, src),
    yearBuilt: of(r?.year_built, src),
    lotSqft: of(r ? num(r.lot_sqft) : null, src),
    garageSpacesX10: of(r?.garage_spaces_x10, src),
    storiesX10: of(r?.stories_x10, src),
    poolPrivate: of(r?.pool_private, src),
    subdivision: of(r?.subdivision_name, src),
    latE6: of(r?.latitude_e6, src),
    lonE6: of(r?.longitude_e6, src),
  };
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

function history(rows: readonly ValuationRow[]): SaleHistoryEntry[] {
  return rows
    .filter((r) => r.status === 'sold')
    .map((r) => ({ listingId: r.id, mlsNumber: r.mls_number, status: r.status, closeDate: day(r.close_date), closePriceCents: num(r.close_price_cents), listingBrokerageName: r.listing_brokerage_name }))
    .sort((a, b) => ((b.closeDate ?? '') < (a.closeDate ?? '') ? -1 : (b.closeDate ?? '') > (a.closeDate ?? '') ? 1 : a.listingId < b.listingId ? -1 : 1));
}

function newest(rows: readonly ValuationRow[]): ValuationRow | null {
  return [...rows].sort((a, b) => (b.mls_modified_at?.getTime() ?? 0) - (a.mls_modified_at?.getTime() ?? 0) || (a.id < b.id ? -1 : 1))[0] ?? null;
}

/**
 * Resolves the subject. `sizeField` is the connection's size field (the RESO field the feed's sizes come from), used for
 * an agent-entered or team size (V3: every size comparison is like with like).
 */
export async function resolveSubject(tx: Tx, input: SubjectInput, o: { contactId: string | null; sizeField: string | null }): Promise<ResolvedSubject> {
  let address: SubjectAddress;
  let facts: SubjectFacts;
  let sizeSource: string | null = null;
  let sizeSentence: string;
  let key: string | null;
  let rowsAtKey: ValuationRow[] = [];
  let listingId: string | null = null;
  let contactAddressId: string | null = null;
  let mirrorListingId: string | null = null;
  let connectionId: string | null = null;
  const self = new Set<string>();
  const selfNumbers = new Set<string>();
  const agentSize = `Size entered by the agent, taken as ${o.sizeField ?? 'the MLS feed’s size field'} (the size your MLS reports).`;

  if (input.kind === 'listing') {
    const row = await listingRow(tx, input.listingId);
    if (!row) throw new AppError('NOT_FOUND');
    listingId = row.id;
    self.add(row.id);
    if (row.mls_number) selfNumbers.add(row.mls_number);
    address = { line1: row.address_line1, line2: row.address_line2, city: row.city, region: row.region, postalCode: row.postal_code };
    if (row.source === 'team') {
      const mirror = (await mirrorsOf(tx, row.id))[0] ?? null;
      for (const m of await mirrorsOf(tx, row.id)) {
        self.add(m.id);
        if (m.mls_number) selfNumbers.add(m.mls_number);
      }
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
        sizeSource = mirror.size_source;
        sizeSentence = `Size from the MLS record${mirror.size_source ? ` (${mirror.size_source})` : ''}${row.sqft !== null && row.sqft !== mirror.sqft ? `; agent-entered size ${row.sqft} sq ft` : ''}.`;
      } else {
        sizeSource = o.sizeField;
        sizeSentence = agentSize;
      }
      mirrorListingId = mirror?.id ?? null;
      connectionId = mirror?.mls_connection_id ?? null;
      key = mirror?.address_key ?? addressKey(address);
    } else {
      facts = factsFromRow(row, 'mls');
      sizeSource = row.size_source;
      sizeSentence = `Size from the MLS record${row.size_source ? ` (${row.size_source})` : ''}.`;
      connectionId = row.mls_connection_id;
      key = row.address_key ?? addressKey(address);
    }
    if (key) rowsAtKey = await mlsRowsAtAddress(tx, key);
  } else if (input.kind === 'contact_address') {
    if (o.contactId === null) throw new AppError('VALIDATION_FAILED', { reason: 'CONTACT_REQUIRED' });
    const a: AddressRow | null = await addressOf(tx, o.contactId, input.contactAddressId);
    if (!a) throw new AppError('NOT_FOUND');
    contactAddressId = a.id;
    address = { line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code };
    key = addressKey(address);
    rowsAtKey = key ? await mlsRowsAtAddress(tx, key) : [];
    const n = newest(rowsAtKey);
    facts = factsFromRow(n, 'mls');
    sizeSource = n?.sqft != null ? n.size_source : o.sizeField;
    sizeSentence = n?.sqft != null ? `Size from the newest MLS record of this address${n.size_source ? ` (${n.size_source})` : ''}.` : agentSize;
    connectionId = n?.mls_connection_id ?? null;
  } else {
    const an = input.anchor;
    address = { line1: an.line1 ?? null, line2: an.line2 ?? null, city: an.city ?? null, region: an.region, postalCode: an.postalCode };
    key = addressKey(address);
    rowsAtKey = key ? await mlsRowsAtAddress(tx, key) : [];
    facts = factsFromRow(null, 'agent');
    sizeSource = o.sizeField;
    sizeSentence = agentSize;
  }

  for (const r of rowsAtKey) {
    self.add(r.id);
    if (r.mls_number) selfNumbers.add(r.mls_number);
  }
  const hadSize = facts.sqft.value !== null;
  facts = withAgentFacts(facts, input.facts);
  if (input.facts?.sqft !== undefined && (input.kind !== 'entered' || hadSize)) {
    sizeSource = o.sizeField ?? sizeSource;
    sizeSentence = agentSize;
  }

  const missing = [...(facts.propertyType.value === null ? ['propertyType'] : []), ...(facts.sqft.value === null ? ['sqft'] : [])];
  if (missing.length > 0) {
    throw new AppError('CMA_SUBJECT_INCOMPLETE', {
      missing,
      sentence: rowsAtKey.length === 0 ? 'This address is not in the MLS history. Enter the property type and size to prepare a CMA.' : 'Enter the property type and size to prepare a CMA.',
    });
  }
  if (UNSUPPORTED_TYPES.includes(facts.propertyType.value!)) {
    throw new AppError('CMA_SUBJECT_TYPE_NOT_SUPPORTED', { propertyType: facts.propertyType.value, sentence: 'Land is not valued yet: CMAs cover homes only for now.' });
  }

  return {
    kind: input.kind,
    listingId,
    contactAddressId,
    address,
    addressKey: key,
    state: uspsState(address.region),
    facts,
    sizeSource,
    sizeSentence,
    saleHistory: history(rowsAtKey),
    selfListingIds: [...self].sort(),
    selfMlsNumbers: [...selfNumbers].sort(),
    mirrorListingId,
    connectionId,
  };
}

/** The engine's view of the subject (property and location facts only). */
export function engineSubject(s: ResolvedSubject): CmaSubject {
  return {
    propertyType: s.facts.propertyType.value!,
    sqft: s.facts.sqft.value!,
    sizeSource: s.sizeSource,
    beds: s.facts.beds.value,
    bathsX10: s.facts.bathsX10.value,
    yearBuilt: s.facts.yearBuilt.value,
    lotSqft: s.facts.lotSqft.value,
    garageSpacesX10: s.facts.garageSpacesX10.value,
    storiesX10: s.facts.storiesX10.value,
    poolPrivate: s.facts.poolPrivate.value,
    latE6: s.facts.latE6.value !== null && s.facts.lonE6.value !== null ? s.facts.latE6.value : null,
    lonE6: s.facts.latE6.value !== null && s.facts.lonE6.value !== null ? s.facts.lonE6.value : null,
    subdivision: s.facts.subdivision.value,
    postalCode: s.address.postalCode,
    city: s.address.city,
    region: s.address.region,
    addressKey: s.addressKey,
    listingIds: s.selfListingIds,
    mlsNumbers: s.selfMlsNumbers,
  };
}
