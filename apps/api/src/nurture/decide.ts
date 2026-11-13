// Pure decisions of api/nurture (PHASE2_3_PLAN §5.4 #26; R-NURT-1..5, R-NURT-7, R-NURT-8, R-FH-2, R-AST-20).
// No I/O: executeTriggerRun reads the facts under the contact lock and passes them in; the property tests
// (decide.property.test.ts) drive these functions directly.
//
//   firingOfRow(row)        a stored trigger run (playbook_step_runs + trigger_ref) back to a core Firing
//   apiSkip(...)            the API-level skips core cannot see (contact merged away, step gone, a kind that
//                           is not available yet, an anniversary the post-closing playbook already sent, ...)
//   decideBatch(...)        send | draft | skip for the one digested message, after core planTriggerRun /
//                           planBatch decided each item: anything that is not plainly sendable becomes a draft
//                           for the contact's owner (paused, fair housing, any autonomy downgrade); wiring
//                           details are never sendable at all; nothing is ever sent without an approved,
//                           current version. Never a touch, never an ownership change (R-NURT-8).
//   digestBody(...)         the one message text for several items (R-NURT-3)
import type { DowngradeReason, EvidenceRef, PlaybookContent, TriggerKind } from '@realty/core/assistant';
import { TRIGGER_KINDS } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import { type DraftReason, type Firing, type FiringRef, SKIP_REASON_TEXT, type SkipReason } from '@realty/core/nurture';

/** Skips only the API can see (stored in trigger_ref.skip with a visible sentence, never silent). */
export type ApiSkipReason = 'CONTACT_REMOVED' | 'STEP_REMOVED' | 'NOT_AVAILABLE_YET' | 'NO_LONGER_FOLLOWED' | 'ANNIVERSARY_ALREADY_SENT' | 'NOT_QUEUED' | 'DATE_COMPLETED' | 'NOT_OUR_CLIENT' | 'AI_ISA_ACTIVE';
export type RunSkipReason = SkipReason | ApiSkipReason;

export const API_SKIP_TEXT: Readonly<Record<ApiSkipReason, string>> = {
  CONTACT_REMOVED: 'This contact was merged into another record or removed.',
  // R-ISA-2 (D12 proposed; b12 review B12X-4): no trigger message goes out while the person is under live AI care
  AI_ISA_ACTIVE: 'This person was under AI care, so this alert was not sent.',
  STEP_REMOVED: 'The approved playbook no longer has this alert.',
  NOT_AVAILABLE_YET: 'This kind of alert is not available yet.',
  NO_LONGER_FOLLOWED: 'The contact no longer follows this home.',
  ANNIVERSARY_ALREADY_SENT: 'The home anniversary note already went out this year.',
  NOT_QUEUED: 'The message could not be queued (no address or sender to use).',
  // module 31 (R-TXN-2): a milestone marked done after its update was planned sends nothing
  DATE_COMPLETED: 'The date was marked done after this update was planned.',
  // K1 (b8 deals sends/F1, R-TXN-4): the deal's side says the team does not represent this person
  NOT_OUR_CLIENT: 'This contact is not this team’s client on the deal (the other side, or a lease deal), so the team’s automatic updates do not go to them.',
};

export function skipText(r: RunSkipReason): string {
  return (API_SKIP_TEXT as Record<string, string>)[r] ?? SKIP_REASON_TEXT[r as SkipReason];
}

/** What a trigger run stores in `trigger_ref` (a jsonb object, R-NURT-1): ids, codes, facts and instants. */
export interface StoredTriggerRef {
  v: 1;
  trigger: TriggerKind;
  playbookId: string;
  /** the firing's own instant (fact time + step offset); scheduled_for is the digest's send time */
  firedAt: number;
  ref: FiringRef;
  evidence: EvidenceRef[];
  /** set when the run is skipped: the visible reason */
  skip?: { reason: RunSkipReason; text: string };
}

