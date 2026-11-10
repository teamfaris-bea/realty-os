// Shared Vitest settings for every workspace package (imported by each package's vitest.config.ts).
// - resolves workspace packages to their TypeScript sources via the "@realty/source" export condition
// - loads the repo-root .env (never overriding variables already set) so DB tests find their URLs
// - generous hook timeouts: the first createTestDb() call may rebuild the template database
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { ViteUserConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export function loadRootEnv(): void {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
  }
}

export interface RealtyVitestOptions {
  environment: 'node' | 'jsdom';
  setupFiles?: string[];
  coverageInclude?: string[];
  include?: string[];
}

const SOURCE_CONDITION = '@realty/source';

export function realtyVitest(o: RealtyVitestOptions): ViteUserConfig {
  loadRootEnv();
  return {
    resolve: {
      conditions: [SOURCE_CONDITION, 'module', 'browser', 'development|production'],
    },
    ssr: {
      resolve: {
        conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'],
        externalConditions: [SOURCE_CONDITION],
      },
    },
    test: {
      environment: o.environment,
      include: o.include ?? ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
      setupFiles: o.setupFiles ?? [],
      testTimeout: 30_000,
      hookTimeout: 180_000,
      // Test files run in parallel; each DB test file gets its own database via createTestDb().
      pool: 'forks',
      coverage: {
        provider: 'v8',
        include: o.coverageInclude ?? ['src/**/*.{ts,tsx}'],
        exclude: ['**/*.test.{ts,tsx}', '**/testing/**'],
        reporter: ['text-summary', 'json-summary'],
      },
    },
  };
}
