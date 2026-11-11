// Contact points (R-PAR-11, R-PAR-12). An address is never edited in place: "editing" a phone or email
// is a plan that removes the old point (reason `replaced`) and adds the new one. Consent, suppressions
// and opt-outs stay keyed by each address's HMAC, so the old number keeps its STOP and the new one
// starts with whatever its own HMAC carries. A removed point keeps blocking the person's other phones
// unless it was removed as a CONFIRMED wrong number (the consent ledger holds a wrong_number revoke).
import { normalizeEmail, normalizePhone } from '../../foundation/normalize.js';

export const POINT_KINDS = ['phone', 'email'] as const;
export type PointKind = (typeof POINT_KINDS)[number];
export const POINT_LABELS = ['mobile', 'home', 'work', 'other'] as const;
export type PointLabel = (typeof POINT_LABELS)[number];
export const REMOVED_REASONS = ['replaced', 'old', 'wrong_number'] as const;
export type RemovedReason = (typeof REMOVED_REASONS)[number];

export interface ExistingPoint {
  id: string;
  kind: PointKind;
  address: string;
  label: PointLabel;
  removed: boolean;
  removedReason: RemovedReason | null;
}

export interface NewPoint {
  kind: PointKind;
  /** canonical form: E.164 or lower-case email */
  address: string;
  label: PointLabel;
}

export type PointCode = 'PHONE_INVALID' | 'EMAIL_INVALID' | 'POINT_REMOVED' | 'POINT_UNCHANGED' | 'WRONG_NUMBER_NOT_RECORDED';

/** Normalizes a typed phone/email to its canonical address. */
export function normalizePointAddress(kind: PointKind, raw: string): { ok: true; address: string } | { ok: false; code: 'PHONE_INVALID' | 'EMAIL_INVALID' } {
  if (kind === 'phone') {
    const r = normalizePhone(raw, 'US');
    return r.ok ? { ok: true, address: r.e164 } : { ok: false, code: 'PHONE_INVALID' };
  }
  const r = normalizeEmail(raw);
  return r.ok ? { ok: true, address: r.email } : { ok: false, code: 'EMAIL_INVALID' };
}

export interface ReplacePlan {
  remove: { id: string; reason: 'replaced' };
  add: NewPoint;
}

/**
 * The replace-number plan. Never an UPDATE of the address: always remove (`replaced`) + add. The new
 * point keeps the old label unless one is given. Replacing a removed point, or with the same address,
 * is refused.
 */
export function planReplacePoint(old: ExistingPoint, rawNew: string, label?: PointLabel): { ok: true; plan: ReplacePlan } | { ok: false; code: PointCode } {
  if (old.removed) return { ok: false, code: 'POINT_REMOVED' };
  const n = normalizePointAddress(old.kind, rawNew);
  if (!n.ok) return n;
  if (n.address === old.address) return { ok: false, code: 'POINT_UNCHANGED' };
  return { ok: true, plan: { remove: { id: old.id, reason: 'replaced' }, add: { kind: old.kind, address: n.address, label: label ?? old.label } } };
}

/**
 * Why a point is removed. `wrong_number` only when the consent ledger already proves it (a
 * wrong-number revoke for that address written by the call-outcome or wrong-number-reply path); a
 * status edit alone is never proof (review S1).
 */
export function removalReason(asked: 'old' | 'wrong_number', ledgerHasWrongNumberRevoke: boolean): { ok: true; reason: RemovedReason } | { ok: false; code: 'WRONG_NUMBER_NOT_RECORDED' } {
  if (asked === 'wrong_number' && !ledgerHasWrongNumberRevoke) return { ok: false, code: 'WRONG_NUMBER_NOT_RECORDED' };
  return { ok: true, reason: asked };
}

/** R-PAR-12: whether a point's opt-out still counts for the person's other phones. */
export function pointCountsForOptOut(p: Pick<ExistingPoint, 'removed' | 'removedReason'>): boolean {
  return !p.removed || p.removedReason !== 'wrong_number';
}

/**
 * A confirmed wrong number is never restored: it is final for its person (R-PAR-12). The person has one row per
 * address, so it cannot be added again either; the API answers WRONG_NUMBER_FINAL.
 */
export function restorable(p: Pick<ExistingPoint, 'removed' | 'removedReason'>): boolean {
  return p.removed && p.removedReason !== 'wrong_number';
}

/** The last four digits for an over-block explanation ("a number you removed (•••1234) opted out"). */
export function maskedTail(address: string): string {
  const digits = address.replace(/\D/g, '');
  return `•••${digits.slice(-4)}`;
}
