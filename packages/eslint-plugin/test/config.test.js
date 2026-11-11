// Architecture test: the repository's eslint.config.js applies each BUILD_PLAN rule to the right
// paths (and not to the allowlisted ones). Lints virtual files at real repository paths.
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { CLIENT_DB_EXPORTS } from '../src/rules/portal-tx-separation.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

/**
 * @param {string} path repository-relative
 * @param {string} code
 * @returns {Promise<import('eslint').Linter.LintMessage[]>}
 */
async function lintMessages(path, code) {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${path}` });
  return result?.messages ?? [];
}

/**
 * @param {string} path repository-relative
 * @param {string} code
 * @returns {Promise<string[]>} rule ids reported
 */
async function lint(path, code) {
  return (await lintMessages(path, code)).map((m) => m.ruleId ?? `fatal:${m.message}`);
}

/**
 * The value names a repository TypeScript module exports (types left out), optionally only those it re-exports from
 * `from`. A value `export *` cannot be listed this way and is skipped.
 * @param {string} path repository-relative
 * @param {string} [from]
 * @returns {string[]} sorted
 */
function valueExports(path, from) {
  // typescript-eslint types its parser loosely (one argument, an unknown AST); @typescript-eslint/parser takes options
  const parser = /** @type {any} */ (tseslint.parser);
  const { ast } = parser.parseForESLint(readFileSync(`${repoRoot}${path}`, 'utf8'), { sourceType: 'module', ecmaVersion: 2023 });
  /** @param {any} n @returns {string} */
  const nameOf = (n) => n.name ?? n.value;
  /** @type {Set<string>} */
  const names = new Set();
  for (const n of /** @type {any[]} */ (ast.body)) {
    if (n.type !== 'ExportNamedDeclaration' || n.exportKind === 'type') continue;
    if (from !== undefined && n.source?.value !== from) continue;
    const d = n.declaration;
    if (d?.type === 'VariableDeclaration') for (const v of d.declarations) names.add(nameOf(v.id));
    else if (d?.id) names.add(nameOf(d.id));
    for (const s of n.specifiers) if (s.exportKind !== 'type') names.add(nameOf(s.exported));
  }
  return [...names].sort();
}

describe('eslint.config.js architecture wiring', () => {
  it('packages/core imports nothing from db/api and no Node built-ins (type imports allowed)', async () => {
    expect(await lint('packages/core/src/ownership/decide.ts', "import { x } from '@realty/db';\nexport const y = x;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('packages/core/src/ownership/decide.ts', "import { x } from '@realty/api';\nexport const y = x;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('packages/core/src/foundation/time.ts', "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('packages/core/src/foundation/time.ts', "import { createHash } from 'crypto';\nexport const y = createHash;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('packages/core/src/foundation/time.ts', "import type { Buffer } from 'node:buffer';\nexport type B = Buffer;\n")).toEqual([]);
    expect(await lint('packages/core/src/compliance/gate.ts', "import { x } from '../foundation/index.js';\nexport const y = x;\n")).toEqual([]);
  });

  it('packages/core is pure: no wall clock, randomness, timers or process', async () => {
    const ids = await lint(
      'packages/core/src/priority/feed.ts',
      'export const a = Date.now();\nexport const b = Math.random();\nexport const c = new Date();\nexport const d = process.env.X;\nsetTimeout(() => {}, 1);\n',
    );
    expect(ids.filter((i) => i === 'no-restricted-properties')).toHaveLength(2);
    expect(ids).toContain('no-restricted-syntax');
    expect(ids.filter((i) => i === 'no-restricted-globals')).toHaveLength(2);
    expect(await lint('packages/core/src/foundation/time.ts', 'export const at = (ms: number) => new Date(ms);\n')).toEqual([]);
    expect(
      await lint('packages/core/src/foundation/tz.ts', "import { DateTime } from 'luxon';\nexport const a = DateTime.now();\nexport const b = DateTime.fromMillis(0, { zone: 'UTC' });\n"),
    ).toEqual(['no-restricted-syntax']);
    // tests may measure performance (BUILD_PLAN acceptance criteria are timings)
    expect(await lint('packages/core/src/priority/feed.test.ts', 'export const t = performance.now();\n')).toEqual([]);
  });

  it('only comms/dispatch.ts and comms/dial.ts may use provider send/dial', async () => {
    const code =
      'type P = { telephony: { sendSms(m: unknown): Promise<void>; dialCall(m: unknown): Promise<void> } };\n' +
      'export async function f(providers: P, m: unknown) { await providers.telephony.sendSms(m); }\n';
    expect(await lint('apps/api/src/assistant/firstResponse.ts', code)).toContain('realty/no-provider-outbound');
    expect(await lint('apps/api/src/worker/handlers/notify.ts', code)).toContain('realty/no-provider-outbound');
    expect(await lint('apps/api/src/comms/inbound.ts', code)).toContain('realty/no-provider-outbound');
    expect(await lint('apps/api/src/comms/dispatch.ts', code)).toEqual([]);
    expect(await lint('apps/api/src/comms/dial.ts', code.replace('sendSms', 'dialCall'))).toEqual([]);
    expect(await lint('apps/api/src/providers/fake/telephony.test.ts', code)).toEqual([]);
  });

  it('R-GATE-15: only marketing/publish.ts may call publishPost / postReviewReply (module 29)', async () => {
    const code =
      'type S = { publishPost(p: unknown): Promise<void>; postReviewReply(p: unknown): Promise<void> };\n' +
      'export async function f(social: S, p: unknown) { await social.publishPost(p); await social.postReviewReply(p); }\n';
    expect(await lint('apps/api/src/marketing/routes.ts', code)).toContain('realty/no-provider-outbound');
    expect(await lint('apps/api/src/marketing/handlers.ts', code)).toContain('realty/no-provider-outbound');
    expect(await lint('apps/api/src/marketing/publish.ts', code)).toEqual([]);
  });

  it("Actor { kind: 'system' } is constructed only in apps/api/src/worker/**", async () => {
    const code = "export const actor = { kind: 'system' as const, tenantId: 't', via: 'timer' as const };\n";
    expect(await lint('apps/api/src/leads/intake.ts', code)).toContain('realty/no-system-actor');
    expect(await lint('packages/db/src/ownership.ts', code)).toContain('realty/no-system-actor');
    expect(await lint('packages/core/src/ownership/decide.ts', code)).toContain('realty/no-system-actor');
    expect(await lint('apps/web/src/shell/App.tsx', code)).toContain('realty/no-system-actor');
    expect(await lint('apps/api/src/worker/systemActor.ts', code)).toEqual([]);
    expect(await lint('packages/db/test/ownership.test.ts', code)).toEqual([]);
  });

  it('R-TEN-14: withPortalTx only in portal client code, withTenantTx never there; client actors only from the resolver', async () => {
    const portalUse = "import { withPortalTx, type ClientActor } from '@realty/db';\nexport const f = (c: ClientActor) => withPortalTx(c, async () => 1);\n";
    const staffUse = "import { withTenantTx, type Tx } from '@realty/db';\nexport const f = (a: Parameters<typeof withTenantTx>[0]) => withTenantTx(a, async (_tx: Tx) => 1);\n";
    expect(await lint('apps/api/src/portal/client/routes.ts', portalUse)).toEqual([]);
    expect(await lint('apps/api/src/portal/client/routes.ts', staffUse)).toContain('realty/portal-tx-separation');
    // the session-then-act helper is a staff/pre-tenant transaction too (withPreTenant, then withTenantTx's GUCs)
    const preThenStaff = "import { withPreTenantThenTenant } from '@realty/db';\nexport const f = () => withPreTenantThenTenant(async () => 1, () => null, async () => 1);\n";
    expect(await lint('apps/api/src/portal/client/session.ts', preThenStaff)).toContain('realty/portal-tx-separation');
    expect(await lint('apps/api/src/auth/sessions.ts', preThenStaff)).toEqual([]);
    expect(await lint('apps/api/src/portal/staff/invite.ts', portalUse)).toContain('realty/portal-tx-separation');
    expect(await lint('apps/api/src/portal/staff/invite.ts', staffUse)).toEqual([]);
    expect(await lint('apps/api/src/workspace/deals.ts', portalUse)).toContain('realty/portal-tx-separation');
    expect(await lint('apps/api/src/worker/handlers/portal.ts', portalUse)).toContain('realty/portal-tx-separation');
    const forged = "export const c = { kind: 'client' as const, tenantId: 't', portalAccountId: 'a', sessionId: 's' };\n";
    expect(await lint('apps/api/src/portal/staff/preview.ts', forged)).toContain('realty/portal-tx-separation');
    expect(await lint('packages/db/src/consent.ts', forged)).toContain('realty/portal-tx-separation');
    expect(await lint('packages/db/test/portal_auth.test.ts', portalUse + staffUse.replace(/f =/, 'g ='))).toEqual([]);
  });

  it('R-TEN-14: portal client code takes from @realty/db only the value exports of portalTx.ts; every other export is refused there, not in the worker', async () => {
    // the rule's allowlist is exactly what portalTx.ts exports, and the barrel re-exports exactly that under the same names
    const allowed = [...CLIENT_DB_EXPORTS].sort();
    expect(valueExports('packages/db/src/portalTx.ts')).toEqual(allowed);
    expect(valueExports('packages/db/src/index.ts', './portalTx.js')).toEqual(allowed);
    // every value @realty/db exports, one import per line, so the line of each report names the export it refused
    const surface = valueExports('packages/db/src/index.ts');
    expect(surface).toEqual(expect.arrayContaining(['runOwnershipFollowup', 'claimJobs', 'finishJob', 'reapJobs', 'dueWork', 'jobs', 'getDatabase', 'createDatabase']));
    const code = `${surface.map((n) => `import { ${n} } from '@realty/db';`).join('\n')}\n`;
    /** @param {string} path @returns {Promise<string[]>} */
    const refused = async (path) =>
      (await lintMessages(path, code)).filter((m) => m.ruleId === 'realty/portal-tx-separation').map((m) => surface[m.line - 1] ?? `line ${m.line}`).sort();
    expect(await refused('apps/api/src/portal/client/probe.ts')).toEqual(surface.filter((n) => !CLIENT_DB_EXPORTS.includes(n)));
    // staff code (here the worker, which runs the queue and the follow-up job) is refused withPortalTx only
    expect(await refused('apps/api/src/worker/probe.ts')).toEqual(['withPortalTx']);
    // a call through the queue or the follow-up job is refused in client code even without the import
    const calls = 'export const f = async (now: never, actor: never, payload: never) => {\n  await dueWork(now, 10);\n  await runOwnershipFollowup(actor, payload);\n};\n';
    expect((await lint('apps/api/src/portal/client/jobs.ts', calls)).filter((id) => id === 'realty/portal-tx-separation')).toHaveLength(2);
  });

  it('SET app.* without LOCAL is banned everywhere', async () => {
    const code = "export const q = 'SET app.tenant_id = $1';\n";
    expect(await lint('packages/db/src/tenantTx.ts', code)).toContain('realty/no-session-guc');
    expect(await lint('apps/api/src/worker/loop.ts', code)).toContain('realty/no-session-guc');
    expect(await lint('packages/db/src/tenantTx.ts', "export const q = \"SELECT set_config('app.tenant_id', $1, true)\";\n")).toEqual([]);
  });

  it('selectFrom only in packages/db and module repositories (and tests)', async () => {
    const code = "type Db = { selectFrom(t: string): unknown };\nexport const f = (db: Db) => db.selectFrom('contacts');\n";
    expect(await lint('apps/api/src/leads/routes.ts', code)).toContain('no-restricted-syntax');
    expect(await lint('apps/api/src/workspace/feed.ts', code)).toContain('no-restricted-syntax');
    expect(await lint('packages/db/src/repos/contacts.ts', code)).toEqual([]);
    expect(await lint('apps/api/src/leads/repos/contacts.ts', code)).toEqual([]);
    expect(await lint('apps/api/src/leads/contacts.repo.ts', code)).toEqual([]);
    expect(await lint('apps/api/src/leads/intake.test.ts', code)).toEqual([]);
  });

  it('R-PAR-29: sql.raw / sql.lit / sql.ref / sql.id / sql.table are banned in apps/api/src/lists (smart-list SQL)', async () => {
    const code = "import { sql } from 'kysely';\nexport const f = (c: string) => sql.raw(c);\n";
    expect(await lint('apps/api/src/lists/repos/people.ts', code)).toContain('realty/no-sql-raw');
    expect(await lint('apps/api/src/lists/run.ts', code)).toContain('realty/no-sql-raw');
    expect(await lint('apps/api/src/leads/repos/contacts.ts', code)).not.toContain('realty/no-sql-raw');
    expect(await lint('apps/api/src/lists/people.sql.test.ts', code)).not.toContain('realty/no-sql-raw');
  });

  it('packages/db never imports api/web; apps/web never imports db and api only as types', async () => {
    expect(await lint('packages/db/src/jobs.ts', "import { x } from '@realty/api';\nexport const y = x;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('apps/web/src/shell/api.ts', "import { x } from '@realty/db';\nexport const y = x;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('apps/web/src/shell/api.ts', "import { x } from '@realty/api';\nexport const y = x;\n")).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
    expect(await lint('apps/web/src/shell/api.ts', "import type { X } from '@realty/api';\nexport type Y = X;\n")).toEqual([]);
  });

  it('relative imports cannot escape a package', async () => {
    expect(await lint('apps/api/src/leads/intake.ts', "import { x } from '../../../../packages/db/src/index.js';\nexport const y = x;\n")).toContain(
      'realty/no-relative-outside-package',
    );
  });
  it('PHASE2_3_PLAN §5.3 (module 37): the chat widget imports nothing from the staff app; its tests and the staff app are not restricted', async () => {
    expect(await lint('apps/web/src/widget/widget.ts', "import { Button } from '../design/index.js';\nexport const b = Button;\n")).toContain('realty/isolated-bundle');
    expect(await lint('apps/web/src/widget/main.ts', "import { createRoot } from 'react-dom/client';\nexport const r = createRoot;\n")).toContain('realty/isolated-bundle');
    expect(await lint('apps/web/src/widget/api.ts', "import { copy } from './copy.js';\nexport const c = copy;\n")).not.toContain('realty/isolated-bundle');
    expect(await lint('apps/web/src/widget/widget.test.ts', "import { describe } from 'vitest';\nexport const d = describe;\n")).not.toContain('realty/isolated-bundle');
    expect(await lint('apps/web/src/surfaces/thread/ThreadPage.tsx', "import { Button } from '../../design/index.js';\nexport const b = Button;\n")).not.toContain('realty/isolated-bundle');
  });
});
