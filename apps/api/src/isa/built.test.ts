// b13 review B13S-2: the panel and the opt-in form say what this tree builds from ONE server list
// (sentences.ts ISA_BUILT_CAPABILITIES): every capability turn.ts can grant is in it, and the panel rows read it.
import { readFileSync } from 'node:fs';
import { ISA_CAPABILITIES, ISA_RESERVED_CAPABILITIES } from '@realty/core/isa';
import { describe, expect, it } from 'vitest';
import { ISA_BUILT_CAPABILITIES, capabilityRow } from './sentences.js';

const TURN = readFileSync(new URL('./turn.ts', import.meta.url), 'utf8');

describe('what this tree builds (B13S-2)', () => {
  it('R-ISA-22: every capability turn.ts can grant (caps.has / shareAllowed / capability) is reported as built; no reserved one is', () => {
    const granted = [...new Set([...TURN.matchAll(/caps\.has\('([a-z_]+)'\)/g)].map((m) => m[1]!))].sort();
    expect(granted).toEqual(['book_appointments', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'share_listings']);
    for (const c of [...granted, 'converse']) expect(ISA_BUILT_CAPABILITIES as readonly string[], c).toContain(c);
    expect([...ISA_BUILT_CAPABILITIES].sort()).toEqual([...ISA_CAPABILITIES].sort());
    for (const r of ISA_RESERVED_CAPABILITIES) expect(ISA_BUILT_CAPABILITIES as readonly string[]).not.toContain(r);
  });

  it('R-ISA-22 E534: a row is allowed by the policy and the opt-in alone; recent sales say what they still wait for; competition says asking prices', () => {
    expect(capabilityRow('book_appointments', true, true)).toEqual({ capability: 'book_appointments', allowed: true, built: true, sentence: 'Allowed.' });
    expect(capabilityRow('share_listings', true, false)).toEqual({ capability: 'share_listings', allowed: false, built: true, sentence: 'Not in the opt-in or the team policy.' });
    expect(capabilityRow('seller_competition', true, true).sentence).toBe('Allowed: competing listings with their asking prices.');
    expect(capabilityRow('seller_sold_comps', true, true)).toMatchObject({ allowed: true, built: true, sentence: expect.stringMatching(/platform:cma and platform:ai_isa_seller_data/) });
    expect(capabilityRow('share_value_estimate', true, true)).toEqual({ capability: 'share_value_estimate', allowed: false, built: false, sentence: 'Not built in this version.' });
  });
});
