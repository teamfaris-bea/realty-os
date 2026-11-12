// Architecture checks for module 52 (R-GATE-15, R-ADS-3, R-ADS-11, R-PRED-4, D1): source scans of apps/api/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';

installNetworkTripwire();

const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string, withTests = false): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p, withTests);
    return /\.tsx?$/.test(n) && (withTests || (!/\.test\.tsx?$/.test(n) && !n.endsWith('testing.ts'))) ? [p] : [];
  });
}
const SOURCES = files(SRC).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
const ALL = files(SRC, true).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') })).filter((f) => f.rel !== 'ads/architecture.test.ts');
const ADS = ALL.filter((f) => f.rel.startsWith('ads/'));

describe('module 52 architecture', () => {
  it('R-GATE-15 R-ADS-3: ads/dispatch.ts is the only caller of applyBudgetChange and pauseCampaign (besides the adapter and providers/**), tests included', () => {
    const offenders = ALL.filter((f) => !f.rel.startsWith('providers/') && f.rel !== 'ads/dispatch.ts' && f.rel !== 'ads/provider.ts' && /\.\s*(applyBudgetChange|pauseCampaign)\s*\(/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    const d = SOURCES.find((f) => f.rel === 'ads/dispatch.ts')!.text;
    expect(d).toMatch(/\.applyBudgetChange\(/);
    expect(d).toMatch(/\.pauseCampaign\(/);
    // the scan is live: a call written anywhere else is found
    expect(/\.\s*(applyBudgetChange|pauseCampaign)\s*\(/.test('await deps.ads.pauseCampaign(p)')).toBe(true);
  });

  it('D1 R-PRED-4: ads/** imports no contact dispatch, no prediction and no model provider', () => {
    for (const f of ADS) {
      expect(f.text, f.rel).not.toMatch(/comms\/dispatch(\.js)?['"]/);
      expect(f.text, f.rel).not.toMatch(/@realty\/core\/predict|core\/src\/predict/);
      expect(f.text, f.rel).not.toMatch(/providers\/anthropic(\.js)?['"]|\bproviders\.ai\b|\.ai\.complete\(/);
      expect(f.text, f.rel).not.toMatch(/dispatchOutbound|dialOutbound/);
    }
  });

  it('R-ADS-3 R-ADS-11: only ads/** writes ad_allocation_events and ad_campaigns, and only ads/repo.ts writes ads_sync costs', () => {
    const ledgerWriters = SOURCES.filter((f) => /(INSERT INTO|UPDATE)\s+(ad_allocation_events|ad_campaigns)\b/.test(f.text)).map((f) => f.rel);
    expect(ledgerWriters.length).toBeGreaterThan(0);
    expect(ledgerWriters.filter((r) => !r.startsWith('ads/'))).toEqual([]);
    // a statement that writes lead_source_costs naming the ads_sync origin (insights/owner.ts writes manual rows only)
    const adsSyncWrite = /(INSERT INTO|UPDATE)\s+lead_source_costs\b[^`]*'ads_sync'/;
    const costWriters = SOURCES.filter((f) => adsSyncWrite.test(f.text)).map((f) => f.rel);
    expect(costWriters).toEqual(['ads/repo.ts']);
    expect(adsSyncWrite.test("sql`INSERT INTO lead_source_costs (origin) VALUES ('ads_sync')`")).toBe(true);
    expect(SOURCES.find((f) => f.rel === 'insights/owner.ts')!.text).toMatch(/INSERT INTO lead_source_costs[^`]*'manual'/);
  });
});
