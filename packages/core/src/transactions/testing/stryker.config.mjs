// Mutation testing of core/transactions (PHASE2_3_PLAN §6 Phase 2 exit criterion 5:
// `transactions/confirmDate` >= 90 %). Run from packages/core:
//   pnpm exec stryker run src/transactions/testing/stryker.config.mjs
// Uses its own self-contained vitest config (the sandbox copy cannot reach vitest.shared.ts).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'src/transactions/testing/stryker.vitest.config.mjs' },
  mutate: ['src/transactions/confirm.ts', 'src/transactions/risk.ts'],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  tempDirName: '.stryker-tmp',
};
