// The system actor exists only through apps/api/src/worker/systemActor.ts (ARCHITECTURE §2, §16).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SystemActorError, systemActor } from './systemActor.js';

const T = '0190f5a0-0000-7000-8000-00000000000a';
const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('system actor factory', () => {
  it('builds a tenant-scoped system actor with a validated tenant id, via and job id', () => {
    expect(systemActor(T, 'timer', 42n)).toEqual({ kind: 'system', tenantId: T, via: 'timer', jobId: '42' });
    expect(systemActor(T.toUpperCase(), 'worker')).toEqual({ kind: 'system', tenantId: T, via: 'worker' });
    expect(() => systemActor('', 'worker')).toThrow(SystemActorError);
    expect(() => systemActor('tenant-a', 'worker')).toThrow(SystemActorError);
    expect(() => systemActor(T, 'root' as never)).toThrow(/unknown system via/);
    expect(() => systemActor(T, 'worker', 'x; DROP')).toThrow(/jobId/);
  });

  it('architecture: no source file in apps/api outside src/worker builds a { kind: "system" } actor literal', () => {
    const offenders = sourceFiles(API_SRC)
      .filter((f) => !relative(API_SRC, f).startsWith('worker'))
      .filter((f) => /kind\s*:\s*['"`]system['"`]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(API_SRC, f));
    expect(offenders).toEqual([]);
  });
});
