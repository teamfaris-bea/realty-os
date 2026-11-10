# Realty OS: Engineering Conventions (Phase 1)

Written by the scaffold step. Every module builder follows it. The authoritative design is in `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` and `docs/BUILD_PLAN.md`; this file says **where code goes, how modules plug into shared files without conflicts, and how to test**. Where this file and BUILD_PLAN disagree on a path, BUILD_PLAN wins. Tell the orchestrator about the disagreement.

Several module builders work **concurrently in one working tree**. Stay inside your module's paths (§2). Touch shared files only through the additive-edit protocol (§3). Do not commit; the orchestrator commits.

---

## 1. Workspace layout

pnpm workspace, TypeScript 6 (`strict`, `noUncheckedIndexedAccess`), Node 22, ESM everywhere (`"type": "module"`).

| Package | Dir | What | Depends on |
|---|---|---|---|
| `@realty/core` | `packages/core` | Pure domain logic (modules 1–6). No I/O, no clock, no randomness. | zod, luxon, libphonenumber-js, csv-parse, @noble/hashes |
| `@realty/db` | `packages/db` | Migrations, Kysely types, tenant tx, ownership/consent persistence, jobs (module 7). Also the migration runner and the test-DB helper. | `@realty/core`, kysely, pg |
| `@realty/api` | `apps/api` | Fastify HTTP server and worker, one build with two entrypoints (modules 8–16). | `@realty/core`, `@realty/db`, fastify + plugins, zod, argon2, otplib, web-push, @anthropic-ai/sdk, uuid |
| `@realty/web` | `apps/web` | One responsive React 18 app for phone and desktop (module 17). | `@realty/core` (types and pure helpers only), react, react-router-dom 7, @tanstack/react-query, tailwind 4 |
| `@realty/eslint-plugin` | `packages/eslint-plugin` | The architecture lint rules (§6). | eslint |

**Imports between packages** always use the package name, never a relative path. A lint rule rejects any relative import that leaves its package.
- `@realty/core` has **one subpath per module**: `@realty/core/foundation`, `@realty/core/compliance`, `@realty/core/ownership`, `@realty/core/assistant`, `@realty/core/priority`, `@realty/core/import`. Each maps to `packages/core/src/<module>/index.ts`, which that module owns. The root `@realty/core` entry stays empty, so no core module ever edits a shared index file.
- Inside a package, relative imports carry the `.js` extension (NodeNext): `import { x } from '../foundation/index.js'`. A core module may import another core module's `index.js`, but never its internals.
- `@realty/db` exports `.` (module 7 fills `src/index.ts`), `./migrate` and `./testing`. Module 7 may add subpaths in `packages/db/package.json`.
- Workspace packages resolve to their **TypeScript sources** through the `@realty/source` export condition. tsc uses it via `customConditions`, Vitest and Vite via `resolve.conditions` (see `vitest.shared.ts`), and tsx via `--conditions=@realty/source`. Built output (`dist/`) is used only by `node dist/...` in production. You never need to build a package before testing another.

**Dependencies are already installed.** Do not run `pnpm add` or `pnpm install` unless something is truly missing. If you must, use `pnpm --filter <pkg> add <dep>` and say so in your output. Already available:
- runtime: `fastify@5`, `@fastify/{cookie,cors,helmet,rate-limit,multipart,swagger}`, `fastify-type-provider-zod`, `zod@4`, `kysely`, `pg`, `argon2`, `otplib`, `web-push`, `@anthropic-ai/sdk`, `uuid` (v7), `luxon`, `libphonenumber-js`, `csv-parse`, `@noble/hashes`, `react@18`, `react-dom@18`, `react-router-dom@7`, `@tanstack/react-query@5`
- dev: `vitest@5`, `@vitest/coverage-v8`, `fast-check`, `@stryker-mutator/core` + `vitest-runner` (in core), `jsdom`, `@testing-library/{react,dom,user-event,jest-dom}`, `axe-core`, `tailwindcss@4` + `@tailwindcss/vite`, `vite@8`, `@vitejs/plugin-react`, `tsx`, `typescript@6`
- Playwright is preinstalled globally and linked into `apps/web` as `playwright` (`link:` to `/opt/node-tools/node_modules/playwright`; browsers in `$PLAYWRIGHT_BROWSERS_PATH`). Specs import from `'playwright/test'`. Only Chromium is installed, so the iPhone 13 project runs Chromium with iPhone viewport, touch and user agent.

