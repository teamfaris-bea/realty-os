// The mock county server for tests (never a real county call). It answers the connector's GETs from SYNTHETIC
// ArcGIS-shaped fixtures (fixtures/*.json: fictional streets, "SAMPLE OWNER A", PIN "TEST-0001") and records each
// call. While PUBLIC_RECORDS_LIVE_CALLS is not "true" in the process environment, ANY call fails the test: the mock
// asserts that a full run makes zero outbound requests unless a test explicitly builds a live connector with it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock, Instant } from '@realty/core/foundation';
import type { CountyFetch } from './http.js';

export type FixtureName = 'address_unique' | 'address_none' | 'address_multiple' | 'parcel_unique' | 'parcel_multiple' | 'gisfile_sale' | 'arcgis_error';

export function fixture(name: FixtureName): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));
}

/** One scripted answer: a fixture or a body, a status, headers, or a thrown error / a hang. */
export type MockAnswer =
  | { fixture: FixtureName; status?: number }
  | { body: string; status?: number; headers?: Record<string, string> }
  | { status: number; headers?: Record<string, string>; body?: string }
  | { hang: true }
  | { throws: Error };

export interface MockCountyCall {
  url: string;
  method: string;
  redirect: string;
  headers: Record<string, string>;
}

export interface MockCounty {
  fetch: CountyFetch;
  calls: MockCountyCall[];
  /** answers by layer path ('Addresses', 'EnerGov', 'SwrAddLookUp'); a queue is consumed in order */
  answers: Record<string, MockAnswer[]>;
}

/**
 * A mock county. `allowCalls: true` is the explicit opt-in a connector test with live calls on gives; otherwise every
 * call throws (and is recorded), proving no request leaves the process while live calls are off.
 */
export function mockCounty(opts: { allowCalls?: boolean; answers?: Record<string, MockAnswer[]> } = {}): MockCounty {
  const calls: MockCountyCall[] = [];
  const answers: Record<string, MockAnswer[]> = {
    Addresses: [{ fixture: 'address_unique' }],
    EnerGov: [{ fixture: 'parcel_unique' }],
    SwrAddLookUp: [{ fixture: 'gisfile_sale' }],
    ...(opts.answers ?? {}),
  };
  const fetch: CountyFetch = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect, headers: init.headers });
    if (!opts.allowCalls && (process.env.PUBLIC_RECORDS_LIVE_CALLS ?? '').trim().toLowerCase() !== 'true') {
      throw new Error('mockCounty: a county request was made while PUBLIC_RECORDS_LIVE_CALLS is off');
    }
    const layer = Object.keys(answers).find((k) => url.includes(`/${k}/`));
    const queue = layer ? answers[layer]! : [];
    const a = queue.length > 1 ? queue.shift()! : queue[0];
    if (!a) return new Response('{"features":[]}', { status: 200 });
    if ('throws' in a) throw a.throws;
    if ('hang' in a) {
      return new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if ('fixture' in a) return new Response(JSON.stringify(fixture(a.fixture)), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
    return new Response(a.body ?? '', { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  return { fetch, calls, answers };
}

/** A clock and a sleep that advances it (the limiter's waits are observable and instant). */
export function manualClock(start = Date.parse('2026-11-12T07:00:00Z')) {
  let t = start;
  const sleeps: number[] = [];
  return {
    clock: { now: () => t as Instant } satisfies Clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}
