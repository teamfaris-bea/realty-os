// R-AST-13: no output shape carries a confidence, probability or score, and none takes or returns tenant_id.
import { describe, expect, it } from 'vitest';
import { publishable } from './publishable.js';
import { renderPortalItem } from './render.js';
import { dealGrant, documentSrc, facts, feedback, milestone, sellerUpdate, showing, task } from './testing/fixtures.js';

const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
};

describe('core/portal output shapes', () => {
  it('carry no confidence, probability, score or tenant key', () => {
    const g = dealGrant({ clientIsSellerSide: true });
    const outs: unknown[] = [publishable('milestone', facts(milestone())), publishable('milestone', facts(task())),
      ...[milestone(), documentSrc(), showing(), feedback(), sellerUpdate(), task()].map((s) => renderPortalItem(facts(s, { grant: g })))];
    const keys = [...new Set(outs.flatMap((o) => keysDeep(o)))].sort();
    expect(keys).toMatchSnapshot();
    for (const k of keys) expect(k).not.toMatch(/confiden|probab|score|tenant/i);
  });
});
