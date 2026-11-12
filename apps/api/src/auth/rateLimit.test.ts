// The DB-backed fixed-window limits (rateLimit.ts) and their clock: the DB clock by default (every API process counts
// in the same windows), or a Clock the caller passes (the test seam the public listing page uses). Real Postgres.
import { randomBytes } from 'node:crypto';
import { type Clock, MINUTE_MS, fixedClock } from '@realty/core/foundation';
import { type Database, createDatabase } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { type Limit, enforceLimits } from './rateLimit.js';
import { rateKey } from './tokens.js';

let testDb: TestDb;
let db: Database;
let su: pg.Pool;
const secret = new Uint8Array(randomBytes(32));

beforeAll(async () => {
  testDb = await createTestDb();
  db = createDatabase({ url: testDb.appUserUrl, max: 2, applicationName: 'api-test-ratelimit' });
  su = new pg.Pool({ connectionString: testDb.ownerUrl, max: 1 });
  su.on('error', () => {});
}, 120_000);
afterAll(async () => {
  await db?.close();
  await su?.end();
  await testDb?.drop();
});

const perMinute = (ip: string, max: number): Limit => ({ kind: 'rate_limit_test_ip', parts: [ip], max, windowSeconds: 60 });

/** The windows counted for one limit, as epoch ms of their starts. */
async function windowsOf(l: Limit): Promise<number[]> {
  const r = await su.query<{ window_start: Date }>('SELECT window_start FROM auth_attempts WHERE key = $1 ORDER BY window_start', [rateKey(secret, l.kind, ...l.parts)]);
  return r.rows.map((x) => x.window_start.getTime());
}

async function refusal(l: Limit, clock?: Clock): Promise<AppError | null> {
  try {
    await enforceLimits(db, secret, [l], clock);
    return null;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
}

describe('fixed-window rate limits: the clock the windows are read at', () => {
  it('by default the window is the DB clock\'s minute (production passes no clock)', async () => {
    const l = perMinute('192.0.2.1', 5);
    const before = (await su.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
    expect(await refusal(l)).toBeNull();
    const after = (await su.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
    const [start, ...rest] = await windowsOf(l);
    expect(rest).toEqual([]);
    expect(start! % MINUTE_MS).toBe(0);
    expect(start).toBeGreaterThanOrEqual(Math.floor(before / MINUTE_MS) * MINUTE_MS);
    expect(start).toBeLessThanOrEqual(Math.floor(after / MINUTE_MS) * MINUTE_MS);
  });

  it('a passed clock decides the window: a burst on a pinned clock stays in one window however long it takes; the next window starts fresh', async () => {
    const l = perMinute('192.0.2.2', 3);
    // 0.4 s before a minute boundary, far from the DB clock: only the passed clock can put the attempts there
    const clock = fixedClock('2001-01-01T00:00:59.600Z');
    for (let i = 0; i < 3; i++) expect(await refusal(l, clock), `attempt ${i + 1}`).toBeNull();
    const blocked = await refusal(l, clock);
    expect(blocked?.code).toBe('RATE_LIMITED');
    expect(blocked?.details).toEqual({ retryAfterSeconds: 1 });
    expect(await windowsOf(l)).toEqual([Date.parse('2001-01-01T00:00:00Z')]);
    // the clock crosses the boundary: a new window, a new budget
    clock.advance(400);
    expect(await refusal(l, clock)).toBeNull();
    expect(await windowsOf(l)).toEqual([Date.parse('2001-01-01T00:00:00Z'), Date.parse('2001-01-01T00:01:00Z')]);
  });
});
