// R-AST-12 is a compile-time rule: the feed-scoring input types have no field for protected-proxy
// attributes. These assertions are checked by `pnpm --filter @realty/core typecheck` (tsc includes
// test files); the runtime `it` blocks below exercise the same type machinery so a regression in the
// helper itself is caught too.
import { describe, expect, it } from 'vitest';
import type { ExceptionInputs, FeedInputs, SpeedRow, TouchFacts } from './index.js';

type Prim = string | number | boolean | bigint | symbol | null | undefined;
type Next<D extends unknown[]> = [...D, 1];

/** Every property name reachable from T (through arrays, Maps, unions), up to 6 levels deep. */
type DeepKeys<T, D extends unknown[] = []> = D['length'] extends 6
  ? never
  : T extends Prim
    ? never
    : T extends ReadonlyMap<infer K, infer V>
      ? DeepKeys<K, Next<D>> | DeepKeys<V, Next<D>>
      : T extends readonly (infer E)[]
        ? DeepKeys<E, Next<D>>
        : T extends object
          ? { [K in keyof T]-?: (K & string) | DeepKeys<T[K], Next<D>> }[keyof T]
          : never;

/** true if any reachable object type has an open string index signature (could smuggle any field). */
type DeepOpen<T, D extends unknown[] = []> = D['length'] extends 6
  ? false
  : T extends Prim
    ? false
    : T extends ReadonlyMap<infer K, infer V>
      ? DeepOpen<K, Next<D>> | DeepOpen<V, Next<D>>
      : T extends readonly (infer E)[]
        ? DeepOpen<E, Next<D>>
        : T extends object
          ? string extends keyof T
            ? true
            : { [K in keyof T]-?: DeepOpen<T[K], Next<D>> }[keyof T]
          : false;

type Fragment =
  | 'protect'
  | 'proxy'
  | 'attribute'
  | 'sensitiv'
  | 'military'
  | 'veteran'
  | 'income'
  | 'race'
  | 'religio'
  | 'familial'
  | 'disab'
  | 'gender'
  | 'demograph'
  | 'ethnic'
  | 'national'
  | 'birth'
  | 'marital'
  | 'pregnan'
  | 'orientation';
type Exact = 'va' | 'pcs' | 'age' | 'sex' | 'dob';

/** Property names that could carry a protected class or proxy (VERIFY WITH COUNSEL: the list). */
type Suspicious<K extends string> = K extends unknown ? (Lowercase<K> extends `${string}${Fragment}${string}` | Exact ? K : never) : never;

type IsNever<T> = [T] extends [never] ? true : false;

// ---- the assertions (compile errors if violated) ------------------------------------------------
const feedHasNoProxyFields: IsNever<Suspicious<DeepKeys<FeedInputs>>> = true;
const exceptionsHaveNoProxyFields: IsNever<Suspicious<DeepKeys<ExceptionInputs>>> = true;
const speedRowsHaveNoProxyFields: IsNever<Suspicious<DeepKeys<SpeedRow | TouchFacts>>> = true;
const feedInputsAreClosed: DeepOpen<FeedInputs> extends false ? true : false = true;
const exceptionInputsAreClosed: DeepOpen<ExceptionInputs> extends false ? true : false = true;

// ---- the helper itself works (would catch a regression) ------------------------------------------
type Probe = { offers: { contactId: string; attributes: { vaLoan: boolean } }[]; m: Map<string, { protected_proxy: boolean }> };
const probeFound: Suspicious<DeepKeys<Probe>>[] = ['attributes', 'protected_proxy'];
const probeOpen: DeepOpen<{ a: { [k: string]: unknown }[] }> = true;
const probeExact: Suspicious<'VA' | 'page' | 'stage'> = 'VA';

describe('R-AST-12 feed-scoring inputs have no protected-proxy fields (compile time)', () => {
  it('R-AST-12: FeedInputs, ExceptionInputs and scoreboard rows have no protected-proxy field and no open index signature', () => {
    expect([feedHasNoProxyFields, exceptionsHaveNoProxyFields, speedRowsHaveNoProxyFields, feedInputsAreClosed, exceptionInputsAreClosed]).toEqual([true, true, true, true, true]);
  });

  it('the compile-time detector flags proxy-looking keys and open records (self-test)', () => {
    expect(probeFound).toEqual(['attributes', 'protected_proxy']);
    expect(probeOpen).toBe(true);
    expect(probeExact).toBe('VA');
  });
});
