// The comps email (R-ISA-18; E534-E537; docs/AI_ISA.md §6.3 "Comparable recent sales: the complete engine set or
// nothing"). The ONLY caller of the comps pipeline (compsForSubjectInTx, through cmaSeam.ts; an architecture test).
//
//   1. the seller gates (gates.ts), then the read-only pipeline on behalf of the lead's owner;
//   2. clientReadiness(use 'ai_isa') must list no blocker (R-CMA-7), the record must be the confirmed one;
//   3. the ISA ceilings: every tier in ISA_COMP_TIERS, a 12-month look-back, both filters, at least 3 comps, no
//      agent label; the complete set or nothing, never partial, never a count of what was left out;
//   4. each comp through the adapter: its client DisplayListing (clientView, or clientSoldView for a mirror), the
//      brokerage (its own, else the mirror's, else refused), a location only when shown, and one "why";
//   5. only the area sentences V1-B's own builders give (each asserted to be among the engine's), never the value,
//      tier-limit, records-left-out, weight or valuation-date sentences;
//   6. the statements (one per comp connection for the subject's state, deduplicated, each printable at <= 12 pt; V2-A
//      STUB refuses every statement), the attribution and disclaimer per connection, the EARLIEST sync as the as-of,
//      the pack's client_lines verbatim;
//   7. the guard and fair housing over the whole body, and the server-text ban over ISA and engine lines only;
//   8. one pending sold_comp_set row per comp (written by the caller with the message id), and last_comps_check.
// The body never names a value, range, adjusted price, weight, back-test, hidden count, forecast or direction.
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { contentGuard } from '@realty/core/assistant';
import { type Instant, type SystemActor, toIso } from '@realty/core/foundation';
import type { DisplayListing } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import {
  CMA_DEFAULTS,
  type ListingRow,
  type MlsEligibility,
  type StoredResult,
  clientRendering,
  compsForSubjectInTx,
  filterSkippedSentence,
  listingRows,
  mlsEligibility,
  printable,
  statementProminence,
  tierName,
  tierReachedSentence,
  tierSkippedSentence,
  valuationStatement,
} from './cmaSeam.js';
import { type IsaCompResult, type IsaCompView, ISA_COMP_TIERS, SELLER_DATA_LINES, renderCompsEmail } from './isa1Seam.js';
import type { AssignmentRow } from './isa2Seam.js';
import { sellerGatesInTx } from './gates.js';
import { displayRulesVersion } from './versions.js';

/** The longest point size an email statement may need (V2-A refuses EMAIL_TYPE_SIZE above it). VERIFY WITH COUNSEL. */
export const EMAIL_MAX_STATEMENT_PT = 12;
/** A refresh re-sends the full set at most this often, and only when the hash changed (§6.3). VERIFY. */
export const COMPS_REFRESH_DAYS = 30;

/**
 * The server-text ban (§6.3; AI_ISA.md:728): run over ISA-1's and the engine's lines only, never over counsel's or the
 * MLS's text (the usual disclaimer says "not guaranteed"). "appraisal" is allowed only inside the negation.
 */
export const SERVER_TEXT_BAN: readonly RegExp[] = [/\bworth\b/i, /\bwill sell for\b/i, /\bguarantee\w*/i, /\btop dollar\b/i, /\blist at\b/i];
const APPRAISAL_NEGATION = /not an appraisal/gi;
export function serverTextBanned(line: string): boolean {
  if (SERVER_TEXT_BAN.some((re) => re.test(line))) return true;
  return /\bappraisal\b/i.test(line.replace(APPRAISAL_NEGATION, ''));
}

/** Seller dependencies a test may replace (the V2-A statement rules until V2-A merges). */
export interface SellerDeps {
  statement: { printable: typeof printable; statementProminence: typeof statementProminence };
}
export const DEFAULT_SELLER_DEPS: SellerDeps = { statement: { printable, statementProminence } };

export interface PendingFact {
  factKind: 'sold_comp_set';
  listingId: string;
  connectionId: string;
  priceKind: 'sold';
  priceCents: number;
  statusAtBuild: 'sold';
  asOf: Instant;
  displayRulesVersion: string;
  methodVersion: string;
  valuationDate: string;
  tier: string;
  compSetHash: string;
  lineSha256: string;
}

export type CompsBuild =
  | { ok: true; channel: 'email'; body: string; pendingFacts: PendingFact[]; compSetHash: string; count: number; updated: boolean }
  | { ok: false; codes: string[] };

const refuse = (codes: string[]): CompsBuild => ({ ok: false, codes: [...new Set(codes)] });

