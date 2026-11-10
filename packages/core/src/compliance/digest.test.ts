import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalize, hash32, sha256Hex } from './digest.js';

describe('canonical JSON (R-GATE-5 digest input)', () => {
  it('sorts keys, drops undefined members, keeps array order and turns undefined array items into null', () => {
    expect(canonicalJson({ b: 1, a: [3, undefined, 'x'], c: undefined, d: null, e: true })).toBe('{"a":[3,null,"x"],"b":1,"d":null,"e":true}');
  });
  it('Sets and Maps are order-independent', () => {
    expect(canonicalJson(new Set(['b', 'a']))).toBe(canonicalJson(new Set(['a', 'b'])));
    expect(canonicalJson(new Set([{ a: 1 }, { a: 1 }]))).toBe('[{"a":1},{"a":1}]');
    expect(canonicalJson(new Map([['y', 1], ['x', 2]]))).toBe('[["x",2],["y",1]]');
    expect(canonicalJson(new Map([['x', 2], ['y', 1]]))).toBe('[["x",2],["y",1]]');
  });
  it('rejects values that have no stable JSON form', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(() => 1)).toThrow(TypeError);
    expect(() => canonicalize(1n)).toThrow(TypeError);
  });
  it('sha256Hex and hash32 are the standard SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hash32('abc')).toBe(0xba7816bf);
  });
});
