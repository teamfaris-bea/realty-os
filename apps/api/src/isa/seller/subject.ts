// The seller's home (R-ISA-18, R-ISA-26; E536, E538; docs/AI_ISA.md §6.3 "The subject"). Resolved exactly as V1-C
// resolves a contact-address subject: the default address (property, else home, newest; owner question 5), then
// resolveSubject with no agent facts. The record is the newest MLS row at the address key among the connections the
// agent gate admits; its connection and facts must be the ones resolveSubject took, else SUBJECT_CHANGED. The record
// is shown only through the client rendering (clientView, or clientSoldView with the team row for a sold mirror), so
// the display rules cover the seller's own record (VERIFY WITH MLS). Nothing here calls the comps pipeline.
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { type Instant, instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../../errors.js';
import { type ListingRow, addressKey, clientRendering, connectionSizeField, defaultAddress, listingRows, mlsEligibility, mlsRowsAtAddress, newest, readinessConnections, resolveSubject } from './cmaSeam.js';

/** Owner question 6 default: a newest record older than this is SUBJECT_RECORD_OLD. VERIFY. */
export const SUBJECT_RECORD_MAX_YEARS = 10;

export type SubjectState = 'ok' | 'no_address' | 'no_mls_connection' | 'not_in_mls' | 'incomplete' | 'type_not_supported' | 'record_old' | 'not_displayable' | 'changed';

export const SUBJECT_SENTENCES: Readonly<Record<SubjectState, { code: string | null; sentence: string; nextStep: string | null }>> = Object.freeze({
  ok: { code: null, sentence: 'The home’s MLS record was found.', nextStep: 'Confirm this is the home they’re selling' },
  no_address: { code: 'SUBJECT_INCOMPLETE', sentence: 'Add the home’s address (a property or home address) so the assistant can find its MLS record.', nextStep: 'Add the home’s address' },
  no_mls_connection: { code: 'SUBJECT_NOT_IN_MLS', sentence: 'No MLS feed whose licence pack records valuation use is connected, so the home’s record could not be looked up.', nextStep: null },
  not_in_mls: { code: 'SUBJECT_NOT_IN_MLS', sentence: 'This home is not in the MLS history, so the assistant shares no recent sales.', nextStep: 'Prepare a CMA (enter type and size)' },
  incomplete: { code: 'SUBJECT_INCOMPLETE', sentence: 'The home’s MLS record lacks its property type, bedrooms or size, so the assistant shares no recent sales.', nextStep: 'Prepare a CMA (enter type and size)' },
  type_not_supported: { code: 'CMA_SUBJECT_TYPE_NOT_SUPPORTED', sentence: 'Land and other property types are not compared yet.', nextStep: null },
  record_old: { code: 'SUBJECT_RECORD_OLD', sentence: `The home’s newest MLS record is more than ${SUBJECT_RECORD_MAX_YEARS} years old, so the assistant shares no recent sales.`, nextStep: 'Prepare a CMA (enter type and size)' },
  not_displayable: { code: 'SUBJECT_INCOMPLETE', sentence: 'The home’s bedrooms or size cannot be shown to clients under your MLS licence, so the assistant shares no recent sales.', nextStep: 'Prepare a CMA (enter type and size)' },
  changed: { code: 'SUBJECT_CHANGED', sentence: 'The home’s MLS record changed since it was looked up. Confirm it again.', nextStep: 'Confirm this is the home they’re selling' },
});

/** The confirmed facts, in the watch's subject_facts shape (CHECK keys: type, beds, baths_x10, sqft). */
export interface SubjectFactsRow {
  type: string;
  beds: number;
  baths_x10: number | null;
  sqft: number;
}

export interface SellerSubject {
  state: SubjectState;
  code: string | null;
  sentence: string;
  nextStep: string | null;
  contactAddressId: string | null;
  addressKey: string | null;
  /** the address as the agent sees it (never sent to a client from here) */
  addressLine: string | null;
  record: { listingId: string; connectionId: string; modifiedAt: Instant | null } | null;
  facts: SubjectFactsRow | null;
  /** sha256 of the address id, key, record id, connection and facts: the confirm route's freshness check */
  factsSha256: string | null;
}

const ms = (y: number) => y * 365.25 * 86_400_000;

function of(state: SubjectState, o: Partial<SellerSubject> = {}): SellerSubject {
  const s = SUBJECT_SENTENCES[state];
  return { state, code: s.code, sentence: s.sentence, nextStep: s.nextStep, contactAddressId: null, addressKey: null, addressLine: null, record: null, facts: null, factsSha256: null, ...o };
}

export function subjectHash(x: Pick<SellerSubject, 'contactAddressId' | 'addressKey' | 'record' | 'facts'>): string {
  return sha256Hex(canonicalJson({ a: x.contactAddressId, k: x.addressKey, r: x.record?.listingId ?? null, c: x.record?.connectionId ?? null, f: x.facts }));
}

/** The seller's home now, read in `tx` as the caller (a user under RLS, or the system). */
export async function currentSubjectInTx(tx: Tx, contactId: string, now: Instant): Promise<SellerSubject> {
  const addr = await defaultAddress(tx, contactId);
  if (addr === null) return of('no_address');
  const key = addr.line1 && addr.city && addr.region && addr.postal_code ? addressKey({ line1: addr.line1, line2: addr.line2, city: addr.city, region: addr.region, postalCode: addr.postal_code }) : null;
  const line = [addr.line1, addr.line2].filter(Boolean).join(' ') + (addr.city ? `, ${addr.city}` : '');
  const base: Partial<SellerSubject> = { contactAddressId: addr.id, addressKey: key, addressLine: line };
  if (key === null) return of('no_address', base);
  const conns = await readinessConnections(tx, now);
  const ids = conns.used.map((u) => u.conn.id);
  if (ids.length === 0) return of('no_mls_connection', base);
  const rows = (await mlsRowsAtAddress(tx, key)).filter((r) => r.mls_connection_id !== null && ids.includes(r.mls_connection_id));
  const rec = newest(rows);
  if (rec === null) return of('not_in_mls', base);
  let resolved;
  try {
    resolved = await resolveSubject(tx, { kind: 'contact_address', contactAddressId: addr.id }, { contactId, sizeField: await connectionSizeField(tx, ids), connectionIds: ids });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CMA_SUBJECT_TYPE_NOT_SUPPORTED') return of('type_not_supported', base);
    if (e instanceof AppError && (e.code === 'CMA_SUBJECT_INCOMPLETE' || e.code === 'NOT_FOUND')) return of('incomplete', base);
    throw e;
  }
  const record = { listingId: rec.id, connectionId: rec.mls_connection_id!, modifiedAt: rec.mls_modified_at ? instantFromDate(rec.mls_modified_at) : null };
  // the record's facts must be the ones resolveSubject took (same connection, same values)
  const f = resolved.facts;
  if (resolved.connectionId !== rec.mls_connection_id || f.sqft.value !== rec.sqft || f.beds.value !== rec.beds) return of('changed', { ...base, record });
  if (f.beds.value === null || f.sqft.value === null || f.propertyType.value === null) return of('incomplete', { ...base, record });
  if (record.modifiedAt === null || now - record.modifiedAt > ms(SUBJECT_RECORD_MAX_YEARS)) return of('record_old', { ...base, record });
  // R-ISA-18: shown only through the client rendering (a sold mirror through clientSoldView with its team row)
  const e = await mlsEligibility(tx, now);
  const team = rec.team_listing_id !== null && rec.status === 'sold' ? ((await listingRows(tx, [rec.team_listing_id]))[0] ?? null) : null;
  const d = clientRendering(e, rec, team);
  if (d === null || d.beds === undefined || d.beds === null || d.sqft === undefined || d.sqft === null) return of('not_displayable', { ...base, record });
  const facts: SubjectFactsRow = { type: f.propertyType.value, beds: f.beds.value, baths_x10: f.bathsX10.value, sqft: f.sqft.value };
  const out = of('ok', { ...base, record, facts });
  return { ...out, factsSha256: subjectHash(out) };
}

/** The watch row's subject columns. */
export interface WatchRow {
  assignment_id: string;
  contact_id: string;
  contact_address_id: string | null;
  subject_address_key: string | null;
  subject_connection_id: string | null;
  subject_record_listing_id: string | null;
  subject_record_date: Date | null;
  subject_facts: SubjectFactsRow | null;
  subject_confirmed_by_user_id: string | null;
  subject_confirmed_at: Date | null;
  subject_disputed_at: Date | null;
  subject_cleared_reason: string | null;
  near_match_dismissed: string[];
  last_snapshot: Record<string, unknown>;
  snapshot_versions: Record<string, unknown>;
  last_comps_check: { codes: string[]; comp_set_hash?: string; checked_at: string } | null;
  comps_suspended_at: Date | null;
  comps_resumed_at: Date | null;
  comps_resumed_reason: string | null;
  last_run_at: Date | null;
}

export async function watchOf(tx: Tx, assignmentId: string, lock = false): Promise<WatchRow | null> {
  const r = await sql<WatchRow>`SELECT assignment_id, contact_id, contact_address_id, subject_address_key, subject_connection_id, subject_record_listing_id,
      subject_record_date, subject_facts, subject_confirmed_by_user_id, subject_confirmed_at, subject_disputed_at, subject_cleared_reason,
      near_match_dismissed, last_snapshot, snapshot_versions, last_comps_check, comps_suspended_at, comps_resumed_at, comps_resumed_reason, last_run_at
    FROM ai_isa_seller_watch WHERE tenant_id = app.tenant_id() AND assignment_id = ${assignmentId}${lock ? sql` FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

/** The watch row of a seller-side assignment, created empty by the system on first use. */
export async function ensureWatchInTx(tx: Tx, a: { id: string; contactId: string }): Promise<void> {
  const addr = await defaultAddress(tx, a.contactId);
  await sql`INSERT INTO ai_isa_seller_watch (tenant_id, assignment_id, contact_id, contact_address_id)
    VALUES (app.tenant_id(), ${a.id}, ${a.contactId}, ${addr?.id ?? null}) ON CONFLICT (tenant_id, assignment_id) DO NOTHING`.execute(tx);
}

/**
 * The read-time check (E536): a confirmed subject whose stored address (still the default), key, record and facts
 * equal the current ones. Codes: SUBJECT_UNCONFIRMED, SUBJECT_DISPUTED, SUBJECT_CHANGED, or the current state's code.
 */
export function confirmationCodes(w: WatchRow | null, cur: SellerSubject): string[] {
  if (w === null || w.subject_confirmed_at === null) return cur.state === 'ok' ? ['SUBJECT_UNCONFIRMED'] : [cur.code ?? 'SUBJECT_UNCONFIRMED', 'SUBJECT_UNCONFIRMED'];
  if (w.subject_disputed_at !== null) return ['SUBJECT_DISPUTED'];
  if (cur.state !== 'ok') return [cur.code ?? 'SUBJECT_CHANGED'];
  const same =
    w.contact_address_id === cur.contactAddressId &&
    w.subject_address_key === cur.addressKey &&
    w.subject_record_listing_id === cur.record!.listingId &&
    w.subject_connection_id === cur.record!.connectionId &&
    canonicalJson(w.subject_facts) === canonicalJson(cur.facts);
  return same ? [] : ['SUBJECT_CHANGED'];
}

export type { ListingRow };
