// The seller gates (R-ISA-18, R-ISA-26; E534-E538; docs/AI_ISA.md §6.3). Codes only, never content.
//
//   sellerGatesInTx(kind)  every kind: a seller- or both-side live assignment; the capability in effect; a confirmed,
//                          unchanged, undisputed subject; the owner's cma.prepare on behalf (canAsRole, E538); a
//                          client-eligible MLS connection. Comps also: no pricing suspension (E502) and a bound email.
//                          The readiness blockers and the ceilings need the pipeline, so comps.ts checks them.
//   subjectLinkInTx        link 10 "Seller home" (§3.1): a live team listing or mirror at the key ends care
//                          (active_client); another live MLS row at the key ends it (listed_elsewhere); an undismissed
//                          live near match pauses it (possible_listing). Near matches stay blocking for comps (R-CMA-7).
import { type Instant, type Role, type SystemActor, type UserActor, can, canAsRole, isRole } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type ListingRow, LISTING_COLS, addressKey, defaultAddress, liveNearMatches, mlsEligibility, mlsRowsAtAddress, nearMatches, streetOfKey } from './cmaSeam.js';
import { type AssignmentRow, capabilitySet, contextFor } from './isa2Seam.js';
import { type SellerSubject, type WatchRow, confirmationCodes, currentSubjectInTx, watchOf } from './subject.js';

export type SellerKind = 'competition' | 'comps' | 'count';

/** The policy and opt-in capability each kind needs (core ISA_CAPABILITIES). */
export const KIND_CAPABILITY: Readonly<Record<SellerKind, string>> = Object.freeze({ competition: 'seller_competition', comps: 'seller_sold_comps', count: 'seller_competition' });

export interface SellerGates {
  codes: string[];
  subject: SellerSubject;
  watch: WatchRow | null;
}

const LIVE: readonly string[] = ['coming_soon', 'active', 'pending'];

/** Whether the owner, as a member now, may prepare a CMA for the contact (E538: demoted to isa, suspended). */
export async function ownerHoldsCmaPrepare(tx: Tx, a: Pick<AssignmentRow, 'ownerUserId' | 'contactId'>): Promise<boolean> {
  const m = (
    await sql<{ role: string; active: boolean; own: boolean }>`SELECT m.role, m.status = 'active' AS active,
        EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${a.contactId}::uuid AND c.owner_user_id = m.user_id) AS own
      FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${a.ownerUserId}::uuid`.execute(tx)
  ).rows[0];
  const role: Role | null = m && isRole(m.role) ? m.role : null;
  return m !== undefined && m.active && role !== null && canAsRole(role, 'cma.prepare', { own: m.own }).ok;
}

/** Whether comps are suspended now (E502): a pricing hold after the last resume. */
export function compsSuspended(w: Pick<WatchRow, 'comps_suspended_at' | 'comps_resumed_at'> | null): boolean {
  if (w === null || w.comps_suspended_at === null) return false;
  return w.comps_resumed_at === null || w.comps_resumed_at.getTime() < w.comps_suspended_at.getTime();
}

/**
 * E502 and owner question 10: a suspension clears only on the owner's own CMA for the contact created or re-run after
 * it (an unchanged re-tap stores nothing, cma/service.ts oneTap), a CMA shared after it (V2-A), or the owner's
 * resume-comps. A generic resolve does not clear it. The system records the CMA resume; a user's read only computes it.
 */
export async function compsSuspendedNowInTx(tx: Tx, actor: SystemActor | UserActor, a: Pick<AssignmentRow, 'id' | 'contactId' | 'ownerUserId'>, w: WatchRow | null): Promise<boolean> {
  if (!compsSuspended(w)) return false;
  const r = (await sql<{ prepared: boolean; shared: boolean }>`SELECT
      EXISTS (SELECT 1 FROM cma_reports c WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${a.contactId} AND c.created_by_user_id = ${a.ownerUserId}
                AND GREATEST(c.created_at, c.updated_at) > ${w!.comps_suspended_at}) AS prepared,
      EXISTS (SELECT 1 FROM cma_reports c WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${a.contactId} AND c.shared_at > ${w!.comps_suspended_at}) AS shared`.execute(tx)).rows[0]!;
  const reason = r.shared ? 'cma_shared' : r.prepared ? 'cma_prepared' : null;
  if (reason === null) return true;
  if (actor.kind === 'system') {
    await sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_reason = ${reason}, comps_resumed_by_user_id = ${a.ownerUserId}
      WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
  }
  return false;
}

