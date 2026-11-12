// Boundary test of the homeowner-profile lane (modules 77-79; owner decision D10; R-HOME-7, R-HOME-8, R-PRED-2,
// R-PRED-4): the county data reaches the agents' panel and nothing else. Predict-style source scans over apps/api
// and apps/web (comments are stripped where a rule names a table or a function).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(API_SRC, '..', '..', 'web', 'src');
const CORE_SRC = join(API_SRC, '..', '..', '..', 'packages', 'core', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' || n === 'fixtures' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}
const rel = (f: string, base = API_SRC) => relative(base, f).replaceAll('\\', '/');
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /(^|\/)testing\.ts$/.test(f) || /\.testing\.ts$/.test(f);
const RUNTIME = sourceFiles(API_SRC).filter((f) => !isTest(rel(f)));
const LANE = RUNTIME.filter((f) => /^(homeowner|providers\/publicRecords)\//.test(rel(f)));
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
const target = (file: string, spec: string) => (spec.startsWith('.') ? rel(resolve(dirname(file), spec)).replace(/\.js$/, '.ts') : spec);

describe('R-HOME-7 R-HOME-8: the homeowner lane reaches only the agents\' panel', () => {
  it('the scans are not vacuous', () => {
    expect(LANE.map((f) => rel(f)).sort()).toEqual([
      'homeowner/handlers.ts', 'homeowner/refresh.ts', 'homeowner/repos.ts', 'homeowner/routes.ts', 'homeowner/schemas.ts', 'homeowner/settings.ts',
      'providers/publicRecords/beaufort.ts', 'providers/publicRecords/fields.ts', 'providers/publicRecords/http.ts',
    ]);
    expect(RUNTIME.length).toBeGreaterThan(200);
  });

  it('R-HOME-8: homeowner/** and providers/publicRecords/** import nothing from messaging, leads, the assistant, ownership, ads, the portal, marketing, seller updates, mail sync, bulk, lists, coaching or documents (comms/repos/contacts.ts and nurture/repos.ts excepted)', () => {
    const FORBIDDEN = /^(comms|channels|leads|assistant|ownership|ads|portal|marketing|sellerUpdates|mailSync|bulk|lists|coaching|documents|nurture)\//;
    const ALLOWED = new Set(['comms/repos/contacts.ts', 'nurture/repos.ts']);
    const SPECS = /(@realty\/core\/(ownership|routing|ads|portal|assistant|coaching|marketing|texting)|@realty\/db\/.*ownership)/;
    for (const f of LANE) {
      const bad = importsOf(f).map((s) => target(f, s)).filter((t) => (FORBIDDEN.test(t) && !ALLOWED.has(t)) || SPECS.test(t));
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it('R-HOME-8: they name no send, dial, enqueue, notification, publish, AI provider or ownership command', () => {
    const NAMES = /\b(dispatchOutbound|dialOutbound|deliverChannelMessage|sendSms|sendEmail|dialCall|enqueueTyped|enqueue|createNotification|notify|publishPost|postReviewReply|applyBudgetChange|applyOwnershipCommand|priority_feed_items|tasks|playbook_enrollments|notifications)\b/;
    for (const f of LANE) {
      expect(code(f).match(NAMES)?.[0] ?? null, rel(f)).toBeNull();
      expect(/providers\.ai\b|anthropic/i.test(code(f)), rel(f)).toBe(false);
    }
  });

  it('R-HOME-6 R-HOME-7: the lane\'s SQL writes only homeowner_profiles and homeowner_profile_facts', () => {
    const writes = new Set<string>();
    for (const f of LANE) for (const m of code(f).matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/g)) writes.add(m[2]!);
    expect([...writes].sort()).toEqual(['homeowner_profile_facts', 'homeowner_profiles']);
    for (const f of LANE) expect(/(insertInto|updateTable|deleteFrom)\(/.test(code(f)), rel(f)).toBe(false);
  });

  it('R-HOME-7 R-PRED-4: no runtime file outside homeowner/** names a homeowner table; only routes.ts and worker/handlers/index.ts import homeowner/**', () => {
    const naming = RUNTIME.filter((f) => !rel(f).startsWith('homeowner/') && /\bhomeowner_profile(s|_facts)\b/.test(code(f))).map((f) => rel(f));
    expect(naming).toEqual([]);
    const importers = RUNTIME.filter((f) => !rel(f).startsWith('homeowner/') && importsOf(f).some((s) => target(f, s).startsWith('homeowner/'))).map((f) => rel(f));
    expect(importers.sort()).toEqual(['routes.ts', 'worker/handlers/index.ts']);
    // directories not built yet are covered by these scans as soon as they exist
    for (const d of ['voice', 'ads', 'isa', 'portal', 'documents', 'gbp'].filter((x) => existsSync(join(API_SRC, x)))) {
      expect(RUNTIME.some((f) => rel(f).startsWith(`${d}/`)), d).toBe(true);
    }
  });

  // b11 reconciliation homeowner-18: the importer check above follows relative paths only, and core was not scanned, so
  // the AI ISA core (module 74, packages/core/src/isa) and the assistant were outside the boundary test.
  it('R-HOME-7 R-HOME-8: no core module but core/homeowner imports it (isa, assistant, nurture, marketing and portal included); @realty/core/homeowner is imported only by the lane, the connector and module 50\'s provider', () => {
    const core = sourceFiles(CORE_SRC).filter((f) => !isTest(rel(f, CORE_SRC)));
    for (const d of ['isa', 'assistant', 'nurture', 'marketing', 'portal']) expect(core.some((f) => rel(f, CORE_SRC).startsWith(`${d}/`)), d).toBe(true);
    const coreTarget = (file: string, spec: string) => (spec.startsWith('.') ? rel(resolve(dirname(file), spec), CORE_SRC) : spec);
    const coreImporters = core
      .filter((f) => !rel(f, CORE_SRC).startsWith('homeowner/'))
      .filter((f) => importsOf(f).some((x) => /^homeowner(\/|\.js$|$)/.test(coreTarget(f, x)) || /^@realty\/core\/homeowner\b/.test(x)))
      .map((f) => rel(f, CORE_SRC));
    expect(coreImporters).toEqual([]);
    expect(readFileSync(join(CORE_SRC, 'index.ts'), 'utf8')).not.toMatch(/homeowner/);
    const SPEC = /^@realty\/core\/homeowner\b/;
    const apiImporters = RUNTIME.filter((f) => importsOf(f).some((x) => SPEC.test(x))).map((f) => rel(f)).filter((f) => !/^(homeowner|providers\/publicRecords)\//.test(f));
    expect(apiImporters).toEqual(['predict/provider.ts']);
    const web = sourceFiles(WEB_SRC).filter((f) => !isTest(rel(f, WEB_SRC)));
    expect(web.filter((f) => importsOf(f).some((x) => SPEC.test(x))).map((f) => rel(f, WEB_SRC))).toEqual(['surfaces/homeowner/api.ts']);
  });

  it('R-HOME-2 R-PRED-2 E588: predict/** other than provider.ts never names lookupHomeowner or a homeowner table; lookupHomeowner is called only by homeowner/refresh.ts', () => {
    for (const f of RUNTIME.filter((x) => rel(x).startsWith('predict/') && rel(x) !== 'predict/provider.ts')) {
      expect(/lookupHomeowner|homeowner_profile/.test(code(f)), rel(f)).toBe(false);
    }
    const callers = RUNTIME.filter((f) => /\.lookupHomeowner\(/.test(code(f))).map((f) => rel(f));
    expect(callers).toEqual(['homeowner/refresh.ts']);
  });

  it('R-HOME-7 R-HOME-8: in the web app only surfaces/homeowner/** and contact/sections.ts reference the panel; the widget and portal bundles never do', () => {
    const web = sourceFiles(WEB_SRC).filter((f) => !isTest(rel(f, WEB_SRC)));
    const refs = web.filter((f) => !rel(f, WEB_SRC).startsWith('surfaces/homeowner/') && /HomeownerPanel|surfaces\/homeowner|\.\.\/homeowner\//.test(readFileSync(f, 'utf8'))).map((f) => rel(f, WEB_SRC));
    expect(refs).toEqual(['surfaces/contact/sections.ts']);
    for (const f of web.filter((x) => /^(widget|portal)\//.test(rel(x, WEB_SRC)))) expect(/homeowner/i.test(readFileSync(f, 'utf8')), rel(f, WEB_SRC)).toBe(false);
    // the panel has no write: it only GETs its own route
    const api = readFileSync(join(WEB_SRC, 'surfaces/homeowner/api.ts'), 'utf8');
    expect(api.match(/api\.(post|put|patch|delete)\b/g)).toBeNull();
    expect(api).toContain('/contacts/${contactId}/homeowner');
  });
});
