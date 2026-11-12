// Mutation testing for the AI ISA decision functions (docs/AI_ISA.md §13.1: >= 85 % on core/isa). Run from
// packages/core:
//   pnpm exec stryker run src/isa/testing/stryker.config.mjs
// The static data (areaCodes.ts, stateZones.ts), the fixed lines, the constants, the types and the prompt text are
// not mutated: they are data checked by their own tests, not decision logic.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'src/isa/testing/stryker.vitest.config.mjs' },
  mutate: [
    'src/isa/machine.ts',
    'src/isa/signals.ts',
    'src/isa/readiness.ts',
    'src/isa/slots.ts',
    'src/isa/consent.ts',
    'src/isa/sendPolicy.ts',
    'src/isa/zones.ts',
    'src/isa/ownText.ts',
    'src/isa/output.ts',
    'src/isa/guard.ts',
    'src/isa/content.ts',
    'src/isa/market.ts',
    'src/isa/facts.ts',
  ],
  thresholds: { high: 90, low: 85, break: 85 },
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/isa.json' },
  coverageAnalysis: 'perTest',
  // module-level lexicon regexes and data tables are static mutants: they are reviewed data with fixtures, not
  // decision logic, and would take most of the run (every test re-runs for each one)
  ignoreStatic: true,
  tempDirName: '.stryker-tmp',
  concurrency: 4,
  timeoutMS: 30000,
};