---

## 2. Module map: where each module's code and tests go

Tests sit **next to the code** as `*.test.ts(x)`. The exceptions are `packages/db/test/` (BUILD_PLAN module 7) and `apps/web/e2e/` (Playwright). Shared files a module **creates** (and then owns) are in the last column; other modules extend them only through §3.

| # | Module | Owns (code + tests) | Creates these shared registration files |
|---|---|---|---|
| 1 | core/foundation | `packages/core/src/foundation/**` | `packages/core/src/foundation/authz.ts`: `Action` and `AuditAction` unions; `errors.ts`: base error-code types |
| 2 | core/compliance | `packages/core/src/compliance/**`, `packages/core/stryker.config.mjs` | none (exports `RULES_VERSION`) |
| 3 | core/ownership | `packages/core/src/ownership/**` | none |
| 4 | core/assistant | `packages/core/src/assistant/**` | none |
| 5 | core/priority | `packages/core/src/priority/**` | none |
| 6 | core/import | `packages/core/src/import/**` | none |
| 7 | db/client | `packages/db/src/**` (except `src/testing/`, which is scaffold-owned; db/client may extend it additively), `packages/db/test/**`, `packages/db/package.json` exports | `packages/db/src/schema.ts` (Kysely `DB` interface for every table/view) |
| 8 | api/platform | `apps/api/src/{main.ts,server.ts,routes.ts,auth/,rbac.ts,crypto/,audit.ts,providers/,errors.ts,config.ts}` | `apps/api/src/routes.ts` (route registry), `apps/api/src/errors.ts` (code → HTTP status), `apps/api/src/providers/index.ts` (`Providers` bag), `apps/api/src/config.ts` |
| 9 | api/jobs-worker | `apps/api/src/worker/**` | `apps/api/src/worker/handlers/index.ts` (handler list), `apps/api/src/worker/systemActor.ts` (the only system-actor factory) |
| 10 | api/admin | `apps/api/src/admin/**` | none |
| 11 | api/leads | `apps/api/src/leads/**` | none |
| 12 | api/comms | `apps/api/src/comms/**` | none (`dispatch.ts` and `dial.ts` are the only outbound path) |
| 13 | api/assistant | `apps/api/src/assistant/**` | none |
| 14 | api/workspace | `apps/api/src/workspace/**` | none |
| 15 | api/accountability | `apps/api/src/accountability/**` | none |
| 16 | api/imports | `apps/api/src/imports/**` | none |
| 17a | web/shell | `apps/web/src/{shell,design}/**`, `apps/web/src/main.tsx`, `apps/web/index.html`, `apps/web/e2e/shell/**` | `apps/web/src/shell/registry.ts` (surface/page registry), `apps/web/src/shell/errorMessages.ts` (code → sentence) |
| 17b | web/agent | `apps/web/src/surfaces/{feed,contact,thread,compose,approvals,pond,search,tasks,deals,listings}/**`, `apps/web/e2e/agent/**` | none |
| 17c | web/lead-admin | `apps/web/src/surfaces/{team,admin,imports,settings}/**`, `apps/web/e2e/lead-admin/**` | none |

Repositories: API modules that query the database put Kysely queries in `apps/api/src/<module>/repos/*.ts` (or `*.repo.ts`). The `selectFrom` lint rule allows exactly those places, plus `packages/db/**` and tests.

