// The AI ISA seller part's interface to the rest of module 75 (ISA-3; docs/AI_ISA.md §9.6). ISA-2's files import only
// this file, one call per hook:
//   H1 sellerBundleInTx       turn.ts prepare            the C1..C3 handles, unavailable codes and the three flags
//   H2 renderSellerFactsInTx  effects.ts queue_message   the server-built facts body and its pending facts (TX-B)
//   H3 sellerFactsCurrentInTx send.ts aiIsaGateFacts     codes for chainFailures (FACT_CHANGED, ...) and the licence
//   H4 sellerStartRefusalInTx controls.ts startRefusal   AI_ISA_LISTED_ELSEWHERE / AI_ISA_ACTIVE_CLIENT at start
//   H5 sellerSubjectLinkInTx  repo.ts evaluateChain      link 10 "Seller home"
//   H6 onEscalationInTx       effects.ts escalate        a pricing hold suspends comps (E502); data_unavailable after a
//                                                        sent comps email marks the subject disputed
//   H8 factPlaceholdersInTx   turn.ts prepare            a sent facts message enters the prompt as a fixed placeholder
// H7 (sendResultInTx) is not needed: ISA-2 already flips the facts to sent or canceled, and nothing here follows it.
import { type Instant, type SystemActor, can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { mlsEligibility, listingRows, storedPriceOf } from './cmaSeam.js';
import { type CompsBuild, DEFAULT_SELLER_DEPS, type SellerDeps, buildCompsInTx } from './comps.js';
import { MAX_COMPETITION_HANDLES, competitorLine, competitorsInTx, sourceOf } from './competition.js';
import { assignmentSubjectLinkInTx, sellerGatesInTx, subjectLinkInTx } from './gates.js';
import { FACT_INTROS, STATUS_LABEL, factsMessage } from './isa1Seam.js';
import { type AssignmentRow, type LinkResult, assignmentById } from './isa2Seam.js';
import { currentSubjectInTx, ensureWatchInTx, watchOf } from './subject.js';
import { displayRulesVersion } from './versions.js';

/** The fixed prompt placeholders of sent facts messages (R-ISA-20): never a price, an address or a brokerage. */
export const COMPS_PLACEHOLDER = '[recent sales emailed]';
export const FACTS_PLACEHOLDER = '[listing details sent]';

/**
 * The seller runtime: the V2-A statement rules (STUB until V2-A merges). Tests replace `deps` inside try/finally; no
 * production path writes it.
 */
export const SELLER_RUNTIME: { deps: SellerDeps } = { deps: DEFAULT_SELLER_DEPS };

const seller = (a: Pick<AssignmentRow, 'side'>) => a.side === 'seller' || a.side === 'both';

export interface HandleLabel {
  handle: string;
  factKind: 'competitor' | 'competitor_pending';
  statusLabel: string;
  beds: number | null;
  baths: number | null;
  propertyType: string | null;
  locality: string | null;
}

export interface SellerBundle {
  handles: HandleLabel[];
  /** handle → listing id (server-side only; never in the prompt) */
  handleMap: Record<string, string>;
  unavailable: string[];
  competitionHandles: string[];
  compsAvailable: boolean;
  mlsListedElsewhere: boolean;
  subjectConfirmed: boolean;
}

const EMPTY: SellerBundle = { handles: [], handleMap: {}, unavailable: [], competitionHandles: [], compsAvailable: false, mlsListedElsewhere: false, subjectConfirmed: false };

/** The current competitors as handles (deterministic: competingSet's order, fresh rows only, at most 3). */
async function competitionHandlesInTx(tx: Tx, a: AssignmentRow, now: Instant): Promise<{ labels: HandleLabel[]; map: Record<string, string> }> {
  const w = await watchOf(tx, a.id);
  if (w === null || w.subject_record_listing_id === null || w.subject_facts === null) return { labels: [], map: {} };
  const rec = (await listingRows(tx, [w.subject_record_listing_id]))[0];
  if (!rec) return { labels: [], map: {} };
  const e = await mlsEligibility(tx, now);
  const c = await competitorsInTx(tx, e, { recordRow: rec, facts: w.subject_facts });
  const labels: HandleLabel[] = [];
  const map: Record<string, string> = {};
  for (const r of c.rows) {
    if (labels.length >= MAX_COMPETITION_HANDLES) break;
    const src = sourceOf(e, r, '', now);
    if (src === null || !src.fresh) continue; // E535: a row unseen beyond max_staleness_hours is never offered
    const handle = `C${labels.length + 1}`;
    labels.push({ handle, factKind: r.status === 'pending' ? 'competitor_pending' : 'competitor', statusLabel: STATUS_LABEL[r.status] ?? r.status, beds: r.beds, baths: r.baths_x10 === null ? null : r.baths_x10 / 10, propertyType: r.property_type, locality: r.city });
    map[handle] = r.id;
  }
  return { labels, map };
}

/** H1 (TX-A): what the model may see and propose for a seller lead. No MLS price or sold fact (R-ISA-20). */
export async function sellerBundleInTx(tx: Tx, actor: SystemActor, a: AssignmentRow, now: Instant): Promise<SellerBundle> {
  if (!seller(a)) return EMPTY;
  await ensureWatchInTx(tx, a);
  // a hold in the machine suspends comps the first time (E502; H6 covers each new escalation)
  if (a.machine.held.some((h) => h.class === 'pricing_negotiation')) {
    await sql`UPDATE ai_isa_seller_watch SET comps_suspended_at = now() WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND comps_suspended_at IS NULL`.execute(tx);
  }
  const link = await assignmentSubjectLinkInTx(tx, a);
  const comp = await sellerGatesInTx(tx, actor, a, now, 'competition');
  const subjectConfirmed = !comp.codes.some((c) => c.startsWith('SUBJECT_'));
  const unavailable: string[] = [];
  let handles: HandleLabel[] = [];
  let handleMap: Record<string, string> = {};
  if (comp.codes.length === 0) {
    const h = await competitionHandlesInTx(tx, a, now);
    handles = h.labels;
    handleMap = h.map;
  } else unavailable.push(`competition_unavailable: ${comp.codes[0]}`);
  const comps = await buildCompsInTx(tx, actor, a, now, SELLER_RUNTIME.deps);
  if (!comps.ok) unavailable.push(`sold_comps_unavailable: ${comps.codes[0]}`);
  return { handles, handleMap, unavailable, competitionHandles: handles.map((x) => x.handle), compsAvailable: comps.ok, mlsListedElsewhere: link.reason === 'listed_elsewhere', subjectConfirmed };
}

export type SellerFacts = null | { ok: true; channel: 'sms' | 'email'; body: string; pendingFacts: PendingAny[] } | { ok: false; codes: string[] };

export interface PendingAny {
  factKind: 'sold_comp_set' | 'competitor';
  listingId: string;
  connectionId: string;
  priceKind: 'sold' | 'asking';
  priceCents: number;
  statusAtBuild: string;
  asOf: Instant;
  displayRulesVersion: string;
  methodVersion: string | null;
  valuationDate: string | null;
  tier: string | null;
  compSetHash: string | null;
  lineSha256: string;
}

/**
 * H2 (TX-B): the server-built body of a seller facts message, re-checked now (the gates and, for comps, the pipeline:
 * R-CMA-7 at queue). null when the message is not a seller facts message. Comps need a bound email: never SMS, no
 * fallback. Competition goes by SMS only when every line fits three segments, else by email.
 */
export async function renderSellerFactsInTx(tx: Tx, actor: SystemActor, a: AssignmentRow, now: Instant, q: { messageKind: string; handles: readonly string[] }): Promise<SellerFacts> {
  if (q.messageKind !== 'facts' || !seller(a)) return null;
  if (q.handles.includes('comps')) {
    if (a.boundPoints.email === undefined) return { ok: false, codes: ['NO_BOUND_EMAIL'] };
    const b: CompsBuild = await buildCompsInTx(tx, actor, a, now, SELLER_RUNTIME.deps);
    if (!b.ok) return b;
    return { ok: true, channel: 'email', body: b.body, pendingFacts: b.pendingFacts.map((f) => ({ ...f })) };
  }
  const comp = q.handles.filter((h) => /^C[1-3]$/.test(h));
  if (comp.length === 0) return null;
  const g = await sellerGatesInTx(tx, actor, a, now, 'competition');
  if (g.codes.length > 0) return { ok: false, codes: g.codes };
  const { map } = await competitionHandlesInTx(tx, a, now);
  const ids = comp.map((h) => map[h]).filter((x): x is string => x !== undefined);
  if (ids.length !== comp.length) return { ok: false, codes: ['FACT_CHANGED'] };
  const e = await mlsEligibility(tx, now);
  const team = (await sql<{ t: string }>`SELECT COALESCE(team_name, brokerage_legal_name) AS t FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!.t;
  const rows = new Map((await listingRows(tx, ids)).map((r) => [r.id, r]));
  const lines: string[] = [];
  const facts: PendingAny[] = [];
  let sms = true;
  for (const id of ids) {
    const r = rows.get(id)!;
    const line = competitorLine(e, r, r.status === 'pending' ? 'competitor_pending' : 'new_competitor', team, now);
    if (!line.ok) return { ok: false, codes: [line.refusal] };
    if (line.channel !== 'sms') sms = false;
    lines.push(line.line);
    const conn = e.connections.find((c) => c.id === r.mls_connection_id)!;
    facts.push({ factKind: 'competitor', listingId: r.id, connectionId: conn.id, priceKind: 'asking', priceCents: Number(r.list_price_cents), statusAtBuild: r.status, asOf: sourceOf(e, r, team, now)!.asOf, displayRulesVersion: displayRulesVersion(conn), methodVersion: null, valuationDate: null, tier: null, compSetHash: null, lineSha256: '' });
  }
  const conn = e.connections.find((c) => c.id === facts[0]!.connectionId)!;
  let channel: 'sms' | 'email' = sms && a.boundPoints.sms !== undefined ? 'sms' : 'email';
  if (channel === 'email' && a.boundPoints.email === undefined) channel = 'sms';
  const body = factsMessage({ intro: FACT_INTROS.competition, lines, attribution: conn.pack.attributionText, disclaimer: conn.pack.disclaimerText, channel });
  const { sha256Hex } = await import('@realty/core/compliance');
  return { ok: true, channel, body, pendingFacts: facts.map((f, k) => ({ ...f, lineSha256: sha256Hex(lines[k]!) })) };
}

/** Writes the pending facts of a queued seller facts message (TX-B; 0191's trigger refuses a sold fact on non-email). */
export async function writeSellerFactsInTx(tx: Tx, ids: { next<T extends string>(): unknown }, a: Pick<AssignmentRow, 'id' | 'contactId'>, turnId: string | null, messageId: string, facts: readonly PendingAny[]): Promise<void> {
  for (const f of facts) {
    await sql`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, turn_id, message_id, fact_kind, listing_id, mls_connection_id, price_kind, price_cents,
        status_at_build, as_of, display_rules_version, gate, method_version, valuation_date, tier, comp_set_hash, line_sha256)
      VALUES (app.tenant_id(), ${ids.next<'X'>() as string}, ${a.id}, ${a.contactId}, ${turnId}, ${messageId}, ${f.factKind}, ${f.listingId}, ${f.connectionId}, ${f.priceKind}, ${f.priceCents},
        ${f.statusAtBuild}, ${new Date(f.asOf)}, ${f.displayRulesVersion}, '[]'::jsonb, ${f.methodVersion}, ${f.valuationDate}::date, ${f.tier}, ${f.compSetHash}, ${f.lineSha256})`.execute(tx);
  }
}

/**
 * H3 (TX1, under lock_contact): whether a message's pending seller facts are still current. Codes join chainFailures
 * (terminal, core gate.ts); `licenceOk` is the licence part of sellerPacksCleared (ai_isa_comps on every comp's feed).
 * A change enqueues one model-free re-render per turn (ai_isa.seller_rerender). A sync that moves only last_synced_at
 * changes nothing here (E537).
 */
export async function sellerFactsCurrentInTx(tx: Tx, actor: SystemActor, messageId: string, now: Instant): Promise<{ codes: string[]; licenceOk: boolean }> {
  const facts = (await sql<{ fact_kind: string; listing_id: string | null; mls_connection_id: string | null; price_kind: string | null; price_cents: string | null; status_at_build: string | null;
      display_rules_version: string | null; comp_set_hash: string | null; assignment_id: string; turn_id: string | null }>`SELECT fact_kind, listing_id, mls_connection_id, price_kind, price_cents,
      status_at_build, display_rules_version, comp_set_hash, assignment_id, turn_id FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND status = 'pending'`.execute(tx)).rows;
  const seller = facts.filter((f) => f.fact_kind === 'sold_comp_set' || f.fact_kind === 'competitor');
  if (seller.length === 0) return { codes: [], licenceOk: true };
  if (!can(actor, 'ai_isa.seller_facts', { tenantId: actor.tenantId }).ok) return { codes: ['SELLER_FACTS_NOT_ALLOWED'], licenceOk: false };
  const e = await mlsEligibility(tx, now);
  const codes = new Set<string>();
  const rows = new Map((await listingRows(tx, seller.flatMap((f) => (f.listing_id ? [f.listing_id] : [])))).map((r) => [r.id, r]));
  let licenceOk = true;
  for (const f of seller) {
    const r = f.listing_id ? rows.get(f.listing_id) : undefined;
    const conn = e.connections.find((c) => c.id === f.mls_connection_id);
    if (!r || !conn || !e.clientIds.includes(conn.id)) {
      codes.add('FACT_CHANGED');
      continue;
    }
    if (f.fact_kind === 'sold_comp_set' && !conn.pack.valuation.aiIsaComps) licenceOk = false;
    if (r.status !== f.status_at_build || storedPriceOf(r, f.price_kind) !== String(f.price_cents) || !r.display_allowed || displayRulesVersion(conn) !== f.display_rules_version) codes.add('FACT_CHANGED');
  }
  if (seller.some((f) => f.fact_kind === 'sold_comp_set')) {
    const a = await assignmentById(tx, seller[0]!.assignment_id);
    if (a === null) codes.add('FACT_CHANGED');
    else {
      const b = await buildCompsInTx(tx, actor, a, now, SELLER_RUNTIME.deps);
      if (!b.ok) for (const c of b.codes) codes.add(c === 'PLATFORM_NOT_CLEARED' || c === 'CLIENT_USE_NOT_ALLOWED' ? c : 'FACT_CHANGED');
      else if (b.compSetHash !== seller.find((f) => f.fact_kind === 'sold_comp_set')!.comp_set_hash) codes.add('FACT_CHANGED');
    }
  }
  if (codes.has('FACT_CHANGED')) {
    const turn = seller[0]!.turn_id ?? messageId;
    await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.seller_rerender', payload: { assignmentId: seller[0]!.assignment_id, messageId }, dedupeKey: `ai_isa.seller_rerender:${turn}` });
  }
  return { codes: [...codes].sort(), licenceOk };
}

/** H4: a start refusal for a seller- or both-side start (R-ISA-26), or null. */
export async function sellerStartRefusalInTx(tx: Tx, contactId: string, side: string | undefined, now: Instant): Promise<'AI_ISA_LISTED_ELSEWHERE' | 'AI_ISA_ACTIVE_CLIENT' | null> {
  if (side !== 'seller' && side !== 'both') return null;
  const s = await currentSubjectInTx(tx, contactId, now);
  const zip = s.addressKey?.split('|')[4] ?? null;
  const link = await subjectLinkInTx(tx, s.addressKey, zip, []);
  return link.reason === 'listed_elsewhere' ? 'AI_ISA_LISTED_ELSEWHERE' : link.reason === 'active_client' ? 'AI_ISA_ACTIVE_CLIENT' : null;
}

/** H5: link 10 "Seller home" of the chain (§3.1), in ISA-2's LinkResult shape. */
export async function sellerSubjectLinkInTx(tx: Tx, a: AssignmentRow): Promise<LinkResult | null> {
  if (!seller(a)) return null;
  const l = await assignmentSubjectLinkInTx(tx, a);
  return { link: 10, name: 'Seller home', effect: l.effect, code: l.code, reason: l.reason, sentence: l.sentence };
}

/** H6: an escalation's seller effects (E502; owner question 9: a disputed subject after a sent comps email). */
export async function onEscalationInTx(tx: Tx, a: Pick<AssignmentRow, 'id' | 'side'>, cls: string): Promise<void> {
  if (!seller(a)) return;
  if (cls === 'pricing_negotiation') {
    await sql`UPDATE ai_isa_seller_watch SET comps_suspended_at = now() WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
  } else if (cls === 'data_unavailable') {
    await sql`UPDATE ai_isa_seller_watch w SET subject_disputed_at = now() WHERE w.tenant_id = app.tenant_id() AND w.assignment_id = ${a.id} AND w.subject_disputed_at IS NULL
      AND EXISTS (SELECT 1 FROM ai_isa_shared_facts f WHERE f.tenant_id = w.tenant_id AND f.assignment_id = w.assignment_id AND f.fact_kind = 'sold_comp_set' AND f.status = 'sent')`.execute(tx);
  }
}

/** H8 (R-ISA-20): the prompt placeholders of messages that carried facts; a message without facts keeps its body. */
export async function factPlaceholdersInTx(tx: Tx, messageIds: readonly string[]): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const r = await sql<{ message_id: string; sold: boolean }>`SELECT message_id, bool_or(fact_kind IN ('sold_comp_set','nearby_sale')) AS sold FROM ai_isa_shared_facts
    WHERE tenant_id = app.tenant_id() AND message_id = ANY (${[...messageIds]}::uuid[]) GROUP BY message_id`.execute(tx);
  return new Map(r.rows.map((x) => [x.message_id, x.sold ? COMPS_PLACEHOLDER : FACTS_PLACEHOLDER]));
}

export { sellerRoutes } from './routes.js';
