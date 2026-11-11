// Trigger detection, digest and the send-time decision (R-NURT-1..5, R-NURT-7, R-NURT-8, R-MLS-2/3).
//
//   detectFirings(fact, candidates)   facts only, never signals; owned contacts only; an agent
//                                     playbook only for contacts its owner owns; MLS rows only while
//                                     the feed is fresh and the listing is displayable
//   digest(firings, windowMinutes)    one message per contact and playbook inside the approved window
//   recheckFact(firing, current)      the fact still holds at send time (or a visible skip reason)
//   planTriggerRun(...)               send | draft (paused, fair housing, money...) | skip, re-checking
//                                     the approval, the owner and the pause; never an ownership change
import { type EvidenceRef, formatPriceCents, type GuardResult } from '../assistant/index.js';
import { type Instant, instant, MINUTE_MS } from '../foundation/index.js';
import type { AvmDecision } from './avm.js';
import { type Batch, type Fact, type FactState, type Firing, type FiringRef, type ListingStatus, SKIP_REASON_TEXT, type SkipReason, type TriggerCandidate, type TriggerKind } from './types.js';

/** Statuses a home returns to market from. */
const OFF_MARKET: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['withdrawn', 'expired', 'pending']);
const ON_MARKET: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['active', 'coming_soon']);

function triggerOf(fact: Fact): TriggerKind | null {
  switch (fact.kind) {
    case 'price_change':
      return fact.newPriceCents < fact.oldPriceCents ? 'price_drop' : null;
    case 'status_change':
      return OFF_MARKET.has(fact.from) && fact.to === 'active' ? 'back_on_market' : null;
    case 'home_anniversary':
      return 'home_anniversary';
    case 'home_value':
      return 'home_value';
    case 'deal_date_upcoming':
      return 'deal_date_upcoming';
    default:
      return null; // anything else (an open, a click, a prediction) is not a fact: fail closed
  }
}

function concerns(fact: Fact, c: TriggerCandidate): boolean {
  switch (fact.kind) {
    case 'price_change':
    case 'status_change':
      return c.relation.kind === 'listing' && c.relation.listingId === fact.listingId;
    case 'home_anniversary':
    case 'home_value':
      return c.relation.kind === 'contact' && c.contactId === fact.contactId;
    case 'deal_date_upcoming':
      return c.relation.kind === 'contact' && fact.contactIds.includes(c.contactId);
  }
}

function keyOf(fact: Fact, contactId: string, stepKey: string): string {
  switch (fact.kind) {
    case 'price_change':
      return `price_drop:${fact.historyId}:${contactId}`;
    case 'status_change':
      return `back_on_market:${fact.historyId}:${contactId}`;
    case 'home_anniversary':
      return `anniversary:${fact.dealId}:${fact.year}:${contactId}`;
    case 'home_value':
      return `avm:${fact.contactAddressId}:${fact.month}`;
    case 'deal_date_upcoming':
      return `deal_date:${fact.dealDateId}:v${fact.dueVersion}:${stepKey}:${contactId}`;
  }
}

function refOf(fact: Fact): FiringRef {
  switch (fact.kind) {
    case 'price_change':
      return { kind: 'price_drop', listingId: fact.listingId, historyId: fact.historyId, source: fact.source, oldPriceCents: fact.oldPriceCents, newPriceCents: fact.newPriceCents, address: fact.address, mlsNumber: fact.mlsNumber };
    case 'status_change':
      return { kind: 'back_on_market', listingId: fact.listingId, historyId: fact.historyId, source: fact.source, from: fact.from, address: fact.address, mlsNumber: fact.mlsNumber, priceCents: fact.priceCents };
    case 'home_anniversary':
      return { kind: 'home_anniversary', dealId: fact.dealId, closedOn: fact.closedOn, year: fact.year, address: fact.address };
    case 'home_value':
      return { kind: 'home_value', contactAddressId: fact.contactAddressId, month: fact.month, valuationId: fact.valuationId, address: fact.address };
    case 'deal_date_upcoming':
      return { kind: 'deal_date_upcoming', dealId: fact.dealId, dealDateId: fact.dealDateId, dueVersion: fact.dueVersion, dueAt: fact.dueAt, label: fact.label };
  }
}

