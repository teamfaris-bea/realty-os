// R-AST-13: no output shape carries a confidence, probability or score; none takes or returns tenant_id.
import { describe, expect, it } from 'vitest';
import { overspend } from './overspend.js';
import { DEFAULT_ALLOC_RULES, proposeReallocation } from './propose.js';
import { cap, campaign, out, outcomes, spend } from './testing/fixtures.js';

const keysDeep = (v: unknown, acc: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.push(k); keysDeep(x, acc); }
  return acc;
};

describe('core/ads output shapes', () => {
  it('carry no confidence, probability, score or tenant key', () => {
    const cs = [campaign(1), campaign(2), campaign(3, { targeting: { geo: 'radius_of_listing', radiusMiles: 20, zips: ['00000'] } })];
    const proposal = proposeReallocation(cs, [spend(1, 300_000), spend(2, 600_000)], outcomes(out(1, 10), out(2, 6)), cap(), DEFAULT_ALLOC_RULES);
    const hold = proposeReallocation(cs, [], outcomes(), cap(), DEFAULT_ALLOC_RULES);
    const keys = { proposal: [...new Set(keysDeep(proposal))].sort(), hold: [...new Set(keysDeep(hold))].sort(), overspend: keysDeep(overspend([], cap())) };
    expect(keys).toMatchSnapshot();
    for (const k of [...keys.proposal, ...keys.hold]) expect(k).not.toMatch(/confiden|probab|score|tenant|targeting$/i);
  });
});
