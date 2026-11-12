// ESLint flat config. Architecture rules come from docs/BUILD_PLAN.md ("ESLint architecture rules")
// and are explained in docs/CONVENTIONS.md. Run: pnpm lint
import js from '@eslint/js';
import realty from '@realty/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const TEST_FILES = ['**/*.test.{ts,tsx,js,mjs}', '**/test/**', '**/testing/**', '**/e2e/**'];
const CONFIG_FILES = ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts', 'vitest.shared.ts', 'eslint.config.js', '**/stryker.config.mjs'];

const nodeBuiltins = [...new Set(builtinModules.flatMap((m) => (m.startsWith('node:') ? [m] : [m, `node:${m}`])))];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.stryker-tmp/**', '**/reports/**', '**/playwright-report/**', '**/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    plugins: { realty },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // ARCHITECTURE §3 pool hygiene: request-context GUCs are transaction-local only (R-TEN-3)
      'realty/no-session-guc': 'error',
      // workspace boundaries cannot be bypassed with ../../
      'realty/no-relative-outside-package': 'error',
      // R-GATE-2: provider send/dial only from comms/dispatch.ts and comms/dial.ts
      'realty/no-provider-outbound': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: CONFIG_FILES,
    rules: { 'realty/no-relative-outside-package': 'off' },
  },
  {
    // the rule implementations and their fixtures necessarily contain the banned SQL as strings
    files: ['packages/eslint-plugin/**'],
    rules: { 'realty/no-session-guc': 'off' },
  },

  // ---- R-GATE-2 allowlist: the only dispatch path, and the provider implementations/fakes themselves
  {
    // module 29: marketing/publish.ts is the single publishing path (publishPost / postReviewReply, R-GATE-15)
    // module 52: ads/dispatch.ts is the single budget and pause path (applyBudgetChange / pauseCampaign); ads/provider.ts is the adapter
    files: ['apps/api/src/comms/dispatch.ts', 'apps/api/src/comms/dial.ts', 'apps/api/src/marketing/publish.ts', 'apps/api/src/ads/dispatch.ts', 'apps/api/src/ads/provider.ts', 'apps/api/src/providers/**'],
    rules: { 'realty/no-provider-outbound': 'off' },
  },

  // ---- Actor { kind: 'system' } only in apps/api/src/worker/** (tests may build fixtures)
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['apps/api/src/worker/**', ...TEST_FILES],
    rules: { 'realty/no-system-actor': 'error' },
  },

  // ---- R-TEN-14 / R-PORTAL-4 (module 43): the client principal's transaction helper and the staff ones never
  //      mix. Portal client code (apps/api/src/portal/client/**) uses withPortalTx only; everything else never
  //      uses withPortalTx or builds a client actor (only packages/db/src/portalTx.ts does).
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/db/src/portalTx.ts', 'apps/api/src/portal/client/**', ...TEST_FILES],
    rules: { 'realty/portal-tx-separation': ['error', { mode: 'staff' }] },
  },
  {
    files: ['apps/api/src/portal/client/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: { 'realty/portal-tx-separation': ['error', { mode: 'client' }] },
  },

  // ---- selectFrom only in packages/db and module repositories (and tests)
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/db/**', 'apps/api/src/**/repos/**', 'apps/api/src/**/*.repo.ts', ...TEST_FILES],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='selectFrom']",
          message: 'selectFrom belongs in packages/db or a module repository (apps/api/src/<module>/repos/*.ts or *.repo.ts).',
        },
      ],
    },
  },

  // ---- R-PAR-29 (parity module 60): smart-list SQL only from fixed fragments and bound parameters
  {
    files: ['apps/api/src/lists/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'realty/no-sql-raw': 'error' },
  },

  // ---- packages/core is pure: no db/api/web, no Node built-ins (type imports allowed)
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltins.map((name) => ({ name, message: 'packages/core is pure: no Node built-ins (type imports only).', allowTypeImports: true })),
          patterns: [
            { group: ['@realty/db', '@realty/db/*', '@realty/api', '@realty/api/*', '@realty/web', '@realty/web/*'], message: 'packages/core imports nothing from db/api/web.' },
            { group: ['pg', 'kysely', 'fastify', '@fastify/*', '@anthropic-ai/*', 'argon2'], message: 'packages/core is pure: no I/O libraries.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: TEST_FILES,
    languageOptions: { globals: { ...globals['shared-node-browser'] } },
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'core is pure: take `now` from the injected Clock.' },
        { object: 'Math', property: 'random', message: 'core is pure: take randomness from an injected generator.' },
        { object: 'performance', property: 'now', message: 'core is pure: take `now` from the injected Clock.' },
        { object: 'crypto', property: 'randomUUID', message: 'core is pure: ids come from the injected IdGenerator.' },
        { object: 'crypto', property: 'getRandomValues', message: 'core is pure: take randomness from an injected generator.' },
      ],
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', 'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'require', '__dirname', '__filename', 'XMLHttpRequest', 'WebSocket', 'localStorage'].map((name) => ({
          name,
          message: 'packages/core is pure: no I/O, timers or ambient environment.',
        })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'core is pure: `new Date()` reads the wall clock; use the injected Clock.' },
        { selector: "CallExpression[callee.name='Date'][arguments.length=0]", message: 'core is pure: `Date()` reads the wall clock; use the injected Clock.' },
        {
          selector: "CallExpression[callee.object.name='DateTime'][callee.property.name=/^(now|local|utc)$/][arguments.length=0]",
          message: 'core is pure: luxon DateTime.now()/local()/utc() read the wall clock; use DateTime.fromMillis(now, { zone }).',
        },
        { selector: "MemberExpression[property.name='selectFrom']", message: 'packages/core does no I/O.' },
      ],
    },
  },

  // ---- R-PRED-4: predictions/coaching never feed ownership, priority, ads, the portal or messaging (module 49)
  {
    files: [
      'packages/core/src/{ownership,priority,ads,portal}/**/*.{ts,tsx}',
      'apps/api/src/{ownership,comms,ads,portal}/**/*.{ts,tsx}',
      'apps/api/src/leads/routing*',
      'apps/api/src/leads/routing*/**/*.{ts,tsx}',
      'apps/web/src/portal/**/*.{ts,tsx}',
    ],
    rules: { 'realty/no-prediction-import': 'error' },
  },

  // ---- PHASE2_3_PLAN §5.3 (module 37): the website chat widget is a separate bundle; it imports nothing from the
  //      staff app (no surface, shell, design system or package). Module 46 adds src/portal the same way.
  {
    files: ['apps/web/src/widget/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: { 'realty/isolated-bundle': ['error', { dir: 'widget' }] },
  },

  // ---- R-GMAIL-14 (module 68): synced Gmail SQL only in apps/api/src/mailSync/** (plus the flagged ingestSyncedMailInTx);
  //      the assistant and the model provider never import mailSync; mailSync imports no model provider and never sends
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [...TEST_FILES, 'apps/api/src/mailSync/**'],
    rules: { 'realty/mail-sync-boundary': ['error', { mode: 'outside', allowInFunctions: ['ingestSyncedMailInTx'] }] },
  },
  {
    files: ['apps/api/src/assistant/**/*.ts', 'apps/api/src/providers/anthropic.ts'],
    ignores: TEST_FILES,
    rules: { 'realty/mail-sync-boundary': ['error', { mode: 'no-import' }] },
  },
  {
    files: ['apps/api/src/mailSync/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'realty/mail-sync-boundary': ['error', { mode: 'inside' }] },
  },

  // ---- packages/db depends on core only (never api/web)
  {
    files: ['packages/db/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@realty/api', '@realty/api/*', '@realty/web', '@realty/web/*'], message: 'packages/db may import @realty/core only.' }] },
      ],
    },
  },

  // ---- apps/api never imports the web app
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@realty/web', '@realty/web/*'], message: 'apps/api never imports apps/web.' }] },
      ],
    },
  },

  // ---- apps/web: browser code; no db, api only as types
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@realty/db', '@realty/db/*'], message: 'apps/web never imports the database package.' },
            { group: ['@realty/api', '@realty/api/*'], message: 'apps/web may import @realty/api for types only.', allowTypeImports: true },
          ],
        },
      ],
    },
  },
);
