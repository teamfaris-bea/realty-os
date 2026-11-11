// Home anniversaries (R-NURT-2, E101): a closed deal fires once a year on its closing date; a Feb 29
// closing fires Feb 28 in common years. The daily scan (module 26) passes today's local date; the
// firing key `anniversary:{deal}:{yyyy}:{contact}` makes a second scan the same year a no-op, and
// the post-closing template no longer has an anniversary step (no duplicate message).
import type { Instant } from '../foundation/index.js';
import type { Fact } from './types.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The anniversary of `closedOn` (`YYYY-MM-DD`) in `year`; Feb 29 ⇒ Feb 28 in common years. */
export function anniversaryOn(closedOn: string, year: number): string {
  const m = DATE_RE.exec(closedOn);
  if (m === null) throw new Error(`anniversaryOn: not a date: ${closedOn}`);
  const md = `${m[2]}-${m[3]}`;
  const y = String(year).padStart(4, '0');
  return md === '02-29' && !isLeap(year) ? `${y}-02-28` : `${y}-${md}`;
}

export interface ClosedDeal {
  dealId: string;
  status: 'open' | 'closed' | 'canceled';
  closedOn: string | null;
  /** client contacts on the deal (each gets their own firing) */
  contactIds: readonly string[];
  address: string;
}

/**
 * Anniversary facts due on `today` (`YYYY-MM-DD`, the tenant's local date): closed deals whose
 * anniversary is today, from the first anniversary on. `at` is the scan instant.
 */
export function anniversariesDue(deals: readonly ClosedDeal[], today: string, at: Instant): Extract<Fact, { kind: 'home_anniversary' }>[] {
  const t = DATE_RE.exec(today);
  if (t === null) throw new Error(`anniversariesDue: not a date: ${today}`);
  const year = Number(t[1]);
  const out: Extract<Fact, { kind: 'home_anniversary' }>[] = [];
  for (const d of deals) {
    if (d.status !== 'closed' || d.closedOn === null || !DATE_RE.test(d.closedOn)) continue;
    if (Number(d.closedOn.slice(0, 4)) >= year) continue;
    if (anniversaryOn(d.closedOn, year) !== today) continue;
    for (const contactId of [...new Set(d.contactIds)].sort()) out.push({ kind: 'home_anniversary', dealId: d.dealId, contactId, closedOn: d.closedOn, year, at, address: d.address });
  }
  return out;
}
