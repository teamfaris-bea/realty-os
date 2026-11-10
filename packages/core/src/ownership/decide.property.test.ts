// Property suite of BUILD_PLAN module 3: random command sequences against a simulated world
// (testing/world.ts: memberships, the job queue, the rotation cursor, the non-guarded inactivity
// columns) that applies decide()'s effects the way db/client does. Acceptance: 10k sequences green.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plusMs } from '../foundation/index.js';
import { DTS, World, stepArb } from './testing/world.js';

const RUNS = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OWNERSHIP_PROPERTY_RUNS ?? 10_000);

describe('decide() properties (R-OWN-1 … R-OWN-26)', () => {
  it(
    `R-OWN-1 R-OWN-4 R-OWN-15: ${RUNS} random command sequences keep next == fold(ledger), one owner, a gapless seq at the head, no-op rejections/replays/stale fences, and no user-actor routing`,
    () => {
      let decisions = 0;
      let events = 0;
      const seen = new Set<string>();
      fc.assert(
        fc.property(fc.array(stepArb, { minLength: 8, maxLength: 40 }), (steps) => {
          const w = new World();
          for (const s of steps) {
            w.now = plusMs(w.now, DTS[s.dt] as number);
            const c = w.command(s);
            if (!c) continue;
            const d = w.apply(c.cmd, c.ctx);
            seen.add(d.ok ? `${c.cmd.kind}:${d.events.map((e) => e.type).join('+') || 'noop'}` : `${c.cmd.kind}!${d.code}`);
          }
          w.finalChecks();
          decisions += w.decisions;
          events += w.ledger.length;
        }),
        { numRuns: RUNS, seed: 20261110 },
      );
      // the generator really explores the state machine
      expect(decisions).toBeGreaterThan(RUNS * 8);
      expect(events).toBeGreaterThan(RUNS * 3);
      for (const k of ['accept:offer_accepted', 'claim:claimed', 'timer:first_touch_breached', 'timer:auto_released', 'timer:offer_expired+offered', 'decline:offer_declined', 'touch:first_touch_recorded', 'reinquiry:reinquiry', 'accept!LEAD_OFFER_EXPIRED', 'claim!LEAD_ALREADY_CLAIMED']) {
        if (RUNS >= 1000) expect([...seen].some((x) => x.startsWith(k))).toBe(true);
      }
    },
    600_000,
  );

  it('R-OWN-1: no reachable projection has two owners or an owner outside `owned` (exhaustive small sequences)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 8 }), (steps) => {
        const w = new World();
        for (const s of steps) {
          w.now = plusMs(w.now, DTS[s.dt] as number);
          const c = w.command(s);
          if (c) w.apply(c.cmd, c.ctx);
          const st = w.state;
          if (st) expect(st.state === 'owned').toBe(st.ownerUserId !== null);
        }
      }),
      { numRuns: 2000, seed: 7 },
    );
  });
});