/** The adapter (scope 6): one engine comp → the narrow view ISA-1 renders, from the client DisplayListing only. */
export function adaptComp(c: StoredResult['comps'][number], d: DisplayListing, sale: ListingRow): IsaCompView | null {
  if (c.tier === null || d.closePriceCents === undefined || d.closePriceCents === null || d.closeDate === undefined || d.closeDate === null) return null;
  const tier = c.tier;
  const brokerage = d.listingBrokerageName ?? sale.listing_brokerage_name;
  if (brokerage === null || brokerage.trim() === '') return null;
  const shownAddress = d.address !== undefined && !d.addressHidden ? d.address.line1 : null;
  const subdivision = d.omittedFields.includes('subdivisionName' as never) ? null : (d.subdivisionName ?? null);
  const view = {
    identity: c.ref.identity,
    closePriceCents: d.closePriceCents,
    closeDate: d.closeDate,
    beds: d.beds ?? null,
    sqft: d.sqft ?? null,
    tier,
    locationLabel: shownAddress ?? subdivision,
    listingBrokerageName: brokerage,
    // distance only with a shown address; otherwise the tier's name alone
    why: shownAddress !== null && c.why[0] !== undefined ? c.why[0] : `In ${tierName(tier)}.`,
  } satisfies IsaCompView;
  return view;
}

/** The area sentences rebuilt with V1-B's own builders, each one among the engine's (scope 6). */
export function areaSentences(r: StoredResult, subjectYearBuilt: number | null): string[] {
  const out: string[] = [];
  const reached = tierReachedSentence(r.area.tier, true, r.area.lookbackMonths, CMA_DEFAULTS);
  out.push(reached);
  const skipped = tierSkippedSentence(r.area.tiersSkipped);
  if (skipped !== null) out.push(skipped);
  if (subjectYearBuilt === null) out.push(filterSkippedSentence('year_built'));
  return out.filter((s) => r.area.sentences.includes(s));
}

interface Footer {
  ok: boolean;
  code: string | null;
  statement: string | null;
  attribution: string | null;
  mlsName: string;
  asOf: Instant | null;
}

function footerOf(e: MlsEligibility, connectionIds: readonly string[], state: string | null, deps: SellerDeps): Footer {
  const conns = [...new Set(connectionIds)].sort().map((id) => e.connections.find((c) => c.id === id)).filter((c) => c !== undefined);
  if (conns.length === 0) return { ok: false, code: 'FEED_DISCONNECTED', statement: null, attribution: null, mlsName: '', asOf: null };
  const statements: string[] = [];
  for (const c of conns) {
    const st = valuationStatement(c.pack, state);
    if (st === null) return { ok: false, code: 'NO_VALUATION_STATEMENT', statement: null, attribution: null, mlsName: '', asOf: null };
    const p = deps.statement.statementProminence(st.minPointSize);
    if (!deps.statement.printable(st.text, 'email') || !p.ok) return { ok: false, code: p.code ?? 'CMA_STATEMENT_NOT_RENDERABLE', statement: null, attribution: null, mlsName: '', asOf: null };
    if (p.pointSize > EMAIL_MAX_STATEMENT_PT) return { ok: false, code: 'EMAIL_TYPE_SIZE', statement: null, attribution: null, mlsName: '', asOf: null };
    if (!statements.includes(st.text)) statements.push(st.text);
  }
  const foot: string[] = [];
  for (const c of conns) for (const t of [c.pack.attributionText, c.pack.disclaimerText]) if (t !== null && t.trim() !== '' && !foot.includes(t)) foot.push(t);
  const times = conns.map((c) => c.lastSyncedAt);
  if (times.some((t) => t === null)) return { ok: false, code: 'FEED_STALE', statement: null, attribution: null, mlsName: '', asOf: null };
  return { ok: true, code: null, statement: statements.join('\n\n'), attribution: foot.join('\n\n'), mlsName: [...new Set(conns.map((c) => c.displayName))].join(' and '), asOf: Math.min(...(times as Instant[])) as Instant };
}

async function clientLinesMatch(tx: Tx): Promise<boolean> {
  const r = await sql<{ lines: unknown }>`SELECT rules -> 'client_lines' AS lines FROM jurisdiction_packs WHERE key = 'platform:ai_isa_seller_data' AND status = 'published'`.execute(tx);
  return canonicalJson(r.rows[0]?.lines ?? null) === canonicalJson([...SELLER_DATA_LINES]);
}

