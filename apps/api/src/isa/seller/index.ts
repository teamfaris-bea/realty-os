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
import { type IdGenerator, type Instant, type SystemActor, can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { type MlsEligibility, mlsEligibility, listingRows, storedPriceOf } from './cmaSeam.js';
import { type CompsBuild, DEFAULT_SELLER_DEPS, type SellerDeps, buildCompsInTx } from './comps.js';
import { MAX_COMPETITION_HANDLES, competitorLine, competitorsInTx, smsFits, sourceOf } from './competition.js';
import { assignmentSubjectLinkInTx, sellerGatesInTx, subjectLinkInTx } from './gates.js';
import { type CompetitorEvent, FACT_INTROS, STATUS_LABEL, composeMessage, factsMessage } from './isa1Seam.js';
import { type AssignmentRow, type LinkResult, assignmentById, contextFor, queueFactsMessageInTx } from './isa2Seam.js';
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

/** Where a seller facts message may go (ISA-3 audit F5): ISA-2's channel plan for this assignment. */
export interface SellerChannels {
  /** the bound channels the policy allows (ISA-2's ctx.channels: boundPoints ∩ the policy's content.channels) */
  channels: readonly ('sms' | 'email')[];
  /** the body as it will be queued (ISA-2's composeMessage, its longest form); the SMS fit is judged on it */
  compose: (core: string, channel: 'sms' | 'email') => string;
}

/**
 * H2 (TX-B): the server-built body of a seller facts message, re-checked now (the gates and, for comps, the pipeline:
 * R-CMA-7 at queue). null when the message is not a seller facts message. Only a channel the policy allows and the
 * assignment binds (ISA-2's ctx.channels) is ever used. Comps need that email: never SMS, no fallback. Competition goes
 * by SMS only when the whole message as queued (intro, every line, every feed's footer, the sign-off) fits three
 * segments (fitsSms and smsSegments, scope 7), else by email; with no allowed email it is refused (FACTS_DO_NOT_FIT),
 * never sent as a long SMS. VERIFY (owner): scope 7's last fallback, the 'email_details_pointer' line by SMS, is not
 * sent: it is not a facts message, and it would offer an email the lead has not given.
 */
export async function renderSellerFactsInTx(tx: Tx, actor: SystemActor, a: AssignmentRow, now: Instant, q: { messageKind: string; handles: readonly string[] }, plan: SellerChannels): Promise<SellerFacts> {
  if (q.messageKind !== 'facts' || !seller(a)) return null;
  const allowed = (ch: 'sms' | 'email') => plan.channels.includes(ch) && a.boundPoints[ch] !== undefined;
  if (q.handles.includes('comps')) {
    if (a.boundPoints.email === undefined) return { ok: false, codes: ['NO_BOUND_EMAIL'] };
    if (!allowed('email')) return { ok: false, codes: ['CHANNEL_NOT_ALLOWED'] };
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
  return (await competitionFactsInTx(tx, a, now, ids.map((id) => ({ listingId: id, priceAtBuild: null })), plan, false)).facts;
}

/**
 * A competition message over `items` (listing ids), each rendered from its client DisplayListing as it is now: pending
 * as "Now pending (not yet sold)", a changed asking price (against `priceAtBuild`) as a price change, else as new. A
 * line that no longer renders refuses the message, or, with `dropFailing` (the E537 re-render), is dropped and named in
 * `dropped`; with nothing left it is FACT_CHANGED. The channel rule is H2's (renderSellerFactsInTx).
 */
async function competitionFactsInTx(tx: Tx, a: AssignmentRow, now: Instant, items: readonly { listingId: string; priceAtBuild: string | null }[], plan: SellerChannels, dropFailing: boolean): Promise<{ facts: Exclude<SellerFacts, null>; dropped: string[] }> {
  const allowed = (ch: 'sms' | 'email') => plan.channels.includes(ch) && a.boundPoints[ch] !== undefined;
  const e = await mlsEligibility(tx, now);
  const team = (await sql<{ t: string }>`SELECT COALESCE(team_name, brokerage_legal_name) AS t FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!.t;
  const rows = new Map((await listingRows(tx, items.map((x) => x.listingId))).map((r) => [r.id, r]));
  const lines: string[] = [];
  const facts: PendingAny[] = [];
  const dropped: string[] = [];
  for (const it of items) {
    const r = rows.get(it.listingId);
    const event: CompetitorEvent = r?.status === 'pending' ? 'competitor_pending' : it.priceAtBuild !== null && r !== undefined && storedPriceOf(r, 'asking') !== it.priceAtBuild ? 'competitor_price_change' : 'new_competitor';
    const line = r === undefined ? ({ ok: false, refusal: 'FACT_CHANGED' } as const) : competitorLine(e, r, event, team, now);
    if (!line.ok || r === undefined) {
      if (!dropFailing) return { facts: { ok: false, codes: [line.ok ? 'FACT_CHANGED' : line.refusal] }, dropped };
      dropped.push(it.listingId);
      continue;
    }
    lines.push(line.line);
    const conn = e.connections.find((c) => c.id === r.mls_connection_id)!;
    facts.push({ factKind: 'competitor', listingId: r.id, connectionId: conn.id, priceKind: 'asking', priceCents: Number(r.list_price_cents), statusAtBuild: r.status, asOf: sourceOf(e, r, team, now)!.asOf, displayRulesVersion: displayRulesVersion(conn), methodVersion: null, valuationDate: null, tier: null, compSetHash: null, lineSha256: '' });
  }
  if (facts.length === 0) return { facts: { ok: false, codes: ['FACT_CHANGED'] }, dropped };
  const bodyOf = (ch: 'sms' | 'email') => factsMessage({ intro: FACT_INTROS.competition, lines, attribution: footerOfFeeds(e, facts.map((f) => f.connectionId), ch), disclaimer: null, channel: ch });
  const channel: 'sms' | 'email' | null = allowed('sms') && smsFits(plan.compose(bodyOf('sms'), 'sms')) ? 'sms' : allowed('email') ? 'email' : null;
  if (channel === null) return { facts: { ok: false, codes: [plan.channels.some((ch) => a.boundPoints[ch] !== undefined) ? 'FACTS_DO_NOT_FIT' : 'CHANNEL_NOT_ALLOWED'] }, dropped };
  const body = bodyOf(channel);
  const { sha256Hex } = await import('@realty/core/compliance');
  return { facts: { ok: true, channel, body, pendingFacts: facts.map((f, k) => ({ ...f, lineSha256: sha256Hex(lines[k]!) })) }, dropped };
}

export interface SellerRerender {
  /** the kind the original message carried (its own facts decide: sold comps, else competition) */
  kind: 'comps' | 'competition' | null;
  /** empty when there is something to send; DATA_UNAVAILABLE when nothing renders any more */
  codes: string[];
  /** listing ids of the original facts left out because they no longer render (sent without them) */
  dropped: string[];
  facts: SellerFacts;
  /** false until ISA-2 builds queueFactsMessageInTx (STUB) */
  delivered: boolean;
}

/**
 * The E537 re-render (ai_isa.seller_rerender, once per turn, model-free): the original message's own facts decide the
 * kind. Sold comps are rebuilt whole (the complete set or nothing). Competition is rebuilt over the same listings as
 * they are now ("Now pending (not yet sold)", a price change), each fact that no longer renders dropped; with nothing
 * left, or comps refused, it is DATA_UNAVAILABLE. The result goes to STUB(ISA-2) queueFactsMessageInTx with the
 * original message and turn, so the re-render binds to that turn and a change of the re-render itself is refused
 * without another re-render (sellerFactsCurrentInTx: it never loops). VERIFY (ISA-2): DATA_UNAVAILABLE becomes a
 * data_unavailable escalation once ISA-2 builds the queue function; until then nothing is delivered.
 */
export async function sellerRerenderInTx(tx: Tx, actor: SystemActor, a: AssignmentRow, messageId: string, now: Instant): Promise<SellerRerender> {
  const orig = (await sql<{ fact_kind: string; listing_id: string | null; price_cents: string | null; turn_id: string | null }>`SELECT fact_kind, listing_id, price_cents::text AS price_cents, turn_id
      FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND assignment_id = ${a.id} AND fact_kind IN ('sold_comp_set','competitor')
      ORDER BY created_at, id`.execute(tx)).rows;
  const kind = orig.some((f) => f.fact_kind === 'sold_comp_set') ? 'comps' : orig.length > 0 ? 'competition' : null;
  if (kind === null || a.endedAt !== null || !seller(a)) return { kind, codes: ['DATA_UNAVAILABLE'], dropped: [], facts: null, delivered: false };
  const c = await contextFor(tx, a, now);
  const plan: SellerChannels = { channels: c.channels, compose: (core, ch) => composeMessage({ body: core, who: c.who, firstInThread: true, optOutHint: true, channel: ch }) };
  let facts: SellerFacts;
  let dropped: string[] = [];
  if (kind === 'comps') facts = await renderSellerFactsInTx(tx, actor, a, now, { messageKind: 'facts', handles: ['comps'] }, plan);
  else {
    const g = await sellerGatesInTx(tx, actor, a, now, 'competition');
    const items = [...new Map(orig.filter((f) => f.listing_id !== null).map((f) => [f.listing_id!, { listingId: f.listing_id!, priceAtBuild: f.price_cents }])).values()];
    const out = g.codes.length > 0 ? { facts: { ok: false as const, codes: g.codes }, dropped: [] } : await competitionFactsInTx(tx, a, now, items, plan, true);
    facts = out.facts;
    dropped = out.dropped;
  }
  if (facts === null || !facts.ok) return { kind, codes: ['DATA_UNAVAILABLE'], dropped, facts, delivered: false };
  const sent = await queueFactsMessageInTx(tx, { assignmentId: a.id, rerenderOf: messageId, turnId: orig[0]?.turn_id ?? null, channel: facts.channel, body: facts.body, pendingFacts: facts.pendingFacts });
  return { kind, codes: [], dropped, facts, delivered: sent.delivered };
}

/**
 * The footer of a competition message (R-MLS-2; ISA-3 audit F4): each feed's own attribution, then its disclaimer, for
 * every feed a line came from, in the lines' order, each text once (as comps.ts footerOf does for comps). A line from a
 * second MLS never goes out under the first feed's attribution alone.
 */
export function footerOfFeeds(e: Pick<MlsEligibility, 'connections'>, connectionIds: readonly string[], channel: 'sms' | 'email'): string | null {
  const foot: string[] = [];
  for (const id of [...new Set(connectionIds)]) {
    const c = e.connections.find((x) => x.id === id);
    for (const t of c ? [c.pack.attributionText, c.pack.disclaimerText] : []) if (t !== null && t.trim() !== '' && !foot.includes(t)) foot.push(t);
  }
  return foot.length === 0 ? null : foot.join(channel === 'email' ? '\n\n' : '\n');
}

/** Writes the pending facts of a queued seller facts message (TX-B; 0084's trigger, lane number 0191, refuses a sold fact on non-email). */
export async function writeSellerFactsInTx(tx: Tx, ids: IdGenerator, a: Pick<AssignmentRow, 'id' | 'contactId'>, turnId: string | null, messageId: string, facts: readonly PendingAny[]): Promise<void> {
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
      // a refusal stays its own code (terminal in the core gate); FACT_CHANGED means the facts moved under the message
      if (!b.ok) for (const c of b.codes) codes.add(c === 'SUBJECT_CHANGED' || c === 'COMPS_HIDDEN' || c === 'COMPS_TOO_FEW' || c === 'NO_VALUE' ? 'FACT_CHANGED' : c);
      else if (b.compSetHash !== seller.find((f) => f.fact_kind === 'sold_comp_set')!.comp_set_hash) codes.add('FACT_CHANGED');
    }
  }
  if (codes.has('FACT_CHANGED')) {
    // E537 (ISA-3 audit F6): one re-render per turn; a message that is itself a re-render (ISA-2's queue function marks
    // its action rerenderOf) is refused with no second one, so a fact that keeps changing never loops
    const again = (await sql<{ r: boolean }>`SELECT (aa.payload ->> 'rerenderOf') IS NOT NULL AS r FROM messages m JOIN assistant_actions aa ON aa.tenant_id = m.tenant_id AND aa.id = m.assistant_action_id
        WHERE m.tenant_id = app.tenant_id() AND m.id = ${messageId}`.execute(tx)).rows[0]?.r ?? false;
    if (again) codes.add('DATA_UNAVAILABLE');
    else {
      const turn = seller[0]!.turn_id ?? messageId;
      await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.seller_rerender', payload: { assignmentId: seller[0]!.assignment_id, messageId }, dedupeKey: `ai_isa.seller_rerender:${turn}` });
    }
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