function evidenceOf(fact: Fact): EvidenceRef[] {
  switch (fact.kind) {
    case 'price_change':
      return [{ sourceType: 'listing', sourceId: fact.listingId, locator: { kind: 'field', name: 'list_price' }, snippet: `${formatPriceCents(fact.newPriceCents)} (was ${formatPriceCents(fact.oldPriceCents)})` }];
    case 'status_change':
      return [{ sourceType: 'listing', sourceId: fact.listingId, locator: { kind: 'field', name: 'status' }, snippet: `${fact.to} (was ${fact.from})` }];
    case 'home_anniversary':
      return [{ sourceType: 'deal', sourceId: fact.dealId, locator: { kind: 'field', name: 'closed_on' }, snippet: fact.closedOn }];
    case 'home_value':
      return [];
    case 'deal_date_upcoming':
      return [{ sourceType: 'deal', sourceId: fact.dealId, locator: { kind: 'field', name: `deal_date:${fact.dealDateId}` }, snippet: fact.label }];
  }
}

/** Anchor the step offset hangs off: the fact's instant, or the deal date for upcoming dates. */
function anchorOf(fact: Fact): Instant {
  return fact.kind === 'deal_date_upcoming' ? fact.dueAt : fact.at;
}

/**
 * Firings for one fact (R-NURT-1, R-NURT-2, R-NURT-7). One per contact and fact: when two approved
 * playbooks would fire for the same contact, the contact's own agent's playbook wins over the
 * team's (then the lower playbook id), because the DB trigger_key is unique.
 */
export function detectFirings(fact: Fact, candidates: readonly TriggerCandidate[]): Firing[] {
  const trigger = triggerOf(fact);
  if (trigger === null) return [];
  if ((fact.kind === 'price_change' || fact.kind === 'status_change') && fact.source === 'mls' && (!fact.feedFresh || !fact.displayAllowed)) return [];
  const byKey = new Map<string, { f: Firing; rank: string }>();
  for (const c of candidates) {
    if (!concerns(fact, c)) continue;
    if (c.ownerUserId === null) continue;
    if (c.playbook.scope === 'agent' && c.playbook.ownerUserId !== c.ownerUserId) continue;
    for (const step of c.playbook.steps) {
      if (step.trigger !== trigger) continue;
      const triggerKey = keyOf(fact, c.contactId, step.stepKey);
      const firing: Firing = {
        triggerKey,
        trigger,
        contactId: c.contactId,
        playbookId: c.playbook.playbookId,
        versionId: c.playbook.versionId,
        stepKey: step.stepKey,
        scheduledFor: instant(anchorOf(fact) + step.offsetSeconds * 1000),
        ref: refOf(fact),
        evidence: evidenceOf(fact),
      };
      const rank = `${c.playbook.scope === 'agent' ? '0' : '1'}:${c.playbook.playbookId}`;
      const prev = byKey.get(triggerKey);
      if (prev === undefined || rank < prev.rank) byKey.set(triggerKey, { f: firing, rank });
    }
  }
  return [...byKey.values()].map((v) => v.f).sort((a, b) => a.scheduledFor - b.scheduledFor || a.triggerKey.localeCompare(b.triggerKey));
}

/** The listing a firing is about, if any (a newer firing for the same listing replaces an older one). */
function listingOf(f: Firing): string | null {
  return f.ref.kind === 'price_drop' || f.ref.kind === 'back_on_market' ? f.ref.listingId : null;
}

/**
 * R-NURT-3: firings for one contact and playbook whose scheduled instants fall inside the window
 * opened by the first one become one batch, sent when the window closes. The window is approved
 * content, not a cap: nothing is dropped. A later firing for the same listing replaces the earlier
 * item in that batch (the message reflects the latest fact; E83). Window 0 = one batch per firing.
 */
