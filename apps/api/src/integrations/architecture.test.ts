// Architecture checks for module 21 (R-INT-1, R-INT-3, R-GATE-15): source scans of apps/api/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !n.endsWith('testing.ts') ? [p] : [];
  });
}
const SOURCES = files(SRC).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));

describe('module 21 architecture', () => {
  it('R-INT-1: real integration adapters are selected only inside providers/** (everyone else uses Providers.integrations)', () => {
    const offenders = SOURCES.filter((f) => !f.rel.startsWith('providers/') && /integrations\/real(\.js)?['"]/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('R-INT-3: the routing key, the credential link and capabilities are written by one repository function, called only by the provider callback', () => {
    const writers = SOURCES.filter((f) => /UPDATE\s+integration_connections\s+SET[^`]*\b(external_account_id|credential_id|capabilities)\s*=/.test(f.text)).map((f) => f.rel);
    expect(writers).toEqual(['integrations/repos/connections.ts']);
    const callers = SOURCES.filter((f) => /\brepo\.applyProof\(/.test(f.text)).map((f) => f.rel);
    expect(callers).toEqual(['integrations/service.ts']);
    const svc = SOURCES.find((f) => f.rel === 'integrations/service.ts')!.text;
    const cb = svc.slice(svc.indexOf('export async function oauthCallback'));
    expect(cb.indexOf('repo.applyProof(')).toBeGreaterThan(0);
    expect(svc.slice(0, svc.indexOf('export async function oauthCallback'))).not.toContain('repo.applyProof(');
  });

  it('R-INT-3: the API-key link and the key validation result are written only by the Spark MLS service, as the system actor', () => {
    for (const fn of ['linkKeyCredential', 'applyKeyValidation', 'insertMlsCredential']) {
      const callers = SOURCES.filter((f) => new RegExp(`\\brepo\\.${fn}\\(`).test(f.text)).map((f) => f.rel);
      expect(callers, fn).toEqual(['mls/spark/service.ts']);
    }
    const svc = SOURCES.find((f) => f.rel === 'mls/spark/service.ts')!.text;
    // every transaction of the save / validate path runs as the system actor of the session's own tenant
    expect(svc.match(/withTenantTx\(\s*sys,/g)?.length).toBe(3);
    expect(svc).toContain("systemActor(actor.tenantId, 'provider')");
  });

  it('R-INT-1: the Spark adapter is read-only: it builds no request with a method other than GET, and only the adapter calls the transport', () => {
    const spark = SOURCES.find((f) => f.rel === 'providers/integrations/spark.ts')!.text;
    expect(spark).toMatch(/if \(method !== 'GET'\) throw new SparkError\('METHOD_NOT_ALLOWED'\)/);
    expect(new Set([...spark.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]))).toEqual(new Set(['GET']));
    expect(spark).toContain("redirect: 'manual'");
    const transport = SOURCES.filter((f) => /\bmlsTransport\b/.test(f.text)).map((f) => f.rel).sort();
    expect(transport).toEqual(['mls/spark/service.ts', 'providers/integrations/types.ts']);
  });

  it('R-GATE-15: no code outside the reserved paths calls sendDirectMessage or publishPost', () => {
    const allowed = new Set(['comms/dispatch.ts', 'marketing/publish.ts']);
    const offenders = SOURCES.filter((f) => !f.rel.startsWith('providers/') && !allowed.has(f.rel) && /\.(sendDirectMessage|publishPost)\b/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
