// avm.refresh (PHASE2_3_PLAN §5.4 #26, wave 2C; P15, R-AVM-1..3, R-NURT-1, R-NURT-2, R-OWN-27, R-INT-1).
//
// A per-tenant daily standalone job, shaped like mls.sync (claim, read outside any transaction, fenced write):
//   TX1  (system)  the due (address, UTC month) pairs, bounded per pass: a complete address of a live, owned
//                  contact that is a home they bought through the team (K2, R.avmAddressQualifies: buyer or co_buyer
//                  of a buy or dual deal closed before this UTC month; the deal's listing address when it matches one
//                  of their addresses, else their 'home'; never a house they sold through the team); a current approved trigger playbook with a
//                  home_value step would fire for the contact (core detectFirings: scope and owner rules); nothing
//                  recorded for the same house of the same person this UTC month (no ok or unavailable row, no
//                  avm:{address}:{yyyy-mm} firing, across every record of a merged person); and the send-time preview (comms evaluateGate on the step's channel, purpose and
//                  category; never stored) shows none of the recipient refusals below. AUTOMATION_PAUSED is not a
//                  refusal here (R-NURT-5: the firing becomes a draft); content and sender codes are not judged
//                  before the text exists. core avmRequest gives the firing key.
//   vendor        outside any transaction (no contact lock is held while the vendor answers)
//   TX2  (system)  under lockContact: the address is unchanged, still the contact's and still qualifies, the contact
//                  still live and owned; the UTC month is recomputed from TX2's now() and re-checked; then one home_valuations row
//                  (valued_at = now(), never the vendor's as_of) and recordFactInTx with the home_value Fact.
// Idempotent across a crash or a second worker: the TX2 re-check under the contact lock, the unique index
// home_valuations_one_per_month (ok rows) and the firing's unique trigger_key. A vendor failure (or an answer the
// parser refuses) writes nothing and fires nothing; a later pass in the same month asks again. With no vendor
// configured on the platform (production's unconfigured bag) nothing is requested or written.
// Nothing here sends: the firing is built by executeTriggerRun and sent only by comms/dispatch.ts (D1).
import { type AvmEstimate as CoreEstimate, type Fact, avmRequest, changeFromPriorBps, detectFirings, homeValueText } from '@realty/core/nurture';
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import type { EvidenceRef } from '@realty/core/assistant';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { evaluateGate } from '../comms/index.js';
import * as g from '../comms/repos/gate.js';
import type { OutboundIntent } from '../comms/types.js';
import { IN_HOUSE_REF } from '../cma/avm.js';
import type { AddressFacts, AvmProvider } from '../providers/integrations/types.js';
import { ProviderError } from '../providers/types.js';
import type { Logger } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { literal } from './decide.js';
import { recordFactInTx } from './detect.js';
import * as R from './repos.js';
import type { NurtureDeps } from './types.js';

/** Pairs requested per pass (bounded work; the next daily pass picks up the rest). */
export const AVM_REFRESH_BATCH = 50;
/** Candidate rows read per page while looking for due pairs, and the most pages one pass reads. */
const PAGE = 200;
const MAX_PAGES = 25;

/** The send-time preview refusals that mean the client cannot receive the note at all (R-AVM-3, D1). */
export const AVM_PREVIEW_REFUSALS = ['CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT', 'CONTACT_POINT_INVALID', 'TENANT_SUSPENDED'] as const;

// ---- the vendor answer -----------------------------------------------------------------------------------

/** A vendor answer after parsing: what TX2 stores. No confidence or score field exists (R-AST-13). */
export type ParsedAvmAnswer =
  | { status: 'ok'; valueCents: number; lowCents: number; highCents: number; asOf: string; displayAllowed: boolean; provider: string; method: string; comparables: { address: string; soldOn: string; priceCents: number; listingId: string | null }[]; ref: string | null }
  | { status: 'unavailable'; provider: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const cents = (x: unknown): number | null => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null);

/** A vendor string as a client may see it: literal() (no template markers, line breaks or bidi controls), bounded. */
export function vendorText(x: unknown, max: number): string | null {
  if (typeof x !== 'string') return null;
  // markup characters go before literal(), so nothing can re-form a template marker after it ran
  const s = literal(literal(x.replace(/[<>]/g, '')).slice(0, max));
  return s === '' ? null : s;
}

function realDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Parses what the vendor adapter returned (untyped at this boundary: a real adapter reads a vendor's JSON). Only a
 * literal `true` grants display (N8; never defaulted to true). Returns null for an answer that cannot be stored
 * (treated like a vendor failure: no row, retried by a later pass). An unavailable answer never carries a value.
 */
export function parseAvmAnswer(raw: unknown): ParsedAvmAnswer | null {
  if (!isObj(raw)) return null;
  const provider = vendorText(raw['provider'], 80);
  if (provider === null) return null;
  if (raw['available'] === false) return { status: 'unavailable', provider };
  if (raw['available'] !== true) return null;
  const valueCents = cents(raw['valueCents']);
  const lowCents = cents(raw['lowCents']);
  const highCents = cents(raw['highCents']);
  const asOf = raw['asOf'];
  if (valueCents === null || valueCents <= 0 || lowCents === null || highCents === null || lowCents > highCents) return null;
  if (typeof asOf !== 'string' || !realDate(asOf)) return null;
  const method = vendorText(raw['method'], 120);
  if (method === null) return null;
  // R-CMA-10 (lane V2-B): an in-house ref is stored only when well formed; a present but malformed one makes the answer
  // unparseable (no row, retried by a later pass; E634)
  const rawRef = raw['ref'];
  if (rawRef !== undefined && (typeof rawRef !== 'string' || !IN_HOUSE_REF.test(rawRef))) return null;
  // comparables are evidence: malformed entries are dropped, never repaired
  const comparables = (Array.isArray(raw['comparables']) ? raw['comparables'] : []).slice(0, 20).flatMap((c) => {
    if (!isObj(c)) return [];
    const address = vendorText(c['address'], 200);
    const priceCents = cents(c['priceCents']);
    const soldOn = typeof c['soldOn'] === 'string' && realDate(c['soldOn']) ? c['soldOn'] : null;
    const listingId = typeof c['listingId'] === 'string' && /^[0-9a-f-]{36}$/i.test(c['listingId']) ? c['listingId'] : null;
    return address !== null && priceCents !== null && soldOn !== null ? [{ address, soldOn, priceCents, listingId }] : [];
  });
  return { status: 'ok', valueCents, lowCents, highCents, asOf, displayAllowed: raw['displayAllowed'] === true, provider, method, comparables, ref: typeof rawRef === 'string' ? rawRef : null };
}

/** The stored row as core's AvmEstimate (avmSendable, homeValueText). */
export function estimateOfRow(v: Pick<R.ValuationRow, 'status' | 'valueCents' | 'lowCents' | 'highCents' | 'asOf' | 'displayAllowed' | 'provider'>): CoreEstimate {
  return { status: v.status, valueCents: v.valueCents, lowCents: v.lowCents, highCents: v.highCents, asOf: v.asOf, displayAllowed: v.displayAllowed, provider: v.provider };
}

// ---- addresses ---------------------------------------------------------------------------------------------

/** How a home address reads in a firing and a message ("12 Birch Ln, Springfield, ST 00000"); vendor-safe. */
export function addressText(a: Pick<R.HomeAddressRow, 'line1' | 'city' | 'region' | 'postalCode'>): string {
  const part = (x: string | null) => literal(x ?? '');
  return `${part(a.line1)}, ${part(a.city)}, ${part(a.region)} ${part(a.postalCode)}`.trim();
}

/** Every field a valuation depends on: an edit of any of them makes the address "not the one that was valued". */
export function addressFingerprint(a: R.HomeAddressRow): string {
  return JSON.stringify([a.contactId, a.kind, a.line1, a.line2, a.city, a.region, a.postalCode, a.country]);
}

/** Every field the vendor needs. Which address rows qualify at all (kind, side, purchased house) is R.avmAddressQualifies (K2). */
function complete(a: R.HomeAddressRow): boolean {
  return [a.line1, a.city, a.region, a.postalCode].every((x) => (x ?? '').trim() !== '');
}

function facts(a: R.HomeAddressRow): AddressFacts {
  return { line1: (a.line1 ?? '').trim(), city: (a.city ?? '').trim(), region: (a.region ?? '').trim(), postalCode: (a.postalCode ?? '').trim() };
}

// ---- TX1 ---------------------------------------------------------------------------------------------------

export interface DuePair {
  address: R.HomeAddressRow;
  contactId: string;
  ownerUserId: string;
  month: string;
  triggerKey: string;
}

/**
 * The step a home_value firing would use for this contact (core detectFirings over the current approved trigger
 * playbooks: the contact's own agent's playbook wins over the team's), or null when none would fire.
 */
function wouldFire(playbooks: readonly R.TriggerPlaybook[], c: { contactId: string; ownerUserId: string }, addressId: string, month: string, address: string): { channel: 'sms' | 'email'; purpose: 'marketing' | 'informational'; category: string } | null {
  const fact: Fact = { kind: 'home_value', contactId: c.contactId, contactAddressId: addressId, month, valuationId: '00000000-0000-0000-0000-000000000000', at: 0 as Instant, address };
  const firings = detectFirings(fact, playbooks.map((p) => ({ contactId: c.contactId, ownerUserId: c.ownerUserId, relation: { kind: 'contact' as const }, playbook: p.ref })));
  const f = firings[0];
  if (!f) return null;
  const p = playbooks.find((x) => x.ref.playbookId === f.playbookId);
  const step = p?.content.triggers.find((t) => t.stepKey === f.stepKey && t.trigger === 'home_value');
  return step ? { channel: step.channel, purpose: step.purpose, category: step.category } : null;
}

/** The send-time preview for the step (never stored): whether the client can receive it at all. */
async function previewAllows(tx: Tx, contactId: string, step: { channel: 'sms' | 'email'; purpose: 'marketing' | 'informational'; category: string }, now: Instant): Promise<boolean> {
  const kind = step.channel === 'email' ? 'email' : 'phone';
  const points = await g.contactPoints(tx, contactId);
  const point = points.find((p) => p.kind === kind && p.status === 'active') ?? points.find((p) => p.kind === kind);
  if (!point) return false; // no point on the step's channel: nothing could reach them
  const intent: OutboundIntent = {
    contactId,
    recipient: { kind: 'contact', addressHmac: point.hmac, channel: step.channel, pointId: point.id },
    purpose: step.purpose,
    initiator: 'assistant',
    category: step.category as OutboundIntent['category'],
    // the sender is chosen when the message is built: not judged here
    sender: { phoneNumberId: null, emailIdentityId: step.channel === 'email' ? await g.chooseEmailIdentity(tx, null) : null },
    body: null,
  };
  const { decision } = await evaluateGate(tx, intent, now);
  return !decision.reasons.some((r) => (AVM_PREVIEW_REFUSALS as readonly string[]).includes(r));
}

/** TX1: up to `limit` due pairs, in address id order. */
export async function duePairsInTx(tx: Tx, now: Instant, limit = AVM_REFRESH_BATCH): Promise<DuePair[]> {
  const playbooks = (await R.approvedTriggerPlaybooks(tx)).filter((p) => p.content.triggers.some((t) => t.trigger === 'home_value'));
  if (playbooks.length === 0) return [];
  const out: DuePair[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
    const rows = await R.avmCandidates(tx, after, PAGE);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.address.id;
    for (const c of rows) {
      if (out.length >= limit) break;
      if (!complete(c.address)) continue;
      const step = wouldFire(playbooks, { contactId: c.address.contactId, ownerUserId: c.ownerUserId }, c.address.id, c.month, addressText(c.address));
      if (step === null) continue;
      // addressCurrent: the candidate query applied R.avmAddressQualifies to this very row in this transaction (K2)
      const req = avmRequest({ contactAddressId: c.address.id, month: c.month, addressCurrent: true, previewAllows: await previewAllows(tx, c.address.contactId, step, now), alreadyRequestedThisMonth: false });
      if (!req.request) continue;
      out.push({ address: c.address, contactId: c.address.contactId, ownerUserId: c.ownerUserId, month: c.month, triggerKey: req.triggerKey });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---- TX2 ---------------------------------------------------------------------------------------------------

export type RecordOutcome = 'recorded' | 'already' | 'address_changed' | 'contact_gone';

/** TX2 under the contact lock: re-check, store the answer, record the home_value fact (one firing per key). */
export async function recordAnswerInTx(tx: Tx, deps: Pick<NurtureDeps, 'ids'>, pair: DuePair, answer: ParsedAvmAnswer): Promise<{ outcome: RecordOutcome; valuationId?: string; fired?: number }> {
  await lockContact(tx, pair.contactId as ContactId);
  const c = await R.contactState(tx, pair.contactId);
  if (!c || !c.live || c.ownerUserId === null) return { outcome: 'contact_gone' };
  const addr = await R.addressById(tx, pair.address.id);
  if (!addr || addressFingerprint(addr) !== addressFingerprint(pair.address) || !complete(addr)) return { outcome: 'address_changed' };
  // the month of THIS transaction's clock (a pass that spans a month boundary records under the new month)
  const month = await R.utcMonthNow(tx);
  // K2: re-checked under the lock: still a home this person bought through the team (never one they sold since)
  const addressCurrent = await R.avmAddressQualifies(tx, c.id, addr.id);
  const req = avmRequest({ contactAddressId: addr.id, month, addressCurrent, previewAllows: true, alreadyRequestedThisMonth: await R.avmRecordedThisMonth(tx, addr.id, month) });
  if (!addressCurrent) return { outcome: 'address_changed' };
  if (!req.request) return { outcome: 'already' };
  const prior = await R.priorOkValuation(tx, addr.id, null, null);
  const est: CoreEstimate =
    answer.status === 'ok'
      ? { status: 'ok', valueCents: answer.valueCents, lowCents: answer.lowCents, highCents: answer.highCents, asOf: answer.asOf, displayAllowed: answer.displayAllowed, provider: answer.provider }
      : { status: 'unavailable', valueCents: null, lowCents: null, highCents: null, asOf: null, displayAllowed: false, provider: answer.provider };
  const id = deps.ids.next<'HomeValuationId'>();
  const valuedAt = await R.insertValuation(tx, {
    id,
    contactId: c.id,
    contactAddressId: addr.id,
    status: est.status as 'ok' | 'unavailable',
    valueCents: est.valueCents,
    lowCents: est.lowCents,
    highCents: est.highCents,
    asOf: est.asOf,
    displayAllowed: est.displayAllowed,
    provider: est.provider,
    providerRef: answer.status === 'ok' ? answer.ref : null, // R-CMA-10: the in-house run's ref; none from any other source
    changeFromPriorBps: changeFromPriorBps(est, prior ? estimateOfRow(prior) : null),
  });
  const fact: Fact = { kind: 'home_value', contactId: c.id, contactAddressId: addr.id, month, valuationId: id, at: valuedAt, address: addressText(addr) };
  // the claim cites the row (R-AVM-1): the fact the agent and the trigger-runs view see is the R-AVM-1 sentence
  // R-CMA-6 (E636): a number only when the estimate may reach the client; trigger runs are read by ISA and TC too
  const snippet = est.status !== 'ok' ? 'No estimate available.' : est.displayAllowed ? (homeValueText(est) ?? 'No estimate available.') : 'Estimate not shown to clients.';
  const evidence: EvidenceRef[] = [{ sourceType: 'home_valuation', sourceId: id, locator: { kind: 'field', name: 'estimate' }, snippet }];
  const fired = await recordFactInTx(tx, deps, fact, [{ contactId: c.id, ownerUserId: c.ownerUserId, relation: { kind: 'contact' } }], { evidence });
  return { outcome: 'recorded', valuationId: id, fired };
}

// ---- the pass ----------------------------------------------------------------------------------------------

export interface AvmRefreshDeps extends Pick<NurtureDeps, 'ids' | 'db'> {
  avm: AvmProvider;
}

export interface AvmRefreshResult {
  configured: boolean;
  requested: number;
  recorded: number;
  fired: number;
  failed: number;
  skipped: number;
}

/**
 * One avm.refresh pass for one tenant (the handler and the tests call this). Every transaction is this tenant's,
 * as its system actor; the vendor is called between them.
 */
export async function avmRefresh(deps: AvmRefreshDeps, tenantId: TenantId | string, log?: Logger): Promise<AvmRefreshResult> {
  const res: AvmRefreshResult = { configured: deps.avm.configured, requested: 0, recorded: 0, fired: 0, failed: 0, skipped: 0 };
  if (!deps.avm.configured) return res; // R-INT-1: no vendor on this platform ⇒ nothing requested, nothing written
  // R-CMA-10 E620: a source with tenant prerequisites (the in-house one) that this tenant lacks ⇒ nothing requested
  if (deps.avm.availability && !(await deps.avm.availability({ tenantId: String(tenantId), db: deps.db })).available) return res;
  const actor = systemActor(tenantId as TenantId, 'provider');
  const pairs = await withTenantTx(actor, (tx, now) => duePairsInTx(tx, now), { db: deps.db, retries: 2 });
  for (const pair of pairs) {
    res.requested += 1;
    let answer: ParsedAvmAnswer | null;
    try {
      const raw = await deps.avm.estimate(facts(pair.address), { tenantId: String(tenantId), contactId: pair.contactId, contactAddressId: pair.address.id, db: deps.db });
      answer = parseAvmAnswer(raw);
      if (answer === null) log?.warn('avm.refresh answer refused', { code: 'AVM_ANSWER_UNPARSEABLE' });
    } catch (e) {
      answer = null;
      log?.warn('avm.refresh vendor error', { code: e instanceof ProviderError ? (e.providerCode ?? e.kind) : e instanceof Error ? e.name : 'unknown' });
    }
    if (answer === null) {
      res.failed += 1; // no row, no firing: a later pass this month asks again
      continue;
    }
    const r = await withTenantTx(actor, (tx) => recordAnswerInTx(tx, deps, pair, answer), { db: deps.db, retries: 2 });
    if (r.outcome === 'recorded') {
      res.recorded += 1;
      res.fired += r.fired ?? 0;
    } else res.skipped += 1;
  }
  return res;
}

