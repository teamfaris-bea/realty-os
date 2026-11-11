// Architecture test: the repository's eslint.config.js applies each BUILD_PLAN rule to the right
// paths (and not to the allowlisted ones). Lints virtual files at real repository paths.
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

/**
 * @param {string} path repository-relative
 * @param {string} code
 * @returns {Promise<string[]>} rule ids reported
 */
async function lint(path, code) {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${path}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal:${m.message}`);
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
    expect(await lint('apps/api/src/portal/staff/invite.ts', portalUse)).toContain('realty/portal-tx-separation');
    expect(await lint('apps/api/src/portal/staff/invite.ts', staffUse)).toEqual([]);
    expect(await lint('apps/api/src/workspace/deals.ts', portalUse)).toContain('realty/portal-tx-separation');
    expect(await lint('apps/api/src/worker/handlers/portal.ts', portalUse)).toContain('realty/portal-tx-separation');
    const forged = "export const c = { kind: 'client' as const, tenantId: 't', portalAccountId: 'a', sessionId: 's' };\n";
    expect(await lint('apps/api/src/portal/staff/preview.ts', forged)).toContain('realty/portal-tx-separation');
    expect(await lint('packages/db/src/consent.ts', forged)).toContain('realty/portal-tx-separation');
    expect(await lint('packages/db/test/portal_auth.test.ts', portalUse + staffUse.replace(/f =/, 'g ='))).toEqual([]);
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
});
