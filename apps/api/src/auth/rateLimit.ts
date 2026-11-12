// DB-backed rate limits for auth routes (ARCHITECTURE §3 step 2): auth.rate_limit_hit with HMAC-ed
// keys, fixed windows, shared by every API process.
//
//   login:  5 / min per IP+email, 20 / h per email, 100 / h per IP
//   others: see each route (password reset, signup, MFA verify, re-auth, invite, alert phone)
//
// Every limit is counted on every attempt (no short-circuit), so a blocked caller keeps counting.
// The windows are read at the DB clock (clock_timestamp() of the counting transaction), the one clock every API
// process shares. A caller may pass a Clock instead: a test seam only (a burst pinned inside one window); production
// passes none.
import type { Clock } from '@realty/core/foundation';
import type { Database } from '@realty/db';
import { withPreTenant } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { rateKey } from './tokens.js';

export interface Limit {
  kind: string;
  parts: string[];
  max: number;
  windowSeconds: number;
}

export async function enforceLimits(db: Database, secret: Uint8Array, limits: readonly Limit[], clock?: Clock): Promise<void> {
  const blocked = await withPreTenant(
    async (tx, dbNow) => {
      const now = clock ? clock.now() : dbNow;
      let retryAfter = 0;
      for (const l of limits) {
        const windowMs = l.windowSeconds * 1000;
        const start = Math.floor(now / windowMs) * windowMs;
        const r = await sql<{ ok: boolean }>`
          SELECT auth.rate_limit_hit(${rateKey(secret, l.kind, ...l.parts)}, ${new Date(start)}::timestamptz, ${l.max}) AS ok`.execute(tx);
        if (!r.rows[0]?.ok) retryAfter = Math.max(retryAfter, Math.ceil((start + windowMs - now) / 1000));
      }
      return retryAfter;
    },
    { db },
  );
  if (blocked > 0) throw new AppError('RATE_LIMITED', { retryAfterSeconds: blocked });
}

export const LOGIN_LIMITS = (ip: string, email: string): Limit[] => [
  { kind: 'login_ip_email', parts: [ip, email], max: 5, windowSeconds: 60 },
  { kind: 'login_email', parts: [email], max: 20, windowSeconds: 3600 },
  { kind: 'login_ip', parts: [ip], max: 100, windowSeconds: 3600 },
];
