// Mutation testing for the fair-housing copy check (PHASE2_3_PLAN §6 Phase 2 exit 5: >= 90 % on
// fairhousing/check.ts). Run from packages/core:
//   pnpm exec stryker run src/fairhousing/testing/stryker.config.mjs
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'src/fairhousing/testing/stryker.vitest.config.mjs' },
  mutate: ['src/fairhousing/check.ts'],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  tempDirName: '.stryker-tmp',
};
