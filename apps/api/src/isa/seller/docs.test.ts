// b17: the deployment docs name every hold on the assistant's recent-sales email (the comps email) before they call
// AI_ISA_LIVE_SENDS the last one, as readiness use 'ai_isa' (cma/gates.ts) and the seller panel (routes.ts) now
// require: platform:cma, platform:ai_isa_seller_data and the assistant's own pack platform:ai_isa. And ARCHITECTURE
// §21.59 no longer contradicts itself (B16S-3 changed cma/service.ts; the UNSUBSCRIBE_MISSING fix is above its Proof).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const doc = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../../docs/${name}`, import.meta.url)), 'utf8');
/** The paragraph or bullet holding `marker`, cut at the marker: what it says before it. */
const before = (text: string, marker: string) => {
  const at = text.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return text.slice(text.lastIndexOf('\n', at) + 1, at);
};

describe('b17: the docs name platform:ai_isa among the holds on a comps email', () => {
  it('DEPLOY §10.1: platform:ai_isa is named before "AI_ISA_LIVE_SENDS is the last hold"', () => {
    const lead = before(doc('DEPLOY.md'), '`AI_ISA_LIVE_SENDS` is the last hold');
    for (const pack of ['`platform:cma', '`platform:ai_isa_seller_data', '`platform:ai_isa@', '`platform:ai_isa`']) expect(lead).toContain(pack);
  });

  it('AI_ISA.md §6.5: platform:ai_isa is named before AI_ISA_LIVE_SENDS is called the last hold on a comps email', () => {
    const lead = before(doc('AI_ISA.md'), '`AI_ISA_LIVE_SENDS` is the last hold on a comps email');
    expect(lead).toContain('`platform:ai_isa`');
    expect(lead).toMatch(/platform:cma, platform:ai_isa_seller_data and platform:ai_isa ship unreviewed/);
  });

  it('ARCHITECTURE §21.59 says what changed in cma/** and points to the UNSUBSCRIBE_MISSING fix where it is', () => {
    const a = doc('ARCHITECTURE.md');
    const sec = a.slice(a.indexOf('### 21.59 '), a.indexOf('\n### ', a.indexOf('### 21.59 ') + 10));
    expect(sec).not.toContain('Nothing in `cma/**` changed');
    expect(sec).toContain('`compsForSubjectInTx` (`cma/service.ts`) also returns `readinessConnectionIds`');
    // the fix bullet comes before the Proof bullet
    expect(sec.indexOf('**Found and fixed in batch 16: UNSUBSCRIBE_MISSING.**')).toBeLessThan(sec.indexOf('**Proof.**'));
    expect(sec.slice(sec.indexOf('**Proof.**'))).toContain('until the UNSUBSCRIBE_MISSING fix above');
    expect(sec).toMatch(/Since batch 17 readiness requires all three packs/);
  });
});
