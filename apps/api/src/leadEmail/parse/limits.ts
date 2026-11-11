// Size limits of the lead-email parser (pure constants; re-exported by ./index.ts).

/** Longer inputs are truncated BEFORE any processing (text, html and the normalized body alike). */
export const MAX_INPUT_CHARS = 200_000;

/** Field caps (they match what leads intake accepts: IntakeBody in apps/api/src/leads/schemas.ts). */
export const MAX_NAME = 120;
export const MAX_PHONE = 40;
export const MAX_EMAIL = 254;
export const MAX_MESSAGE = 2000;
export const MAX_PROPERTY = 300;
export const MAX_LISTING_ID = 64;
export const MAX_POINTS = 5;
export const MAX_SUBJECT = 1000;
