// Mutation testing of core/valuation (module 70; PHASE2_3_PLAN §6: break >= 85 % on select.ts, adjust.ts
// and estimate.ts). Run from packages/core:
//   pnpm exec stryker run src/valuation/testing/stryker.config.mjs
// Uses its own self-contained vitest config (the sandbox copy cannot reach vitest.shared.ts).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'src/valuation/testing/stryker.vitest.config.mjs' },
  mutate: ['src/valuation/select.ts', 'src/valuation/adjust.ts', 'src/valuation/estimate.ts'],
  thresholds: { high: 90, low: 85, break: 85 },
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  tempDirName: '.stryker-tmp',
  concurrency: 4,
  timeoutMS: 30_000,
};
