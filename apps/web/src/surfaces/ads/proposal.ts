// Defensive reading of a stored ad_reallocation payload (GET /ads pendingProposal / latestHold; the API types it as a
// plain record, apps/api/src/ads/schemas.ts Shown). Only the v:1 shapes ads/propose.ts writes are understood: anything
// else reads as null, and the card then shows only the explanation, with no Approve (R-STAFF-4).

export interface ProposalRowWords {
  campaignId: string;
  fromDailyCents: number;
  toDailyCents: number;
  changed: boolean;
  /** core/ads ProposalRow.sentence (a plain sentence with its denominators), or null when absent */
  sentence: string | null;
}

export interface ParsedProposal {
  kind: 'weekly' | 'resume';
  rows: ProposalRowWords[];
  totals: { currentDailyCents: number; proposedDailyCents: number; ceilingDailyCents: number };
}

export interface ParsedHold {
  windowDays: number;
  minAgreements: number | null;
  campaigns: { campaignId: string; agreements: number; closings: number; spendCents: number }[];
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCents = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64;

export function parseProposal(p: unknown): ParsedProposal | null {
  if (!isObj(p) || p.v !== 1 || 'hold' in p) return null;
  if (p.kind !== undefined && p.kind !== 'weekly' && p.kind !== 'resume') return null;
  const { rows, changes, totals } = p;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500 || !Array.isArray(changes) || changes.length === 0) return null;
  const out: ProposalRowWords[] = [];
  for (const r of rows as unknown[]) {
    if (!isObj(r) || !isId(r.campaignId) || !isCents(r.fromDailyCents) || !isCents(r.toDailyCents)) return null;
    out.push({
      campaignId: r.campaignId,
      fromDailyCents: r.fromDailyCents,
      toDailyCents: r.toDailyCents,
      changed: r.changed === true,
      sentence: typeof r.sentence === 'string' && r.sentence.trim() !== '' ? r.sentence : null,
    });
  }
  // every change must be one of the rows, at the row's amount (what Approve will plan)
  for (const c of changes as unknown[]) {
    if (!isObj(c) || !isId(c.campaign_id) || !isCents(c.to_daily_cents)) return null;
    if (!out.some((r) => r.campaignId === c.campaign_id && r.toDailyCents === c.to_daily_cents)) return null;
  }
  if (!isObj(totals) || !isCents(totals.currentDailyCents) || !isCents(totals.proposedDailyCents) || !isCents(totals.ceilingDailyCents)) return null;
  return {
    kind: p.kind === 'resume' ? 'resume' : 'weekly',
    rows: out,
    totals: { currentDailyCents: totals.currentDailyCents, proposedDailyCents: totals.proposedDailyCents, ceilingDailyCents: totals.ceilingDailyCents },
  };
}

export function parseHold(p: unknown): ParsedHold | null {
  if (!isObj(p) || p.v !== 1 || typeof p.hold !== 'string' || !isObj(p.counts)) return null;
  const c = p.counts;
  if (!isCents(c.windowDays) || !Array.isArray(c.campaigns)) return null;
  const campaigns: ParsedHold['campaigns'] = [];
  for (const x of c.campaigns as unknown[]) {
    if (!isObj(x) || !isId(x.campaignId) || !isCents(x.agreements) || !isCents(x.closings) || !isCents(x.spendCents)) return null;
    campaigns.push({ campaignId: x.campaignId, agreements: x.agreements, closings: x.closings, spendCents: x.spendCents });
  }
  return { windowDays: c.windowDays, minAgreements: isCents(c.minAgreements) ? c.minAgreements : null, campaigns };
}
