// Error code → human sentence (CONVENTIONS §7: the web never shows a raw code).
//
// SHARED REGISTRATION FILE (CONVENTIONS §3), owned by web/shell. Prefer `errorMessages` on your
// SurfaceModule (registry.ts); add a line here only for a code that several surfaces show. One code
// per line, above the `// registry: add new entries above this line` marker.
//
// Sentences are plain, specific and honest: they say what happened and what the person can do, they
// never blame the person, and they never reveal more than the server did (LOGIN_FAILED stays uniform;
// NOT_FOUND never hints that something exists). A variant keyed `CODE/<details.rule>` refines a code
// when the server sends a `rule` detail (PASSWORD_TOO_WEAK).
import type { BaseErrorCode, DenyCode, NormalizeErrorCode } from '@realty/core/foundation';

/** Codes produced by the web client itself (api.ts), never by the server. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'BAD_RESPONSE';

type CoreCode = BaseErrorCode | DenyCode | NormalizeErrorCode | ClientErrorCode;

export const GENERIC_ERROR_MESSAGE = "Something went wrong on our side, and it wasn't saved. Try again in a moment.";

export const errorMessages: Record<CoreCode, string> & Record<string, string> = {
  // ---- client ----
  NETWORK_ERROR: "Can't reach the server. Check your connection, then try again.",
  BAD_RESPONSE: 'The server sent an answer the app could not read. Try again in a moment.',
  // ---- base (core/foundation BASE_ERROR_CODES) ----
  NOT_FOUND: "This isn't available. It may have moved, or you may not have access to it.",
  UNAUTHENTICATED: 'You were signed out. Sign in again to continue.',
  REAUTH_REQUIRED: 'For your security, enter your password again to do this.',
  MFA_ENROLLMENT_REQUIRED: 'Set up two-step verification to continue. Your role requires it.',
  CSRF_INVALID: 'This page is out of date. Reload it and try again.',
  RATE_LIMITED: 'Too many tries in a short time. Wait a few minutes, then try again.',
  VALIDATION_FAILED: 'Some of the information is missing or not in the right format. Check it and try again.',
  INTERNAL_ERROR: GENERIC_ERROR_MESSAGE,
  // ---- core can() denials ----
  OWNER_REQUIRED: 'Only the account owner can do this.',
  ATTESTATION_REQUIRED: 'This needs your written confirmation before it can be turned on.',
  SUPPRESSION_NOT_LIFTABLE: "This block can't be lifted by staff. Only the person can opt back in.",
  PURPOSE_NOT_PERMITTED: "Your role can't send this kind of message.",
  FIELDS_NOT_PERMITTED: "Your role can't change some of these fields.",
  TARGET_NOT_ELIGIBLE: "That person can't take this right now.",
  // ---- core normalize ----
  PHONE_INVALID: "That phone number doesn't look complete. Include the area code.",
  EMAIL_INVALID: "That email address doesn't look right.",
  // ---- api/platform: auth and sessions ----
  LOGIN_FAILED: "That email and password don't match. Check both and try again. After several failed tries, sign-in pauses for 15 minutes.",
  MFA_REQUIRED: 'Enter the code from your authenticator app to continue.',
  MFA_CODE_INVALID: "That code didn't work. Codes change every 30 seconds; enter the newest one.",
  MFA_ALREADY_ENABLED: 'Two-step verification is already set up for this account.',
  MFA_NOT_ENROLLED: "Two-step verification isn't set up for this account yet.",
  TENANT_REQUIRED: 'Choose a team to continue.',
  PASSWORD_TOO_WEAK: 'Choose a stronger password.',
  'PASSWORD_TOO_WEAK/length': 'Use at least 12 characters. A few unrelated words work well.',
  'PASSWORD_TOO_WEAK/common': 'That password is too common. Choose one that is harder to guess.',
  'PASSWORD_TOO_WEAK/email': "Don't use your email address in your password.",
  PASSWORD_REQUIRED: 'Choose a password to finish creating your account.',
  LOGIN_REQUIRED: 'This invite is for an existing account. Sign in first, then open the invite link again.',
  RESET_TOKEN_INVALID: 'This reset link has expired or was already used. Request a new one.',
  INVITE_INVALID: 'This invite has expired, was already used, or was withdrawn. Ask your team admin for a new one.',
  SIGNUP_UNAVAILABLE: "We couldn't create an account with these details. If you already have one, sign in instead.",
  SLUG_TAKEN: 'That team web address is taken. Try another.',
  TIMEZONE_INVALID: "We didn't recognize that time zone.",
  ALERT_PHONE_OPTED_OUT: 'This phone replied STOP to our alerts. Text START to that number to turn alerts back on.',
  VERIFICATION_INVALID: "That code didn't match or has expired. Request a new code.",
  WEBHOOK_SIGNATURE_INVALID: GENERIC_ERROR_MESSAGE,
  PAYLOAD_TOO_LARGE: 'That is too large to upload.',
  UNSUPPORTED_MEDIA_TYPE: "That file type isn't supported.",
  // registry: add new entries above this line
};

export interface ErrorLike {
  code: string;
  details?: Record<string, unknown> | null;
}

/**
 * The sentence for an error. Lookup order: surface/extra messages, then this map, each first by
 * `CODE/<rule>` and then by `CODE`; unknown codes get the generic sentence (never the code).
 */
export function messageFor(e: ErrorLike | string, extra?: Readonly<Record<string, string>>): string {
  const code = typeof e === 'string' ? e : e.code;
  const rule = typeof e === 'string' ? undefined : e.details?.rule;
  const keys = typeof rule === 'string' ? [`${code}/${rule}`, code] : [code];
  for (const k of keys) {
    const s = (extra && Object.hasOwn(extra, k) ? extra[k] : undefined) ?? (Object.hasOwn(errorMessages, k) ? errorMessages[k] : undefined);
    if (s !== undefined) return s;
  }
  return GENERIC_ERROR_MESSAGE;
}
