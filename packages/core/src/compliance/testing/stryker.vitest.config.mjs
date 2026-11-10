// Vitest config used only by Stryker (packages/core/stryker.config.mjs). Stryker runs the tests in
// a sandbox copy of packages/core, where the package config's `../../vitest.shared.js` import does
// not resolve; this config is self-contained and runs only the compliance tests (gate.ts is the
// mutated file). Settings mirror vitest.shared.ts.
import { defineConfig } from 'vitest/config';

const root = new URL('../../../', import.meta.url).pathname; // packages/core (or its sandbox copy)
const SOURCE_CONDITION = '@realty/source';

export default defineConfig({
  root,
  resolve: { conditions: [SOURCE_CONDITION, 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'], externalConditions: [SOURCE_CONDITION] } },
  test: {
    environment: 'node',
    include: ['src/compliance/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
