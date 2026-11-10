// Shared base error codes and result helpers (CONVENTIONS §7).
//
// Codes are stable SCREAMING_SNAKE_CASE strings. Core functions return `{ ok: false, code, ... }`
// for expected outcomes and never throw for them; they throw only on programming errors (bad
// arguments that validated input can never produce). Each core module exports its own code union
// (e.g. `OwnershipErrorCode`); api/platform maps every code to an HTTP status in
// apps/api/src/errors.ts.
import type { DenyCode } from './authz.js';
import type { NormalizeErrorCode } from './normalize.js';

/** Codes every layer may produce (HTTP mapping in CONVENTIONS §7). */
export const BASE_ERROR_CODES = [
  'NOT_FOUND', // invisible, nonexistent, or permission denied on it: always 404 (R-PERM-5)
  'UNAUTHENTICATED', // 401
  'REAUTH_REQUIRED', // 401: re-authentication older than 15 minutes (R-PERM-13)
  'MFA_ENROLLMENT_REQUIRED', // 403: enrollment-only session (R-PERM-14)
  'CSRF_INVALID', // 403
  'RATE_LIMITED', // 429
  'VALIDATION_FAILED', // 422
  'INTERNAL_ERROR', // 500: never carries details
] as const;
export type BaseErrorCode = (typeof BASE_ERROR_CODES)[number];

/** Every code core/foundation itself can return. */
export type FoundationErrorCode = BaseErrorCode | DenyCode | NormalizeErrorCode;

export const ERROR_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

export function isErrorCode(s: string): boolean {
  return ERROR_CODE_RE.test(s);
}

export type Ok<T extends object = object> = { ok: true } & T;
export type Fail<C extends string, X extends object = object> = { ok: false; code: C } & X;
export type Result<T extends object, C extends string, X extends object = object> = Ok<T> | Fail<C, X>;

export function ok(): { ok: true };
export function ok<T extends object>(value: T): Ok<T>;
export function ok<T extends object>(value?: T): Ok<T> | { ok: true } {
  return value === undefined ? { ok: true } : { ok: true, ...value };
}

export function fail<C extends string>(code: C): Fail<C>;
export function fail<C extends string, X extends object>(code: C, extra: X): Fail<C, X>;
export function fail<C extends string, X extends object>(code: C, extra?: X): Fail<C, X> | Fail<C> {
  return extra === undefined ? { ok: false, code } : { ...extra, ok: false, code };
}

/** Exhaustiveness check for discriminated unions. */
export function assertNever(x: never, what = 'value'): never {
  throw new TypeError(`unexpected ${what}: ${JSON.stringify(x)}`);
}
