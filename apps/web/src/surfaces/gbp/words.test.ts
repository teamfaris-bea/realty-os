// gbpPlain and the GBP words against the API's real strings (module 55 item 12; R-STAFF-1, R-STAFF-3, E663, E678).
// Each fixture is copied from the API, with the line it comes from.
import { describe, expect, it } from 'vitest';
import { GBP_ERROR_MESSAGES, GUARD_WORDS, gbpPlain, refusalWords, starsWords } from './words.js';

const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;

// apps/api/src/gbp/sync.test.ts:59 (status.ts notClearedSentence, status.ts:22-24)
const NOT_CLEARED = 'Google Business Profile stays off until counsel reviews it (pack platform:gbp 2026.11.0). Nothing is read from or posted to Google.';
// status.ts:23 with no published pack version
const NOT_CLEARED_NOT_INSTALLED = 'Google Business Profile stays off until counsel reviews it (pack platform:gbp not installed). Nothing is read from or posted to Google.';
// apps/api/src/gbp/sync.test.ts:177 (status.ts:27 locationSentence with a last_error_code)
const LOCATION_FAILED = 'Last check failed (LIST_TIMEOUT); we will try again.';
// apps/api/src/gbp/sync.test.ts:74 (status.ts:35 with provider.ts:68 GBP_NOT_SET_UP)
const NOT_SET_UP = 'Google Business Profile is not set up on this platform yet. Export posts and copy them to your Business Profile yourself.';
// apps/api/src/gbp/replies.test.ts:174 (replies.ts:216 OUTCOME_SENTENCE.failed)
const REPLY_FAILED = 'Google did not take the reply (REPLY_REJECTED). Edit it or try again.';
// replies.ts:217 OUTCOME_SENTENCE.unknown
const REPLY_UNKNOWN_API = "We didn't hear back from Google. We are checking; we won't post it twice.";

describe('gbpPlain (R-STAFF-1, E678)', () => {
  it('R-STAFF-1 E678: the not-cleared sentence loses the pack key and its version, and keeps its words', () => {
    expect(gbpPlain(NOT_CLEARED)).toBe('Google Business Profile stays off until counsel reviews it. Nothing is read from or posted to Google.');
    expect(gbpPlain(NOT_CLEARED_NOT_INSTALLED)).toBe('Google Business Profile stays off until counsel reviews it. Nothing is read from or posted to Google.');
  });

  it('R-STAFF-1: a location sentence loses its "(CODE)"; the reply outcome loses its code', () => {
    expect(gbpPlain(LOCATION_FAILED)).toBe('Last check failed; we will try again.');
    expect(gbpPlain(REPLY_FAILED)).toBe('Google did not take the reply. Edit it or try again.');
  });

  it('R-STAFF-1: sentences without a code pass through unchanged', () => {
    for (const s of [NOT_SET_UP, REPLY_UNKNOWN_API, 'No Business Profile location is connected.', 'One Business Profile location is connected.', '2 Business Profile locations are connected.', 'Not checked yet', 'No review needs a reply.']) {
      expect(gbpPlain(s)).toBe(s);
    }
  });

  it('R-STAFF-1: any other platform key is said by its name', () => {
    expect(gbpPlain('Waits for platform:fair_housing.')).toBe('Waits for Publishing marketing (fair-housing rules).');
  });

  it('R-STAFF-1: no output carries a raw code', () => {
    for (const s of [NOT_CLEARED, NOT_CLEARED_NOT_INSTALLED, LOCATION_FAILED, NOT_SET_UP, REPLY_FAILED]) expect(gbpPlain(s)).not.toMatch(RAW);
  });
});

describe('stars and refusals in words (R-STAFF-3, E663)', () => {
  it('R-STAFF-3: stars always carry their denominator', () => {
    expect([1, 2, 3, 4, 5].map(starsWords)).toEqual(['1 of 5 stars', '2 of 5 stars', '3 of 5 stars', '4 of 5 stars', '5 of 5 stars']);
    expect(starsWords(null)).toBe('No star rating');
  });

  it('E663: every guard code and every refusal code has words with no raw code', () => {
    for (const w of Object.values(GUARD_WORDS)) expect(w).not.toMatch(RAW);
    for (const w of Object.values(GBP_ERROR_MESSAGES)) expect(w).not.toMatch(RAW);
    for (const code of ['GBP_NOT_CLEARED', 'GBP_NOT_CONFIGURED', 'CHANNEL_NOT_CONNECTED', 'REPLY_STALE', 'REPLY_IN_PROGRESS', 'ASSISTANT_UNAVAILABLE']) {
      expect(GBP_ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });

  it('E663: REPLY_PRIVACY names each code and the words of the person\'s own text it found', () => {
    const text = 'Thanks Jane! Glad the $500 credit helped.';
    const w = refusalWords({ code: 'REPLY_PRIVACY', status: 422, details: { codes: ['REVIEWER_NAME', 'MONEY'], spans: [{ code: 'REVIEWER_NAME', start: 7, end: 11 }, { code: 'MONEY', start: 22, end: 26 }] } }, text);
    expect(w.sentence).toBe(GBP_ERROR_MESSAGES.REPLY_PRIVACY);
    expect(w.items).toEqual([`${GUARD_WORDS.REVIEWER_NAME} (“Jane”)`, `${GUARD_WORDS.MONEY} (“$500”)`]);
  });

  it('E663: PLATFORM_NOT_CLEARED names the pack through packName, never its key', () => {
    const w = refusalWords({ code: 'PLATFORM_NOT_CLEARED', status: 409, details: { pack: 'platform:fair_housing' } });
    expect(w.sentence).toBe("Replies wait for counsel's review of Publishing marketing (fair-housing rules). Nothing was posted.");
    expect(w.sentence).not.toMatch(RAW);
  });

  it('E663: ASSISTANT_UNAVAILABLE says why when the API says (AI_OFF, DRAFT_REFUSED)', () => {
    expect(refusalWords({ code: 'ASSISTANT_UNAVAILABLE', status: 409, details: { reason: 'AI_OFF' } }).sentence).toMatch(/turned off/);
    expect(refusalWords({ code: 'ASSISTANT_UNAVAILABLE', status: 409, details: { reason: 'DRAFT_REFUSED' } }).sentence).toMatch(/nothing was saved/);
    expect(refusalWords({ code: 'ASSISTANT_UNAVAILABLE', status: 409, details: null }).sentence).toBe(GBP_ERROR_MESSAGES.ASSISTANT_UNAVAILABLE);
  });
});
