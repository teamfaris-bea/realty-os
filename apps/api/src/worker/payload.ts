// Job payload schemas (R-TEN-7: payloads hold ids, codes, fences and instants, never names, phones,
// emails or bodies).
//
// `jobPayload(shape)` is the only way handlers build their schema:
// - `.strict()`: an unknown key (`phone`, `body`, `name`, …) is rejected, so PII cannot ride along in an
//   extra field;
// - every string anywhere in the payload is checked by db's `assertNoPiiInPayload` (an email address or
//   a phone number is rejected even inside an allowed field);
// - strings are bounded (ids, codes and keys are short).
import { JobPayloadError, assertNoPiiInPayload, type JsonValue } from '@realty/db';
import { z } from 'zod';

/** A uuid (any RFC 9562 version; derived command ids are v8). */
export const zId = z.uuid();
/** Epoch milliseconds (core `Instant`). */
export const zInstant = z.number().int().nonnegative().max(8_640_000_000_000_000);
/** A ledger seq / fence counter. */
export const zSeq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** A machine code (UPPER_SNAKE or lower_snake / dotted), never prose. */
export const zCode = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

/**
 * A machine token: an id, code, dedupe key or audit action (letters, digits and `_ . : -`, ≤ 200).
 * No whitespace, so no prose: a sentence ("Call Pat Lee back") can never ride in a payload.
 */
export const zToken = z.string().regex(/^[A-Za-z0-9_.:-]{0,200}$/);

/** JSON made of ids, codes, numbers and booleans only: strings are machine tokens and checked for PII. */
export const zSafeJson: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([zToken, z.number(), z.boolean(), z.null(), z.array(zSafeJson).max(500), z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), zSafeJson)]),
);

function noPii(v: unknown, ctx: z.RefinementCtx): void {
  try {
    assertNoPiiInPayload(v as JsonValue);
  } catch (e) {
    if (e instanceof JobPayloadError) ctx.addIssue({ code: 'custom', message: 'payload looks like contact PII (R-TEN-7)' });
    else throw e;
  }
}

/** A strict object schema whose every string is PII-checked. */
export function jobPayload<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape).superRefine(noPii);
}
