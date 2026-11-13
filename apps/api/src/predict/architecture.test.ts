// R-PRED-4 architecture test (module 50): a prediction becomes a feed card and nothing else. Source scans of every
// apps/api file prove that prediction output reaches no routing, ownership, ads, portal or message code, that the
// prediction module writes only its own rows, and that no app code writes prediction_models (R-PRED-1: models are
// platform-released; a fresh database holds none). Also E120: the feature loader never selects contact_attributes.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(API_SRC, '..', '..', '..');
const PREDICT = join(API_SRC, 'predict');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(API_SRC, f).replaceAll('\\', '/');
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /(^|\/)testing\.ts$/.test(f) || /\.testing\.ts$/.test(f);
const ALL = sourceFiles(API_SRC);
const RUNTIME = ALL.filter((f) => !isTest(rel(f)));
const PREDICT_RUNTIME = RUNTIME.filter((f) => rel(f).startsWith('predict/'));

/** Import specifiers of a file (static, dynamic and type imports). */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
const resolvesInto = (file: string, spec: string, dir: string) => spec.startsWith('.') && resolve(dirname(file), spec).startsWith(dir + '/');

describe('R-PRED-4: prediction reaches nothing but its feed card', () => {
  it('the scans are not vacuous: the prediction module and the rest of apps/api are read', () => {
    expect(PREDICT_RUNTIME.map(rel).sort()).toEqual(['predict/decide.ts', 'predict/handlers.ts', 'predict/models.ts', 'predict/pass.ts', 'predict/provider.ts', 'predict/routes.ts', 'predict/settings.ts']);
    expect(RUNTIME.length).toBeGreaterThan(200);
  });

  it('R-PRED-4: only worker/handlers/index.ts, providers/index.ts and routes.ts (the read-only GET /likely, module 55, and nothing else of predict/**) import predict/** (outside the module and its tests); predict/provider.ts alone is also imported by providers/publicRecords/** and homeowner/** (D10)', () => {
    const PROVIDER = join(PREDICT, 'provider.ts');
    const LANE = /^(providers\/publicRecords|homeowner)\//;
    const importers = RUNTIME.filter((f) => !rel(f).startsWith('predict/') && !LANE.test(rel(f)) && importsOf(f).some((s) => resolvesInto(f, s, PREDICT))).map(rel);
    expect(importers.sort()).toEqual(['providers/index.ts', 'routes.ts', 'worker/handlers/index.ts']);
    // routes.ts (which every lane edits) reaches predict/** through the read-only route file only: never pass.ts,
    // handlers.ts or another module file (batch 14 audit S2, the condition of the verify 9 sign-off)
    const ROUTES = join(API_SRC, 'routes.ts');
    expect(importsOf(ROUTES).filter((s) => resolvesInto(ROUTES, s, PREDICT))).toEqual(['./predict/routes.js']);
    // the homeowner lane imports predict/provider.ts (the shared interface) and no other predict file
    const isProvider = (f: string, s: string) => resolve(dirname(f), s).replace(/\.js$/, '.ts') === PROVIDER;
    for (const f of RUNTIME.filter((x) => LANE.test(rel(x)))) {
      expect(importsOf(f).filter((s) => resolvesInto(f, s, PREDICT) && !isProvider(f, s)), rel(f)).toEqual([]);
    }
  });

  it('R-PRED-4: predict/** imports nothing from comms, channels, leads, assistant, ownership, ads, portal, nurture or marketing, and names no send, dial, publish, budget or ownership command', () => {
    const FORBIDDEN_DIRS = ['comms', 'channels', 'leads', 'assistant', 'ownership', 'ads', 'portal', 'nurture', 'marketing', 'mailSync', 'coaching'].map((d) => join(API_SRC, d));
    const FORBIDDEN_SPECS = /(^@realty\/db\/.*ownership|packages\/db\/src\/ownership|\/ownership(\/|\.js$)|@realty\/core\/(coaching|ownership|routing|ads|portal))/;
    const FORBIDDEN_NAMES = /\b(dispatchOutbound|dialOutbound|deliverChannelMessage|publishPost|postReviewReply|applyBudgetChange|applyOwnershipCommand|sendSms|sendEmail|dialCall|enqueueTyped|createNotification|notify)\b/;
    for (const f of PREDICT_RUNTIME) {
      const specs = importsOf(f);
      expect(specs.filter((s) => FORBIDDEN_DIRS.some((d) => resolvesInto(f, s, d)) || FORBIDDEN_SPECS.test(s)), rel(f)).toEqual([]);
      expect(readFileSync(f, 'utf8').match(FORBIDDEN_NAMES)?.[0] ?? null, rel(f)).toBeNull();
      // no AI provider call either
      expect(/providers\.ai\b|anthropic/i.test(readFileSync(f, 'utf8')), rel(f)).toBe(false);
    }
  });

  it('R-PRED-4: the module\'s SQL writes only property_records, contact_predictions, likely_to_move rows under likely: keys, and the purge', () => {
    const writes: string[] = [];
    for (const f of PREDICT_RUNTIME) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/g)) writes.push(`${m[1]!.replace(/\s+/g, ' ')} ${m[2]}`);
      // every feed write is a likely_to_move row under a likely: key
      for (const m of src.matchAll(/(?:INSERT INTO|UPDATE) priority_feed_items[\s\S]*?`/g)) expect(/likely_to_move|likely:%|id = \$\{|id = ANY/.test(m[0]), `${rel(f)}: ${m[0].slice(0, 80)}`).toBe(true);
      for (const m of src.matchAll(/SELECT\s+\*?\s*FROM\s+app\.([a-z_]+)\(|app\.([a-z_]+)\(/g)) {
        const fn = m[1] ?? m[2]!;
        expect(['tenant_id', 'purge_prediction_data'], `${rel(f)} calls app.${fn}`).toContain(fn);
      }
    }
    expect([...new Set(writes)].sort()).toEqual(['INSERT INTO contact_predictions', 'INSERT INTO priority_feed_items', 'INSERT INTO property_records', 'UPDATE contact_predictions', 'UPDATE priority_feed_items']);
    // the feed rows the module updates are selected by item_type likely_to_move and a likely: key
    const pass = readFileSync(join(PREDICT, 'pass.ts'), 'utf8');
    expect(pass).toMatch(/item_type = 'likely_to_move' AND contact_id = ANY[\s\S]*dedupe_key LIKE 'likely:%'/);
  });

  it('R-PRED-4 R-STAFF-7: predict/routes.ts (GET /likely, module 55) writes nothing and registers one GET only (the module-wide write list above cannot tell which file writes)', () => {
    const file = join(PREDICT, 'routes.ts');
    // code only: the header comment explains the rule
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/\b(INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY\s+[a-z_.]+\s+FROM|FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE))\b/i)?.[0] ?? null).toBeNull();
    expect(code.match(/\b(insertInto|updateTable|deleteFrom|mergeInto|replaceInto)\s*\(/)?.[0] ?? null).toBeNull();
    // no app.* function but app.tenant_id(): a definer could write on its behalf
    expect([...code.matchAll(/\bapp\.([a-z_]+)\s*\(/g)].map((m) => m[1])).toEqual(['tenant_id']);
    // the routes it registers: exactly one, the GET of /likely
    expect([...code.matchAll(/\b(?:r|app)\.(get|post|put|patch|delete|head|options|all|route)\s*\(\s*(['"`][^'"`]*['"`])?/g)].map((m) => `${m[1]} ${m[2] ?? ''}`)).toEqual(["get '/likely'"]);
    // and its own relative imports cannot reach a writer: the actor helper, the RouteModule type and the band words
    expect(importsOf(file).filter((s) => s.startsWith('.')).sort()).toEqual(['../admin/common.js', '../routes.js', './settings.js']);
  });

  it('R-PRED-4: no SQL outside predict/** names contact_predictions or property_records, except the feed read (workspace/feed.ts)', () => {
    const offenders = RUNTIME.filter((f) => !rel(f).startsWith('predict/') && rel(f) !== 'workspace/feed.ts')
      .filter((f) => /\b(contact_predictions|property_records)\b/.test(readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
      .map(rel);
    expect(offenders).toEqual([]);
    // directories not built yet are covered by this scan as soon as they exist
    const later = ['ads', 'portal', 'nurture', 'marketing'].filter((d) => existsSync(join(API_SRC, d)));
    for (const d of later) expect(RUNTIME.some((f) => rel(f).startsWith(`${d}/`)), d).toBe(true);
  });

  it('R-PRED-1: no apps/api code writes prediction_models (models are released by the platform); E120: predict/** never selects contact_attributes', () => {
    const writers = ALL.filter((f) => !rel(f).endsWith('.test.ts') && !rel(f).endsWith('testing.ts'))
      .filter((f) => /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+prediction_models|(insertInto|updateTable|deleteFrom)\(\s*['"]prediction_models/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(writers).toEqual([]);
    // code only (comments explain the rule and name the table)
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of PREDICT_RUNTIME) expect(/contact_attributes|imported_fields|\bnotes\b|\bmessages\b/.test(code(f)), rel(f)).toBe(false);
  });

  it('R-PRED-4: realty/no-prediction-import reports nothing in the guarded code, and does fire there', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const results = await eslint.lintFiles(['packages/core/src/{ownership,priority}/**/*.ts', 'apps/api/src/{comms,leads}/**/*.ts']);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'realty/no-prediction-import').map((m) => `${relative(REPO, r.filePath)}:${m.line}`));
    expect(hits).toEqual([]);
    const probe = await eslint.lintText("import { scoreWithModel } from '@realty/core/predict';\nexport const x = scoreWithModel;\n", { filePath: join(REPO, 'apps/api/src/comms/compose.ts') });
    expect(probe[0]!.messages.some((m) => m.ruleId === 'realty/no-prediction-import')).toBe(true);
  }, 180_000);
});