export async function sellerGatesInTx(tx: Tx, actor: SystemActor | UserActor, a: AssignmentRow, now: Instant, kind: SellerKind): Promise<SellerGates> {
  const codes: string[] = [];
  const subject = await currentSubjectInTx(tx, a.contactId, now);
  const watch = await watchOf(tx, a.id);
  if (actor.kind === 'system' && !can(actor, 'ai_isa.seller_facts', { tenantId: actor.tenantId }).ok) codes.push('SELLER_FACTS_NOT_ALLOWED');
  if (a.endedAt !== null || (a.side !== 'seller' && a.side !== 'both')) codes.push('SUBJECT_NOT_SELLER');
  const ctx = await contextFor(tx, a, now);
  const optIn = (await sql<{ c: string[] }>`SELECT capabilities AS c FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND id = ${a.optinId}`.execute(tx)).rows[0]?.c ?? [];
  if (!capabilitySet(ctx.content, optIn).has(KIND_CAPABILITY[kind])) codes.push('CAPABILITY_NOT_AVAILABLE');
  codes.push(...confirmationCodes(watch, subject));
  if (!(await ownerHoldsCmaPrepare(tx, a))) codes.push('CMA_SCOPE_LOST');
  const e = await mlsEligibility(tx, now);
  if (e.clientIds.length === 0) codes.push('MLS_CLIENT_DISPLAY_OFF');
  if (kind === 'comps') {
    if (await compsSuspendedNowInTx(tx, actor, a, watch)) codes.push('COMPS_SUSPENDED');
    if (a.boundPoints.email === undefined) codes.push('NO_BOUND_EMAIL');
  }
  return { codes: [...new Set(codes)], subject, watch };
}

export interface SubjectLink {
  effect: 'ok' | 'pause' | 'end';
  code: string | null;
  reason: 'active_client' | 'listed_elsewhere' | 'possible_listing' | null;
  sentence: string;
  listingIds: string[];
}

export const LINK_SENTENCES = Object.freeze({
  ok: 'No live listing of the seller’s home.',
  active_client: 'The seller’s home is listed by your team, so they are a client now. AI care ended.',
  listed_elsewhere: 'The seller’s home is listed in the MLS by another brokerage. AI care ended.',
  possible_listing: 'Possibly listed: confirm it’s a different home, then resume.',
});

const keyOfRow = (r: ListingRow): string | null => r.address_key ?? addressKey({ line1: r.address_line1, line2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code });

/** Live team listings at the key (team rows carry no stored key; read by postal code, keyed here). */
async function liveTeamAtKey(tx: Tx, key: string, postalCode: string | null): Promise<ListingRow[]> {
  if (postalCode === null) return [];
  const zip = postalCode.trim().slice(0, 5);
  const rows = (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'team'
      AND l.status = ANY (${[...LIVE]}::text[]) AND left(l.postal_code, 5) = ${zip} ORDER BY l.id LIMIT 500`.execute(tx)).rows;
  return rows.filter((r) => keyOfRow(r) === key);
}

/**
 * Link 10 "Seller home" (R-ISA-26; E538). `key` is the subject's address key (the confirmed one, else the default
 * address's); `dismissed` the owner's "different home" answers, which lift only the pause.
 */
export async function subjectLinkInTx(tx: Tx, key: string | null, postalCode: string | null, dismissed: readonly string[]): Promise<SubjectLink> {
  if (key === null) return { effect: 'ok', code: null, reason: null, sentence: LINK_SENTENCES.ok, listingIds: [] };
  const team = await liveTeamAtKey(tx, key, postalCode);
  const atKey = (await mlsRowsAtAddress(tx, key)).filter((r) => LIVE.includes(r.status));
  const street = streetOfKey(key);
  const onStreet = street === null ? [] : await liveNearMatches(tx, street);
  const own = [...atKey, ...onStreet.filter((r) => keyOfRow(r) === key)];
  const mirrors = own.filter((r) => r.team_listing_id !== null);
  if (team.length > 0 || mirrors.length > 0) return { effect: 'end', code: 'AI_ISA_ACTIVE_CLIENT', reason: 'active_client', sentence: LINK_SENTENCES.active_client, listingIds: [...new Set([...team, ...mirrors].map((r) => r.id))].sort() };
  if (own.length > 0) return { effect: 'end', code: 'AI_ISA_LISTED_ELSEWHERE', reason: 'listed_elsewhere', sentence: LINK_SENTENCES.listed_elsewhere, listingIds: [...new Set(own.map((r) => r.id))].sort() };
  const near = (await nearMatches(tx, key, dismissed, onStreet)).filter((m) => !m.dismissed);
  if (near.length > 0) return { effect: 'pause', code: 'AI_ISA_POSSIBLE_LISTING', reason: 'possible_listing', sentence: LINK_SENTENCES.possible_listing, listingIds: near.map((m) => m.listingId) };
  return { effect: 'ok', code: null, reason: null, sentence: LINK_SENTENCES.ok, listingIds: [] };
}

/** Link 10 for an assignment: the confirmed key, else the default address's. */
export async function assignmentSubjectLinkInTx(tx: Tx, a: Pick<AssignmentRow, 'id' | 'contactId' | 'side'>): Promise<SubjectLink> {
  if (a.side !== 'seller' && a.side !== 'both') return { effect: 'ok', code: null, reason: null, sentence: LINK_SENTENCES.ok, listingIds: [] };
  const w = await watchOf(tx, a.id);
  const addr = await defaultAddress(tx, a.contactId);
  const key = w?.subject_address_key ?? (addr && addr.line1 && addr.city && addr.region && addr.postal_code ? addressKey({ line1: addr.line1, line2: addr.line2, city: addr.city, region: addr.region, postalCode: addr.postal_code }) : null);
  return subjectLinkInTx(tx, key, addr?.postal_code ?? null, w?.near_match_dismissed ?? []);
}
