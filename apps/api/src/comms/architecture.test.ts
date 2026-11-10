// Architecture tests of api/comms (BUILD_PLAN module 12 "Accept when"; R-GATE-2, R-AST-13, R-TEN-3).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { COMMS_REQUEST_SCHEMAS, COMMS_RESPONSE_SCHEMAS } from './schemas.js';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(API_SRC, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}

const ALLOWED = new Set(['comms/dispatch.ts', 'comms/dial.ts']);
const OUTBOUND = /\.(sendSms|sendEmail|dialCall)\s*\(|\b(sendSms|sendEmail|dialCall)\s*:/;

describe('the one outbound path (R-GATE-2)', () => {
  it('R-GATE-2: only comms/dispatch.ts and comms/dial.ts call a provider send or dial (source scan of every apps/api file)', () => {
    const offenders = sourceFiles(API_SRC)
      .map((f) => relative(API_SRC, f).replaceAll('\\', '/'))
      .filter((f) => !f.startsWith('providers/') && !ALLOWED.has(f) && !f.endsWith('.test.ts'))
      .filter((f) => OUTBOUND.test(readFileSync(join(API_SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
    // and the allowed modules really are the ones that send
    expect(OUTBOUND.test(readFileSync(join(API_SRC, 'comms/dispatch.ts'), 'utf8'))).toBe(true);
    expect(OUTBOUND.test(readFileSync(join(API_SRC, 'comms/dial.ts'), 'utf8'))).toBe(true);
  });

  it('R-GATE-2: the lint rule realty/no-provider-outbound reports nothing in apps/api and does fire outside the allowlist', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const results = await eslint.lintFiles(['apps/api/src/**/*.ts']);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'realty/no-provider-outbound').map((m) => `${relative(REPO, r.filePath)}:${m.line}`));
    expect(hits).toEqual([]);
    const probe = await eslint.lintText('export async function leak(p: { telephony: { sendSms(x: unknown): Promise<unknown> } }) { await p.telephony.sendSms({}); }\n', { filePath: join(REPO, 'apps/api/src/comms/compose.ts') });
    expect(probe[0]!.messages.some((m) => m.ruleId === 'realty/no-provider-outbound')).toBe(true);
    const allowed = await eslint.lintText('export async function ok(p: { telephony: { sendSms(x: unknown): Promise<unknown> } }) { await p.telephony.sendSms({}); }\n', { filePath: join(REPO, 'apps/api/src/comms/dispatch.ts') });
    expect(allowed[0]!.messages.some((m) => m.ruleId === 'realty/no-provider-outbound')).toBe(false);
  }, 120_000);
});

function keysOf(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.properties && typeof n.properties === 'object') for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
      out.push(k);
      walk(v);
    }
    for (const k of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  return out;
}

describe('schemas (R-AST-13, R-TEN-3)', () => {
  it('R-AST-13: no comms response schema carries a confidence field (snapshot of every response key)', () => {
    const all = Object.fromEntries(Object.entries(COMMS_RESPONSE_SCHEMAS).map(([n, s]) => [n, keysOf(s as z.ZodType).sort()]));
    for (const keys of Object.values(all)) expect(keys.filter((k) => /confidence/i.test(k))).toEqual([]);
    expect(all).toMatchSnapshot();
  });

  it('R-TEN-3: no comms request schema accepts a tenant id (tenant context comes only from the session, a resolver or a job row)', () => {
    for (const [name, s] of Object.entries(COMMS_REQUEST_SCHEMAS)) {
      const keys = keysOf(s as z.ZodType);
      expect(keys.filter((k) => /tenant/i.test(k)), name).toEqual([]);
    }
  });
});