Scaffold-owned files (do not edit unless asked; additive `.env.example` keys are allowed): root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.shared.ts`, `eslint.config.js`, `packages/eslint-plugin/**`, `scripts/rule-coverage.mjs`, `packages/db/src/{migrate.ts,dbConfig.ts,testing/*,scripts/*}`, and each package's `package.json`, `tsconfig*.json` and `vitest.config.ts`. A module that needs a change to one of these (for example a new package export) makes the smallest additive edit and reports it.

---

## 3. Shared registration points and the additive-edit protocol

Shared registration files keep conflicts small: each dependent module adds **one import line and one list entry** and never touches anyone else's lines.

| File | Owner | Shape (owner defines it exactly) | How dependents register |
|---|---|---|---|
| `apps/api/src/routes.ts` | api/platform | `export const routeModules: RouteModule[] = [...]`, where `RouteModule = { name: string; register: FastifyPluginAsync }`. Mounted under the **`/api` prefix**. Every route declares its authorization (core `Action` or `'public'` / `'webhook'`), so the route-table test can prove that no route lacks `authorize`. | `apps/api/src/<module>/routes.ts` exports `<module>Routes: RouteModule`; add its import and entry. |
| `apps/api/src/errors.ts` | api/platform | `ERROR_STATUS: Record<ErrorCode, number>` plus `AppError` | Add your module's codes (see §7). |
| `apps/api/src/providers/index.ts` | api/platform | `Providers` bag + `createFakeProviders()` / `createProviders(config)` | Only api/platform adds providers. |
| `apps/api/src/worker/handlers/index.ts` | api/jobs-worker | `export const handlers: JobHandler<any>[] = [...]` | `apps/api/src/<module>/handlers.ts` exports `<module>Handlers`; add one import and `...<module>Handlers`. |
| `packages/db/src/schema.ts` | db/client | `export interface DB { <table>: <Table>Table; ... }` | Whoever adds a migration with a new table/column adds the matching interface members (the drift test compares against `information_schema`). |
| `packages/core/src/foundation/authz.ts` | core/foundation | `Action` and `AuditAction` string unions, `can()` matrix | Add new members to a union when your module introduces an action. A new `Action` also needs its `can()` matrix row (coordinate with the DATA_MODEL §3 matrix; never widen a permission silently). |
| `apps/web/src/shell/registry.ts` | web/shell | `export const surfaces: SurfaceModule[] = [...]`, where `SurfaceModule = { pages: PageDef[]; errorMessages?: Record<string, string> }`, and `PageDef` has path, title, nav placement (phone tab / desktop sidebar / none), allowed roles and a lazy component | `apps/web/src/surfaces/<surface>/index.ts` exports `surface: SurfaceModule`; add one import and entry. |
| `apps/web/src/shell/errorMessages.ts` | web/shell | `Record<ErrorCode, string>` human sentences, plus a generic fallback | Prefer `errorMessages` on your `SurfaceModule`; edit this file only for cross-surface codes. |
| `.env.example` | scaffold | `KEY=` lines with a comment | Add new keys at the end with a comment. Never put real secrets in it. |

**Protocol (mandatory):**
1. **Re-read the file immediately before editing.** Other agents edit concurrently.
2. Use an exact-string edit that inserts **new lines only**. Never rewrite the whole file, reorder, reformat, rename, or delete someone else's entries. Insert at the end of the list, before the closing bracket or the `// registry: add new entries above this line` marker if the owner placed one.
3. One line per import, one line per entry. Do not merge your entry into another line.
4. If the edit fails because the file changed, re-read it and redo the insertion. Do not overwrite.
5. Run the owning package's `typecheck` after the edit.
6. If the registry file you need does not exist yet, its owner has not delivered it. **Do not create a competing one.** Report the blocker.

---

## 4. Database and migrations

- Schema source: `packages/db/migrations/NNNN_<module>_<what>.sql`, applied in lexical order by `@realty/db/migrate` (`pnpm db:migrate`, owner role from `MIGRATION_DATABASE_URL`). Each file runs in **one transaction** with its bookkeeping row in `realty_migrations.schema_migrations` (version, name, sha256 checksum). The runner refuses an edited, renamed, missing or out-of-order applied migration, and two files with the same number.
- **Naming.** Use the next free 4-digit number plus your module slug: `0002_db_client_kysely_support.sql`, `0003_api_admin_invite_indexes.sql`. Lowercase, digits, `_` or `-` only.
- **Claiming a number.** Run `ls packages/db/migrations`, take the highest number + 1, and write the **complete** file in one go. If the runner later reports a duplicate number, the file written second is renumbered by its author.
- **Never edit `0001_init.sql`**, any committed migration, or another module's migration. While your own uncommitted migration is in progress, iterate with tests: `createTestDb()` rebuilds its template automatically when migration content changes. Do **not** run `pnpm db:migrate` against `realty_dev` until your migration is final. Once it is applied there, changing it means writing a new migration.
- **Every new table must keep the 0001 invariants.** The test `packages/db/test/schema_invariants.test.ts` re-runs 0001's self-check (§22) over all migrations, so a violation fails `pnpm --filter @realty/db test`. The invariants:
  - `tenant_id uuid NOT NULL` leads the primary key, and every reference is a composite FK `(tenant_id, x_id)`; user references go to `memberships (tenant_id, user_id)`.
  - `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, with the Layer-1 policies the 0001 DO loop created for older tables. The loop ran once and does not cover new tables, so add them yourself:
    ```sql
    ALTER TABLE x ENABLE ROW LEVEL SECURITY; ALTER TABLE x FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON x AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
    CREATE POLICY support_read_only_ins ON x AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
    CREATE POLICY support_read_only_upd ON x AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
    CREATE POLICY support_read_only_del ON x AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
    -- plus at least one PERMISSIVE policy (Layer 2) and the minimal GRANTs to app_user
    ```
  - Append-only tables use `app.reject_mutation()` triggers, and `app_user` gets SELECT and INSERT only. `updated_at` uses the `app.touch_updated_at()` trigger. Enums are `text` + `CHECK`. Ids have no DB default (core generates UUIDv7).
  - A `SECURITY DEFINER` function is owned by `app_definer` (or `app_retention` for retention), pins `search_path`, filters `tenant_id = app.tenant_id()` explicitly, and returns minimal columns. Adding one is a security-review item: call it out in your output.
- **Roles.** `app_user` (password `app_user_dev` in dev) is `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT` and a member of **no role**; 0001 aborts otherwise. `app_definer` and `app_retention` are `NOLOGIN BYPASSRLS` owners. Application code connects only as `app_user` (`DATABASE_URL`). `app_owner` is the dev superuser for migrations and test fixtures only.
- **Dev bootstrap.** `pnpm db:setup` is idempotent: it writes `.env` (fresh KEK and session secret) if missing, creates `realty_dev`, provisions `app_user`, migrates, and checks that `app_user` sees 0 tenants without context.

---

## 5. Tests

### Running
| What | Command |
|---|---|
| everything | `pnpm -r test` (also `pnpm -r typecheck`, `pnpm lint`) |
| one package | `pnpm --filter @realty/core test` (`@realty/db`, `@realty/api`, `@realty/web`, `@realty/eslint-plugin`) |
| one module / file | `pnpm --filter @realty/core exec vitest run src/compliance`, `pnpm --filter @realty/api exec vitest run src/leads/intake.test.ts` |
| watch | `pnpm --filter @realty/core exec vitest` |
| coverage (core: 100 % branches on decision functions) | `pnpm --filter @realty/core test:coverage` |
| mutation (gate.ts ≥ 90 %) | `pnpm --filter @realty/core test:mutation` |
| Playwright (phone + desktop projects) | `pnpm --filter @realty/web test:e2e` (starts Vite on 5173; start the API yourself when a spec needs it) |
| rule/edge-case coverage (exit criteria 2/3) | `pnpm rule-coverage` (static scan of test names), `pnpm test:report` (only **passed** tests count) |

Vitest runs test files in parallel (`pool: 'forks'`). The test timeout is 30 s and the hook timeout 180 s (the first `createTestDb()` after a migration change rebuilds the template).

### Per-test databases (never use `realty_dev` in tests)
```ts
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { createTestDb, type TestDb } from '@realty/db/testing';

let db: TestDb;
let app: pg.Pool;
beforeAll(async () => {
  db = await createTestDb();                     // fully migrated, uniquely named, isolated
  app = new pg.Pool({ connectionString: db.appUserUrl, max: 4 });   // RLS-bound app_user
});
afterAll(async () => {
  await app?.end();
  await db?.drop();
});
```
- `db.appUserUrl` connects as `app_user`. Use it for **everything the application does**, including all RLS assertions.
- `db.ownerUrl` connects as the superuser and bypasses RLS. Use it only for fixtures that have no application path and for reading back state. Never use it to prove an RLS property. Prefer seeding through the real paths (`app.provision_tenant`, `auth.accept_invite`, the module's own API), as `rls_smoke.sql` does.
- Keep pools small (`max` ≤ 5). Postgres allows 100 connections and many test files run at once. Always `end()` pools before `drop()`.
- `createTestDb()` keeps a template database `realty_template` whose comment stores the migrations' content hash. A changed hash rebuilds it, under an exclusive advisory lock, while clones hold the shared lock. Every call then clones `realty_test_<time>_<pid>_<rand>`. Leftovers older than 12 h are garbage-collected. `createTestDb({ empty: true })` gives an unmigrated database (for migration-runner tests).
- `runPsqlScript(url, sql)` (also from `@realty/db/testing`) runs psql-style scripts (`\set` variables) and returns NOTICEs. `packages/db/test/rls_smoke.test.ts` uses it to run `rls_smoke.sql` unchanged.
- Concurrency tests open several connections (two sessions = two `pg.Client`s) against the same `db.appUserUrl`.

### Naming tests for rule coverage
Put rule and edge-case ids in the test name: `it('R-OWN-5 E1: losing claimer gets LEAD_ALREADY_CLAIMED and the release still succeeds', …)`. `scripts/rule-coverage.mjs` maps ids in `it`/`test`/`describe` titles (`skip` and `todo` excluded) to DATA_MODEL §4/§5 and lists the gaps. **Only name an id when the test (together with the other tests that name it) proves the rule as DATA_MODEL states it.** For a partial check, mention the id in a comment instead. Today the smoke port and the schema-invariant test link 20 rules; every other rule and all 70 edge cases are gaps that their modules close.

### Other test rules
- Core: inject `fixedClock(t)` / `steppingClock()` and `sequentialIds()` (core/foundation provides them). Use fast-check for property tests. Performance assertions may use `performance.now()`; test files are exempt from the purity lint.
- API integration tests run against real Postgres via `createTestDb()` and the fake providers. Mocks are never used for RLS.
- Every Zod response schema gets a snapshot test asserting no `confidence*` fields and no `tenant_id` input fields (R-AST-13, R-TEN-3).
- Never skip a test or leave a TODO in place of required behaviour. If something needs a real external account, build the adapter interface + deterministic fake and say so.

---

## 6. Architecture lint rules (`pnpm lint`, ESLint flat config in `eslint.config.js`)

| Rule | Where it applies | Allowed in |
|---|---|---|
| `packages/core` imports nothing from `@realty/db`, `@realty/api` or `@realty/web`, no I/O libraries, and no Node built-ins (`import type` is fine) | `packages/core/**` | none |
| core purity: no `Date.now()`, `new Date()` / `Date()` with no args, `Math.random()`, `performance.now()`, `crypto.randomUUID/getRandomValues`, luxon `DateTime.now()/local()/utc()` with no args, and no `process`, `Buffer`, `fetch` or timers | `packages/core/src/**` | core test files |
| **R-GATE-2** provider outbound: the reserved method names `sendSms`, `sendEmail` and `dialCall`, and any `.send` / `.dial` on `providers` / `telephony` / `email` objects (`realty/no-provider-outbound`) | everywhere | `apps/api/src/comms/dispatch.ts`, `apps/api/src/comms/dial.ts`, `apps/api/src/providers/**` |
| system actor: an object literal `{ kind: 'system', tenantId/via/... }` (`realty/no-system-actor`) | all `.ts`/`.tsx` | `apps/api/src/worker/**` and tests. Other code (webhooks, intake) imports the factory from `apps/api/src/worker/systemActor.ts`. |
| session GUCs: `SET app.*` without `LOCAL`, and `set_config('app.*', v, <not literally true>)` in any string or template (`realty/no-session-guc`) | everywhere | none |
| `selectFrom` | everywhere | `packages/db/**`, `apps/api/src/**/repos/**`, `apps/api/src/**/*.repo.ts`, tests |
| `packages/db` imports neither api nor web; `apps/api` never imports web; `apps/web` never imports db and imports `@realty/api` **types only** | per package | none |
| no relative import leaves its package (`realty/no-relative-outside-package`) | everywhere | config files |

So api/platform must name the outbound provider methods exactly `TelephonyProvider.sendSms`, `TelephonyProvider.dialCall` and `EmailProvider.sendEmail`. Other provider methods must not use those names or start an outbound send under another name (web push to agents is `deliverPush`; it is not a contact communication). api/comms adds the codebase architecture test that proves `dispatch.ts` and `dial.ts` are the only callers (BUILD_PLAN module 12). The rules themselves are tested in `packages/eslint-plugin/test/` (RuleTester and a wiring test against the real config).

`eslint-disable` for an architecture rule needs a one-line justification comment and a mention in your output.

---

## 7. Errors

- **Codes** are stable `SCREAMING_SNAKE_CASE` strings (`LEAD_OFFER_EXPIRED`, `DRAFT_STALE`, `REAUTH_REQUIRED`). Core functions return `{ ok: false, code, ... }` for expected outcomes and never throw for them. Each core module exports its own code union (e.g. `OwnershipErrorCode`). core/foundation exports the shared base codes.
- **HTTP** (api/platform implements; modules register their codes in `apps/api/src/errors.ts`). The body is always `{ "error": { "code": "...", "requestId": "...", "details"?: {...} } }`. It never carries PII, SQL or stack traces.
  - invisible or nonexistent resource, or permission denied on it: **404 `NOT_FOUND`**, never 403 (R-PERM-5)
  - unauthenticated: 401 `UNAUTHENTICATED`; stale re-auth: 401 `REAUTH_REQUIRED`; MFA enrollment-only session: 403 `MFA_ENROLLMENT_REQUIRED`
  - CSRF / Origin failure: 403 `CSRF_INVALID`; rate limit: 429 `RATE_LIMITED`
  - input validation (Zod): 422 `VALIDATION_FAILED`
  - state conflicts (`LEAD_STATE_CHANGED`, `LEAD_ALREADY_CLAIMED`, `DRAFT_STALE`, …): 409, with the fresh projection in `details` where BUILD_PLAN says so
  - gate outcomes are not errors: the send endpoint returns the `GateDecision` (deny / defer / needs_confirmation) with its human explanation
- **Web** never shows a raw code. Each code maps to a sentence (`errorMessages` on the surface, or `apps/web/src/shell/errorMessages.ts`), and unknown codes get a generic, honest sentence.

## 8. Audit

- `audit(tx, actor, { action, entity, changes?, reason? })` from `apps/api/src/audit.ts` (api/platform) is called **inside the same transaction** as the action. If the audit insert fails, the action fails (R-AUDIT-3).
- `action` matches `^[a-z_]+\.[a-z_.]+$` (DB CHECK) and is a member of the `AuditAction` union in `packages/core/src/foundation/authz.ts`, for example `member.role_changed`, `recording.play` or `import.committed`. Add new actions to that union (§3).
- `changes` is a **redacted diff**: non-PII fields become `{from, to}`, PII fields (names, phones, emails, bodies, notes) become `{"changed": true}` (R-AUDIT-4). Ids and codes only; never PII in `reason`.
- Every action in R-AUDIT-5 must be audited. Human ownership commands are mirrored by `applyOwnershipCommand` (module 7); do not double-audit them.
- Logs follow the same rule: ids, codes and timings only. Redaction drops PII keys and masks E.164 numbers and emails.

## 9. Runtime conventions

- **Actor and tenant context** come only from the resolved session, a webhook resolver or a job row (R-TEN-3). Zod input schemas never contain `tenant_id`. DB access runs inside `withTenantTx(actor, fn)` (module 7). `now` is the DB clock read in that transaction and injected into core.
- **One job = one transaction = one tenant** (R-TEN-6). Job payloads hold ids and fences only, never PII (R-TEN-7).
- **Every outbound contact communication** goes through `dispatchOutbound` / `dialOutbound`, which call `canContact` at send time. **Every ownership change** goes through `applyOwnershipCommand`.
- **Legal parameters** are data (jurisdiction packs or tenant policy versions) with the strictest default, marked **VERIFY WITH COUNSEL**. Nothing state-specific is hard-coded.
- **Ports and URLs (dev).** API on `API_PORT` (3001), all routes under `/api`. Vite on 5173 proxies `/api`, so cookies are same-origin as in production. `WEB_ORIGIN` is the CSRF/CORS allowlist.
- **Env.** `.env` (gitignored, created by `pnpm db:setup`) holds `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL`, `KEK_BASE64` (32-byte dev KEK), `SESSION_SECRET_BASE64`, `API_PORT`, `WEB_ORIGIN` and `*_PROVIDER=fake`. Provider adapters default to their deterministic fakes. `vitest.shared.ts` loads the root `.env` for tests without overriding variables that are already set.
- **Product copy.** The AI is "the assistant", never a persona name. No confidence scores in agent-facing UI or schemas. Every number shows its denominator. No fake activity indicators and no dark patterns.