export interface TriggerRunRow {
  id: string;
  contactId: string;
  versionId: string;
  stepKey: string;
  triggerKey: string;
  scheduledFor: Instant;
  triggerRef: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The stored run as a core Firing, or null when its trigger_ref is not one we wrote (fail closed). */
export function firingOfRow(r: TriggerRunRow): Firing | null {
  const t = r.triggerRef;
  if (!isObj(t) || t['v'] !== 1 || !isObj(t['ref']) || typeof t['playbookId'] !== 'string' || typeof t['firedAt'] !== 'number') return null;
  const trigger = t['trigger'];
  if (typeof trigger !== 'string' || !(TRIGGER_KINDS as readonly string[]).includes(trigger)) return null;
  const ref = t['ref'] as unknown as FiringRef;
  if (ref.kind !== trigger) return null;
  return {
    triggerKey: r.triggerKey,
    trigger: trigger as TriggerKind,
    contactId: r.contactId,
    playbookId: t['playbookId'] as string,
    versionId: r.versionId,
    stepKey: r.stepKey,
    scheduledFor: t['firedAt'] as Instant,
    ref,
    evidence: Array.isArray(t['evidence']) ? (t['evidence'] as EvidenceRef[]) : [],
  };
}

export function storedRefOf(f: Firing): StoredTriggerRef {
  return { v: 1, trigger: f.trigger, playbookId: f.playbookId, firedAt: f.scheduledFor, ref: f.ref, evidence: f.evidence };
}

/** Trigger kinds that can fire (home values from wave 2C's avm.refresh; deal dates fire from module 31). */
export const FIRES_IN_THIS_RELEASE: ReadonlySet<TriggerKind> = new Set<TriggerKind>(['price_drop', 'back_on_market', 'home_anniversary', 'home_value', 'deal_date_upcoming']);

/**
 * The API-level checks before core's planTriggerRun: the contact is a live record (not merged away, not
 * deleted), the approved content still has the step, the kind can fire now, the contact still follows
 * the home, and the yearly anniversary was not already sent by a post-closing enrollment.
 */
export function apiSkip(i: {
  contactLive: boolean;
  content: Extract<PlaybookContent, { kind: 'triggers' }> | null;
  firing: Firing;
  stillFollowed: boolean;
  anniversaryAlreadySent: boolean;
}): ApiSkipReason | null {
  if (!i.contactLive) return 'CONTACT_REMOVED';
  if (i.content === null || !i.content.triggers.some((t) => t.stepKey === i.firing.stepKey && t.trigger === i.firing.trigger)) return 'STEP_REMOVED';
  if (!FIRES_IN_THIS_RELEASE.has(i.firing.trigger)) return 'NOT_AVAILABLE_YET';
  if ((i.firing.trigger === 'price_drop' || i.firing.trigger === 'back_on_market') && !i.stillFollowed) return 'NO_LONGER_FOLLOWED';
  if (i.firing.trigger === 'home_anniversary' && i.anniversaryAlreadySent) return 'ANNIVERSARY_ALREADY_SENT';
  return null;
}

export type BatchDecision =
  | { action: 'send'; countsAsTouch: false }
  | { action: 'draft'; reasons: (DraftReason | 'AUTONOMY_DOWNGRADE')[]; downgrade: DowngradeReason | null; checkThis: boolean; countsAsTouch: false }
  | { action: 'skip'; reason: 'PAYMENT_INSTRUCTIONS' | 'NOT_OWNED'; countsAsTouch: false };

/**
 * The one message of a batch whose items still hold (planBatch kept at least one). `verdict` is core
 * authorizeAutonomousAction over the exact text (the check dispatch repeats at send time); `guard` is the
 * content guard's fair-housing and hard-block view of that text; `itemsDraft` is planBatch's own draft
 * outcome (pause, AVM). A send needs ALL of: not paused, no item draft, an allowed verdict, no fair-housing
 * match. Anything else is a draft for the owner, never dropped (R-NURT-3, R-NURT-5, R-FH-2).
 */
export function decideBatch(i: {
  paused: boolean;
  itemsDraft: { draft: boolean; reasons: DraftReason[]; checkThis: boolean };
  verdict: { allow: true } | { allow: false; downgrade: DowngradeReason };
  guard: { hardBlock: boolean; fairHousing: boolean };
  ownerUserId: string | null;
}): BatchDecision {
  if (i.guard.hardBlock || (!i.verdict.allow && i.verdict.downgrade === 'PAYMENT_INSTRUCTIONS')) return { action: 'skip', reason: 'PAYMENT_INSTRUCTIONS', countsAsTouch: false };
  if (i.ownerUserId === null) return { action: 'skip', reason: 'NOT_OWNED', countsAsTouch: false };
  const reasons: (DraftReason | 'AUTONOMY_DOWNGRADE')[] = [];
  if (i.paused) reasons.push('PAUSED');
  for (const r of i.itemsDraft.reasons) if (!reasons.includes(r)) reasons.push(r);
  if (i.guard.fairHousing && !reasons.includes('FAIR_HOUSING')) reasons.push('FAIR_HOUSING');
  if (!i.verdict.allow) reasons.push('AUTONOMY_DOWNGRADE');
  if (reasons.length === 0 && !i.itemsDraft.draft) return { action: 'send', countsAsTouch: false };
  return { action: 'draft', reasons, downgrade: i.verdict.allow ? null : i.verdict.downgrade, checkThis: i.guard.fairHousing || i.itemsDraft.checkThis, countsAsTouch: false };
}

/** The draft card's one line (≤ 300 chars), in plain words. */
export function draftExplanation(d: Extract<BatchDecision, { action: 'draft' }>, downgradeText: string | null): string {
  if (d.reasons.includes('PAUSED')) return 'They replied, so automatic alerts are paused. This alert waits for you: send it, edit it or dismiss it.';
  if (d.checkThis) return 'Check this: the wording may raise a fair-housing concern, so it was not sent on its own.';
  // home values (R-AVM-2): the failed check in plain words
  if (d.reasons.includes('AVM_NOT_CLEARED')) return 'Home-value notes wait for counsel review, so this one was not sent on its own. Check it, then send it, edit it or dismiss it.';
  if (d.reasons.includes('AVM_JUMP_TOO_LARGE')) return 'The estimate moved a lot since last month, so this note was not sent on its own. Check it before it goes out.';
  if (d.reasons.includes('AVM_RANGE_TOO_WIDE')) return 'The estimate’s range is wider than your team’s limit, so this note was not sent on its own. Check it before it goes out.';
  if (downgradeText !== null) return downgradeText;
  return 'This alert needs a quick check before it goes out.';
}

/**
 * Strips template markers, line breaks, other control characters and bidi controls from data we did not write
 * (MLS addresses, licence notes, AVM vendor strings) before composing.
 */
export function literal(s: string): string {
  // line breaks become spaces, other control and bidi characters go, then template markers (until none re-forms)
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/\{\{|\}\}/g, '');
  }
  return out.trim();
}

/**
 * The digest template (R-NURT-3): several items in one message. Fixed wording, like the Phase 1
 * saved-search digest; the items are the facts, one per line. The sign-off, brokerage name and opt-out
 * lines are added by core renderStep like every playbook message.
 */
export function digestTemplate(lines: readonly string[]): string {
  return [`Hi {{first_name}}, ${lines.length} updates on homes you follow:`, ...lines.map((l) => `- ${literal(l)}`), 'Reply here if you want to see any of them.'].join('\n');
}

export const DIGEST_SUBJECT = (n: number): string => `${n} updates on homes you follow`;
