// Password hashing (argon2id m=64 MiB, t=3, p=1; BUILD_PLAN module 8) and the password policy.
//
// Login timing uniformity: when the email is unknown, the account is locked/disabled, or has no
// password, login still verifies the submitted password against DUMMY hash with the same parameters,
// so the response time does not reveal which case applied.
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

const MAX_PASSWORD_CHARS = 256; // bounds hashing work per request (argon2 DoS)

function prepare(pw: string): string {
  return pw.normalize('NFKC');
}

export async function hashPassword(pw: string): Promise<string> {
  if (pw.length > MAX_PASSWORD_CHARS) throw new RangeError('password too long');
  return argon2.hash(prepare(pw), ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  // An over-long password or a non-argon2id hash still costs one full argon2id verification, so
  // the response time does not reveal that the email exists (the unknown-email path always pays it).
  if (pw.length > MAX_PASSWORD_CHARS || !hash.startsWith('$argon2id$')) return burn(pw);
  try {
    return await argon2.verify(hash, prepare(pw));
  } catch {
    return false;
  }
}

/** One argon2id verification against the dummy hash; always false. */
async function burn(pw: string): Promise<false> {
  try {
    await argon2.verify(await dummyHash(), prepare(pw.slice(0, MAX_PASSWORD_CHARS)));
  } catch {
    // the work is the point; the result is irrelevant
  }
  return false;
}

let dummy: Promise<string> | null = null;

/** An argon2id hash of a random secret with the production parameters (computed once). */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'));
  return dummy;
}

/**
 * Burns the same verification work as a real check and returns false. Used for unknown emails,
 * locked and disabled accounts (uniform login errors and timing).
 */
export async function verifyDummy(pw: string): Promise<false> {
  return burn(pw);
}

/** A short deny-list of the most common passwords (a breached-password service is a Phase 2 item). */
const COMMON = new Set([
  'password1234',
  '123456789012',
  'qwertyuiopas',
  'iloveyou1234',
  'passwordpassword',
  'realestate123',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'administrator',
]);

export type PasswordPolicyResult = { ok: true } | { ok: false; code: 'PASSWORD_TOO_WEAK'; rule: 'length' | 'common' | 'email' };

/** ASVS L2 V2.1: at least 12 characters, at most 256, not a common password, not the email. */
export function checkPasswordPolicy(pw: string, email?: string): PasswordPolicyResult {
  const p = prepare(pw);
  if ([...p].length < 12 || p.length > MAX_PASSWORD_CHARS) return { ok: false, code: 'PASSWORD_TOO_WEAK', rule: 'length' };
  if (COMMON.has(p.toLowerCase())) return { ok: false, code: 'PASSWORD_TOO_WEAK', rule: 'common' };
  if (email && p.toLowerCase().includes(email.toLowerCase().split('@')[0]!) && email.split('@')[0]!.length >= 4) {
    return { ok: false, code: 'PASSWORD_TOO_WEAK', rule: 'email' };
  }
  return { ok: true };
}
