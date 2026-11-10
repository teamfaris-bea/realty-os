import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type ContactId, type IdGenerator, type TenantId, isUuid, isUuidV7, parseId, sequentialIds, uuidv7Generator, uuidv7Time } from './ids.js';
import { at, fixedClock, instant } from './time.js';

/** Deterministic byte source (xorshift32) so the generator is testable without crypto. */
function seededBytes(seed: number): (n: number) => Uint8Array {
  let x = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
    return out;
  };
}

describe('uuidv7Generator', () => {
  it('produces RFC 9562 v7 ids that embed the clock millisecond', () => {
    const clock = fixedClock('2026-11-10T12:00:00.123Z');
    const ids = uuidv7Generator(clock, seededBytes(7));
    const id = ids.next<'ContactId'>();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
    expect(uuidv7Time(id)).toBe(at('2026-11-10T12:00:00.123Z'));
  });

  it('is strictly increasing within one millisecond and when the clock steps backwards', () => {
    const clock = fixedClock('2026-11-10T12:00:00Z');
    const ids = uuidv7Generator(clock, seededBytes(42));
    const seen: string[] = [];
    for (let i = 0; i < 2000; i++) seen.push(ids.next());
    clock.advance(-5000); // NTP step backwards
    for (let i = 0; i < 100; i++) seen.push(ids.next());
    clock.advance(10_000);
    for (let i = 0; i < 100; i++) seen.push(ids.next());
    for (let i = 1; i < seen.length; i++) expect(seen[i]! > seen[i - 1]!).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every(isUuidV7)).toBe(true);
  });

  it('advances the timestamp instead of overflowing the random field', () => {
    const clock = fixedClock(1000);
    // All-ones bytes: the first id has the maximal random field, so the next must bump the ms.
    const ids = uuidv7Generator(clock, (n) => new Uint8Array(n).fill(0xff));
    const a = ids.next();
    const b = ids.next();
    expect(uuidv7Time(a)).toBe(1000);
    expect(uuidv7Time(b)).toBe(1001);
    expect(b > a).toBe(true);
  });

  it('property: ids sort by issue order for any clock sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 200 }), fc.integer(), (steps, seed) => {
        const clock = fixedClock(at('2030-01-01T00:00:00Z'));
        const ids = uuidv7Generator(clock, seededBytes(seed));
        let prev = '';
        for (const s of steps) {
          clock.advance(s);
          const id = ids.next();
          if (!(id > prev)) return false;
          prev = id;
        }
        return true;
      }),
    );
  });

  it('rejects clocks outside the 48-bit range', () => {
    expect(() => uuidv7Generator(fixedClock(-1), seededBytes(1)).next()).toThrow(RangeError);
  });

  it('brands ids by type parameter (compile-time)', () => {
    const ids: IdGenerator = sequentialIds();
    expectTypeOf(ids.next<'ContactId'>()).toEqualTypeOf<ContactId>();
    expectTypeOf(ids.next<'TenantId'>()).toEqualTypeOf<TenantId>();
    // @ts-expect-error a ContactId is not a TenantId
    const t: TenantId = ids.next<'ContactId'>();
    expect(typeof t).toBe('string');
  });
});

describe('sequentialIds', () => {
  it('issues deterministic, sortable, uuid-column-safe ids', () => {
    const ids = sequentialIds();
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000001');
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000002');
    expect(ids.issued).toBe(2);
    const other = sequentialIds({ prefix: 0xabc, start: 255 });
    const x = other.next();
    expect(x).toBe('00000abc-0000-7000-8000-0000000000ff');
    expect(isUuid(x)).toBe(true);
    expect(isUuidV7(x)).toBe(true);
  });

  it('validates options', () => {
    expect(() => sequentialIds({ prefix: -1 })).toThrow(RangeError);
    expect(() => sequentialIds({ start: 1.5 })).toThrow(RangeError);
    const last = sequentialIds({ start: 0xffff_ffff_ffff });
    expect(last.next()).toBe('00000000-0000-7000-8000-ffffffffffff');
    expect(() => last.next()).toThrow(RangeError);
  });
});

describe('parseId', () => {
  it('accepts and lower-cases uuids, rejects anything else', () => {
    expect(parseId<'ContactId'>('0190B8E4-1C2D-7ABC-8DEF-0123456789AB')).toBe('0190b8e4-1c2d-7abc-8def-0123456789ab');
    expect(parseId('not-a-uuid')).toBeNull();
    expect(parseId('0190b8e4-1c2d-7abc-8def-0123456789a')).toBeNull();
    expect(parseId("0190b8e4-1c2d-7abc-8def-0123456789ab' OR 1=1")).toBeNull();
    expect(uuidv7Time('0190b8e4-1c2d-4abc-8def-0123456789ab')).toBeNull(); // v4
    expect(uuidv7Time('00000000-0001-7000-8000-000000000000')).toBe(instant(1));
  });
});
