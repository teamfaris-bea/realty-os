// Architecture of api/documents (module 42; D1, R-DOC-2, R-DOC-7, R-DOC-8, R-TEN-7, A2): source scans of every
// apps/api file. documents/** sends nothing, calls no model, writes no deal_dates SQL (module 31's confirmInTx is the
// one writer), reads file bytes only where it must, and answers no confidence number or tenant id.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as S from './schemas.js';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(API_SRC, f).replaceAll('\\', '/');
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /(^|\/)testing\.ts$/.test(f);
const ALL = sourceFiles(API_SRC);
const RUNTIME = ALL.filter((f) => !isTest(rel(f)));
const DOCS = RUNTIME.filter((f) => rel(f).startsWith('documents/'));
const src = (f: string) => readFileSync(f, 'utf8');

describe('api/documents architecture', () => {
  it('the scans are not vacuous', () => {
    expect(DOCS.map(rel).sort()).toEqual(
      ['confirm', 'copy', 'decide', 'extract', 'extractionView', 'finder', 'handlers', 'manage', 'provider', 'read', 'repos', 'routes', 'scan', 'schemas', 'types', 'upload'].map((n) => `documents/${n}.ts`),
    );
    expect(RUNTIME.length).toBeGreaterThan(200);
  });

  it('D1: documents/** imports no dispatch, dial, compose or send path and calls no provider outbound method', () => {
    for (const f of DOCS) {
      const s = src(f).replace(/reply(\.code\(\d+\))?\.send\(/g, ''); // the HTTP reply is not an outbound send
      expect(s, rel(f)).not.toMatch(/dispatchOutbound|dialOutbound|queueOutbound|comms\/(dispatch|dial|compose|send)\.js|(?<!reply)\.send\(|sendEmail|sendSms|placeCall|\.publish\(/);
    }
  });

  it('R-DOC-2: documents/** never reaches an AI provider or the assistant\'s model paths', () => {
    for (const f of DOCS) expect(src(f), rel(f)).not.toMatch(/providers\.ai\b|anthropic|AiProvider|ai_runs|assistant\/(firstResponse|drafts|summaries|prompt)|buildPrompt|\.complete\(/);
  });

  it('R-DOC-8: documents/** writes no deal_dates SQL (INSERT, UPDATE or DELETE): only module 31\'s confirmInTx does', () => {
    for (const f of DOCS) expect(src(f), rel(f)).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+deal_dates/i);
  });

  it('R-DOC-7: the scanner and the extractor are called only from scan.ts and extract.ts; file bytes are read only in read.ts, scan.ts and extract.ts', () => {
    const scanners = RUNTIME.filter((f) => /\bscanner\.scan\(/.test(src(f))).map(rel);
    expect(scanners).toEqual(['documents/scan.ts']);
    const extractors = RUNTIME.filter((f) => /\bextractor\.extract\(|textExtractor\.extract\(/.test(src(f))).map(rel);
    expect(extractors).toEqual(['documents/extract.ts']);
    const readers = DOCS.filter((f) => /\bgetObject\(/.test(src(f))).map(rel).sort();
    expect(readers).toEqual(['documents/extract.ts', 'documents/read.ts', 'documents/scan.ts']);
  });

  it('R-DOC-7: the streaming SQL itself requires scan_status = \'clean\' and a live document object', () => {
    const repos = src(join(API_SRC, 'documents/repos.ts'));
    const fn = repos.slice(repos.indexOf('export async function cleanObjectOf'), repos.indexOf('export async function portalCleared'));
    expect(fn).toMatch(/d\.scan_status = 'clean'/);
    expect(fn).toMatch(/o\.deleted_at IS NULL AND o\.dek_wrapped IS NOT NULL/);
    expect(src(join(API_SRC, 'documents/read.ts'))).toMatch(/const o = await R\.cleanObjectOf\(tx, id\);/);
  });

  it('A2 R-TEN-7: no response schema has a confidence or tenant id key, and job payloads are ids only', () => {
    const keys = (t: z.ZodType): string[] => {
      const j = z.toJSONSchema(t, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
      const out: string[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== 'object') return;
        const o = n as Record<string, unknown>;
        if (o.properties && typeof o.properties === 'object') for (const k of Object.keys(o.properties)) out.push(k);
        for (const v of Object.values(o)) walk(v);
      };
      walk(j);
      return out;
    };
    for (const [name, t] of Object.entries(S)) {
      if (!(t instanceof z.ZodType)) continue;
      for (const k of keys(t)) expect(`${name}.${k}`).not.toMatch(/confidence|score|tenant_?id|storage_?key|dek/i);
    }
    const handlers = src(join(API_SRC, 'documents/handlers.ts'));
    expect([...handlers.matchAll(/jobPayload\(\{([^}]*)\}\)/g)].map((m) => m[1]!.trim())).toEqual(['documentId: zId', '']);
  });

  it('R-DOC-5: no log, audit row or job payload in documents/** names a file or display name', () => {
    for (const f of DOCS) {
      const s = src(f);
      for (const m of s.matchAll(/(?:log\.(?:info|warn|error)|ctx\.log\.\w+)\(([^)]*)\)/g)) expect(m[1], rel(f)).not.toMatch(/display_?name|filename|displayName/i);
      for (const m of s.matchAll(/audit\(tx,[^;]*;/gs)) expect(m[0], rel(f)).not.toMatch(/display_?name|filename|displayName/i);
      for (const m of s.matchAll(/enqueueJob\(tx,[^;]*;/gs)) expect(m[0], rel(f)).not.toMatch(/display_?name|filename|displayName/i);
    }
  });
});
