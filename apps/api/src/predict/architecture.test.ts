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

// The S2 pin on predict/routes.ts (batch 14 audit S2, decision (c)): the first write or row lock in `code`, or null.
// An UPDATE is caught with an alias (`UPDATE t f SET`, `UPDATE t AS f SET`, the idiom workspace/feed.ts uses on the same
// table), with ONLY, quoted or inside a CTE; any upper-case UPDATE keyword at all is a write or a row lock here.
const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[a-z_."]+(?:\s+(?:AS\s+)?(?!SET\b)[a-z_]+)?\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY\s+[a-z_.]+\s+FROM|FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE))\b/i;
const SQL_UPDATE_KEYWORD = /\bUPDATE\b/;
const WRITE_BUILDER = /\b(insertInto|updateTable|deleteFrom|mergeInto|replaceInto)\s*\(/;
function firstWrite(code: string): string | null {
  return code.match(WRITE_SQL)?.[0] ?? code.match(SQL_UPDATE_KEYWORD)?.[0] ?? code.match(WRITE_BUILDER)?.[0] ?? null;
}
/** The top-level arguments of the call whose '(' is at `open`, as source text (strings, templates and nesting skipped). */
function callArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const last = code.slice(start, i).trim();
        if (last !== '' || args.length > 0) args.push(last);
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}
/** The routes `code` registers, as '<method> <path>', on ANY receiver (not only one named r or app) and by dot or
 *  bracket access (`r.get(` or `r['get'](`): every verb call whose first argument is a literal path, plus any route(
 *  and any POST/PUT/PATCH/ALL whose path is not a literal, plus (b14 review F3; b15, b14 low d) any GET/DELETE/HEAD/
 *  OPTIONS whose path is not a literal (a variable, a call such as pathOf('x') or String(P)) and that takes a second
 *  argument (a handler or options; a Map's or Headers' `.get(key)` takes one). */
function routesIn(code: string): string[] {
  const out: string[] = [];
  const VERB = 'get|post|put|patch|delete|head|options|all|route';
  for (const m of code.matchAll(new RegExp(`(?:\\.\\s*(${VERB})|\\[\\s*(['"\`])(${VERB})\\2\\s*\\])\\s*\\(`, 'g'))) {
    const verb = (m[1] ?? m[3])!;
    const args = callArgs(code, m.index! + m[0].length - 1);
    const first = args[0] ?? '';
    if (verb === 'route') out.push('route (path not a literal)');
    else if (/^['"`]\/[^'"`]*['"`]$/.test(first)) out.push(`${verb} ${first}`);
    else if (!['get', 'delete', 'head', 'options'].includes(verb) || args.length >= 2) out.push(`${verb} (path not a literal)`);
  }
  return out;
}
/** The S2 pin on EVERY import of a file (b14 review F3): each module specifier with the names taken from it, sorted;
 *  a namespace import is '* as X', a default import 'default X'; a re-export, require() or dynamic import() is listed
 *  under its own key, so it can never be added unseen. */
function importPin(code: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (key: string, names: readonly string[]) => (out[key] = [...(out[key] ?? []), ...names].sort());
  for (const m of code.matchAll(/^\s*import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1]!;
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const n of braces[1]!.split(',').map((x) => x.trim()).filter(Boolean)) names.push(n.replace(/^type\s+/, ''));
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (ns) names.push(`* as ${ns[1]}`);
    else if (rest) names.push(`default ${rest}`);
    add(m[2]!, names);
  }
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) add(`side effect ${m[1]}`, []);
  for (const m of code.matchAll(/^\s*export\s[^'";]*from\s+['"]([^'"]+)['"]/gm)) add(`re-export ${m[1]}`, []);
  for (const m of code.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) add(`${m[1]}() ${m[2]!.trim()}`, []);
  return out;
}
/** predict/routes.ts's imports as signed off (batch 14 audit S2; b14 review F3): of @realty/db only withTenantTx, so a
 *  writer exported there (enqueueJob, insertAuditRow, lockContact, recordConsentEvent …) cannot be imported unseen. */
const ROUTES_IMPORTS: Record<string, string[]> = {
  '@realty/core/foundation': ['UserActor'],
  '@realty/core/predict': ['backtestText'],
  '@realty/db': ['withTenantTx'],
  fastify: ['FastifyInstance'],
  'fastify-type-provider-zod': ['ZodTypeProvider'],
  kysely: ['sql'],
  zod: ['z'],
  '../admin/common.js': ['actorOf'],
  '../routes.js': ['RouteModule'],
};

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
    const FORBIDDEN_NAMES = /\b(dispatchOutbound|dialOutbound|deliverChannelMessage|publishPost|postReviewReply|applyBudgetChange|applyOwnershipCommand|sendSms|sendEmail|dialCall|enqueueTyped|enqueueJob|insertAuditRow|recordConsentEvent|lockContact|createNotification|notify)\b/;
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
    expect(firstWrite(code)).toBeNull();
    // no app.* function but app.tenant_id(): a definer could write on its behalf
    expect([...code.matchAll(/\bapp\.([a-z_]+)\s*\(/g)].map((m) => m[1])).toEqual(['tenant_id']);
    // the routes it registers: exactly one, the GET of /likely
    expect(routesIn(code)).toEqual(["get '/likely'"]);
    // and its own relative imports cannot reach a writer: the actor helper and the RouteModule type
    expect(importsOf(file).filter((s) => s.startsWith('.')).sort()).toEqual(['../admin/common.js', '../routes.js']);
    // b14 review F3: every import, package ones included, with the names it takes (no writer of @realty/db)
    expect(importPin(code)).toEqual(ROUTES_IMPORTS);
  });

  it('R-PRED-4 R-STAFF-7 (b14 to-do): the S2 pin\'s patterns fire on planted writes and routes, aliased, CTE and any receiver included', () => {
    const writes = [
      'await sql`UPDATE priority_feed_items f SET state = f.state WHERE f.user_id = ${actor.userId}`.execute(tx);',
      'await sql`UPDATE priority_feed_items AS f SET state = f.state`.execute(tx);',
      'await sql`UPDATE ONLY priority_feed_items SET state = state`.execute(tx);',
      'await sql`WITH u AS (UPDATE priority_feed_items f SET state = f.state RETURNING f.id) SELECT count(*) FROM u`.execute(tx);',
      'await sql`update public.priority_feed_items set state = state`.execute(tx);',
      'await sql`UPDATE "priority_feed_items" SET state = state`.execute(tx);',
      'await sql`INSERT INTO contact_predictions (id) VALUES (${id})`.execute(tx);',
      'await sql`DELETE FROM priority_feed_items WHERE id = ${id}`.execute(tx);',
      'await sql`SELECT id FROM priority_feed_items WHERE id = ${id} FOR UPDATE`.execute(tx);',
      "await tx.updateTable('priority_feed_items').set({ state: 'done' }).execute();",
    ];
    for (const w of writes) expect(firstWrite(w), w).not.toBeNull();
    // reads stay clean
    expect(firstWrite('await sql`SELECT f.id, f.updated_at FROM priority_feed_items f WHERE f.state = ${s}`.execute(tx); // last update time')).toBeNull();
    const routes = [
      "r.post('/likely/:id/dismiss', handler);",
      "t.post('/likely/:id/dismiss', handler);",
      "s.get('/likely/export', handler);",
      "fastify.delete(`/likely/${id}`, handler);",
      "instance.route({ method: 'POST', url: '/likely/x', handler });",
      'scope.put(LIKELY_PATH, handler);',
      // b14 review F3: a GET or DELETE whose path is in a variable, or a literal without the leading slash
      'r.get(LIKELY_EXPORT, exportAll);',
      'r.delete(LIKELY_ITEM, dismiss);',
      "r.get('likely/export', { config: { auth: 'self' } }, h);",
      // b15 (b14 low d): a path built by a call, and bracket access
      "r.get(pathOf('likely/export'), h);",
      'r.get(String(LIKELY_EXPORT), h);',
      'r.delete(paths.item(id), dismiss);',
      "r['get']('/likely/export', h);",
      'r["delete"](LIKELY_ITEM, dismiss);',
      "r[`post`]('/likely/:id/dismiss', h);",
    ];
    for (const x of routes) expect(routesIn(`r.get('/likely', h);\n${x}`), x).not.toEqual(["get '/likely'"]);
    // b14 review F3: a writer imported from a package (none of these is SQL in the file) changes the import pin
    const pinned = readFileSync(join(PREDICT, 'routes.ts'), 'utf8');
    expect(importPin(pinned)).toEqual(ROUTES_IMPORTS);
    for (const planted of [
      "import { enqueueJob, withTenantTx } from '@realty/db';",
      "import { insertAuditRow } from '@realty/db';",
      "import { lockContact as lc } from '@realty/db';",
      "import * as db from '@realty/db';",
      "import { recordConsentEvent } from '@realty/db';",
      "export { enqueueJob } from '@realty/db';",
      "const m = await import('../comms/dispatch.js');",
    ]) expect(importPin(`${pinned}\n${planted}\n`), planted).not.toEqual(ROUTES_IMPORTS);
    // a Map or Headers .get is not a route (one argument), even when its key is a call
    expect(routesIn("r.get('/likely', h);\nconst v = byId.get(id) ?? req.headers.get('x-id') ?? byId.get(keyOf(a, b)) ?? m['get'](k);")).toEqual(["get '/likely'"]);
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