/** The body's guard issues that refuse a comps email (money words are its subject; the sign-off is added at queue). */
const GUARD_REFUSES = new Set(['PAYMENT_INSTRUCTIONS', 'CONTRACT_TOPIC', 'HUMAN_CLAIM', 'UNKNOWN_LINK', 'UNFILLED_SLOT', 'OBFUSCATED_TEXT', 'FAIR_HOUSING', 'EMPTY']);

async function recordCheck(tx: Tx, assignmentId: string, codes: string[], hash: string | null, now: Instant): Promise<void> {
  const check = { codes: [...new Set(codes)].sort(), ...(hash !== null ? { comp_set_hash: hash } : {}), checked_at: toIso(now) };
  await sql`UPDATE ai_isa_seller_watch SET last_comps_check = ${JSON.stringify(check)}::jsonb WHERE tenant_id = app.tenant_id() AND assignment_id = ${assignmentId}`.execute(tx);
}

/**
 * Builds the comps email for an assignment now (TX-A at the bundle, TX-B at queue; TX1 re-checks through
 * sellerFactsCurrentInTx). Writes only last_comps_check (as the system). The caller writes the pending facts with the
 * message id.
 */
export async function buildCompsInTx(tx: Tx, actor: SystemActor, a: AssignmentRow, now: Instant, deps: SellerDeps = DEFAULT_SELLER_DEPS): Promise<CompsBuild> {
  const g = await sellerGatesInTx(tx, actor, a, now, 'comps');
  const done = async (codes: string[], hash: string | null = null): Promise<CompsBuild> => {
    await recordCheck(tx, a.id, codes, hash, now);
    return refuse(codes);
  };
  if (g.codes.length > 0) return done(g.codes);
  const w = g.watch!;
  const p = await compsForSubjectInTx(tx, actor, now, { kind: 'contact_address', contactAddressId: w.contact_address_id! }, { contactId: a.contactId, onBehalfOf: { userId: a.ownerUserId } });
  if (!p.ok) return done([p.code]);
  if (p.record === null || p.record.listingId !== w.subject_record_listing_id) return done(['SUBJECT_CHANGED']);
  const blockers = p.readiness.share.blockers.map((b) => b.code);
  if (blockers.length > 0) return done(blockers);
  const r = p.result;
  // the ISA ceilings (E536): the complete set or nothing
  const bedsFiltered = !r.area.sentences.includes(filterSkippedSentence('beds'));
  if (!r.available || r.comps.length < CMA_DEFAULTS.minComps) return done(['COMPS_TOO_FEW']);
  if (r.area.lookbackMonths !== 12 || !bedsFiltered || r.comps.some((c) => c.tier === null || !(ISA_COMP_TIERS as readonly string[]).includes(c.tier)) || r.comps.some((c) => c.labels.length > 0)) return done(['COMPS_CEILING']);
  // the adapter, from the client renderings
  const e = await mlsEligibility(tx, now);
  const ids = r.comps.flatMap((c) => {
    const l = r.listings[c.ref.identity];
    return l ? [l.saleListingId, ...(l.teamListingId ? [l.teamListingId] : [])] : [];
  });
  const rows = new Map((await listingRows(tx, ids)).map((x) => [x.id, x]));
  const views: IsaCompView[] = [];
  const facts: Omit<PendingFact, 'compSetHash' | 'lineSha256'>[] = [];
  for (const c of r.comps) {
    const l = r.listings[c.ref.identity];
    const sale = l ? rows.get(l.saleListingId) : undefined;
    if (!l || !sale || sale.mls_connection_id === null) return done(['COMPS_HIDDEN']);
    const team = l.teamListingId ? (rows.get(l.teamListingId) ?? null) : null;
    const d = clientRendering(e, sale, team);
    const v = d === null ? null : adaptComp(c, d, sale);
    if (v === null) return done(d === null ? ['COMPS_HIDDEN'] : ['BROKERAGE_MISSING']);
    views.push(v);
    const conn = e.connections.find((x) => x.id === sale.mls_connection_id)!;
    facts.push({ factKind: 'sold_comp_set', listingId: sale.id, connectionId: conn.id, priceKind: 'sold', priceCents: v.closePriceCents!, statusAtBuild: 'sold', asOf: (conn.lastSyncedAt ?? now) as Instant, displayRulesVersion: displayRulesVersion(conn), methodVersion: r.methodVersion, valuationDate: p.valuationDate, tier: c.tier! });
  }
  const sentences = areaSentences(r, p.resolved.facts.yearBuilt.value);
  const result: IsaCompResult = { methodVersion: r.methodVersion, comps: views, areaLookbackMonths: r.area.lookbackMonths, sizeFilterApplied: true, bedsFilterApplied: bedsFiltered, sentences };
  const foot = footerOf(e, facts.map((f) => f.connectionId), p.resolved.state, deps);
  if (!foot.ok) return done([foot.code!]);
  if (!(await clientLinesMatch(tx))) return done(['PACK_LINES_MISMATCH']);
  // dedupe and refresh: an unchanged set already sent is skipped; a changed one after 30 days is "Updated"
  const sent = await sql<{ h: string | null; at: Date }>`SELECT comp_set_hash AS h, created_at AS at FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id()
      AND assignment_id = ${a.id} AND fact_kind = 'sold_comp_set' AND status = 'sent' ORDER BY created_at DESC LIMIT 1`.execute(tx);
  const last = sent.rows[0] ?? null;
  const email = renderCompsEmail({
    result,
    gates: { blockers: [], packsCleared: true, subjectConfirmed: true },
    subject: { recordDate: toIso(w.subject_record_date ? (w.subject_record_date.getTime() as Instant) : now).slice(0, 10), beds: w.subject_facts?.beds ?? null, sqft: w.subject_facts?.sqft ?? null },
    mlsName: foot.mlsName,
    teamName: (await sql<{ t: string }>`SELECT COALESCE(team_name, brokerage_legal_name) AS t FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!.t,
    asOf: foot.asOf!,
    stateStatement: foot.statement,
    attribution: foot.attribution,
    updated: last !== null,
  });
  if (!email.ok) return done([email.refusal]);
  if (last !== null && last.h === email.hash) return done(['COMPS_ALREADY_SENT'], email.hash);
  if (last !== null && now - last.at.getTime() < COMPS_REFRESH_DAYS * 86_400_000) return done(['COMPS_REFRESH_TOO_SOON'], email.hash);
  // the text checks: the whole body through the guard and fair housing; the ban over ISA and engine lines only
  const guard = contentGuard(email.body, { channel: 'email', purpose: 'marketing', maxLength: 20_000 }, { brokerageLegalName: '', teamName: '', agentFirstName: '', scope: 'agent', allowedLinkHosts: [] } as never, { firstInThread: false, requireSignOff: false });
  const refused = guard.issues.filter((i) => GUARD_REFUSES.has(i.code)).map((i) => `GUARD_${i.code}`);
  if (refused.length > 0) return done(refused, email.hash);
  const counselOrMls = new Set([...(foot.statement ?? '').split('\n\n'), ...(foot.attribution ?? '').split('\n\n')]);
  const isaLines = email.body.split('\n\n').filter((x) => !counselOrMls.has(x));
  if (isaLines.some(serverTextBanned)) return done(['SERVER_TEXT_BANNED'], email.hash);
  const lines = email.body.split('\n\n');
  const pendingFacts: PendingFact[] = facts.map((f, k) => ({ ...f, compSetHash: email.hash, lineSha256: sha256Hex(lines.find((x) => x.startsWith(`${k + 1}. `)) ?? '') }));
  await recordCheck(tx, a.id, [], email.hash, now);
  return { ok: true, channel: 'email', body: email.body, pendingFacts, compSetHash: email.hash, count: views.length, updated: last !== null };
}

/** Writes the pending sold_comp_set rows of a queued comps email (TX-B; 0191's trigger refuses a non-email message). */
export async function writePendingFactsInTx(tx: Tx, ids: { next<T extends string>(): unknown }, a: Pick<AssignmentRow, 'id' | 'contactId'>, turnId: string | null, messageId: string, facts: readonly PendingFact[]): Promise<void> {
  for (const f of facts) {
    await sql`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, turn_id, message_id, fact_kind, listing_id, mls_connection_id, price_kind, price_cents,
        status_at_build, as_of, display_rules_version, gate, method_version, valuation_date, tier, comp_set_hash, line_sha256)
      VALUES (app.tenant_id(), ${ids.next<'X'>() as string}, ${a.id}, ${a.contactId}, ${turnId}, ${messageId}, ${f.factKind}, ${f.listingId}, ${f.connectionId}, ${f.priceKind}, ${f.priceCents},
        ${f.statusAtBuild}, ${toIso(f.asOf)}::timestamptz, ${f.displayRulesVersion}, '[]'::jsonb, ${f.methodVersion}, ${f.valuationDate}::date, ${f.tier}, ${f.compSetHash}, ${f.lineSha256})`.execute(tx);
  }
}