export function digest(firings: readonly Firing[], windowMinutes: number): Batch[] {
  const windowMs = Math.max(0, Math.trunc(windowMinutes)) * MINUTE_MS;
  const groups = new Map<string, Firing[]>();
  for (const f of firings) {
    const k = `${f.contactId}\u0000${f.playbookId}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const out: Batch[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.scheduledFor - b.scheduledFor || a.triggerKey.localeCompare(b.triggerKey));
    let cur: Batch | null = null;
    for (const f of sorted) {
      if (cur === null || windowMs === 0 || f.scheduledFor >= cur.sendAt) {
        cur = { contactId: f.contactId, playbookId: f.playbookId, versionId: f.versionId, sendAt: instant(f.scheduledFor + windowMs), firings: [] };
        out.push(cur);
      }
      const l = listingOf(f);
      if (l !== null) cur.firings = cur.firings.filter((x) => listingOf(x) !== l);
      cur.firings.push(f);
      cur.versionId = f.versionId;
    }
  }
  return out.sort((a, b) => a.sendAt - b.sendAt || a.contactId.localeCompare(b.contactId) || a.playbookId.localeCompare(b.playbookId));
}

/**
 * R-NURT-4: does the fact still hold at send time? A price drop holds while the home is on the
 * market and its current price is still below the price before the drop (E83: the message shows the
 * current price; no net drop ⇒ skipped). An MLS row also needs a fresh feed and display permission.
 */
export function recheckFact(f: Firing, current: FactState, now?: Instant): { ok: true } | { ok: false; reason: SkipReason } {
  if (current.kind === 'gone') return { ok: false, reason: 'FACT_GONE' };
  const r = f.ref;
  switch (r.kind) {
    case 'price_drop':
    case 'back_on_market': {
      if (current.kind !== 'listing') return { ok: false, reason: 'FACT_MISMATCH' };
      if (r.source === 'mls' && !current.feedFresh) return { ok: false, reason: 'MLS_STALE' };
      if (r.source === 'mls' && !current.displayAllowed) return { ok: false, reason: 'NOT_DISPLAYABLE' };
      if (!ON_MARKET.has(current.status)) return { ok: false, reason: 'LISTING_INACTIVE' };
      if (r.kind === 'price_drop' && (current.priceCents === null || current.priceCents >= r.oldPriceCents)) return { ok: false, reason: 'PRICE_NOT_LOWER' };
      return { ok: true };
    }
    case 'home_anniversary':
      if (current.kind !== 'deal') return { ok: false, reason: 'FACT_MISMATCH' };
      if (current.status !== 'closed') return { ok: false, reason: 'DEAL_NOT_CLOSED' };
      if (!current.contactIsParty) return { ok: false, reason: 'NOT_A_PARTY' };
      return { ok: true };
    case 'home_value':
      if (current.kind !== 'home_value') return { ok: false, reason: 'FACT_MISMATCH' };
      return current.addressCurrent ? { ok: true } : { ok: false, reason: 'ADDRESS_NOT_CURRENT' };
    case 'deal_date_upcoming':
      if (current.kind !== 'deal_date') return { ok: false, reason: 'FACT_MISMATCH' };
      if (!current.confirmed) return { ok: false, reason: 'DATE_UNCONFIRMED' };
      if (current.dueVersion !== r.dueVersion || current.dueAt !== r.dueAt) return { ok: false, reason: 'DATE_CHANGED' };
      if (now !== undefined && now >= r.dueAt) return { ok: false, reason: 'DATE_PASSED' };
      return { ok: true };
  }
}

/** One line of a digested message for an item that still holds, with the CURRENT price (E83). */
export function alertItemLine(f: Firing, current: FactState): string {
  const r = f.ref;
  const mls = (n: string | null): string => (n === null ? '' : ` (MLS #${n})`);
  switch (r.kind) {
    case 'price_drop': {
      const now = current.kind === 'listing' && current.priceCents !== null ? current.priceCents : r.newPriceCents;
      return `${r.address}${mls(r.mlsNumber)}: now ${formatPriceCents(now)}, down from ${formatPriceCents(r.oldPriceCents)}`;
    }
    case 'back_on_market': {
      const p = current.kind === 'listing' && current.priceCents !== null ? current.priceCents : r.priceCents;
      return `${r.address}${mls(r.mlsNumber)}: back on the market${p === null ? '' : ` at ${formatPriceCents(p)}`}`;
    }
    case 'home_anniversary':
      return `${r.address}: ${r.year - Number(r.closedOn.slice(0, 4))} year${r.year - Number(r.closedOn.slice(0, 4)) === 1 ? '' : 's'} since closing`;
    case 'home_value':
      return `${r.address}: this month’s home value estimate`;
    case 'deal_date_upcoming':
      return r.label;
  }
}

export interface GuardSummary {
  hardBlock: boolean;
  /** a fair-housing match: never autonomous, the draft says "Check this" (R-FH-2) */
  fairHousing: boolean;
  /** any other guard issue (money, contract, sign-off, links...) */
  otherIssues: boolean;
}

/** Summarize core/assistant's `contentGuard` result for `planTriggerRun`. */
export function guardSummary(g: Pick<GuardResult, 'issues' | 'hardBlock'>): GuardSummary {
  return { hardBlock: g.hardBlock, fairHousing: g.issues.some((x) => x.code === 'FAIR_HOUSING'), otherIssues: g.issues.some((x) => x.code !== 'FAIR_HOUSING') };
}

export type DraftReason = 'PAUSED' | 'CONTENT_GUARD' | 'FAIR_HOUSING' | 'AVM_NOT_CLEARED' | 'AVM_RANGE_TOO_WIDE' | 'AVM_JUMP_TOO_LARGE';

export type TriggerRunPlan =
  | { action: 'send'; countsAsTouch: false }
  | { action: 'draft'; reasons: DraftReason[]; checkThis: boolean; countsAsTouch: false }
  | { action: 'skip'; reason: SkipReason; text: string; countsAsTouch: false };

const skip = (reason: SkipReason): TriggerRunPlan => ({ action: 'skip', reason, text: SKIP_REASON_TEXT[reason], countsAsTouch: false });

/**
 * What `executeTriggerRun` does with one firing (R-NURT-1, R-NURT-4, R-NURT-5, R-NURT-7, R-FH-2,
 * R-AVM-2). Re-checks the approval, the owner, the fact and the pause. A paused conversation turns
 * the firing into a draft (`converted_to_draft`); the DB guard also refuses an autonomous send
 * while paused. Trigger sends never count as touches and never change ownership (R-NURT-8).
 */
export function planTriggerRun(i: {
  firing: Firing;
  current: FactState;
  now: Instant;
  approvalCurrent: boolean;
  playbook: { scope: 'team' | 'agent'; ownerUserId: string | null };
  contactOwnerUserId: string | null;
  paused: boolean;
  /** the content guard over the rendered text, summarized by `guardSummary` */
  guard: GuardSummary;
  /** home_value firings: avmSendable's decision */
  avm?: AvmDecision;
}): TriggerRunPlan {
  if (!i.approvalCurrent) return skip('APPROVAL_NOT_CURRENT');
  if (i.contactOwnerUserId === null) return skip('NOT_OWNED');
  if (i.playbook.scope === 'agent' && i.playbook.ownerUserId !== i.contactOwnerUserId) return skip('OWNER_CHANGED');
  const fact = recheckFact(i.firing, i.current, i.now);
  if (!fact.ok) return skip(fact.reason);
  const reasons: DraftReason[] = [];
  if (i.firing.trigger === 'home_value') {
    const a = i.avm ?? { ok: false, reason: 'UNAVAILABLE' };
    if (!a.ok) {
      if (a.reason === 'UNAVAILABLE') return skip('NO_ESTIMATE');
      if (a.reason === 'NOT_DISPLAYABLE') return skip('ESTIMATE_NOT_DISPLAYABLE');
      if (a.reason === 'STALE') return skip('ESTIMATE_STALE');
      reasons.push(a.reason === 'NOT_CLEARED' ? 'AVM_NOT_CLEARED' : a.reason === 'RANGE_TOO_WIDE' ? 'AVM_RANGE_TOO_WIDE' : 'AVM_JUMP_TOO_LARGE');
    }
  }
  if (i.guard.hardBlock) return skip('PAYMENT_INSTRUCTIONS');
  if (i.paused) reasons.unshift('PAUSED');
  if (i.guard.fairHousing) reasons.push('FAIR_HOUSING');
  if (i.guard.otherIssues) reasons.push('CONTENT_GUARD');
  if (reasons.length > 0) return { action: 'draft', reasons, checkThis: i.guard.fairHousing, countsAsTouch: false };
  return { action: 'send', countsAsTouch: false };
}

/** A batch at send time: the items that still hold, or a visible skip when none does. */
export function planBatch(items: readonly { firing: Firing; plan: TriggerRunPlan }[]):
  | { action: 'skip'; reason: 'NOTHING_LEFT'; text: string; skipped: { firing: Firing; reason: SkipReason }[] }
  | { action: 'send' | 'draft'; keep: Firing[]; skipped: { firing: Firing; reason: SkipReason }[]; reasons: DraftReason[]; checkThis: boolean } {
  const skipped = items.flatMap((x) => (x.plan.action === 'skip' ? [{ firing: x.firing, reason: x.plan.reason }] : []));
  const keep = items.filter((x) => x.plan.action !== 'skip');
  if (keep.length === 0) return { action: 'skip', reason: 'NOTHING_LEFT', text: SKIP_REASON_TEXT.NOTHING_LEFT, skipped };
  const drafts = keep.flatMap((x) => (x.plan.action === 'draft' ? [x.plan] : []));
  return {
    action: drafts.length > 0 ? 'draft' : 'send',
    keep: keep.map((x) => x.firing),
    skipped,
    reasons: [...new Set(drafts.flatMap((d) => d.reasons))],
    checkThis: drafts.some((d) => d.checkThis),
  };
}
