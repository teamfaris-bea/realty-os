// A transcription of app.ad_allocation_cap_check() (0018 §15) over an in-memory ledger: the oracle the
// property tests hold proposeReallocation to. It counts, for every campaign of the tenant:
//   this run's planned row ⇒ its to_daily_cents; not active ⇒ 0; latest planned/applied ⇒
//   GREATEST(to, daily_budget_cents); latest paused ⇒ 0; otherwise daily_budget_cents.
// "latest" is DISTINCT ON (campaign_id) ORDER BY (run_id = NEW.run_id AND kind = 'planned') DESC,
// occurred_at DESC, id DESC.
export interface CampaignRow { id: string; status: string; daily_budget_cents: number }
export interface LedgerRow { id: string; run_id: string; campaign_id: string; event_kind: 'planned' | 'applied' | 'failed' | 'paused'; to_daily_cents: number; occurred_at: number }

export function latestOf(ledger: readonly LedgerRow[], campaignId: string, runId: string | null): LedgerRow | undefined {
  const rows = ledger.filter((e) => e.campaign_id === campaignId);
  rows.sort((a, b) => {
    const pa = a.run_id === runId && a.event_kind === 'planned' ? 1 : 0;
    const pb = b.run_id === runId && b.event_kind === 'planned' ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (a.occurred_at !== b.occurred_at) return b.occurred_at - a.occurred_at;
    return a.id < b.id ? 1 : -1;
  });
  return rows[0];
}

export function triggerTotal(campaigns: readonly CampaignRow[], ledger: readonly LedgerRow[], runId: string): number {
  let total = 0;
  for (const c of campaigns) {
    const l = latestOf(ledger, c.id, runId);
    if (l !== undefined && l.run_id === runId && l.event_kind === 'planned') total += l.to_daily_cents;
    else if (c.status !== 'active') total += 0;
    else if (l !== undefined && (l.event_kind === 'planned' || l.event_kind === 'applied')) total += Math.max(l.to_daily_cents, c.daily_budget_cents);
    else if (l !== undefined && l.event_kind === 'paused') total += 0;
    else total += c.daily_budget_cents;
  }
  return total;
}

/** x->>'campaign_id' = NEW.campaign_id::text AND x->>'to_daily_cents' = NEW.to_daily_cents::text, via a JSON round trip. */
export function payloadNames(payloadJson: string, campaignId: string, toDailyCents: bigint): boolean {
  const changes = (JSON.parse(payloadJson) as { changes: unknown }).changes;
  if (!Array.isArray(changes)) return false;
  // ->> renders a JSON number by its text; re-extract that text from the raw JSON rather than from a parsed number.
  return changes.some((x: Record<string, unknown>) => x.campaign_id === campaignId
    && new RegExp(`"campaign_id":"${campaignId}","to_daily_cents":${toDailyCents.toString()}[,}]`).test(payloadJson));
}
