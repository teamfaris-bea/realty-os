// Dollars by lead source (R-OWNER-2, R-OWNER-1 core part; E107, E108).
//
// - Commission of deals CLOSED in the period, summed by the deal's immutable `lead_source_id`.
// - Every row carries its denominators: closings, and deals with a known commission.
// - Deals left out are counted and listed: closed deals with no known commission ("missing
//   commission", E107: they still count as closings, but not in the commission sum) and closed
//   deals with no source (they belong to no row).
// - Cost per closing = cost / closings, half-up to whole cents. With zero closings it is null and
//   said in words "— (0 closings)", never $0 or ∞ (E108).
//
// Decisions (not fixed by the docs; documented here and in the module report):
// - Costs of both origins (manual and ads_sync) are summed; the row also shows each origin.
// - A source with closings but no cost row in the period has a null cost per closing and the words
//   "— (no cost entered)": a missing cost is not a $0 cost.
// - Rows exist for every source with a closing or a cost row in the period, sorted by commission
//   (desc), then closings (desc), then source id.
import { type DealId, type LeadSourceId, type LocalDate, localDateOf } from '../foundation/index.js';
import { divRoundHalfUp, formatCents, plural } from './money.js';
import type { DealFinancialRow, InsightDeal, InsightPeriod, SourceCostRow, SourceDollars, SourceRow } from './types.js';

function inPeriod(d: LocalDate, p: InsightPeriod): boolean {
  return d >= p.start && d < p.endExclusive; // ISO dates compare lexicographically
}

interface Acc {
  closings: number;
  dealsWithCommission: number;
  missingCommission: number;
  commissionCents: number;
  manual: number;
  adsSync: number;
  costRows: number;
}

const emptyAcc = (): Acc => ({ closings: 0, dealsWithCommission: 0, missingCommission: 0, commissionCents: 0, manual: 0, adsSync: 0, costRows: 0 });

function assertCents(v: number, what: string): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what}: expected non-negative integer cents, got ${v}`);
}

/** The cost per closing and its words (E108). */
export function costPerClosing(costCents: number, closings: number, costRows: number): { cents: number | null; words: string } {
  if (closings === 0) return { cents: null, words: '— (0 closings)' };
  if (costRows === 0) return { cents: null, words: `— (no cost entered; ${plural(closings, 'closing', 'closings')})` };
  const cents = divRoundHalfUp(costCents, closings);
  return { cents, words: `${formatCents(cents)} per closing (${plural(closings, 'closing', 'closings')})` };
}

export function sourceDollars(
  deals: readonly InsightDeal[],
  financials: readonly DealFinancialRow[],
  costs: readonly SourceCostRow[],
  period: InsightPeriod,
): SourceDollars {
  const commissionOf = new Map<DealId, number | null>();
  for (const f of financials) {
    if (f.grossCommissionCents !== null) assertCents(f.grossCommissionCents, 'gross_commission_cents');
    commissionOf.set(f.dealId, f.grossCommissionCents);
  }

  const bySource = new Map<LeadSourceId, Acc>();
  const accFor = (id: LeadSourceId): Acc => {
    let a = bySource.get(id);
    if (!a) {
      a = emptyAcc();
      bySource.set(id, a);
    }
    return a;
  };

  const missing: DealId[] = [];
  const noSource: DealId[] = [];
  let closedInPeriod = 0;
  const seen = new Set<DealId>();
  for (const d of deals) {
    if (d.stage !== 'closed' || d.closedAt === null) continue;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    if (!inPeriod(localDateOf(d.closedAt, period.zone), period)) continue;
    closedInPeriod += 1;
    const commission = commissionOf.get(d.id) ?? null;
    if (commission === null) missing.push(d.id);
    if (d.leadSourceId === null) {
      noSource.push(d.id);
      continue;
    }
    const a = accFor(d.leadSourceId);
    a.closings += 1;
    if (commission === null) a.missingCommission += 1;
    else {
      a.dealsWithCommission += 1;
      a.commissionCents += commission;
    }
  }

  for (const c of costs) {
    if (!inPeriod(c.month, period)) continue;
    assertCents(c.amountCents, 'amount_cents');
    const a = accFor(c.leadSourceId);
    a.costRows += 1;
    if (c.origin === 'manual') a.manual += c.amountCents;
    else a.adsSync += c.amountCents;
  }

  const rows: SourceRow[] = [...bySource.entries()].map(([leadSourceId, a]) => {
    const costCents = a.manual + a.adsSync;
    const cpc = costPerClosing(costCents, a.closings, a.costRows);
    return {
      leadSourceId,
      closings: a.closings,
      dealsWithCommission: a.dealsWithCommission,
      missingCommission: a.missingCommission,
      commissionCents: a.commissionCents,
      costCents,
      costByOrigin: { manual: a.manual, adsSync: a.adsSync },
      costRows: a.costRows,
      costPerClosingCents: cpc.cents,
      costPerClosingWords: cpc.words,
    };
  });
  rows.sort(
    (x, y) =>
      y.commissionCents - x.commissionCents ||
      y.closings - x.closings ||
      (x.leadSourceId < y.leadSourceId ? -1 : x.leadSourceId > y.leadSourceId ? 1 : 0),
  );

  const sortIds = (ids: DealId[]): DealId[] => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    rows,
    excluded: {
      missingCommission: { count: missing.length, dealIds: sortIds(missing) },
      noSource: { count: noSource.length, dealIds: sortIds(noSource) },
    },
    closedInPeriod,
  };
}
