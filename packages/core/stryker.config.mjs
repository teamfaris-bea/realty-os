// Mutation testing (BUILD_PLAN module 2 acceptance: gate.ts >= 90 %).
// Run: pnpm --filter @realty/core test:mutation
//
// Stryker copies packages/core into a sandbox (.stryker-tmp/), where vitest.config.ts cannot reach
// the repo-root vitest.shared.ts, so the run uses a self-contained config that mirrors it and
// runs the compliance tests only.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'src/compliance/testing/stryker.vitest.config.mjs' },
  mutate: ['src/compliance/gate.ts'],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
};
