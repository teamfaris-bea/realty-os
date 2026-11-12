// Property-test run counts: the full count normally, a tenth under Stryker (src/isa/testing/stryker.vitest.config.mjs
// sets ISA_MUTATION=1), so a mutation run finishes in reasonable time. The properties are unchanged.
const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
export function runs(n: number): number {
  return env.ISA_MUTATION === '1' ? Math.max(20, Math.ceil(n / 10)) : n;
}
