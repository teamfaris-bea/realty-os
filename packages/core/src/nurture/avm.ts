// Monthly home values (R-AVM-1..3, E98, E99). The AVM vendor is platform configuration; its
// estimates arrive as `home_valuations` rows. A home-value step sends on its own only when
// `platform:avm` is cleared and the estimate is fresh, displayable, within the range limit and within
// the jump limit; otherwise it becomes a draft for the agent or a visible skip. It never says
// "unchanged" when no value was available. **VERIFY WITH COUNSEL (C6)**: wording ("an estimate, not
// an appraisal") and state rules on valuations by non-appraisers.
import { formatPriceCents } from '../assistant/index.js';

export interface AvmEstimate {
  status: 'ok' | 'unavailable' | 'error';
  /** only an `ok` estimate carries a value (R-AVM-1, DB CHECK) */
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  /** `YYYY-MM-DD` */
  asOf: string | null;
  /** from the vendor licence; never defaulted to true (VERIFY) */
  displayAllowed: boolean;
  provider: string;
}

export interface AvmSettings {
  /** tenant_settings.avm_max_range_bps: (high − low) / value */
  maxRangeBps: number;
  /** month-over-month change above which the note becomes a draft (E98: 30 % ⇒ draft) */
  maxJumpBps: number;
  /** an estimate older than this many days is stale */
  maxAgeDays: number;
  /** today, `YYYY-MM-DD` */
  today: string;
}

export const DEFAULT_AVM_JUMP_BPS = 1000;
export const DEFAULT_AVM_MAX_AGE_DAYS = 45;

export type AvmReason = 'NOT_CLEARED' | 'UNAVAILABLE' | 'NOT_DISPLAYABLE' | 'RANGE_TOO_WIDE' | 'JUMP_TOO_LARGE' | 'STALE';
export type AvmDecision = { ok: true } | { ok: false; reason: AvmReason };

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * R-AVM-2. Order: no value ⇒ UNAVAILABLE (E99: skipped "No estimate available", never
 * "unchanged"); not displayable; stale; not cleared; range too wide; jump too large (E98).
 */
export function avmSendable(e: AvmEstimate, prior: AvmEstimate | null, s: AvmSettings, cleared: boolean): AvmDecision {
  if (e.status !== 'ok' || e.valueCents === null || e.valueCents <= 0) return { ok: false, reason: 'UNAVAILABLE' };
  if (!e.displayAllowed) return { ok: false, reason: 'NOT_DISPLAYABLE' };
  if (e.asOf === null || !/^\d{4}-\d{2}-\d{2}$/.test(e.asOf) || days(e.asOf, s.today) > s.maxAgeDays) return { ok: false, reason: 'STALE' };
  if (!cleared) return { ok: false, reason: 'NOT_CLEARED' };
  if (e.lowCents === null || e.highCents === null || ((e.highCents - e.lowCents) * 10_000) / e.valueCents > s.maxRangeBps) return { ok: false, reason: 'RANGE_TOO_WIDE' };
  if (prior !== null && prior.status === 'ok' && prior.valueCents !== null && prior.valueCents > 0) {
    if ((Math.abs(e.valueCents - prior.valueCents) * 10_000) / prior.valueCents > s.maxJumpBps) return { ok: false, reason: 'JUMP_TOO_LARGE' };
  }
  return { ok: true };
}

/** Basis points of change from the prior ok estimate (home_valuations.change_from_prior_bps), or null. */
export function changeFromPriorBps(e: AvmEstimate, prior: AvmEstimate | null): number | null {
  if (e.status !== 'ok' || e.valueCents === null || prior === null || prior.status !== 'ok' || prior.valueCents === null || prior.valueCents <= 0) return null;
  return Math.round(((e.valueCents - prior.valueCents) * 10_000) / prior.valueCents);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The home-value sentence (R-AVM-1): provider, range, as-of date and "an estimate, not an
 * appraisal". Null when there is no value: callers skip with "No estimate available".
 */
export function homeValueText(e: AvmEstimate): string | null {
  if (e.status !== 'ok' || e.valueCents === null || e.asOf === null) return null;
  const [y, m, d] = e.asOf.split('-');
  const asOf = `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
  const range = e.lowCents !== null && e.highCents !== null ? ` (range ${formatPriceCents(e.lowCents)}–${formatPriceCents(e.highCents)})` : '';
  return `Estimated value: ${formatPriceCents(e.valueCents)}${range}, from ${e.provider} as of ${asOf}. This is an estimate, not an appraisal.`;
}

/**
 * R-AVM-3: request a valuation only for a contact who can still receive the step (the send-time
 * preview allows it) at a current address, at most once per address and month. Returns the firing
 * key or why not.
 */
export function avmRequest(i: { contactAddressId: string; month: string; addressCurrent: boolean; previewAllows: boolean; alreadyRequestedThisMonth: boolean }):
  | { request: true; triggerKey: string }
  | { request: false; reason: 'ADDRESS_NOT_CURRENT' | 'CANNOT_RECEIVE' | 'ALREADY_REQUESTED' } {
  if (!i.addressCurrent) return { request: false, reason: 'ADDRESS_NOT_CURRENT' };
  if (!i.previewAllows) return { request: false, reason: 'CANNOT_RECEIVE' };
  if (i.alreadyRequestedThisMonth) return { request: false, reason: 'ALREADY_REQUESTED' };
  return { request: true, triggerKey: `avm:${i.contactAddressId}:${i.month}` };
}
