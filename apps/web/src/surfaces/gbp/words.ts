// Plain words of the Google Business Profile page (module 55; R-STAFF-1, R-STAFF-3, E663, E678). Pure functions
// over what the API sent: the API's sentences pass through gbpPlain, refusals are worded by code here (never in the
// shell's errorMessages, pages.test.ts), and stars always carry their denominator.
import { messageFor } from '../../shell/index.js';
import { packName, plainSentence } from '../admin/integrations/words.js';
import type { GuardCode } from './types.js';

export const GBP_PATH = '/gbp';
/** GET /gbp/reviews answers at most this many reviews (api/gbp/repos/gbp.ts reviewsOf, LIMIT 200). */
export const REVIEW_LIMIT = 200;

/**
 * A status or location sentence of the API without a raw code (CONVENTIONS.md:198): the pack key and version the
 * not-cleared sentence names ("(pack platform:gbp 2026.11.0)"), any other platform key (said by its name), and an
 * error code in brackets ("Last check failed (LIST_TIMEOUT); …").
 */
export function gbpPlain(s: string): string {
  return plainSentence(s.replace(/\s*\(pack platform:[^)]*\)/g, '').replace(/platform:[a-z_]+/g, (k) => packName(k)));
}

/** "4 of 5 stars"; a removed review has no rating. */
export function starsWords(rating: number | null): string {
  if (rating === null) return 'No star rating';
  return `${rating} of 5 stars`;
}

/** What each privacy-guard code means for a public reply (api/gbp/guard.ts GUARD_CODES). */
export const GUARD_WORDS: Record<GuardCode, string> = {
  REVIEWER_NAME: "It names the reviewer. A public reply never repeats the reviewer's name.",
  MONEY: 'It mentions a price or an amount of money.',
  ADDRESS: 'It mentions an address.',
  DATE: 'It mentions a date.',
  CONTACT: 'It includes a phone number, an email address or other contact details.',
  DEAL: 'It mentions deal terms, like an offer, a closing or a loan.',
  FAIR_HOUSING: "It uses words the fair-housing rules don't allow.",
  LENGTH: "It's empty or longer than Google allows.",
};

/** The title above a stored draft's guard words, here and on the approvals card. */
export const GUARD_NOTICE_TITLE = 'Edit this before you post it';

export function guardWords(code: string): string {
  return Object.hasOwn(GUARD_WORDS, code) ? GUARD_WORDS[code as GuardCode] : 'It does not pass the privacy checks.';
}

/** The refusal sentences of the GBP routes (api/gbp/replies.ts, routes.ts), worded here instead of the shell. */
export const GBP_ERROR_MESSAGES: Record<string, string> = {
  GBP_NOT_CLEARED: 'Google Business Profile stays off until counsel reviews it. Nothing was posted.',
  GBP_NOT_CONFIGURED: "Google Business Profile isn't set up on this platform yet, so replies can't be posted from here. Nothing was posted.",
  CHANNEL_NOT_CONNECTED: "This review's Business Profile location isn't connected any more. Nothing was posted.",
  REPLY_PRIVACY: "This reply can't be posted as written. Nothing was posted. Edit it, then post it.",
  REPLY_STALE: 'The review changed on Google after this reply was drafted. Nothing was posted. Draft the reply again.',
  REPLY_IN_PROGRESS: "This reply is already being posted. It won't be posted twice.",
  ASSISTANT_UNAVAILABLE: "The assistant couldn't draft a reply right now. Write one yourself, or try again later.",
  NOT_FOUND: "This review or its draft isn't available any more. The list below is up to date.",
};

const ASSISTANT_REASON: Record<string, string> = {
  AI_OFF: 'The assistant is turned off for your team. Write a reply yourself.',
  DRAFT_REFUSED: "The assistant's draft didn't pass the privacy checks, so nothing was saved. Write a reply yourself, or try again.",
};

export interface Refusal {
  code: string;
  status: number;
  details: Record<string, unknown> | null;
}

/** A refusal in words: the sentence, and for REPLY_PRIVACY each guard code and the words of the person's own text it found. */
export function refusalWords(r: Refusal, text = ''): { sentence: string; items: string[] } {
  const d = r.details ?? {};
  if (r.code === 'PLATFORM_NOT_CLEARED') {
    const pack = typeof d.pack === 'string' ? d.pack : '';
    return { sentence: `Replies wait for counsel's review of ${pack ? packName(pack) : 'a feature they need'}. Nothing was posted.`, items: [] };
  }
  if (r.code === 'ASSISTANT_UNAVAILABLE' && typeof d.reason === 'string' && Object.hasOwn(ASSISTANT_REASON, d.reason)) {
    return { sentence: ASSISTANT_REASON[d.reason]!, items: [] };
  }
  if (r.code === 'REPLY_PRIVACY') {
    const codes = Array.isArray(d.codes) ? d.codes.filter((c): c is string => typeof c === 'string') : [];
    const spans = Array.isArray(d.spans) ? (d.spans as { code?: unknown; start?: unknown; end?: unknown }[]) : [];
    const items = codes.map((c) => {
      // the words of the person's own text the guard found (offsets into the trimmed text sent); never for LENGTH
      const found = c === 'LENGTH' ? [] : spans.filter((s) => s.code === c && typeof s.start === 'number' && typeof s.end === 'number').map((s) => text.slice(s.start as number, s.end as number).trim()).filter((w) => w !== '');
      const unique = [...new Set(found)];
      return unique.length > 0 ? `${guardWords(c)} (${unique.map((w) => `“${w}”`).join(', ')})` : guardWords(c);
    });
    return { sentence: GBP_ERROR_MESSAGES.REPLY_PRIVACY!, items };
  }
  if (Object.hasOwn(GBP_ERROR_MESSAGES, r.code)) return { sentence: GBP_ERROR_MESSAGES[r.code]!, items: [] };
  return { sentence: messageFor(r.code), items: [] };
}

/** A reply whose answer was lost (network, 5xx): never "failed", never re-sent by itself (R-STAFF-4). */
export const REPLY_UNKNOWN = "We couldn't tell whether Google took the reply. The review below shows where it stands; it won't be posted twice.";

export function reviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}
