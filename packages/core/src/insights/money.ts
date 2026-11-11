// Integer-cent helpers for the owner view (R-OWNER-2). Money is never a float: sums stay integer
// cents, and the one division (cost per closing) rounds half-up to whole cents in integer arithmetic.

/**
 * `numerator / denominator` rounded half-up (x.5 rounds away from zero for non-negative inputs) to
 * an integer, computed without floating-point division. Both inputs must be non-negative integers
 * and `denominator > 0`.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator <= 0) {
    throw new RangeError(`divRoundHalfUp: expected integers numerator >= 0 and denominator > 0, got ${numerator}/${denominator}`);
  }
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  return 2 * r >= denominator ? q + 1 : q;
}

/** "$1,234.56" for 123456 cents (non-negative integer cents; negatives get a leading "-"). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${rest}`;
}

/** "1 closing" / "3 closings". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
