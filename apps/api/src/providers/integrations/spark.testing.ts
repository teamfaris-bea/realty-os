// Test-only mock Spark RESO server and a network tripwire (imported by *.test.ts only; no real Spark call
// is ever made by the suite). The mock is a transport (SparkFetch): it records every request it receives
// and answers from a handler; the tripwire makes any real outbound connection fail the test.
import net from 'node:net';
import tls from 'node:tls';
import type { SparkFetch } from './spark.js';

/** An obvious fake: the suites search every output channel for it. */
export const CANARY_TOKEN = 'CANARY-spark-token-DO-NOT-USE-0000';

export interface MockCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect: string;
}

export type MockReply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string | Uint8Array };

export interface MockSpark {
  fetch: SparkFetch;
  calls: MockCall[];
  handler: (c: MockCall) => MockReply | Promise<MockReply>;
}

export function mockSpark(handler: MockSpark['handler'] = () => ({ status: 200, body: { value: [] } })): MockSpark {
  const m: MockSpark = {
    calls: [],
    handler,
    fetch: async (url, init) => {
      const c: MockCall = { url: new URL(url), method: init.method, headers: { ...init.headers }, redirect: init.redirect };
      m.calls.push(c);
      const r = await m.handler(c);
      const body = r.raw !== undefined ? r.raw : r.body === undefined ? null : JSON.stringify(r.body);
      return new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
    },
  };
  return m;
}

/** A RESO Property record (all fields the adapter maps). */
export function property(i: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ListingKey: `LK${String(i).padStart(4, '0')}`,
    ListingId: `MLS${i}`,
    StandardStatus: 'Active',
    ListPrice: 400000 + i,
    StreetNumber: String(100 + i),
    StreetName: 'Example',
    StreetSuffix: 'St',
    City: 'Exampleton',
    StateOrProvince: 'ZZ',
    PostalCode: '00000',
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 1500.4,
    PropertyType: 'Residential',
    ListOfficeName: 'Example Brokerage',
    ModificationTimestamp: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    ...o,
  };
}

export interface Tripwire {
  attempts: string[];
  restore(): void;
}

/**
 * Real outbound traffic fails: global fetch throws, and TCP/TLS connects to anything but loopback (the test
 * Postgres) throw. Every attempt is recorded so a test can assert none happened.
 */
export function installNetworkTripwire(): Tripwire {
  const attempts: string[] = [];
  const origFetch = globalThis.fetch;
  const origConnect = net.Socket.prototype.connect;
  const origTls = tls.connect;
  const loopback = (h: unknown) => h === undefined || h === 'localhost' || h === '127.0.0.1' || h === '::1' || (typeof h === 'string' && h.startsWith('/'));
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(`fetch ${String(input instanceof URL ? input.href : typeof input === 'string' ? input : 'request')}`);
    throw new Error('network access is forbidden in tests');
  }) as typeof fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const a = args[0] as { host?: string; path?: string } | number | string;
    const host = typeof a === 'object' && a !== null ? (a.path ?? a.host) : typeof args[1] === 'string' ? args[1] : typeof a === 'string' ? a : undefined;
    if (!loopback(host)) {
      attempts.push(`connect ${String(host)}`);
      throw new Error('network access is forbidden in tests');
    }
    return (origConnect as (...x: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  (tls as { connect: unknown }).connect = (...args: unknown[]) => {
    const a = args[0] as { host?: string } | number;
    const host = typeof a === 'object' ? a.host : args[1];
    if (!loopback(host)) {
      attempts.push(`tls ${String(host)}`);
      throw new Error('network access is forbidden in tests');
    }
    return (origTls as (...x: unknown[]) => tls.TLSSocket)(...args);
  };
  return {
    attempts,
    restore() {
      globalThis.fetch = origFetch;
      net.Socket.prototype.connect = origConnect;
      (tls as { connect: unknown }).connect = origTls;
    },
  };
}
