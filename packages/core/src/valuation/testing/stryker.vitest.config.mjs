// Vitest config used only by Stryker (src/valuation/testing/stryker.config.mjs). Stryker runs the tests in
// a sandbox copy of packages/core, where the package config's `../../vitest.shared.js` import does not
// resolve; this config is self-contained and runs only the valuation tests. Settings mirror vitest.shared.ts.
// The performance test is left out (timing is not behaviour, and mutants make it slow).
import { defineConfig } from 'vitest/config';

const root = new URL('../../../', import.meta.url).pathname; // packages/core (or its sandbox copy)
const SOURCE_CONDITION = '@realty/source';

export default defineConfig({
  root,
  resolve: { conditions: [SOURCE_CONDITION, 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'], externalConditions: [SOURCE_CONDITION] } },
  test: {
    environment: 'node',
    include: ['src/valuation/**/*.test.ts'],
    // perf: timing is not behaviour; schemas: reads the db package, which the sandbox copy lacks (types.ts is not mutated).
    exclude: ['src/valuation/perf.test.ts', 'src/valuation/schemas.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
  },
});
